import { randomBytes } from "node:crypto";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Header,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import {
  bindTemplate,
  blankDoc,
  nextRunAt,
  ReportDoc,
  ScheduleInput,
  toTemplateDoc,
  type ResultRow,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, type CrmRecordScope } from "../../common/crm-scope";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { safeFilename, toCsv, type CsvColumn } from "../reports/csv";
import { ReportBuilderService } from "./report-builder.service";

/**
 * The Report Builder (migration 0077).
 *
 * ── WHY NOT `/reports` ─────────────────────────────────────────────────
 *
 * `ReportsController` already owns that prefix, and its `GET :report/export`
 * would swallow every path segment added under it. Two controllers on one
 * prefix where one has a greedy param is a routing bug waiting for the next
 * person; a separate prefix costs nothing and cannot collide.
 *
 * ── PERMISSIONS: TWO LAYERS ────────────────────────────────────────────
 *
 * `CrmPermissionsGuard` gates the whole controller on `deal:view` (design doc
 * D7) - the class-level decorator, so a route added later cannot forget it -
 * and each handler additionally resolves a per-report share role through
 * `ReportBuilderService.access()`. The record scope from the first layer flows
 * all the way into every widget's SQL, so an `owned`-scoped rep charting deals
 * charts THEIR deals, in the editor, in the CSV, and in a scheduled run.
 *
 * CSV export is the one route that raises the requirement to `deal:export`,
 * matching `ReportsController` exactly: reading a number on screen and walking
 * out with the rows behind it are different acts.
 */
@Controller("report-builder")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
@RequireCrmPermission("deal", "view")
export class ReportBuilderController {
  constructor(
    private readonly db: DbService,
    private readonly reports: ReportBuilderService,
  ) {}

  // ── the list ──────────────────────────────────────────────────────────

  /**
   * Every report this person can reach - theirs, plus anything shared with
   * them. Deliberately NOT "every report in the org": a report is a document
   * with an author, and a list that showed everyone's drafts would make the
   * draft/published split pointless.
   */
  @Get()
  async list(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    const userId = actorUserId(req);
    const { rows } = await this.db.withOrg(orgId, (client) =>
      client.query(
        `SELECT r.id, r.name, r.description, r.status, r.published_at, r.published_version,
                r.updated_at, r.created_at, r.public_token IS NOT NULL AS has_link,
                u.name AS created_by_name,
                COALESCE(s.role, CASE WHEN r.created_by = $2 THEN 'owner' END) AS role,
                (SELECT count(*) FROM report_schedules sc
                  WHERE sc.report_id = r.id AND sc.active)::int AS active_schedules
           FROM reports r
           LEFT JOIN users u        ON u.id = r.created_by
           LEFT JOIN report_shares s ON s.report_id = r.id AND s.user_id = $2
          WHERE r.org_id = $1 AND r.status <> 'archived'
            AND (r.created_by = $2 OR s.user_id IS NOT NULL)
          ORDER BY r.updated_at DESC`,
        [orgId, userId],
      ),
    );
    return { reports: rows };
  }

  // ── templates (prompt 3.5 / 3.5.1) ────────────────────────────────────

  /**
   * The starter library plus the tenant's own, in one list.
   *
   * `org_id IS NULL` rows are platform-provided and visible to every tenant -
   * migration 0077's RLS policy allows reading them and forbids writing one,
   * so this needs no filter of its own to stay safe.
   */
  @Get("templates")
  async templates(@OrgId() orgId: string) {
    const { rows } = await this.db.withOrg(orgId, (client) =>
      client.query(
        `SELECT id, org_id IS NULL AS is_global, key, name, description, category,
                dataset_roles, sort_order
           FROM report_templates
          WHERE active AND (org_id IS NULL OR org_id = $1)
          ORDER BY org_id IS NOT NULL, sort_order, lower(name)`,
        [orgId],
      ),
    );
    return { templates: rows };
  }

  /** Save an existing report as a reusable template (data bindings stripped). */
  @Post("templates")
  async saveTemplate(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = SaveTemplate.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { reportId, name, description, category } = parsed.data;

    const userId = actorUserId(req);
    const access = await this.reports.access(orgId, reportId, userId);
    // Editor, not owner: turning your work into a template is authoring, not
    // administration, and it takes nothing away from anyone.
    this.reports.requireRole(access, "editor");

    const report = await this.loadReport(orgId, reportId);
    const doc = parseDoc(report.published_doc ?? report.draft_doc);

    // Roles are named after the dataset they came from - the CRM source key, or
    // a slug of the upload's name - so the person instantiating this template
    // is asked for "deals", not for "the dataset that was 3f9c-…".
    const roleByDataset = await this.datasetRoles(orgId, doc);
    const templateDoc = toTemplateDoc(doc, (id) => roleByDataset[id]?.role ?? "data");
    const roles = Object.values(roleByDataset);

    return this.db.withOrg(orgId, async (client) => {
      try {
        const {
          rows: [template],
        } = await client.query(
          `INSERT INTO report_templates
             (org_id, key, name, description, category, doc, dataset_roles, created_by)
           VALUES ($1, $2, btrim($3), $4, $5, $6::jsonb, $7::jsonb, $8)
           RETURNING id, key, name, description, category, dataset_roles, sort_order`,
          [
            orgId,
            slug(name),
            name,
            description ?? null,
            category ?? "custom",
            JSON.stringify(templateDoc),
            JSON.stringify(roles),
            userId,
          ],
        );
        await this.reports.audit(client, orgId, userId, "report.template_create", template.id, {
          fromReport: reportId,
        });
        return { template };
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictException(`a template named "${name}" already exists`);
        }
        throw err;
      }
    });
  }

  // ── palettes (prompt 3.3) ─────────────────────────────────────────────

  @Get("palettes")
  async palettes(@OrgId() orgId: string) {
    const { rows } = await this.db.withOrg(orgId, (client) =>
      client.query(
        `SELECT id, name, colors, background FROM report_palettes
          WHERE org_id = $1 ORDER BY lower(name)`,
        [orgId],
      ),
    );
    return { palettes: rows };
  }

  @Post("palettes")
  async createPalette(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = PaletteInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { name, colors, background } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      try {
        const {
          rows: [palette],
        } = await client.query(
          `INSERT INTO report_palettes (org_id, name, colors, background, created_by)
           VALUES ($1, btrim($2), $3::jsonb, $4, $5)
           RETURNING id, name, colors, background`,
          [orgId, name, JSON.stringify(colors), background ?? null, actorUserId(req)],
        );
        return { palette };
      } catch (err) {
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictException(`a palette named "${name}" already exists`);
        }
        throw err;
      }
    });
  }

  // ── one report ────────────────────────────────────────────────────────

  @Post()
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = CreateReport.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const userId = actorUserId(req);

    let doc = blankDoc();
    let templateId: string | null = null;

    if (input.templateId) {
      const { rows } = await this.db.withOrg(orgId, (client) =>
        client.query<{ id: string; doc: unknown }>(
          `SELECT id, doc FROM report_templates
            WHERE id = $1 AND active AND (org_id IS NULL OR org_id = $2)`,
          [input.templateId, orgId],
        ),
      );
      const template = rows[0];
      if (!template) throw new NotFoundException("template not found");
      templateId = template.id;
      // Bind whatever roles the caller supplied. Unfilled roles are LEFT
      // unbound rather than dropped, so the canvas can walk the user into the
      // mapping step with the placeholders intact (prompt 3.5.1).
      doc = bindTemplate(parseDoc(template.doc), input.datasetByRole ?? {});
    }

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [report],
      } = await client.query(
        `INSERT INTO reports (org_id, name, description, draft_doc, created_by, source_template_id)
         VALUES ($1, btrim($2), $3, $4::jsonb, $5, $6)
         RETURNING id, name, description, status, revision, created_at`,
        [orgId, input.name, input.description ?? null, JSON.stringify(doc), userId, templateId],
      );

      // The creator gets an explicit owner row as well as being `created_by`.
      // Belt and braces on purpose: `created_by` is provenance and share rows
      // are policy, and a share list that does not show the author is a share
      // list somebody will "fix" by removing their access.
      if (userId) {
        await client.query(
          `INSERT INTO report_shares (org_id, report_id, user_id, role, granted_by)
           VALUES ($1, $2, $3, 'owner', $3) ON CONFLICT DO NOTHING`,
          [orgId, report.id, userId],
        );
      }
      await this.reports.audit(client, orgId, userId, "report.create", report.id, {
        templateId,
      });
      return { report: { ...report, doc } };
    });
  }

  @Get(":id")
  async detail(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("token") token: string | undefined,
    @Req() req: PrincipalRequest,
  ) {
    const userId = actorUserId(req);
    const access = await this.reports.access(orgId, id, userId, token);
    const report = await this.loadReport(orgId, id);

    // A viewer sees the PUBLISHED document and nothing else. Handing them the
    // draft would make publishing decorative - see design doc D9.
    const doc = access.role === "viewer" ? report.published_doc : report.draft_doc;
    if (!doc) {
      throw new NotFoundException("this report has not been published yet");
    }
    const parsedDoc = parseDoc(doc);

    return {
      report: {
        id: report.id,
        name: report.name,
        description: report.description,
        status: report.status,
        revision: report.revision,
        publishedVersion: report.published_version,
        publishedAt: report.published_at,
        hasLink: report.public_token !== null,
        role: access.role,
      },
      doc: parsedDoc,
      // Computed on every load rather than stored: a dataset can change shape
      // without anyone touching the report, so a cached answer would be stale
      // exactly when it mattered (prompt 3.2, acceptance criterion 7).
      issues: await this.reports.bindingIssues(orgId, parsedDoc),
    };
  }

  /**
   * Autosave.
   *
   * `revision` is an optimistic lock: the editor sends the revision it loaded,
   * and a mismatch is a 409 rather than a silent overwrite. Full multi-user
   * collaboration is explicitly out of scope for v1 (prompt section 7); this
   * is the cheap half that stops one person's afternoon being eaten by
   * another's second tab.
   */
  @Patch(":id")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = UpdateReport.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;

    const access = await this.reports.access(orgId, id, actorUserId(req));
    this.reports.requireRole(access, "editor");

    const sets = ["revision = revision + 1"];
    const params: unknown[] = [id, input.revision];
    const set = (column: string, value: unknown, cast = "") => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if (input.name !== undefined) set("name", input.name);
    if (input.description !== undefined) set("description", input.description);
    if (input.doc !== undefined) set("draft_doc", JSON.stringify(input.doc), "::jsonb");

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [report],
      } = await client.query<{ id: string; revision: number; updated_at: string }>(
        `UPDATE reports SET ${sets.join(", ")}
          WHERE id = $1 AND revision = $2
          RETURNING id, revision, updated_at`,
        params,
      );
      if (!report) {
        // Either the row is gone or somebody else saved first. Distinguishing
        // them costs a second query and changes nothing the editor can do -
        // both mean "reload before you save again".
        throw new ConflictException(
          "This report changed somewhere else since you opened it. Reload to get the latest version - your unsaved changes are still in this tab.",
        );
      }
      return { report };
    });
  }

  /** Draft -> published. The only thing that changes what a viewer sees. */
  @Post(":id/publish")
  async publish(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const userId = actorUserId(req);
    const access = await this.reports.access(orgId, id, userId);
    this.reports.requireRole(access, "editor");

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [report],
      } = await client.query(
        `UPDATE reports
            SET published_doc = draft_doc,
                published_version = published_version + 1,
                published_at = now(),
                published_by = $2,
                status = 'published',
                revision = revision + 1
          WHERE id = $1
          RETURNING id, published_version, published_at, status, revision`,
        [id, userId],
      );
      if (!report) throw new NotFoundException("report not found");
      await this.reports.audit(client, orgId, userId, "report.publish", id, {
        version: report.published_version,
      });
      return { report };
    });
  }

  @Delete(":id")
  async archive(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const userId = actorUserId(req);
    const access = await this.reports.access(orgId, id, userId);
    this.reports.requireRole(access, "owner");

    return this.db.withOrg(orgId, async (client) => {
      // ARCHIVE, not DELETE. A report is somebody's work and it may be the
      // reference behind a decision already taken; the schedules stop, the
      // link dies, and the document survives. Same call `crm_projects` makes.
      await client.query(
        `UPDATE reports SET status = 'archived', public_token = NULL WHERE id = $1`,
        [id],
      );
      await client.query(`UPDATE report_schedules SET active = false WHERE report_id = $1`, [id]);
      await this.reports.audit(client, orgId, userId, "report.archive", id);
      return { archived: true };
    });
  }

  // ── sharing (prompt 3.4) ──────────────────────────────────────────────

  @Get(":id/shares")
  async shares(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    await this.reports.access(orgId, id, actorUserId(req));
    const { rows } = await this.db.withOrg(orgId, (client) =>
      client.query(
        `SELECT s.user_id, s.role, u.name, u.email
           FROM report_shares s JOIN users u ON u.id = s.user_id
          WHERE s.report_id = $1 ORDER BY u.name NULLS LAST, u.email`,
        [id],
      ),
    );
    return { shares: rows };
  }

  /**
   * Replace the whole share list. Owner only - the prompt (AC 10) is explicit
   * that an editor may edit but not change access.
   */
  @Put(":id/shares")
  async setShares(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = SharesInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const userId = actorUserId(req);
    const access = await this.reports.access(orgId, id, userId);
    this.reports.requireRole(access, "owner");

    const shares = parsed.data.shares;
    if (userId && !shares.some((s) => s.userId === userId && s.role === "owner")) {
      // Removing your own ownership in the same request that sets the list is
      // how a report ends up with no owner and nobody able to fix it. Refused
      // rather than silently re-added, because the person may have meant to
      // hand it over - which is a different, deliberate action.
      throw new BadRequestException(
        "You cannot remove your own owner access here. Make someone else an owner first, then have them remove you.",
      );
    }

    // Every recipient must be a member of THIS org. Without the check, a valid
    // uuid from another tenant would be granted access to this report - the
    // exact cross-tenant path acceptance criterion 9 forbids.
    const memberIds = await this.orgMemberIds(
      orgId,
      shares.map((s) => s.userId),
    );
    const stranger = shares.find((s) => !memberIds.has(s.userId));
    if (stranger) {
      throw new BadRequestException("One of those people is not a member of this workspace.");
    }

    return this.db.withOrg(orgId, async (client) => {
      await client.query(`DELETE FROM report_shares WHERE report_id = $1`, [id]);
      for (const share of shares) {
        await client.query(
          `INSERT INTO report_shares (org_id, report_id, user_id, role, granted_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [orgId, id, share.userId, share.role, userId],
        );
      }
      await this.reports.audit(client, orgId, userId, "report.shares_update", id, {
        count: shares.length,
      });
      return { shares };
    });
  }

  /**
   * Mint or revoke the read-only link.
   *
   * ── A DEVIATION FROM THE PROMPT, STATED ────────────────────────────────
   *
   * The prompt asks for a "shareable link ... tenant-permission-aware". This
   * link is NOT anonymous: opening it still requires a signed-in session that
   * resolves to THIS org. What it grants is read-only access to the published
   * report without needing a `report_shares` row - so "send it to the whole
   * team" is one URL instead of twelve share entries.
   *
   * An unauthenticated link would mean a new endpoint serving tenant data to
   * anyone holding a URL, and a URL leaks: it goes into chat logs, forwarded
   * mail and browser history. That is a decision for the platform's owner to
   * take deliberately, not one to arrive as a side effect of a report feature.
   *
   * Revoking sets the token to NULL, so an old URL is dead forever rather than
   * reusable - a re-mint produces new bytes.
   */
  @Put(":id/link")
  async setLink(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = z.object({ enabled: z.boolean() }).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const userId = actorUserId(req);
    const access = await this.reports.access(orgId, id, userId);
    this.reports.requireRole(access, "owner");
    if (parsed.data.enabled && access.status !== "published") {
      throw new BadRequestException("Publish the report before sharing a link to it.");
    }

    const token = parsed.data.enabled ? randomBytes(32).toString("base64url") : null;
    return this.db.withOrg(orgId, async (client) => {
      await client.query(`UPDATE reports SET public_token = $2 WHERE id = $1`, [id, token]);
      await this.reports.audit(
        client,
        orgId,
        userId,
        parsed.data.enabled ? "report.link_create" : "report.link_revoke",
        id,
      );
      return { token };
    });
  }

  // ── schedules (prompt 3.6, design doc D6) ─────────────────────────────

  @Get(":id/schedules")
  async schedules(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    await this.reports.access(orgId, id, actorUserId(req));
    const { rows } = await this.db.withOrg(orgId, (client) =>
      client.query(
        `SELECT id, cadence, day_of_week, day_of_month, hour_utc, recipients, active,
                next_run_at, last_run_at
           FROM report_schedules WHERE report_id = $1 ORDER BY created_at`,
        [id],
      ),
    );
    return { schedules: rows };
  }

  @Post(":id/schedules")
  async createSchedule(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = ScheduleInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;

    const userId = actorUserId(req);
    const access = await this.reports.access(orgId, id, userId);
    this.reports.requireRole(access, "owner");
    if (access.status !== "published") {
      // A schedule reads `published_doc`, so scheduling an unpublished report
      // would deliver nothing, forever, silently.
      throw new BadRequestException("Publish the report before scheduling it.");
    }

    // SAFETY RULE 3 (design doc D6). Recipients are user ids and they must be
    // members of this org - this is the check that makes "nothing automated
    // sends" true rather than aspirational, because a recipient who is not a
    // member has no notification inbox for this tenant at all.
    const memberIds = await this.orgMemberIds(orgId, input.recipients);
    const stranger = input.recipients.find((r) => !memberIds.has(r));
    if (stranger) {
      throw new BadRequestException(
        "A report can only be delivered to members of this workspace. Notifications appear in their console - nothing is emailed or messaged out.",
      );
    }

    const due = nextRunAt(input);
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [schedule],
      } = await client.query(
        `INSERT INTO report_schedules
           (org_id, report_id, cadence, day_of_week, day_of_month, hour_utc,
            recipients, active, next_run_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8, $9, $10)
         RETURNING id, cadence, day_of_week, day_of_month, hour_utc, recipients, active, next_run_at`,
        [
          orgId,
          id,
          input.cadence,
          input.dayOfWeek ?? null,
          input.dayOfMonth ?? null,
          input.hourUtc,
          input.recipients,
          input.active,
          due.toISOString(),
          userId,
        ],
      );
      await this.reports.audit(client, orgId, userId, "report.schedule_create", id, {
        cadence: input.cadence,
        recipients: input.recipients.length,
      });
      return { schedule };
    });
  }

  @Delete(":id/schedules/:scheduleId")
  async deleteSchedule(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("scheduleId", ParseUUIDPipe) scheduleId: string,
    @Req() req: PrincipalRequest,
  ) {
    const userId = actorUserId(req);
    const access = await this.reports.access(orgId, id, userId);
    this.reports.requireRole(access, "owner");

    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM report_schedules WHERE id = $1 AND report_id = $2`,
        [scheduleId, id],
      );
      if (!rowCount) throw new NotFoundException("schedule not found");
      await this.reports.audit(client, orgId, userId, "report.schedule_delete", id);
      return { deleted: true };
    });
  }

  // ── running ───────────────────────────────────────────────────────────

  /**
   * Render every widget live and return the result WITHOUT storing it.
   *
   * What the print route and the shared read-only view use. Not persisted,
   * because a person opening a report is asking for today's numbers - only a
   * SCHEDULED run freezes an answer, and that distinction is the whole reason
   * `report_runs` is allowed to hold data at all.
   */
  @Post(":id/render")
  async render(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query("token") token: string | undefined,
    @RecordScope() recordScope: CrmRecordScope,
    @Req() req: PrincipalRequest,
  ) {
    const access = await this.reports.access(orgId, id, actorUserId(req), token);
    const report = await this.loadReport(orgId, id);
    const source = access.role === "viewer" ? report.published_doc : report.draft_doc;
    if (!source) throw new NotFoundException("this report has not been published yet");

    const doc = parseDoc(source);
    const { snapshot, failures } = await this.reports.renderSnapshot(orgId, doc, recordScope);
    return { snapshot, failures, name: report.name };
  }

  /** Run now and KEEP it - a manual counterpart to the scheduled run. */
  @Post(":id/runs")
  async run(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @RecordScope() recordScope: CrmRecordScope,
    @Req() req: PrincipalRequest,
  ) {
    const userId = actorUserId(req);
    const access = await this.reports.access(orgId, id, userId);
    this.reports.requireRole(access, "editor");

    const report = await this.loadReport(orgId, id);
    const doc = parseDoc(report.published_doc ?? report.draft_doc);
    const { snapshot, failures } = await this.reports.renderSnapshot(orgId, doc, recordScope);

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [run],
      } = await client.query(
        `INSERT INTO report_runs (org_id, report_id, status, snapshot, error, recipients, finished_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, ARRAY[$6]::uuid[], now())
         RETURNING id, status, started_at, finished_at`,
        [
          orgId,
          id,
          failures.length === 0 ? "succeeded" : "partial",
          JSON.stringify(snapshot),
          failures.length > 0 ? failures.join("; ") : null,
          userId,
        ],
      );
      return { run, failures };
    });
  }

  @Get(":id/runs")
  async runs(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    await this.reports.access(orgId, id, actorUserId(req));
    const { rows } = await this.db.withOrg(orgId, (client) =>
      client.query(
        // The snapshot is deliberately NOT selected: it can be megabytes, and a
        // list of runs needs their metadata, not their contents.
        `SELECT id, status, error, started_at, finished_at, schedule_id
           FROM report_runs WHERE report_id = $1
          ORDER BY started_at DESC LIMIT 50`,
        [id],
      ),
    );
    return { runs: rows };
  }

  @Get(":id/runs/:runId")
  async runDetail(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("runId", ParseUUIDPipe) runId: string,
    @Req() req: PrincipalRequest,
  ) {
    const userId = actorUserId(req);
    await this.reports.access(orgId, id, userId);
    const { rows } = await this.db.withOrg(orgId, (client) =>
      client.query<{
        id: string;
        status: string;
        snapshot: unknown;
        error: string | null;
        started_at: string;
        recipients: string[];
      }>(
        `SELECT id, status, snapshot, error, started_at, recipients
           FROM report_runs WHERE id = $1 AND report_id = $2`,
        [runId, id],
      ),
    );
    const run = rows[0];
    if (!run) throw new NotFoundException("run not found");

    // A snapshot outlives the permission state it was taken under (migration
    // 0077's report_runs header). Re-checking against the report's LIVE access
    // is what keeps an old run from becoming a back door: `access()` above
    // already threw for anyone without current access.
    return { run };
  }

  // ── widget data export (prompt 3.6, AC 14) ────────────────────────────

  /**
   * A widget's underlying, post-transformation rows as CSV.
   *
   * The query is read from the STORED document by widget id, never accepted
   * from the request. That is what makes acceptance criterion 14 - "matches
   * what's visually rendered" - a property rather than a hope: there is
   * exactly one query, run through the same service method the chart uses.
   *
   * `deal:export`, not `deal:view`. Overriding the class-level decorator, the
   * same split ReportsController documents at length: seeing a chart and
   * walking out with the rows behind it are different acts.
   */
  @Get(":id/widgets/:widgetId/export")
  @RequireCrmPermission("deal", "export")
  @Header("Cache-Control", "no-store")
  async exportWidget(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Param("widgetId") widgetId: string,
    @RecordScope() recordScope: CrmRecordScope,
    @Req() req: PrincipalRequest,
    @Res() res: Response,
  ): Promise<void> {
    const access = await this.reports.access(orgId, id, actorUserId(req));
    // A viewer may read the report but not extract its data - that is what the
    // Viewer role means, and `deal:export` alone does not override it.
    this.reports.requireRole(access, "editor");

    const report = await this.loadReport(orgId, id);
    const doc = parseDoc(report.published_doc ?? report.draft_doc);

    const widget = doc.pages.flatMap((p) => p.widgets).find((w) => w.id === widgetId);
    if (!widget) throw new NotFoundException("widget not found");
    if (!widget.datasetId || !widget.query) {
      throw new BadRequestException("this widget has no data mapped to it yet");
    }

    const result = await this.reports.exportRows(
      orgId,
      widget.datasetId,
      widget.query,
      recordScope,
    );
    if (result.error) throw new BadRequestException(result.error);

    const keys = [...result.dimensionKeys, ...result.measureKeys];
    const columns: Array<CsvColumn<ResultRow>> = keys.map((key) => ({
      header: key,
      value: (row) => row[key] ?? "",
    }));

    res
      .status(200)
      .setHeader("Content-Type", "text/csv; charset=utf-8")
      .setHeader(
        "Content-Disposition",
        `attachment; filename="${safeFilename(`${report.name}-${widget.title ?? widgetId}`)}.csv"`,
      )
      .send(toCsv(columns, result.rows));
  }

  // ── shared helpers ────────────────────────────────────────────────────

  private async loadReport(orgId: string, id: string) {
    const { rows } = await this.db.withOrg(orgId, (client) =>
      client.query<{
        id: string;
        name: string;
        description: string | null;
        status: string;
        revision: number;
        published_version: number;
        published_at: string | null;
        public_token: string | null;
        draft_doc: unknown;
        published_doc: unknown;
      }>(
        `SELECT id, name, description, status, revision, published_version, published_at,
                public_token, draft_doc, published_doc
           FROM reports WHERE id = $1`,
        [id],
      ),
    );
    const report = rows[0];
    if (!report) throw new NotFoundException("report not found");
    return report;
  }

  /** Which of these user ids actually hold a membership in this org. */
  private async orgMemberIds(orgId: string, userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const { rows } = await this.db.withOrg(orgId, (client) =>
      client.query<{ user_id: string }>(
        `SELECT user_id FROM memberships WHERE org_id = $1 AND user_id = ANY($2::uuid[])`,
        [orgId, userIds],
      ),
    );
    return new Set(rows.map((r) => r.user_id));
  }

  /** dataset id -> the role name a template should ask for it under. */
  private async datasetRoles(orgId: string, doc: ReportDoc) {
    const ids = new Set<string>();
    for (const page of doc.pages) {
      for (const widget of page.widgets) if (widget.datasetId) ids.add(widget.datasetId);
    }
    const out: Record<
      string,
      { role: string; label: string; hint: string; suggestedSourceKey?: string }
    > = {};
    for (const id of ids) {
      try {
        const dataset = await this.reports.dataset(orgId, id);
        const role = dataset.source_key ?? slug(dataset.name);
        out[id] = {
          role,
          label: dataset.name,
          hint: `A data source shaped like "${dataset.name}"`,
          ...(dataset.source_key ? { suggestedSourceKey: dataset.source_key } : {}),
        };
      } catch {
        // A widget pointing at a deleted dataset: it becomes an unnamed role
        // rather than blocking the whole save.
        out[id] = { role: "data", label: "Data", hint: "Any data source" };
      }
    }
    return out;
  }
}

// ── input shapes ───────────────────────────────────────────────────────────

const CreateReport = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  templateId: z.string().uuid().optional(),
  /** role -> dataset id, for a template being instantiated (design doc D4). */
  datasetByRole: z.record(z.string().max(60), z.string().uuid()).optional(),
});

const UpdateReport = z.object({
  /** The revision the editor loaded. Mismatch = 409, never a silent overwrite. */
  revision: z.number().int().nonnegative(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).nullish(),
  doc: ReportDoc.optional(),
});

const SaveTemplate = z.object({
  reportId: z.string().uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).optional(),
  category: z.string().max(40).optional(),
});

const SharesInput = z.object({
  shares: z
    .array(
      z.object({
        userId: z.string().uuid(),
        role: z.enum(["owner", "editor", "viewer"]),
      }),
    )
    .max(100),
});

const PaletteInput = z.object({
  name: z.string().min(1).max(80),
  colors: z
    .array(z.string().regex(/^#[0-9a-fA-F]{6}$/u, "expected #rrggbb"))
    .min(1)
    .max(12),
  background: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/u)
    .nullish(),
});

// ── helpers ────────────────────────────────────────────────────────────────

function actorUserId(req: PrincipalRequest): string | null {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}

/**
 * Parse a stored document.
 *
 * Throws rather than returning a blank one: a document that will not parse is
 * a bug we need to hear about, and silently substituting an empty canvas would
 * present itself to the user as "my report is gone".
 */
function parseDoc(raw: unknown): ReportDoc {
  const parsed = ReportDoc.safeParse(raw);
  if (!parsed.success) {
    throw new BadRequestException(
      "This report's layout could not be read. It may have been saved by a newer version of the console.",
    );
  }
  return parsed.data;
}

/** A template key from a display name. Matches crm_projects' key CHECK. */
function slug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60);
  return base || `template-${randomBytes(4).toString("hex")}`;
}
