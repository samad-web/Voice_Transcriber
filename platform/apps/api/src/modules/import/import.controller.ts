import { createHash } from "node:crypto";
import { BadRequestException, Body, Controller, Get, NotFoundException, Param, ParseUUIDPipe, Post, Req, UseGuards } from "@nestjs/common";
import { z } from "zod";
import {
  DedupeStrategy,
  entryStage,
  ImportEntity,
  mapRow,
  parsePipelineStages,
  REQUIRED_FIELDS,
  statusForStage,
  suggestMapping,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { toCsv } from "../reports/csv";

const MAX_ROWS = 5000;

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
 * On AdminKeyGuard+TenantGuard only, not CrmPermissionsGuard — a bulk
 * operation spanning up to 5,000 rows of a caller-chosen entity type doesn't
 * fit a single static `@RequireCrmPermission`, and this is the same
 * administrative-bulk-operation tier `scripts/backfill-crm-objects.js`
 * already operates at, not a per-record permission surface.
 *
 * The CSV itself is parsed in the browser (Papa Parse) — this only ever sees
 * already-parsed JSON rows, so there is no file-upload/multer plumbing here.
 */
@Controller("import")
@UseGuards(AdminKeyGuard, TenantGuard)
export class ImportController {
  constructor(private readonly db: DbService) {}

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
        try {
          result =
            entity === "contact"
              ? await importContactRow(client, orgId, mapped, dedupeStrategy)
              : entity === "account"
                ? await importAccountRow(client, orgId, mapped, dedupeStrategy)
                : await importDealRow(client, orgId, mapped);
        } catch (err) {
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

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', 'dev-admin', 'import.run', 'import_job', $2)`,
        [orgId, job.id],
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

  @Get(":jobId/errors")
  async errors(@OrgId() orgId: string, @Param("jobId", ParseUUIDPipe) jobId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [job],
      } = await client.query(`SELECT id FROM import_jobs WHERE id = $1`, [jobId]);
      if (!job) throw new NotFoundException("import job not found");

      const { rows } = await client.query(
        `SELECT row_number, raw, error FROM import_job_errors WHERE job_id = $1 ORDER BY row_number`,
        [jobId],
      );
      return { errors: rows };
    });
  }

  /** Same CSV as the report exports — one encoder for the whole codebase. */
  @Get(":jobId/errors.csv")
  async errorsCsv(@OrgId() orgId: string, @Param("jobId", ParseUUIDPipe) jobId: string) {
    return this.db.withOrg(orgId, async (client) => {
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

function hashPhone(raw: string): { hash: string; prefix: string | null; last3: string | null } | null {
  const digits = raw.replace(/\D+/gu, "");
  if (!digits) return null;
  return {
    hash: createHash("sha256").update(digits).digest("hex"),
    prefix: digits.slice(0, 5) || null,
    last3: digits.length >= 3 ? digits.slice(-3) : null,
  };
}

async function importContactRow(
  client: QueryClient,
  orgId: string,
  row: Record<string, string | null>,
  strategy: DedupeStrategy,
): Promise<RowOutcome> {
  const displayName = row.displayName || [row.firstName, row.lastName].filter(Boolean).join(" ").trim();
  if (!displayName) return { outcome: "failed", error: "no displayName (or first/last name) on this row" };

  const phone = row.phone ? hashPhone(row.phone) : null;
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
    if (isUniqueViolation(err)) return { outcome: "failed", error: "a contact with this phone or email already exists" };
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
    if (isUniqueViolation(err)) return { outcome: "failed", error: "an account with this domain already exists" };
    throw err;
  }
}

/** Deals have no natural dedup key across a CSV — always creates. */
async function importDealRow(client: QueryClient, orgId: string, row: Record<string, string | null>): Promise<RowOutcome> {
  if (!row.name) return { outcome: "failed", error: "no name on this row" };

  const {
    rows: [pipeline],
  } = await client.query<{ id: string; stages: unknown }>(`SELECT id, stages FROM deal_pipelines WHERE is_default = true LIMIT 1`);
  if (!pipeline) return { outcome: "failed", error: "org has no default pipeline" };
  const stages = parsePipelineStages(pipeline.stages);

  const requestedStage = row.stage?.trim();
  const stage = requestedStage && stages.some((s) => s.key === requestedStage) ? requestedStage : entryStage(stages);
  const status = statusForStage(stages, stage);

  let contactId: string | null = null;
  if (row.contactEmail) {
    const {
      rows: [contact],
    } = await client.query<{ id: string }>(`SELECT id FROM contacts WHERE org_id = $1 AND lower(email) = $2 AND status <> 'merged'`, [
      orgId,
      row.contactEmail.toLowerCase(),
    ]);
    contactId = contact?.id ?? null;
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

  await client.query(
    `INSERT INTO deals (org_id, pipeline_id, contact_id, account_id, name, stage, status, amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [orgId, pipeline.id, contactId, accountId, row.name, stage, status, Number.isFinite(amount) ? amount : null],
  );
  return { outcome: "inserted" };
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
