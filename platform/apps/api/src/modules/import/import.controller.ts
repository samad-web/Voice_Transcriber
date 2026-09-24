import { createHash } from "node:crypto";
import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, ParseUUIDPipe, Post, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import { z } from "zod";
import {
  DedupeStrategy,
  entryStage,
  IMPORT_MAX_ROWS,
  ImportEntity,
  mapRow,
  REQUIRED_FIELDS,
  resolveOwnerRole,
  statusForStage,
  suggestMapping,
} from "@aura/shared";
import { importPhone } from "@aura/shared/dist/import-phone";
import type { CountryCode, E164Phone } from "@aura/shared/dist/phone";
import { findLiveContact, recordDealEntry, resolveDealPipeline } from "@aura/db";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { orgPhoneCountry } from "../../common/console-phone";
import { OperatorMayCall, OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { AuthService } from "../auth/auth.service";
import { toCsv } from "../reports/csv";

const MAX_ROWS = IMPORT_MAX_ROWS;

const PreviewBody = z.object({
  entity: ImportEntity,
  headers: z.array(z.string()).min(1).max(200),
});

const RunBody = z.object({
  entity: ImportEntity,
  mapping: z.record(z.string(), z.string().nullable()),
  dedupeStrategy: DedupeStrategy.default("skip"),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(MAX_ROWS),
});

type QueryClient = { query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }> };

interface RowOutcome {
  outcome: "inserted" | "updated" | "skipped" | "failed";
  error?: string;
}

/**
 * Bulk CSV import for contacts/accounts/deals (Kailash gap Milestone 2).
 *
 * Not CrmPermissionsGuard - a bulk operation spanning up to 5,000 rows of a
 * caller-chosen entity type doesn't fit a single static
 * `@RequireCrmPermission`, and this is the same administrative-bulk-operation
 * tier `scripts/backfill-crm-objects.js` already operates at, not a
 * per-record permission surface.
 *
 * ── WHO REACHES IT: THE PERSONAS THE CONSOLE SHOWS IT TO (X8) ──────────────
 *
 * It used to be AdminKeyGuard+TenantGuard and nothing else, so while the
 * console hid "Import" from telecallers and sales (apps/web/lib/nav.ts, the
 * `/owner/import` entry), the API took a 5,000-row write from any member who
 * posted to it. OwnerRoleGuard now enforces the SAME list the nav shows -
 * owner, manager, marketing ("a list bought from an event arrives as a CSV,
 * and loading it is marketing's job") - resolving the persona from
 * `memberships`, never from the request. Change one, change the other.
 *
 * `@OperatorMayCall()` keeps the bare admin key (the operator console, ops
 * scripts - no person, so no persona) working as it did before X8: the gate
 * only ever narrows what console PEOPLE can do, like every other controller
 * gated for X8. A bare-key run is audited as an 'operator', see `run`.
 *
 * The CSV itself is parsed in the browser (Papa Parse) - this only ever sees
 * already-parsed JSON rows, so there is no file-upload/multer plumbing here.
 * `POST /import/run` has its own, larger body limit: see import-body-limit.ts.
 */
@Controller("import")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@OperatorMayCall()
@RequireOwnerRole("owner", "manager", "marketing")
export class ImportController {
  constructor(
    private readonly db: DbService,
    private readonly auth: AuthService,
  ) {}

  @Post("preview")
  preview(@Body() body: unknown) {
    const parsed = PreviewBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { entity, headers } = parsed.data;
    return {
      mapping: suggestMapping(entity, headers),
      requiredFields: REQUIRED_FIELDS[entity],
    };
  }

  @Post("run")
  async run(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = RunBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { entity, mapping, dedupeStrategy, rows } = parsed.data;

    const missingRequired = REQUIRED_FIELDS[entity].filter((f) => !mapping[f]);
    if (missingRequired.length > 0) {
      throw new BadRequestException(`mapping is missing required field(s): ${missingRequired.join(", ")}`);
    }

    const createdByUserId = z.string().uuid().safeParse(req.principal?.userId);

    return this.db.withOrg(orgId, async (client) => {
      // What a phone typed without a "+" is read against - the same workspace
      // country, read the same way, as the console's lead/contact forms (X5).
      const country = entity === "contact" ? await orgPhoneCountry(client, orgId) : null;

      const {
        rows: [job],
      } = await client.query<{ id: string }>(
        `INSERT INTO import_jobs (org_id, entity, status, mapping, dedupe_strategy, total_rows, created_by_user_id)
         VALUES ($1, $2, 'running', $3::jsonb, $4, $5, $6)
         RETURNING id`,
        [orgId, entity, JSON.stringify(mapping), dedupeStrategy, rows.length, createdByUserId.success ? createdByUserId.data : null],
      );

      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      let failed = 0;

      for (let i = 0; i < rows.length; i++) {
        const mapped = mapRow(mapping, rows[i]);
        let result: RowOutcome;
        // Each row runs inside its own SAVEPOINT. A constraint violation
        // (e.g. a duplicate phone/email/domain) marks the whole surrounding
        // transaction aborted at the Postgres level even though the JS
        // exception below is caught - every statement after it, including
        // this row's own import_job_errors insert, would then fail with
        // "current transaction is aborted" unless rolled back to a point
        // before the bad statement ran.
        await client.query(`SAVEPOINT row_${i}`);
        try {
          result =
            entity === "contact"
              ? await importContactRow(client, orgId, mapped, dedupeStrategy, country ?? "IN")
              : entity === "account"
                ? await importAccountRow(client, orgId, mapped, dedupeStrategy)
                : await importDealRow(client, orgId, mapped);
          await client.query(`RELEASE SAVEPOINT row_${i}`);
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT row_${i}`);
          await client.query(`RELEASE SAVEPOINT row_${i}`);
          result = { outcome: "failed", error: err instanceof Error ? err.message : "unknown error" };
        }

        if (result.outcome === "inserted") inserted++;
        else if (result.outcome === "updated") updated++;
        else if (result.outcome === "skipped") skipped++;
        else {
          failed++;
          await client.query(
            `INSERT INTO import_job_errors (org_id, job_id, row_number, raw, error) VALUES ($1, $2, $3, $4::jsonb, $5)`,
            [orgId, job.id, i + 1, JSON.stringify(rows[i]), result.error ?? "unknown error"],
          );
        }
      }

      const {
        rows: [updatedJob],
      } = await client.query(
        `UPDATE import_jobs SET
           status = 'done', inserted_count = $2, updated_count = $3, skipped_count = $4, failed_count = $5
         WHERE id = $1
         RETURNING id, entity, status, dedupe_strategy, total_rows, inserted_count, updated_count,
                   skipped_count, failed_count, created_at`,
        [job.id, inserted, updated, skipped, failed],
      );

      // Who ran it - the shared rule every audit writer uses (doc 31 §2 X9):
      // a person by users.id, the operator console by email, and the bare
      // key with nobody named as 'system'. Never the old "dev-admin"
      // placeholder, which read like a person and named no one.
      const actor = auditActor(req);
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, $2, $3, 'import.run', 'import_job', $4)`,
        [orgId, actor.type, actor.id, job.id],
      );

      return { job: updatedJob };
    });
  }

  @Get(":jobId")
  async status(@OrgId() orgId: string, @Param("jobId", ParseUUIDPipe) jobId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [job],
      } = await client.query(
        `SELECT id, entity, status, dedupe_strategy, total_rows, inserted_count, updated_count,
                skipped_count, failed_count, created_at
           FROM import_jobs WHERE id = $1`,
        [jobId],
      );
      if (!job) throw new NotFoundException("import job not found");
      return { job };
    });
  }

  /**
   * `raw` is the row exactly as the importer typed or pasted it - phone
   * numbers and emails included, unhashed, so the failing row is fixable and
   * re-uploadable. That is real PII, so it is restricted to the person who
   * ran the import, or an owner/manager - see `assertCanViewImportErrors`,
   * inlined because it turns on THIS job's `created_by_user_id`, not a static
   * per-route role, so a class-level guard can't express it.
   */
  @Get(":jobId/errors")
  async errors(@OrgId() orgId: string, @Param("jobId", ParseUUIDPipe) jobId: string, @Req() req: PrincipalRequest) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [job],
      } = await client.query<{ id: string; created_by_user_id: string | null }>(
        `SELECT id, created_by_user_id FROM import_jobs WHERE id = $1`,
        [jobId],
      );
      if (!job) throw new NotFoundException("import job not found");
      await assertCanViewImportErrors(this.auth, req, orgId, job.created_by_user_id);

      const { rows } = await client.query(
        `SELECT row_number, raw, error FROM import_job_errors WHERE job_id = $1 ORDER BY row_number`,
        [jobId],
      );
      return { errors: rows };
    });
  }

  /** Same CSV as the report exports - one encoder for the whole codebase. */
  @Get(":jobId/errors.csv")
  async errorsCsv(@OrgId() orgId: string, @Param("jobId", ParseUUIDPipe) jobId: string, @Req() req: PrincipalRequest) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [job],
      } = await client.query<{ id: string; created_by_user_id: string | null }>(
        `SELECT id, created_by_user_id FROM import_jobs WHERE id = $1`,
        [jobId],
      );
      if (!job) throw new NotFoundException("import job not found");
      await assertCanViewImportErrors(this.auth, req, orgId, job.created_by_user_id);

      const { rows } = await client.query<{ row_number: number; raw: unknown; error: string }>(
        `SELECT row_number, raw, error FROM import_job_errors WHERE job_id = $1 ORDER BY row_number`,
        [jobId],
      );
      const csv = toCsv<{ row_number: number; raw: unknown; error: string }>(
        [
          { header: "row", value: (r) => r.row_number },
          { header: "error", value: (r) => r.error },
          { header: "raw", value: (r) => JSON.stringify(r.raw) },
        ],
        rows,
      );
      return { csv };
    });
  }
}

/**
 * The dedupe key for a phone that has ALREADY been through `importPhone` - the
 * E.164 type says so. The same three values crm-ingest.service.ts `phoneParts`
 * computes for the E.164 `consolePhone` hands it: sha256 over the E.164's
 * digits ("919876543210", no "+"), its first five digits, its last three. The
 * input has to be identical, not merely similar, or one person is two contacts
 * (X5) - import.controller.spec.ts pins it against the console's own hash.
 */
function hashPhone(e164: E164Phone): { hash: string; prefix: string; last3: string } {
  const digits = e164.replace(/\D+/gu, "");
  return {
    hash: createHash("sha256").update(digits).digest("hex"),
    prefix: digits.slice(0, 5),
    last3: digits.slice(-3),
  };
}

async function importContactRow(
  client: QueryClient,
  orgId: string,
  row: Record<string, string | null>,
  strategy: DedupeStrategy,
  country: CountryCode,
): Promise<RowOutcome> {
  const displayName = row.displayName || [row.firstName, row.lastName].filter(Boolean).join(" ").trim();
  if (!displayName) return { outcome: "failed", error: "no displayName (or first/last name) on this row" };

  // To E.164 against the workspace's country BEFORE hashing, as the console
  // does. A phone that is not a number there fails the row with the reason:
  // hashing it as typed is what gave imported contacts a key no lead, call or
  // console-created contact could ever match.
  const checked = importPhone(row.phone, country);
  if (!checked.ok) return { outcome: "failed", error: checked.message };
  const phone = checked.e164 ? hashPhone(checked.e164) : null;
  const email = row.email?.toLowerCase() || null;

  let existing: { id: string } | undefined;
  if (phone) {
    ({
      rows: [existing],
    } = await client.query(
      `SELECT id FROM contacts WHERE org_id = $1 AND phone_hash = $2 AND status <> 'merged'`,
      [orgId, phone.hash],
    ));
  }
  if (!existing && email) {
    ({
      rows: [existing],
    } = await client.query(
      `SELECT id FROM contacts WHERE org_id = $1 AND lower(email) = $2 AND status <> 'merged'`,
      [orgId, email],
    ));
  }

  if (existing) {
    if (strategy === "skip") return { outcome: "skipped" };
    if (strategy === "update") {
      await client.query(
        `UPDATE contacts SET
           display_name = COALESCE($2, display_name),
           first_name   = COALESCE($3, first_name),
           last_name    = COALESCE($4, last_name),
           email        = COALESCE($5, email),
           title        = COALESCE($6, title),
           phone_hash   = COALESCE($7, phone_hash),
           phone_prefix = COALESCE($8, phone_prefix),
           phone_last3  = COALESCE($9, phone_last3),
           last_activity_at = now()
         WHERE id = $1`,
        [existing.id, row.displayName, row.firstName, row.lastName, row.email, row.title, phone?.hash ?? null, phone?.prefix ?? null, phone?.last3 ?? null],
      );
      return { outcome: "updated" };
    }
    // strategy === "create": deliberately insert anyway; a genuine collision
    // on the (org_id, phone_hash)/(org_id, email) partial unique indexes
    // surfaces honestly as a failed row rather than silently skipping.
  }

  try {
    await client.query(
      `INSERT INTO contacts
         (org_id, first_name, last_name, display_name, email, title, phone_hash, phone_prefix, phone_last3)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [orgId, row.firstName, row.lastName, displayName, row.email, row.title, phone?.hash ?? null, phone?.prefix ?? null, phone?.last3 ?? null],
    );
    return { outcome: "inserted" };
  } catch (err) {
    // Thrown, not returned: the caller's per-row SAVEPOINT needs to see this
    // as a failure so it rolls the aborted subtransaction back.
    if (isUniqueViolation(err)) throw new Error("a contact with this phone or email already exists");
    throw err;
  }
}

async function importAccountRow(
  client: QueryClient,
  orgId: string,
  row: Record<string, string | null>,
  strategy: DedupeStrategy,
): Promise<RowOutcome> {
  if (!row.name) return { outcome: "failed", error: "no name on this row" };
  const domain = row.domain?.toLowerCase().replace(/^https?:\/\//u, "").replace(/\/.*$/u, "") || null;

  let existing: { id: string } | undefined;
  if (domain) {
    ({
      rows: [existing],
    } = await client.query(
      `SELECT id FROM accounts WHERE org_id = $1 AND lower(domain) = $2 AND status <> 'merged'`,
      [orgId, domain],
    ));
  }

  if (existing) {
    if (strategy === "skip") return { outcome: "skipped" };
    if (strategy === "update") {
      await client.query(`UPDATE accounts SET name = COALESCE($2, name), last_activity_at = now() WHERE id = $1`, [existing.id, row.name]);
      return { outcome: "updated" };
    }
  }

  try {
    await client.query(`INSERT INTO accounts (org_id, name, domain) VALUES ($1, $2, $3)`, [orgId, row.name, domain]);
    return { outcome: "inserted" };
  } catch (err) {
    // Thrown, not returned - see importContactRow's identical comment.
    if (isUniqueViolation(err)) throw new Error("an account with this domain already exists");
    throw err;
  }
}

/** Deals have no natural dedup key across a CSV - always creates. */
async function importDealRow(client: QueryClient, orgId: string, row: Record<string, string | null>): Promise<RowOutcome> {
  if (!row.name) return { outcome: "failed", error: "no name on this row" };

  // The one pipeline rule every door uses (doc 23, B2) - this was a fourth
  // variant, "any default, archived or not".
  const pipeline = await resolveDealPipeline(client, orgId, { forWrite: true });
  if (!pipeline) return { outcome: "failed", error: "org has no active pipeline" };
  const stages = pipeline.stages;

  const requestedStage = row.stage?.trim();
  const stage = requestedStage && stages.some((s) => s.key === requestedStage) ? requestedStage : entryStage(stages);
  const status = statusForStage(stages, stage);

  let contactId: string | null = null;
  let contactAccountId: string | null = null;
  if (row.contactEmail) {
    // Follows a merge to the survivor, so a deal is never filed under a
    // merged-away contact (doc 23, D2).
    const contact = await findLiveContact(client, orgId, { email: row.contactEmail });
    contactId = contact?.id ?? null;
    contactAccountId = contact?.accountId ?? null;
  }

  let accountId: string | null = null;
  if (row.accountName) {
    const {
      rows: [account],
    } = await client.query<{ id: string }>(`SELECT id FROM accounts WHERE org_id = $1 AND lower(name) = $2 AND status <> 'merged'`, [
      orgId,
      row.accountName.toLowerCase(),
    ]);
    accountId = account?.id ?? null;
  }

  const amount = row.amount ? Number(row.amount.replace(/[^0-9.]/gu, "")) : null;

  // No account column on the row? The deal inherits its contact's (doc 23, F2).
  accountId = accountId ?? contactAccountId;

  const {
    rows: [deal],
  } = await client.query<{ id: string }>(
    `INSERT INTO deals (org_id, pipeline_id, contact_id, account_id, name, stage, status, amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [orgId, pipeline.id, contactId, accountId, row.name, stage, status, Number.isFinite(amount) ? amount : null],
  );
  // The deal's first ledger row. Imported deals used to have none, so every
  // funnel report built on the ledger dropped them (doc 23, B3). No automation
  // event: a bulk import firing "deal created" once per row would bury the
  // floor in tasks, the same reason the backfill never fires them (X6).
  await recordDealEntry(client, orgId, { id: deal.id, stage, status }, "console", "csv import");
  return { outcome: "inserted" };
}

const ERRORS_FORBIDDEN = "only the person who ran this import, or an owner or manager, may view its errors";

/**
 * May this caller read a job's failed rows? The person who ran it, an owner or
 * a manager - or the bare platform admin key.
 *
 * ── WHY NOT `viaAdminKey || role === "platform_admin"` ANY MORE (X6) ────────
 *
 * That was the old first test, and it never refused anyone: the owner console
 * reaches this API with the platform admin key plus `x-caller-user-id`, and
 * admin-key.guard.ts stamps EVERY such request `viaAdminKey: true, role:
 * "platform_admin"` - so a telecaller could read another member's failed rows,
 * raw phone numbers and all. Who the caller is comes from the user id; what
 * they may do is their persona in `memberships`, read through
 * `AuthService.ownerRoleFor` exactly as OwnerRoleGuard reads it - never the
 * `x-caller-owner-role` header, which the request itself chose.
 *
 * The bare admin key (userId is the literal "admin-key": ops scripts, the
 * operator console) has no person to compare and no persona to look up, and
 * is the platform's own credential, so it may read - the same call the class's
 * `@OperatorMayCall()` makes for the whole controller.
 */
async function assertCanViewImportErrors(
  auth: Pick<AuthService, "ownerRoleFor">,
  req: PrincipalRequest,
  orgId: string,
  createdByUserId: string | null,
): Promise<void> {
  const principal = req.principal;
  if (!principal) throw new UnauthorizedException("authentication required");

  const userId = z.string().uuid().safeParse(principal.userId);
  if (!userId.success) {
    if (principal.viaAdminKey && principal.userId === "admin-key") return;
    throw new ForbiddenException(ERRORS_FORBIDDEN);
  }
  if (createdByUserId && userId.data === createdByUserId) return;

  // A Bearer session's ownerRole was read from memberships when its token was
  // resolved; an admin-key caller's must be looked up. No active membership in
  // THIS org is no persona at all - refused, not defaulted to "owner".
  let ownerRole = principal.ownerRole;
  if (principal.viaAdminKey) {
    const resolved = await auth.ownerRoleFor(userId.data, orgId);
    if (resolved === undefined) throw new ForbiddenException(ERRORS_FORBIDDEN);
    ownerRole = resolved;
  }
  const persona = resolveOwnerRole(ownerRole);
  if (persona === "owner" || persona === "manager") return;
  throw new ForbiddenException(ERRORS_FORBIDDEN);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
