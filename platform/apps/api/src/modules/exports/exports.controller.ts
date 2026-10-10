import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpException,
  HttpStatus,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import {
  EXPORT_DATASETS,
  EXPORT_LIMITS,
  EXPORT_RETENTION_DAYS,
  ExportDatasetKey,
  ExportFormat,
  ExportScope,
  ExportSection,
  type ExportDataset,
  datasetModule,
  datasetsInSection,
  exportDataset,
  ownerAlertIsInstant,
  personScopableDatasets,
  personScopeRefusal,
  redactedColumns,
  visibleColumns,
} from "@aura/shared";
import { publishExport } from "@aura/queue";
// Whose records this caller may export (0188). Imported from @aura/db rather
// than reimplemented here because the WORKER asks the same question again at
// render time - see people-visibility.ts's header for why that matters.
import {
  exportablePeople,
  loadPerson,
  resolvePeopleVisibility,
  visibilityAllowsTelecaller,
} from "@aura/db";

import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { principalHasPermission } from "../../common/auth-principal";
import { loadOrgFeatures } from "../../common/org-features";
import { orgHasModule } from "../../common/org-modules";
import { OwnerScope, type OwnerRecordScope } from "../../common/owner-scope";
import { OwnerScopeGuard } from "../../common/owner-scope.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { S3Service } from "../../s3/s3.service";

/**
 * The data export engine's HTTP surface (doc 35 SS9, migration 0148).
 *
 * ── WHAT THIS CONTROLLER IS RESPONSIBLE FOR ─────────────────────────────────
 *
 * Deciding WHO may export WHAT, writing the job, alerting the owners, and
 * handing out a download. It does not read a single exported row - that is the
 * worker's job, and keeping the two apart is what stops a large tenant timing
 * out a request.
 *
 * ── THE FIVE GATES (SS4.1) ──────────────────────────────────────────────────
 *
 * Per dataset, in order: tenant (TenantGuard + RLS), module
 * (`organizations.enabled_modules`), feature (0093), grid
 * (`role_permissions` with action 'export'), row scope (persona INTERSECT
 * grid), and sensitivity (`recordings:export`).
 *
 * A `view` export that fails any of them is a 403. A `section` or `bulk` export
 * DROPS the dataset and says so in the response, because "everything I may see"
 * legitimately means fewer datasets for some people - but a section where
 * nothing survives is a 403 rather than an empty archive, which is
 * indistinguishable from a broken export.
 *
 * ── WHY THE GRID CHECK IS HAND-ROLLED RATHER THAN @RequireCrmPermission ─────
 *
 * That decorator takes ONE static object type, and this route's object list
 * comes from the request: a bulk export spans nine of them. The same reasoning
 * `import.controller.ts` gives for not using it. The grant is still read from
 * the database for the asserted identity, never from a header, so the property
 * that matters is unchanged.
 */

const CreateBody = z
  .object({
    scope: ExportScope,
    format: ExportFormat,
    dataset: ExportDatasetKey.optional(),
    section: ExportSection.optional(),
    filters: z.record(z.string(), z.unknown()).optional(),
    columns: z.array(z.string()).max(200).optional(),
    /**
     * WHOSE records to export, for `scope: "person"` (0188).
     *
     * A telecaller identity, never a user id: that is the column calls, leads,
     * deals and the rollup all scope on, and `telecallers.user_id` is nullable
     * - most of a floor has never signed in. Naming a user here would make the
     * majority of a telecalling team unexportable.
     */
    subjectTelecallerId: z.string().uuid().optional(),
  })
  // `dataset`/`filters` on a section or bulk body are REJECTED, not ignored. A
  // caller who sends filters with a section export believes they will be
  // applied, and silently dropping them returns a file that is correct by the
  // schema and wrong by the request.
  .superRefine((body, ctx) => {
    // The subject belongs to exactly one scope, in both directions. A subject
    // on a bulk body is a caller who believes a filter is being applied that
    // is not - the same reason `filters` is rejected rather than ignored below.
    if (body.scope !== "person" && body.subjectTelecallerId) {
      ctx.addIssue({
        code: "custom",
        message: `a ${body.scope} export cannot name a person - use scope "person"`,
      });
    }
    if (body.scope === "view") {
      if (!body.dataset) {
        ctx.addIssue({ code: "custom", message: "a view export names one dataset" });
      }
      if (body.section) {
        ctx.addIssue({ code: "custom", message: "a view export has no section" });
      }
      return;
    }
    // ── A PERSON EXPORT IS A VIEW EXPORT WITH A SUBJECT ─────────────────
    //
    // One dataset, filters allowed, plus whose data it is. Shaped like `view`
    // rather than like `bulk` for two reasons, and the second is the real one:
    //
    //   · it is what the engine can actually render. The worker streams ONE
    //     dataset to ONE file; multi-dataset archives are doc 35's E3 and are
    //     not built, so a scope that implied them would be accepted here and
    //     refused at render - a job that fails minutes later for a reason the
    //     caller cannot see.
    //   · filters are the point. "Priya's calls" is rarely the question;
    //     "Priya's calls last month" is, because the reason somebody wants one
    //     person's file is almost always a review period.
    if (body.scope === "person") {
      if (!body.subjectTelecallerId) {
        ctx.addIssue({ code: "custom", message: "a person export names whose data it is" });
      }
      if (!body.dataset) {
        ctx.addIssue({ code: "custom", message: "a person export names one dataset" });
      }
      if (body.section) {
        ctx.addIssue({ code: "custom", message: "a person export has no section" });
      }
      return;
    }
    if (body.dataset) {
      ctx.addIssue({ code: "custom", message: `a ${body.scope} export cannot name a dataset` });
    }
    if (body.filters && Object.keys(body.filters).length > 0) {
      ctx.addIssue({ code: "custom", message: `a ${body.scope} export is unfiltered` });
    }
    if (body.scope === "section" && !body.section) {
      ctx.addIssue({ code: "custom", message: "a section export names its section" });
    }
    if (body.scope === "bulk" && body.section) {
      ctx.addIssue({ code: "custom", message: "a bulk export has no section" });
    }
  });

interface QueryClient {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>;
}

/** Why a dataset was left out, for the response and the manifest. */
interface Omitted {
  dataset: string;
  reason: "module" | "feature" | "permission" | "not_implemented";
}

@Controller("exports")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerScopeGuard)
export class ExportsController {
  constructor(
    private readonly db: DbService,
    private readonly s3: S3Service,
  ) {}

  /**
   * What this caller may export - what the drawer reads.
   *
   * Computed from the same registry and the same gates the POST enforces. A
   * dataset offered here and refused there is a bug report, so the gate logic
   * lives in one private method both call.
   */
  @Get("datasets")
  @Header("Cache-Control", "no-store")
  async datasets(
    @OrgId() orgId: string,
    @Req() req: PrincipalRequest,
    @OwnerScope() scope: OwnerRecordScope,
  ) {
    const canExportRecordings = principalHasPermission(
      req.principal ?? throwUnauthenticated(),
      "recordings:export",
    );
    return this.db.withOrg(orgId, async (client) => {
      const allowed = await this.allowedDatasets(client, req, EXPORT_DATASETS);
      return {
        datasets: allowed.granted.map((d) => ({
          key: d.key,
          label: d.label,
          section: d.section,
          sensitivity: d.sensitivity,
          columns: visibleColumns(d, canExportRecordings).map((c) => ({
            name: c.name,
            type: c.type,
          })),
          redacted: redactedColumns(d, canExportRecordings),
        })),
        sections: [...new Set(allowed.granted.map((d) => d.section))].map((section) => ({
          section,
          datasets: allowed.granted.filter((d) => d.section === section).map((d) => d.key),
        })),
        omitted: allowed.omitted,
        // So the drawer can say "your role does not have recording export"
        // BEFORE the job runs rather than after the file arrives short.
        canExportRecordings,
        ownerAlertNotice: true,
        retentionDays: EXPORT_RETENTION_DAYS,
        scope: scope.scope,
      };
    });
  }

  /**
   * WHOSE data this caller may export, and which datasets a person export can
   * produce (0188) - what the person picker reads.
   *
   * Driven by the same `resolvePeopleVisibility` the POST enforces, so a name
   * offered here and refused there is a bug report rather than a policy.
   *
   * There is no "all people" mode and no search parameter: the list is bounded
   * by the caller's own branch, which is at most a floor, and paging it would
   * mean a caller could learn the SIZE of a branch they cannot see into.
   */
  @Get("people")
  @Header("Cache-Control", "no-store")
  async people(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    const principal = req.principal ?? throwUnauthenticated();
    return this.db.withOrg(orgId, async (client) => {
      const actor = {
        userId: principal.userId,
        ownerRole: principal.ownerRole,
        viaAdminKey: principal.viaAdminKey,
      };
      const visibility = await resolvePeopleVisibility(client, actor);
      const people = await exportablePeople(client, actor, visibility);
      const scopable = personScopableDatasets();
      // Intersected with what this caller may export at all, so the picker
      // does not offer a person whose file would come back empty.
      const { granted } = await this.allowedDatasets(client, req, scopable);
      return {
        visibility: visibility.kind,
        people: people.map((p) => ({
          telecallerId: p.telecallerId,
          displayName: p.displayName,
          ownerRole: p.ownerRole,
          isSelf: p.isSelf,
        })),
        datasets: granted.map((d) => ({ key: d.key, label: d.label, section: d.section })),
        // Named so the drawer can explain the gap rather than leaving somebody
        // to wonder where Contacts went.
        notPerPerson: EXPORT_DATASETS.filter((d) => personScopeRefusal(d) !== null).map((d) => ({
          key: d.key,
          label: d.label,
          reason: personScopeRefusal(d) as string,
        })),
      };
    });
  }

  @Post()
  @HttpCode(202)
  async create(@OrgId() orgId: string, @Req() req: PrincipalRequest, @Body() rawBody: unknown) {
    const parsed = CreateBody.safeParse(rawBody);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join("; "));
    }
    const body = parsed.data;
    const principal = req.principal ?? throwUnauthenticated();

    // An API key has no person, no membership and therefore no grid grant or
    // persona (auth-principal.ts:96-104). Refused outright until the dedicated
    // scopes exist (SS4.7) - the fail-closed direction, easy to relax later.
    if (req.apiKey) {
      throw new ForbiddenException("export is not available to integration keys yet");
    }
    // And a bare admin key that names nobody: see UUID_RE's note. The job row
    // has no owner to record, so there is nothing to create.
    if (!UUID_RE.test(principal.userId)) {
      throw new ForbiddenException(
        "an export belongs to a person - assert the acting user with x-caller-user-id",
      );
    }

    const requested =
      body.scope === "view" || body.scope === "person"
        ? [exportDataset(body.dataset as ExportDatasetKey)]
        : body.scope === "section"
          ? datasetsInSection(body.section as ExportSection)
          : EXPORT_DATASETS;

    // ── THE DATASET MUST BE SOMETHING A PERSON CAN HOLD ───────────────────
    //
    // Refused BEFORE any gate or rate limit, because this is a property of the
    // dataset rather than of the caller: nobody, at any permission level, can
    // export "this person's products". A dataset with no per-person column
    // produces `null` from `ownerScopeFilter`, the engine correctly adds no
    // predicate, and the file is the whole tenant under one person's name -
    // doc 35 §4.2's named failure. `personScopeRefusal` is the single place
    // that judgement lives.
    if (body.scope === "person") {
      const refusal = personScopeRefusal(requested[0]);
      if (refusal) throw new BadRequestException(refusal);
    }

    return this.db.withOrg(orgId, async (client) => {
      const { granted, omitted } = await this.allowedDatasets(client, req, requested);

      if ((body.scope === "view" || body.scope === "person") && granted.length === 0) {
        throw new ForbiddenException(
          `you may not export ${body.dataset}: ${omitted[0]?.reason ?? "not permitted"}`,
        );
      }
      // A section or bulk export where NOTHING survives is a 403, not an empty
      // archive. An empty ZIP is indistinguishable from a broken export.
      if (granted.length === 0) {
        throw new ForbiddenException(
          body.scope === "section"
            ? `you may not export anything in ${body.section}`
            : "you may not export any of this workspace's data",
        );
      }

      if (body.scope === "bulk") await this.assertBulkAllowed(client, req);

      // ── WHOSE DATA, AND MAY THIS CALLER HAVE IT (0188) ──────────────────
      //
      // The one authorization question the other three scopes never ask,
      // because they never name anybody. Asked here at enqueue AND again in
      // the worker at render: a reporting line that changes between the two
      // must stop the file, and only the second check can see that.
      //
      // Note what is NOT consulted: the `export` grant and the module gates
      // have already been applied by `allowedDatasets` above. This decides
      // only WHOSE rows, never WHICH datasets - keeping the two questions
      // separate is what stops "why can Priya not export Ashok" having two
      // answers.
      const subject =
        body.scope === "person"
          ? await this.resolveSubject(client, req, body.subjectTelecallerId as string)
          : null;

      await this.assertRateLimit(
        client,
        body.scope,
        body.section ?? null,
        principal.userId,
        subject?.telecallerId ?? null,
      );

      const snapshot = await this.scopeSnapshot(client, req, granted, subject);

      // ── ONE TRANSACTION, AND IT IS THIS ONE ─────────────────────────────
      //
      // `withOrg` is already BEGIN…COMMIT (packages/db/src/index.ts:122), so
      // everything in this callback commits together. That is what makes "every
      // export alerts the owners" true rather than nearly true: a notification
      // written after the commit is one that a crash in between skips while the
      // export still runs, and the alert is the whole governance story.
      //
      // So the job row, the owners' notifications, `owners_notified_at` and the
      // audit row are all written here, and the queue publish - the one thing
      // that must NOT be inside - happens after.
      const {
        rows: [job],
      } = await client.query<{ id: string }>(
        `INSERT INTO export_jobs
           (org_id, scope, section, format, datasets, filters, columns,
            requested_by_user_id, requested_by_auth_id, scope_snapshot,
            subject_telecaller_id, subject_user_id, subject_label)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10::jsonb,
                 $11, $12, $13)
         RETURNING id`,
        [
          orgId,
          body.scope,
          body.scope === "section" ? body.section : null,
          body.format,
          granted.map((d) => d.key),
          // `person` carries filters for the same reason `view` does: the
          // request is almost always "their work in this period".
          JSON.stringify(
            body.scope === "view" || body.scope === "person" ? (body.filters ?? {}) : {},
          ),
          JSON.stringify(body.columns ? { [granted[0].key]: body.columns } : {}),
          principal.userId,
          principal.authUserId ?? null,
          JSON.stringify(snapshot),
          subject?.telecallerId ?? null,
          subject?.userId ?? null,
          // Frozen at enqueue, so a rename six weeks later does not rewrite
          // the record of who looked at whom. 0188's column comment says so.
          subject?.displayName ?? null,
        ],
      );
      const jobId = job.id;

      await this.alertOwners(client, orgId, jobId, body, granted, principal.userId);
      await client.query(`UPDATE export_jobs SET owners_notified_at = now() WHERE id = $1`, [jobId]);

      // Written BEFORE the export runs, not after it succeeds: an attempt that
      // fails is still an attempt worth having a record of.
      await this.audit(client, orgId, req, "export.created", jobId, {
        scope: body.scope,
        section: body.section ?? null,
        format: body.format,
        datasets: granted.map((d) => d.key),
        omitted,
        rowScope: snapshot.ownerScopeKind,
        // The subject goes in the audit row as well as the job row. The job is
        // deleted when its artifact expires; the audit trail is what remains
        // to answer "who exported my data" afterwards.
        subjectTelecallerId: subject?.telecallerId ?? null,
        subjectLabel: subject?.displayName ?? null,
      });

      // AFTER the commit would be better still, but the publish is best-effort
      // and the row is the record: a message consumed before the row is visible
      // finds nothing and nacks, and a failed publish leaves the row for the
      // sweep to re-publish within five minutes. Both failure modes cost
      // latency, never the job.
      await publishExport({ jobId, orgId }).catch(() => undefined);

      return {
        jobId,
        status: "queued" as const,
        datasets: granted.map((d) => d.key),
        // The caller asked for a section and may have got fewer datasets than
        // it holds. Saying so here is what lets the drawer show it rather than
        // leaving somebody to look for a file that was never coming.
        omitted,
      };
    });
  }

  @Get()
  @Header("Cache-Control", "no-store")
  async list(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    const principal = req.principal ?? throwUnauthenticated();
    const ownerWide = isOwner(req);
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT j.id, j.scope, j.section, j.format, j.datasets, j.status,
                j.rows_total, j.rows_written, j.bytes_written, j.current_dataset,
                j.file_name, j.expires_at, j.downloaded_count, j.error,
                j.created_at, j.finished_at,
                j.requested_by_user_id, u.name AS requested_by_name,
                -- 0188: whose work a person export was about. The frozen label
                -- rather than a join to the telecallers table, so a rename does
                -- not rewrite the record of who looked at whom - and so the row
                -- still reads correctly after the identity is deleted.
                -- (No backticks in here: inside a template literal they end
                -- the string, and tsc only says "',' expected".)
                j.subject_telecaller_id, j.subject_label
           FROM export_jobs j
           LEFT JOIN users u ON u.id = j.requested_by_user_id
          WHERE ($1::boolean OR j.requested_by_user_id = $2)
          ORDER BY j.created_at DESC
          LIMIT 100`,
        [ownerWide, principal.userId],
      );
      // `canDownload` rather than letting the console infer it: an owner sees
      // everybody's jobs and may download only their own (SS7.2), and that rule
      // should not be re-derived in the UI.
      return {
        jobs: rows.map((r) => ({
          ...r,
          canDownload: r.requested_by_user_id === principal.userId && r.status === "ready",
        })),
      };
    });
  }

  @Get(":id")
  @Header("Cache-Control", "no-store")
  async one(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const principal = req.principal ?? throwUnauthenticated();
    return this.db.withOrg(orgId, async (client) => {
      const job = await this.loadJob(client, id);
      if (!isOwner(req) && job.requested_by_user_id !== principal.userId) {
        throw new NotFoundException("export not found");
      }
      const { rows: files } = await client.query(
        `SELECT dataset, file_name, row_count, bytes, redacted_columns
           FROM export_job_files WHERE job_id = $1 ORDER BY dataset`,
        [id],
      );
      return {
        ...job,
        files,
        canDownload: job.requested_by_user_id === principal.userId && job.status === "ready",
      };
    });
  }

  /**
   * A 302 to a freshly signed URL (SS7.2).
   *
   * The job row holds the S3 KEY, never a URL. A stored presigned URL is a
   * bearer token in a database column: anyone who can read the row can download
   * the file, deleting the row does not un-sign it, and it expires on the
   * creation clock rather than the download's. Signing here gives a 5-minute
   * window and re-authorises on every click.
   */
  @Get(":id/download")
  @Header("Cache-Control", "no-store")
  async download(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @Res() res: Response,
  ): Promise<void> {
    const principal = req.principal ?? throwUnauthenticated();
    // A platform operator may SEE a tenant's export history and may never
    // download the artifact: reading the job list is operational, reading the
    // file is reading the tenant's data. Checked explicitly rather than
    // inferred from a role.
    if (principal.operatorEmail !== null) {
      throw new ForbiddenException("an operator cannot download a tenant's export");
    }

    const url = await this.db.withOrg(orgId, async (client) => {
      const job = await this.loadJob(client, id);
      // Ownership, not visibility: an owner can see the row (above) and still
      // cannot have the file.
      if (job.requested_by_user_id !== principal.userId) {
        throw new ForbiddenException("this export belongs to somebody else");
      }
      if (job.status === "expired") {
        // 410 rather than 404: the export existed and its file is gone, which
        // is what the console needs in order to offer "Run again" instead of
        // reporting that the job never existed.
        throw new HttpException(
          `this export expired on ${String(job.expires_at)}`,
          HttpStatus.GONE,
        );
      }
      if (job.status !== "ready" || !job.storage_key) {
        throw new BadRequestException(`this export is ${String(job.status)}, not ready`);
      }
      await client.query(
        `UPDATE export_jobs
            SET downloaded_count = downloaded_count + 1, last_downloaded_at = now()
          WHERE id = $1`,
        [id],
      );
      return this.s3.presignedGetUrl(
        String(job.storage_key),
        EXPORT_DOWNLOAD_TTL_SECONDS,
        String(job.content_type ?? "text/csv; charset=utf-8"),
      );
    });

    await this.db.withOrg(orgId, (client) =>
      this.audit(client, orgId, req, "export.downloaded", id, {}),
    );
    res.redirect(302, url);
  }

  /** Cancel a live job, or delete a finished one's artifact now. */
  @Delete(":id")
  async cancel(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const principal = req.principal ?? throwUnauthenticated();
    return this.db.withOrg(orgId, async (client) => {
      const job = await this.loadJob(client, id);
      if (job.requested_by_user_id !== principal.userId && !isOwner(req)) {
        throw new NotFoundException("export not found");
      }

      if (job.status === "queued" || job.status === "running") {
        // The worker checks the status between pages and stops.
        await client.query(
          `UPDATE export_jobs SET status = 'cancelled', finished_at = now() WHERE id = $1`,
          [id],
        );
        return { status: "cancelled" as const };
      }
      if (job.status === "ready" && job.storage_key) {
        // Delete the object BEFORE clearing the key. The other order leaks an
        // orphan on every crash in between, and an orphan in object storage is
        // invisible - nothing ever lists it again.
        await this.s3.deleteObject(String(job.storage_key));
        await client.query(
          `UPDATE export_jobs SET status = 'expired', storage_key = NULL WHERE id = $1`,
          [id],
        );
        return { status: "expired" as const };
      }
      return { status: String(job.status) };
    });
  }

  // ── gates ─────────────────────────────────────────────────────────────────

  /**
   * The five gates, once, for both `GET datasets` and `POST`.
   *
   * Returns what survived and why the rest did not. The order is deliberate:
   * module before feature before grant, so the REASON a dataset is missing is
   * the outermost thing that was off - an org without the CRM module hears
   * "module", not "permission", which is the difference between a sales call
   * and a support ticket.
   */
  private async allowedDatasets(
    client: QueryClient,
    req: PrincipalRequest,
    wanted: ExportDataset[],
  ): Promise<{ granted: ExportDataset[]; omitted: Omitted[] }> {
    const principal = req.principal ?? throwUnauthenticated();
    const features = await loadOrgFeatures(client);
    const granted: ExportDataset[] = [];
    const omitted: Omitted[] = [];

    for (const dataset of wanted) {
      if (!(await orgHasModule(client, datasetModule(dataset)))) {
        omitted.push({ dataset: dataset.key, reason: "module" });
        continue;
      }
      // A feature is a four-state thing (0093), not a boolean: "on", "off",
      // "unavailable" (the module is absent) and "blocked" (a prerequisite is
      // off). Only "on" may export - and note this is VISIBILITY, not security,
      // so it comes AFTER the module gate and BEFORE the grant, which is the
      // one that actually decides.
      if (dataset.feature && features.get(dataset.feature)?.state !== "on") {
        omitted.push({ dataset: dataset.key, reason: "feature" });
        continue;
      }
      if (dataset.object) {
        const grant = await this.gridGrant(client, principal.userId, dataset);
        if (!grant) {
          omitted.push({ dataset: dataset.key, reason: "permission" });
          continue;
        }
      } else if (!(await this.personaMayExport(req, dataset))) {
        omitted.push({ dataset: dataset.key, reason: "permission" });
        continue;
      }
      granted.push(dataset);
    }
    return { granted, omitted };
  }

  /**
   * The grid grant for one object, read from the database for the asserted
   * identity - never from a header.
   *
   * The module join is the one `CrmPermissionsGuard` explains at length: a
   * tenant whose CRM was switched off still has its `roles`/`role_permissions`
   * rows, and without it those rows keep granting access to a module the org no
   * longer has.
   */
  private async gridGrant(
    client: QueryClient,
    userId: string,
    dataset: ExportDataset,
  ): Promise<"all" | "owned" | null> {
    // NO BARE-ADMIN-KEY CARVE-OUT, and no 500 either.
    //
    // A caller presenting the admin key without `x-caller-user-id` has
    // `principal.userId === "admin-key"` (auth-principal.ts), which is not a
    // uuid: passing it to `m.user_id = $1` raises 22P02 and the route answers
    // 500 instead of denying. Both outcomes are wrong, and the right one is
    // already decided - `CrmPermissionsGuard` hardened exactly this case to
    // DENY, on the grounds that omitting the header must not grant more than
    // asserting a real-but-unresolvable id. So: no grant.
    if (!UUID_RE.test(userId)) return null;
    const { rows } = await client.query<{ scope: string }>(
      `SELECT rp.scope
         FROM memberships m
         JOIN organizations o
           ON o.id = m.org_id AND $3 = ANY(o.enabled_modules)
         JOIN roles r
           ON r.org_id = m.org_id
          AND (r.id = m.role_id OR (m.role_id IS NULL AND r.key = m.role))
         JOIN role_permissions rp
           ON rp.role_id = r.id AND rp.object_type = $2 AND rp.action = 'export'
        WHERE m.user_id = $1
        ORDER BY rp.scope
        LIMIT 1`,
      [userId, dataset.object, datasetModule(dataset)],
    );
    const scope = rows[0]?.scope;
    return scope === "all" || scope === "owned" ? scope : null;
  }

  /**
   * One audit row, in the caller's transaction.
   *
   * `auditActor` rather than `principal.userId`: a platform operator has no
   * `users` row, so that field is the literal "admin-key" and every such write
   * used to land as a user of that name - which made the one actor a customer
   * most needs to see in their own trail the one it could not name.
   */
  private async audit(
    client: QueryClient,
    orgId: string,
    req: PrincipalRequest,
    action: string,
    jobId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    const actor = auditActor(req);
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
       VALUES ($1, $2, $3, $4, 'export_job', $5, $6::jsonb)`,
      [orgId, actor.type, actor.id, action, jobId, JSON.stringify(meta)],
    );
  }

  /**
   * Datasets the grid has no object for: calls, transcripts, attendance,
   * members, audit log.
   *
   * `call` is deliberately absent from `PermissionObjectType` - reading a call
   * already has three gates and a fourth axis is how "why can Priya not hear
   * this call" acquires four answers and no authoritative one. So these are
   * gated by PERSONA and, for call content, by `recordings:export`.
   */
  private async personaMayExport(req: PrincipalRequest, dataset: ExportDataset): Promise<boolean> {
    const principal = req.principal ?? throwUnauthenticated();
    if (dataset.sensitivity === "call_content") {
      // Metadata-only `calls` is allowed without the grant; transcripts are
      // not offered at all, because there is nothing left of them to show.
      if (dataset.key === "call_transcripts") {
        return principalHasPermission(principal, "recordings:export");
      }
      return true;
    }
    // The team list and the audit log are the workspace's own records.
    if (dataset.key === "members" || dataset.key === "audit_log") return isOwner(req);
    return true;
  }

  private async assertBulkAllowed(client: QueryClient, req: PrincipalRequest): Promise<void> {
    if (!isOwner(req)) {
      throw new ForbiddenException("only an owner can export the whole workspace");
    }
    void client;
  }

  /**
   * The rate limits (SS5.5). A bulk export is a full read of the tenant; a
   * section export is a full read of one part of it. Letting either be
   * triggered in a loop is a self-inflicted outage.
   */
  private async assertRateLimit(
    client: QueryClient,
    scope: ExportScope,
    section: string | null,
    userId: string,
    subjectTelecallerId: string | null,
  ): Promise<void> {
    if (scope === "view") return;

    // A person export is rate-limited PER SUBJECT, not per requester.
    //
    // Keying it on the requester would let one manager pull the same person
    // repeatedly while a second manager of the same person is refused, which
    // is backwards: the thing worth limiting is how often one employee's file
    // is produced, because that is the thing that ends up in somebody's
    // inbox. Per-subject also makes the audit trail readable - one row per
    // hour per person, rather than a burst that has to be reconstructed.
    if (scope === "person") {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM export_jobs
          WHERE scope = 'person' AND subject_telecaller_id = $1
            AND created_at > now() - interval '1 hour' AND status <> 'cancelled'`,
        [subjectTelecallerId],
      );
      if (Number(rows[0]?.n ?? 0) >= EXPORT_LIMITS.personJobsPerHourPerSubject) {
        throw new BadRequestException(
          "this person's data has already been exported in the last hour",
        );
      }
      return;
    }

    const { rows } = await client.query<{ n: string }>(
      scope === "bulk"
        ? `SELECT count(*)::text AS n FROM export_jobs
            WHERE scope = 'bulk' AND created_at > now() - interval '24 hours'
              AND status <> 'cancelled'`
        : `SELECT count(*)::text AS n FROM export_jobs
            WHERE scope = 'section' AND section = $2 AND requested_by_user_id = $1
              AND created_at > now() - interval '1 hour' AND status <> 'cancelled'`,
      scope === "bulk" ? [] : [userId, section],
    );
    const limit = scope === "bulk" ? EXPORT_LIMITS.bulkJobsPerDay : EXPORT_LIMITS.sectionJobsPerHour;
    if (Number(rows[0]?.n ?? 0) >= limit) {
      throw new BadRequestException(
        scope === "bulk"
          ? "this workspace has already exported everything today; try again tomorrow"
          : `you have already exported ${section} in the last hour`,
      );
    }
  }

  /**
   * The subject of a person export, authorized (0188).
   *
   * Three failures, three different answers, because they are three different
   * problems for whoever is holding the screen:
   *
   *   · the identity does not exist       → 404, they picked a stale row
   *   · it exists, they may not see it    → 403, naming the rule
   *   · they have no identity of their own → 403 with the specific reason,
   *     because "export my own data" failing for a telecaller who was never
   *     linked to a handset is a provisioning gap, not a permission decision,
   *     and saying "not permitted" sends them to the wrong person.
   *
   * The 404-before-403 ordering leaks only that an id is unused, which a
   * caller who can enumerate `/exports/people` already knows for everyone they
   * may see; the alternative - 403 for a non-existent id - makes a stale
   * picker indistinguishable from a permission problem.
   */
  private async resolveSubject(
    client: QueryClient,
    req: PrincipalRequest,
    subjectTelecallerId: string,
  ): Promise<{ telecallerId: string; userId: string | null; displayName: string }> {
    const principal = req.principal ?? throwUnauthenticated();
    const person = await loadPerson(client, subjectTelecallerId);
    if (!person) {
      throw new NotFoundException("that person is not an active member of this workspace");
    }

    const visibility = await resolvePeopleVisibility(client, {
      userId: principal.userId,
      ownerRole: principal.ownerRole,
      viaAdminKey: principal.viaAdminKey,
    });

    if (!visibilityAllowsTelecaller(visibility, subjectTelecallerId)) {
      if (visibility.kind === "own" && visibility.telecallerId === null) {
        throw new ForbiddenException(
          "you are not linked to a telecaller identity, so there is no work to export - ask an owner to link you on the Team page",
        );
      }
      throw new ForbiddenException(
        visibility.kind === "own"
          ? "you may export only your own work"
          : "that person is not in your branch of the organization chart",
      );
    }
    return person;
  }

  /**
   * The grants frozen into the job (SS4.2).
   *
   * The worker re-reads all of this and runs under the INTERSECTION, so this is
   * a CEILING rather than an authorisation: nothing here can widen what the
   * worker will do.
   */
  private async scopeSnapshot(
    client: QueryClient,
    req: PrincipalRequest,
    granted: ExportDataset[],
    subject: { telecallerId: string; userId: string | null; displayName: string } | null,
  ): Promise<Record<string, unknown>> {
    const principal = req.principal ?? throwUnauthenticated();
    const scope = (req as PrincipalRequest & { ownerScope?: OwnerRecordScope }).ownerScope;
    const grid: Record<string, string> = {};
    for (const dataset of granted) {
      if (!dataset.object) continue;
      const grant = await this.gridGrant(client, principal.userId, dataset);
      if (grant) grid[dataset.object] = grant;
    }
    return {
      ownerRole: scope?.role ?? null,
      ownerScopeKind: scope?.scope ?? "all",
      telecallerId: scope?.telecallerId ?? null,
      userId: principal.userId,
      grid,
      canExportRecordings: principalHasPermission(principal, "recordings:export"),
      // The subject as authorized at enqueue (0188). The worker re-resolves
      // visibility rather than trusting this, so it is a CEILING like
      // everything else here: the worker takes the narrower of the two and a
      // subject that has since left the caller's branch stops the job.
      subject: subject
        ? { telecallerId: subject.telecallerId, userId: subject.userId }
        : null,
    };
  }

  /**
   * The owner alert (SS4.5) - every export, whatever its scope, at CREATION.
   *
   * Never to the person who ran it. Without that suppression an owner who
   * exports four reports in a morning gets four notifications about themselves,
   * learns the kind is noise, and mutes it - taking the alert about everybody
   * else with it.
   *
   * No link to the artifact and no download affordance: `linkPath` goes to the
   * exports centre, which shows the job's metadata. The download route's
   * ownership check is unchanged by this, so an owner learns that an export
   * happened, not what was in it.
   */
  private async alertOwners(
    tx: QueryClient,
    orgId: string,
    jobId: string,
    body: z.infer<typeof CreateBody>,
    granted: ExportDataset[],
    requesterId: string,
  ): Promise<void> {
    const { rows: owners } = await tx.query<{ user_id: string }>(
      // COALESCE, not `m.owner_role = 'owner'`: a null persona IS the owner
      // persona (resolveOwnerRole), and `members.controller.ts` - the operator
      // console's member writer - deliberately never sets that column, so every
      // membership it has created since 0018 has it null. The plain comparison
      // told none of those people, silently.
      `SELECT DISTINCT m.user_id
         FROM memberships m
        WHERE COALESCE(m.owner_role, 'owner') = 'owner' AND m.user_id <> $1`,
      [requesterId],
    );
    if (owners.length === 0) return;

    const { rows: who } = await tx.query<{ name: string | null; email: string }>(
      `SELECT name, email FROM users WHERE id = $1`,
      [requesterId],
    );
    const actor = who[0]?.name ?? who[0]?.email ?? "Somebody";
    const what =
      body.scope === "view"
        ? `This view - ${granted[0].label}`
        : body.scope === "section"
          ? `Everything in ${body.section}`
          : "The whole workspace";

    // `linkPath` carries NO `/admin` prefix: the console is served under that
    // basePath in production and `next/link` adds it, so a stored path saying
    // `/admin/...` is prefixed twice and 404s. Invisible in local dev.
    await tx.query(
      `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path)
       SELECT $1, u, 'export_created', $3, $4, $5 FROM unnest($2::uuid[]) AS u`,
      [
        orgId,
        owners.map((o) => o.user_id),
        `${actor} started an export`.slice(0, 200),
        `${what} - ${granted.length} dataset${granted.length === 1 ? "" : "s"} - ${body.format.toUpperCase()}`.slice(
          0,
          1000,
        ),
        `/owner/account/data?job=${jobId}`,
      ],
    );
    // Whether this rings now or waits for the digest is the database's
    // decision via 0109's trigger; the policy that decides which it should be
    // is `ownerAlertIsInstant`, kept as a pure function so it is testable and
    // arguable without a notification.
    void ownerAlertIsInstant(body.scope, granted);
  }

  private async loadJob(client: QueryClient, id: string): Promise<Record<string, unknown>> {
    const { rows } = await client.query(`SELECT * FROM export_jobs WHERE id = $1`, [id]);
    if (rows.length === 0) throw new NotFoundException("export not found");
    return rows[0] as Record<string, unknown>;
  }
}

/** 5 minutes. Short because it is re-signed on every click. */
const EXPORT_DOWNLOAD_TTL_SECONDS = 300;

/**
 * Whether the acting identity is a real user.
 *
 * An export is OWNED by a person - the job row's `requested_by_user_id` is a
 * NOT NULL FK, the worker re-resolves that person's grants, and the download is
 * theirs alone. A caller with no resolvable user has nobody to own it, so there
 * is nothing sensible to write; refusing is both correct and the only thing the
 * schema permits.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isOwner(req: PrincipalRequest): boolean {
  const scope = (req as PrincipalRequest & { ownerScope?: OwnerRecordScope }).ownerScope;
  return scope?.role === "owner" || req.principal?.role === "org_admin";
}

function throwUnauthenticated(): never {
  // Guard order is wrong - this ran before AdminKeyGuard. Same reasoning and
  // status as TenantGuard's equivalent branch: a configuration bug.
  throw new ForbiddenException("authentication required");
}

