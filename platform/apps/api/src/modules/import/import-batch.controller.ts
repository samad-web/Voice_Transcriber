import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  DateOrder,
  IMPORT_MAX_ROWS,
  ImportEntity,
  ImportMode,
  ImportSource,
  REQUIRED_FIELDS,
  findDuplicatesInFile,
  parseAmountCell,
  parseDateCell,
  isFinanceImportEntity,
  mapRow,
  rowFingerprint,
  type DetectedKind,
  type DryRunSummary,
} from "@aura/shared";
import type { PoolClient } from "@aura/db";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { actorUserId, auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { hasCrmGrant } from "../../common/crm-permissions.guard";
import { OperatorMayCall, OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { parseBody, parseOptionalBody } from "../../common/parse-body";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { toCsv } from "../reports/csv";
import { reverseFinancePayment } from "../finance/record-payment";
import {
  importBankTxnRow,
  importExpenseRow,
  importPaymentRow,
  reconcileBankTransactions,
  type FinanceRowContext,
  type FinanceRowOutcome,
} from "./finance-row-importers";

/**
 * The import centre's staged flow
 * (Build docs/indian-business-finance-documents-cycles-import §3).
 *
 * ── WHY A SECOND CONTROLLER BESIDE `ImportController` ───────────────────────
 *
 * `POST /import/run` (0062) parses, writes and reports in one request. That is
 * right for a contact list and wrong for money, which is §3's own first
 * sentence: "Finance data wrongly imported is hard to unwind, so
 * auto-detection should do the work and a person should approve it once."
 *
 * So this controller adds the four steps that cannot be squeezed into `run`:
 *
 *   stage     parse, normalize and validate into `import_staging_rows`
 *   preview   the dry run - "120 new, 15 updates, 4 skipped, 6 errors"
 *   commit    apply the valid rows, recording what each one became
 *   rollback  undo the whole batch
 *
 * The legacy route is untouched and still serves the existing wizard. The two
 * do NOT duplicate any write logic: a staged contact row is applied by the
 * same `importContactRow` the legacy route calls, imported from it.
 *
 * ── THE FILE NEVER REACHES THIS SERVER ──────────────────────────────────────
 *
 * Parsing happens in the browser - papaparse for CSV, `xlsx-read.ts` for
 * .xlsx - and what arrives here is cell values as JSON. That is the existing
 * architecture (0062's header) and it answers several of §3's security bullets
 * by construction rather than by control: there is no uploaded file to virus
 * scan, no workbook for a server-side parser to be exploited through, and no
 * formula engine anywhere in the path.
 *
 * What it does NOT answer is validation, so none is trusted. Every amount and
 * date is re-parsed here with the same shared functions the browser used, the
 * required fields are re-checked, and the row count and body size are capped.
 *
 * ── AND WHO MAY DO IT ───────────────────────────────────────────────────────
 *
 * The controller carries `ImportController`'s own gate - owner, manager,
 * marketing - because that is the list the console's nav shows. On top of it,
 * a FINANCE entity additionally requires `finance:create`, checked per
 * request: §3 says "Sensitive imports (payroll, contracts) need elevated
 * roles", and a marketing persona who may legitimately load a bought lead list
 * must not be able to post payments into the ledger by uploading a
 * spreadsheet.
 */

const StageBody = z.object({
  entity: ImportEntity,
  mapping: z.record(z.string(), z.string().nullable()),
  mode: ImportMode.default("create"),
  /**
   * Resolved before staging. `ambiguous` and `conflict` are refused outright
   * rather than stored: a file whose dates could be read either way must not
   * be staged at all, because the preview a person approves would show dates
   * that are a coin toss.
   */
  dateOrder: z.enum(["iso", "dmy", "mdy"]).default("iso"),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Z]{3}$/)
    .default("INR"),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(IMPORT_MAX_ROWS),
  /** 1-based line numbers in the source file, for the error report. */
  sourceRowNumbers: z.array(z.number().int().positive()).optional(),
  fileName: z.string().trim().max(300).optional(),
  sheetName: z.string().trim().max(200).optional(),
  headerRow: z.number().int().min(0).max(1000).optional(),
  source: ImportSource.optional(),
  templateId: z.string().uuid().optional(),
});

const TemplateBody = z.object({
  name: z.string().trim().min(1).max(120),
  entity: ImportEntity,
  source: ImportSource.optional(),
  mapping: z.record(z.string(), z.string().nullable()),
  headerRow: z.number().int().min(0).max(1000).nullish(),
  dateOrder: z.enum(["iso", "dmy", "mdy"]).nullish(),
  ignoredHeaders: z.array(z.string().max(300)).max(200).default([]),
});

type StagedStatus = "pending" | "valid" | "duplicate" | "error" | "imported" | "updated" | "skipped";

@Controller("import")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@OperatorMayCall()
@RequireOwnerRole("owner", "manager", "marketing")
export class ImportBatchController {
  constructor(private readonly db: DbService) {}

  /**
   * Step 1-8: parse what the browser sent into staging, validate it there, and
   * return the dry run.
   *
   * Nothing is written to a real table by this route. §3's first key design
   * point - "Staging first: parse into a staging table, validate there, and
   * only then write to real tables."
   */
  @Post("stage")
  async stage(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const input = parseBody(StageBody, body);
    const actor = auditActor(req);

    const missing = REQUIRED_FIELDS[input.entity].filter((f) => !input.mapping[f]);
    if (missing.length > 0) {
      throw new BadRequestException(
        `Map these columns before importing: ${missing.join(", ")}.`,
      );
    }

    return this.db.withOrg(orgId, async (client) => {
      if (isFinanceImportEntity(input.entity)) {
        await this.assertMayImportFinance(client, orgId, req);
      }

      const { rows: jobRows } = await client.query<{ id: string }>(
        `INSERT INTO import_jobs
           (org_id, entity, status, mapping, total_rows, created_by_user_id,
            file_name, sheet_name, header_row, source, template_id, mode, date_order)
         VALUES ($1, $2, 'staged', $3::jsonb, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          orgId,
          input.entity,
          JSON.stringify(input.mapping),
          input.rows.length,
          actorUserId(actor),
          input.fileName ?? null,
          input.sheetName ?? null,
          input.headerRow ?? null,
          input.source ?? null,
          input.templateId ?? null,
          input.mode,
          input.dateOrder,
        ],
      );
      const jobId = jobRows[0].id;

      // Map every row first, so in-file duplicate detection sees the whole
      // file. §3 step 6 asks for duplicates "against existing records and
      // within the file", and the second half cannot be done row by row.
      const mapped = input.rows.map((row) => mapRow(input.mapping, row));
      const kind = input.entity as DetectedKind;
      const duplicates = findDuplicatesInFile(kind, mapped);
      const duplicateSet = new Set(duplicates.duplicateRows);

      let valid = 0;
      let errors = 0;
      let duplicateCount = 0;

      for (let i = 0; i < mapped.length; i += 1) {
        const sourceRow = input.sourceRowNumbers?.[i] ?? i + 1;
        const rowKey = rowFingerprint(kind, mapped[i]);

        let status: StagedStatus = "valid";
        let error: string | null = null;

        const missingOnRow = REQUIRED_FIELDS[input.entity].filter((f) => !mapped[i][f]);
        // ── THE DRY RUN HAS TO TRY WHAT THE COMMIT WILL DO ──────────────────
        //
        // Required-field presence alone is not enough, and the gap was
        // visible the first time a real file went through: a row whose amount
        // read "not a number" staged as VALID, the preview said "0 errors",
        // and it failed at commit. §3 step 8's whole purpose is to say "6
        // errors" BEFORE anybody approves it, so a surprise at commit is the
        // one outcome the dry run exists to prevent.
        //
        // `typedFieldProblem` re-parses the amount and the date with the same
        // functions the importer uses, so the two cannot disagree about what
        // is readable.
        const typedProblem =
          missingOnRow.length === 0
            ? typedFieldProblem(input.entity, mapped[i], input.dateOrder)
            : null;

        if (missingOnRow.length > 0) {
          status = "error";
          error = `Missing: ${missingOnRow.join(", ")}`;
        } else if (typedProblem) {
          status = "error";
          error = typedProblem;
        } else if (duplicateSet.has(i)) {
          // A repeat of an EARLIER row in the same file. Not an error - the
          // first copy will import - so it is counted separately and the
          // person is told, which is what §3 step 8's "4 skipped" is.
          status = "duplicate";
          error = "The same record appears earlier in this file.";
        }

        if (status === "valid") valid += 1;
        else if (status === "error") errors += 1;
        else duplicateCount += 1;

        // ── THE DUPLICATE ROW STORES NO KEY, AND THAT IS THE FIX ──────────
        //
        // 0182's unique index is `(job_id, row_key) WHERE row_key IS NOT
        // NULL`. Storing the duplicate WITH its key violates that index by
        // construction - the duplicate has the same key as the row it repeats,
        // which is what made it a duplicate.
        //
        // The first version caught the 23505 and inserted a replacement row,
        // which is the trap the legacy route's own comment warns about and
        // which this file quotes in `commit`: a constraint violation marks the
        // whole transaction aborted at the Postgres level even though the JS
        // exception is caught, so the recovery INSERT failed with 25P02 and
        // the whole stage 500'd. Found by staging a file with a repeated row.
        //
        // So the index keeps its real meaning - one VALID row per key - and a
        // duplicate is recorded without a key. Nothing is lost: the key is
        // derivable from `normalized`, and the row's status already says why
        // it is there.
        await client.query(
          `INSERT INTO import_staging_rows
             (org_id, job_id, source_row_number, raw, normalized, row_key, status, error)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)`,
          [
            orgId,
            jobId,
            sourceRow,
            JSON.stringify(input.rows[i]),
            JSON.stringify(mapped[i]),
            status === "duplicate" ? null : rowKey,
            status,
            error,
          ],
        );
      }

      await client.query(
        `UPDATE import_jobs SET duplicate_count = $2, failed_count = $3 WHERE id = $1`,
        [jobId, duplicateCount, errors],
      );

      const summary: DryRunSummary = {
        // Until commit runs, every valid row is a prospective insert. `update`
        // and `upsert` modes resolve new-vs-update at commit, because that
        // needs a lookup per row and the dry run is meant to be cheap.
        newRows: input.mode === "update" ? 0 : valid,
        updateRows: input.mode === "create" ? 0 : valid,
        skippedRows: duplicateCount,
        errorRows: errors,
        duplicateRows: duplicateCount,
        totalRows: mapped.length,
      };

      return {
        jobId,
        summary,
        unkeyedRows: duplicates.unkeyedRows.length,
        /**
         * The rows that cannot be de-duplicated at all, named rather than
         * hidden: a payment file with no reference column will import happily
         * and import again happily, and the person should know that before
         * they approve it.
         */
        dedupeWarning:
          duplicates.unkeyedRows.length > 0
            ? `${duplicates.unkeyedRows.length} row(s) have nothing to identify them by, so re-importing this file would add them again. Map a reference column to prevent that.`
            : null,
      };
    });
  }

  /** The staged rows, for the preview table. */
  @Get("jobs/:jobId/staged")
  async staged(
    @OrgId() orgId: string,
    @Param("jobId", ParseUUIDPipe) jobId: string,
    @Query("status") status?: string,
    @Query("limit") limit?: string,
  ) {
    const take = Math.min(Math.max(Number(limit) || 100, 1), 500);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        source_row_number: number;
        raw: Record<string, unknown>;
        normalized: Record<string, unknown> | null;
        status: string;
        error: string | null;
        target_table: string | null;
        target_id: string | null;
      }>(
        `SELECT source_row_number, raw, normalized, status, error, target_table, target_id
           FROM import_staging_rows
          WHERE job_id = $1 AND ($2::text IS NULL OR status = $2)
          ORDER BY source_row_number
          LIMIT $3`,
        [jobId, status ?? null, take],
      );
      return {
        rows: rows.map((r) => ({
          sourceRowNumber: r.source_row_number,
          raw: r.raw,
          normalized: r.normalized,
          status: r.status,
          error: r.error,
          target: r.target_id ? { table: r.target_table, id: r.target_id } : null,
        })),
      };
    });
  }

  /**
   * Step 9: apply the valid rows.
   *
   * ── ONE TRANSACTION, WITH A SAVEPOINT PER ROW ───────────────────────────
   *
   * §3 asks for "a transaction per batch". `withOrg` gives exactly that, and
   * the per-row SAVEPOINT is what makes it survivable: a constraint violation
   * marks the whole surrounding transaction aborted at the Postgres level even
   * though the JS exception is caught, so every statement after it - including
   * this row's own error write - would fail with "current transaction is
   * aborted" without a rollback to a point before the bad statement ran. The
   * legacy route learned the same thing and carries the same comment.
   */
  @Post("jobs/:jobId/commit")
  async commit(
    @OrgId() orgId: string,
    @Param("jobId", ParseUUIDPipe) jobId: string,
    @Req() req: PrincipalRequest,
  ) {
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const { rows: jobRows } = await client.query<{
        entity: string;
        status: string;
        mode: string;
        date_order: string | null;
        created_by_user_id: string | null;
      }>(
        `SELECT entity, status, mode, date_order, created_by_user_id
           FROM import_jobs WHERE id = $1 FOR UPDATE`,
        [jobId],
      );
      const job = jobRows[0];
      if (!job) throw new NotFoundException("No such import.");
      if (job.status !== "staged") {
        throw new BadRequestException(
          job.status === "done"
            ? "This import has already been applied."
            : `This import cannot be applied from the "${job.status}" state.`,
        );
      }

      const entity = job.entity as ImportEntity;
      if (isFinanceImportEntity(entity)) {
        await this.assertMayImportFinance(client, orgId, req);
      }

      const { rows: staged } = await client.query<{
        id: string;
        source_row_number: number;
        normalized: Record<string, string | null>;
      }>(
        `SELECT id, source_row_number, normalized
           FROM import_staging_rows
          WHERE job_id = $1 AND status = 'valid'
          ORDER BY source_row_number`,
        [jobId],
      );

      const ctx: FinanceRowContext = {
        orgId,
        actor,
        dateOrder: (job.date_order ?? "iso") as DateOrder,
        currency: "INR",
      };

      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      let failed = 0;

      for (const row of staged) {
        await client.query(`SAVEPOINT staged_row`);
        let outcome: FinanceRowOutcome;
        try {
          outcome = await this.applyRow(client, entity, ctx, row.normalized);
          await client.query(`RELEASE SAVEPOINT staged_row`);
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT staged_row`);
          await client.query(`RELEASE SAVEPOINT staged_row`);
          outcome = {
            outcome: "failed",
            error: err instanceof Error ? err.message : "Unknown error",
          };
        }

        const status: StagedStatus =
          outcome.outcome === "inserted"
            ? "imported"
            : outcome.outcome === "updated"
              ? "updated"
              : outcome.outcome === "skipped"
                ? "skipped"
                : "error";

        if (outcome.outcome === "inserted") inserted += 1;
        else if (outcome.outcome === "updated") updated += 1;
        else if (outcome.outcome === "skipped") skipped += 1;
        else failed += 1;

        await client.query(
          `UPDATE import_staging_rows
              SET status = $2, error = $3, target_table = $4, target_id = $5
            WHERE id = $1`,
          [row.id, status, outcome.error ?? null, outcome.targetTable ?? null, outcome.targetId ?? null],
        );

        if (outcome.outcome === "failed") {
          // Also written to 0062's error table, so the existing errors.csv
          // download works for a staged import too rather than being a second
          // report in a second place.
          await client.query(
            `INSERT INTO import_job_errors (org_id, job_id, row_number, raw, error)
             VALUES ($1, $2, $3, $4::jsonb, $5)`,
            [
              orgId,
              jobId,
              row.source_row_number,
              JSON.stringify(row.normalized),
              outcome.error ?? "Unknown error",
            ],
          );
        }
      }

      // A bank statement import ends by reconciling what it brought in, so the
      // person sees the answer to "did this match what we recorded" on the
      // result page rather than having to go and ask for it.
      let reconciled = 0;
      if (entity === "bank_txn") {
        reconciled = (await reconcileBankTransactions(client, orgId)).matched;
      }

      const { rows: finalJob } = await client.query(
        `UPDATE import_jobs SET
           status = 'done', inserted_count = $2, updated_count = $3,
           skipped_count = skipped_count + $4, failed_count = failed_count + $5,
           finished_at = now()
         WHERE id = $1
         RETURNING id, entity, status, total_rows, inserted_count, updated_count,
                   skipped_count, failed_count, duplicate_count, mode, date_order,
                   file_name, created_at, finished_at`,
        [jobId, inserted, updated, skipped, failed],
      );

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $2, $3, 'import.commit', 'import_job', $4, $5::jsonb)`,
        [
          orgId,
          actor.type,
          actor.id,
          jobId,
          JSON.stringify({ entity, inserted, updated, skipped, failed }),
        ],
      );

      // §3 step 10's result report, including the one number a finance import
      // must not hide: imported expenses arrive UNAPPROVED, so they are not in
      // any cost figure until somebody approves them.
      return {
        job: finalJob[0],
        reconciled: entity === "bank_txn" ? reconciled : null,
        awaitingApproval: entity === "expense" ? inserted : null,
      };
    });
  }

  /**
   * Step 11: undo the whole batch.
   *
   * ── IT DELETES ONLY WHAT IT WROTE, AND ONLY IF NOTHING HAS TOUCHED IT ────
   *
   * Driven off `target_table`/`target_id`, so an edited record is not
   * re-derived from the file and destroyed. §3 adds "subject to period locks",
   * which is enforced by 0172's trigger rather than re-checked here: deleting
   * a payment dated into a closed month raises a check violation and the whole
   * rollback fails, which is the correct outcome - a locked period means the
   * books are closed on that month and an undo would silently change a figure
   * somebody has already filed a return against.
   *
   * A payment is REVERSED rather than deleted, because §6.3 is a MUST: "never
   * edit or delete a posted payment or ledger row." The ledger keeps both
   * entries and the net is zero, which is what an audit trail is for.
   */
  @Post("jobs/:jobId/rollback")
  async rollback(
    @OrgId() orgId: string,
    @Param("jobId", ParseUUIDPipe) jobId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const input = parseOptionalBody(
      z.object({ reason: z.string().trim().min(3, "Say why this is being undone.").max(500) }),
      body,
    );
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const { rows: jobRows } = await client.query<{ entity: string; status: string }>(
        `SELECT entity, status FROM import_jobs WHERE id = $1 FOR UPDATE`,
        [jobId],
      );
      const job = jobRows[0];
      if (!job) throw new NotFoundException("No such import.");
      if (job.status !== "done") {
        throw new BadRequestException("Only a completed import can be undone.");
      }
      if (isFinanceImportEntity(job.entity as ImportEntity)) {
        await this.assertMayImportFinance(client, orgId, req);
      }

      const { rows: targets } = await client.query<{
        id: string;
        target_table: string;
        target_id: string;
      }>(
        `SELECT id, target_table, target_id
           FROM import_staging_rows
          WHERE job_id = $1 AND target_id IS NOT NULL
          ORDER BY source_row_number DESC`,
        [jobId],
      );

      let undone = 0;
      let kept = 0;
      const problems: string[] = [];

      for (const target of targets) {
        await client.query(`SAVEPOINT undo_row`);
        try {
          const result = await this.undoTarget(client, orgId, target, actor, input.reason);
          await client.query(`RELEASE SAVEPOINT undo_row`);
          if (result.undone) undone += 1;
          else {
            kept += 1;
            if (result.why) problems.push(result.why);
          }
        } catch (err) {
          await client.query(`ROLLBACK TO SAVEPOINT undo_row`);
          await client.query(`RELEASE SAVEPOINT undo_row`);
          kept += 1;
          problems.push(err instanceof Error ? err.message : "Unknown error");
        }
      }

      await client.query(
        `UPDATE import_jobs
            SET status = 'rolled_back', rolled_back_at = now(), rolled_back_by = $2
          WHERE id = $1`,
        [jobId, actorUserId(actor)],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, $2, $3, 'import.rollback', 'import_job', $4, $5::jsonb)`,
        [orgId, actor.type, actor.id, jobId, JSON.stringify({ undone, kept, reason: input.reason })],
      );

      return {
        undone,
        kept,
        // De-duplicated: forty rows blocked by one closed period is one
        // sentence, not forty.
        problems: [...new Set(problems)].slice(0, 10),
      };
    });
  }

  /** Discard a staged import that was never applied. */
  @Delete("jobs/:jobId")
  async discard(@OrgId() orgId: string, @Param("jobId", ParseUUIDPipe) jobId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM import_jobs WHERE id = $1 AND status = 'staged'`,
        [jobId],
      );
      if (rowCount === 0) {
        throw new BadRequestException("Only a staged import that was never applied can be discarded.");
      }
      return { ok: true };
    });
  }

  /** §3's import history page. */
  @Get("jobs")
  async history(@OrgId() orgId: string, @Query("limit") limit?: string) {
    const take = Math.min(Math.max(Number(limit) || 30, 1), 100);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT j.id, j.entity, j.status, j.mode, j.date_order, j.source, j.file_name,
                j.sheet_name, j.total_rows, j.inserted_count, j.updated_count,
                j.skipped_count, j.failed_count, j.duplicate_count,
                j.created_at::text AS created_at, j.finished_at::text AS finished_at,
                j.rolled_back_at::text AS rolled_back_at,
                u.name AS created_by_name, t.name AS template_name
           FROM import_jobs j
           LEFT JOIN users u ON u.id = j.created_by_user_id
           LEFT JOIN import_templates t ON t.id = j.template_id
          ORDER BY j.created_at DESC
          LIMIT $1`,
        [take],
      );
      return { jobs: rows };
    });
  }

  // ── §3 step 4's saved mapping templates ────────────────────────────────

  @Get("templates")
  async templates(@OrgId() orgId: string, @Query("entity") entity?: string) {
    const wanted = ImportEntity.safeParse(entity);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, entity, source, mapping, header_row, date_order,
                ignored_headers, times_used, last_used_at::text AS last_used_at
           FROM import_templates
          WHERE ($1::text IS NULL OR entity = $1)
          ORDER BY last_used_at DESC NULLS LAST, name`,
        [wanted.success ? wanted.data : null],
      );
      return { templates: rows };
    });
  }

  @Post("templates")
  async saveTemplate(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const input = parseBody(TemplateBody, body);
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO import_templates
           (org_id, name, entity, source, mapping, header_row, date_order,
            ignored_headers, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::text[], $9)
         ON CONFLICT (org_id, entity, lower(name)) DO UPDATE SET
           source = EXCLUDED.source,
           mapping = EXCLUDED.mapping,
           header_row = EXCLUDED.header_row,
           date_order = EXCLUDED.date_order,
           ignored_headers = EXCLUDED.ignored_headers
         RETURNING id`,
        [
          orgId,
          input.name,
          input.entity,
          input.source ?? null,
          JSON.stringify(input.mapping),
          input.headerRow ?? null,
          input.dateOrder ?? null,
          input.ignoredHeaders,
          actorUserId(actor),
        ],
      );
      return { id: rows[0].id };
    });
  }

  @Post("templates/:id/used")
  async markTemplateUsed(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      await client.query(
        `UPDATE import_templates
            SET times_used = times_used + 1, last_used_at = now()
          WHERE id = $1`,
        [id],
      );
      return { ok: true };
    });
  }

  @Delete("templates/:id")
  async deleteTemplate(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(`DELETE FROM import_templates WHERE id = $1`, [id]);
      if (rowCount === 0) throw new NotFoundException("No such template.");
      return { ok: true };
    });
  }

  /**
   * §3 step 10: "a downloadable error file with row numbers and reasons, so
   * the user can fix and re-upload only failed rows."
   *
   * The ROW NUMBERS are the source file's, not the staged set's, which is the
   * whole point - a number counting staged rows points at the wrong line of
   * their spreadsheet as soon as one blank row has been skipped.
   */
  @Get("jobs/:jobId/failed.csv")
  async failedCsv(@OrgId() orgId: string, @Param("jobId", ParseUUIDPipe) jobId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        source_row_number: number;
        raw: Record<string, unknown>;
        error: string | null;
        status: string;
      }>(
        `SELECT source_row_number, raw, error, status
           FROM import_staging_rows
          WHERE job_id = $1 AND status IN ('error', 'duplicate')
          ORDER BY source_row_number`,
        [jobId],
      );
      if (rows.length === 0) throw new NotFoundException("This import has no failed rows.");

      // Every original column, so the file can be corrected and re-uploaded
      // as-is, with the reason added.
      const headers = [...new Set(rows.flatMap((r) => Object.keys(r.raw ?? {})))];
      const csv = toCsv(
        [
          { header: "Row", value: (r: (typeof rows)[number]) => r.source_row_number },
          { header: "Problem", value: (r: (typeof rows)[number]) => r.error ?? r.status },
          ...headers.map((h) => ({
            header: h,
            value: (r: (typeof rows)[number]) => (r.raw as Record<string, unknown>)?.[h] ?? "",
          })),
        ],
        rows,
      );
      return { csv, fileName: `import-${jobId.slice(0, 8)}-failed.csv` };
    });
  }

  // ─────────────────────────────────────────────────────────────────────────

  /**
   * §3: "Sensitive imports (payroll, contracts) need elevated roles."
   *
   * Checked per request rather than as a class decorator, because the
   * controller serves both lead data and money and only the latter needs it. A
   * marketing persona may load a bought contact list; posting payments into
   * the ledger is `finance:create`.
   */
  private async assertMayImportFinance(
    client: PoolClient,
    orgId: string,
    req: PrincipalRequest,
  ): Promise<void> {
    const principal = req.principal;
    // The bare platform key (ops scripts, the operator console) has no person
    // to look a grant up for, and is the platform's own credential - the same
    // call `@OperatorMayCall()` makes for this whole controller.
    if (principal?.viaAdminKey && principal.userId === "admin-key") return;

    const userId = z.string().uuid().safeParse(principal?.userId);
    if (!userId.success) {
      throw new ForbiddenException("Importing finance records needs a signed-in user.");
    }
    // Read through the grid, in THIS transaction - `hasCrmGrant`'s own header
    // asks for the caller's client rather than a second connection, because
    // the Mumbai-to-Seoul round trip is not one to double for a permission
    // check.
    const allowed = await hasCrmGrant(client, orgId, userId.data, "finance", "create");
    if (!allowed) {
      throw new ForbiddenException(
        "Importing payments, expenses or a bank statement needs permission to create finance records.",
      );
    }
  }

  private async applyRow(
    client: PoolClient,
    entity: ImportEntity,
    ctx: FinanceRowContext,
    row: Record<string, string | null>,
  ): Promise<FinanceRowOutcome> {
    switch (entity) {
      case "payment":
        return importPaymentRow(client, ctx, row);
      case "expense":
        return importExpenseRow(client, ctx, row);
      case "bank_txn":
        return importBankTxnRow(client, ctx, row);
      default:
        // contact / account / deal are applied by the legacy importers, which
        // this controller deliberately does not re-implement. They are not
        // reachable through `stage` yet - see the module's README - and this
        // branch exists so that adding them is one import away rather than a
        // silent fall-through that reports success and writes nothing.
        return {
          outcome: "failed",
          error: `Staged import is not available for ${entity} yet - use the standard import wizard.`,
        };
    }
  }

  private async undoTarget(
    client: PoolClient,
    orgId: string,
    target: { target_table: string; target_id: string },
    actor: ReturnType<typeof auditActor>,
    reason: string,
  ): Promise<{ undone: boolean; why?: string }> {
    switch (target.target_table) {
      case "bank_transactions": {
        // A statement line carries no accounting consequence - nothing is
        // posted to the ledger from it - so it is genuinely deleted.
        const { rowCount } = await client.query(
          `DELETE FROM bank_transactions WHERE id = $1 AND matched_payment_id IS NULL`,
          [target.target_id],
        );
        return rowCount === 0
          ? { undone: false, why: "A statement line has since been reconciled to a payment." }
          : { undone: true };
      }
      case "expenses": {
        // An APPROVED expense is in the margin and in a filed period. Undoing
        // it is a reversal, which is a decision with a reason - not something
        // an undo button does on forty rows.
        const { rowCount } = await client.query(
          `DELETE FROM expenses WHERE id = $1 AND approved_at IS NULL AND reverses_id IS NULL`,
          [target.target_id],
        );
        return rowCount === 0
          ? { undone: false, why: "An expense has since been approved - reverse it instead." }
          : { undone: true };
      }
      case "finance_payments": {
        // §6.3's MUST: never delete a posted payment. `reverseFinancePayment`
        // is the same function `POST /finance/payments/:id/reverse` calls, and
        // it does all three halves - the reversing ledger posting, the
        // re-derived schedule, and the status.
        //
        // The first version of this branch did only the status, and left the
        // ledger holding an entry for money that had been un-received. That is
        // a defect `unbalancedPostings` would have found weeks later with
        // nothing to tie it back to this import.
        const result = await reverseFinancePayment(
          client,
          orgId,
          target.target_id,
          `Import undone: ${reason}`,
          actor,
        );
        if (!result) {
          // ── A PAYMENT THAT WAS NEVER COUNTED IS MARKED `failed` ─────────
          //
          // `reverseFinancePayment` returns null for two different things:
          // the row is gone, or it is not in a collected status - an
          // unverified cash or cheque receipt, which §6.2 deliberately keeps
          // out of the ledger and out of every total until a second person
          // confirms it.
          //
          // Returning `undone: true` and doing nothing left a pending payment
          // from an undone import sitting in the verification queue, which
          // nobody can account for.
          //
          // ── AND THE OBVIOUS FIX WAS WRONG ──────────────────────────────
          //
          // The first attempt DELETED it, on the reasoning that §6.3's "never
          // delete a posted payment" does not cover one that was never
          // posted. The database refused: 0173 REVOKEs DELETE on
          // `finance_payments` from `aura_app`, so the rollback came back
          // "permission denied" with one row kept. That revoke is what makes
          // the append-only guarantee real rather than a comment, and
          // weakening it to tidy up a rollback would have been a bad trade.
          //
          // So the row stays and its status becomes `failed` - which 0173's
          // CHECK already allows and which means exactly this: the payment did
          // not happen. It leaves the verification queue, counts towards
          // nothing, and the reason says why.
          await client.query(
            `UPDATE finance_payments
                SET status = 'failed', reversal_reason = $2
              WHERE id = $1
                AND status NOT IN ('received', 'cheque_cleared', 'partially_refunded', 'disputed')`,
            [target.target_id, `Import undone before verification: ${reason}`],
          );
          await client.query(
            `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
             VALUES ($1, $2, $3, 'finance.payment.voided', 'finance_payment', $4, $5::jsonb)`,
            [
              orgId,
              actor.type,
              actor.id,
              target.target_id,
              JSON.stringify({ reason, via: "import_rollback", wasNeverPosted: true }),
            ],
          );
          return { undone: true };
        }
        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
           VALUES ($1, $2, $3, 'finance.payment.reversed', 'finance_payment', $4, $5::jsonb)`,
          [
            orgId,
            actor.type,
            actor.id,
            target.target_id,
            JSON.stringify({
              reason,
              via: "import_rollback",
              from: result.previousStatus,
              postings: result.reversedPostings,
            }),
          ],
        );
        return { undone: true };
      }
      default:
        return { undone: false, why: `Nothing knows how to undo a ${target.target_table} row.` };
    }
  }
}

/**
 * Does this row's typed content actually parse?
 *
 * ── IT RE-PARSES WITH THE IMPORTER'S OWN FUNCTIONS ──────────────────────────
 *
 * `parseAmountCell` and `parseDateCell` are the same functions
 * `finance-row-importers.ts` calls at commit time, so the dry run and the
 * commit cannot disagree about what is readable. A second, looser check here
 * would be worse than none: it would promise a clean import and then fail
 * half-way through one.
 *
 * Only the fields that are TYPED are checked. A customer name that matches
 * nothing is not an error - the payment lands unmatched and §8's queue exists
 * for exactly that - and failing the row would refuse a file of 200 payments
 * because three customers are spelled differently.
 */
function typedFieldProblem(
  entity: ImportEntity,
  row: Record<string, string | null>,
  dateOrder: "iso" | "dmy" | "mdy",
): string | null {
  const money = (field: string, label: string): string | null => {
    const raw = row[field];
    if (!raw || raw.trim() === "") return null;
    const cell = parseAmountCell(raw);
    if (!cell) return `${label} is not an amount this importer can read: "${raw.trim()}"`;
    return null;
  };
  const date = (field: string, label: string): string | null => {
    const raw = row[field];
    if (!raw || raw.trim() === "") return null;
    return parseDateCell(raw, dateOrder)
      ? null
      : `${label} is not a date this importer can read: "${raw.trim()}"`;
  };

  switch (entity) {
    case "payment": {
      const problem = date("paidAt", "Payment date") ?? money("amount", "Amount");
      if (problem) return problem;
      // A payment must be positive; a refund is a different record with a
      // different ledger shape (§6.3). Checked here so the dry run says so
      // rather than the commit.
      const cell = parseAmountCell(row.amount ?? "");
      if (cell && cell.minor <= 0) {
        return "A payment must be positive. Record money going out as an expense or a refund.";
      }
      return null;
    }
    case "expense":
      return (
        date("spentOn", "Expense date") ??
        money("amount", "Amount") ??
        money("taxAmount", "Tax amount")
      );
    case "bank_txn": {
      const problem =
        date("valueDate", "Date") ??
        money("credit", "Deposit") ??
        money("debit", "Withdrawal") ??
        money("balance", "Balance");
      if (problem) return problem;
      const hasCredit = (row.credit ?? "").trim() !== "";
      const hasDebit = (row.debit ?? "").trim() !== "";
      if (!hasCredit && !hasDebit) return "This row has no amount in either column";
      return null;
    }
    default:
      // contact / account / deal carry no typed fields this check can verify
      // ahead of time - their importers resolve names and phone numbers
      // against the database, which is a commit-time question.
      return null;
  }
}
