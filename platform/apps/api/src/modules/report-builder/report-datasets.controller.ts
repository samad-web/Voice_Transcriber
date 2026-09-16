import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  inferSchema,
  MAX_UPLOAD_ROWS,
  QuerySpec,
  ReportDoc,
  schemaFingerprint,
  type ColumnMeta,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, type CrmRecordScope } from "../../common/crm-scope";
import { softDelete } from "../../common/soft-delete";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { crmSource, crmSourceCatalogue } from "./crm-sources";
import { ReportBuilderService } from "./report-builder.service";

/**
 * Data sources for the Report Builder (migration 0077).
 *
 * ── WHY THE CSV NEVER TOUCHES THIS PROCESS AS A FILE ────────────────────
 *
 * The browser parses the CSV with Papa Parse and posts already-parsed JSON
 * rows, exactly as `/v1/import` has done since migration 0062. No multer, no
 * multipart, no temp files, no upload directory to secure or clean up. The
 * ceiling is enforced on the row count rather than on a byte size, which is
 * the number that actually predicts whether a query over it will be slow.
 *
 * PERMISSIONS (design doc D7): every route here needs `deal:view`. Creating a
 * data source is not a CRM write - it is a saved pointer at data the caller
 * can already read - so it is gated on the same grant as reading, and the
 * record scope still narrows every query run against it.
 */
@Controller("report-datasets")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class ReportDatasetsController {
  constructor(
    private readonly db: DbService,
    private readonly reports: ReportBuilderService,
  ) {}

  /**
   * Everything a data-source picker needs, in one call: the tenant's saved
   * datasets plus the CRM source catalogue they can create more from.
   *
   * Two lists rather than one because they are different objects - a
   * catalogue entry is a template for a dataset, not a dataset - and merging
   * them would make "delete this" ambiguous.
   */
  @Get()
  @RequireCrmPermission("deal", "view")
  async list(@OrgId() orgId: string) {
    const { rows } = await this.db.withOrg(orgId, (client) =>
      client.query(
        `SELECT d.id, d.name, d.kind, d.source_key, d.columns, d.row_count,
                d.schema_fingerprint, d.refreshed_at, d.created_at,
                u.name AS created_by_name,
                -- Deleting a data source that widgets still reference breaks
                -- every one of them, so the console needs to warn BEFORE the
                -- click rather than explain afterwards. Counted across draft
                -- and published docs both: a report can be mid-edit.
                (SELECT count(*) FROM reports r
                  WHERE r.org_id = d.org_id
                    AND (r.draft_doc::text LIKE '%' || d.id::text || '%'
                      OR COALESCE(r.published_doc::text, '') LIKE '%' || d.id::text || '%')
                )::int AS used_by_reports
           FROM report_datasets d
           LEFT JOIN users u ON u.id = d.created_by
          WHERE d.org_id = $1 AND d.deleted_at IS NULL
          ORDER BY d.created_at DESC`,
        [orgId],
      ),
    );
    return { datasets: rows, catalogue: crmSourceCatalogue() };
  }

  @Get(":id")
  @RequireCrmPermission("deal", "view")
  async detail(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    const dataset = await this.reports.dataset(orgId, id);
    return { dataset: { ...dataset, columns: this.reports.schemaFor(dataset) } };
  }

  @Post()
  @RequireCrmPermission("deal", "view")
  async create(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = CreateDataset.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    const userId = actorUserId(req);

    if (input.kind === "crm") {
      const source = crmSource(input.sourceKey);
      if (!source) throw new BadRequestException(`Unknown CRM data source "${input.sourceKey}".`);

      return this.db.withOrg(orgId, async (client) => {
        try {
          const {
            rows: [dataset],
          } = await client.query(
            // `columns` stays EMPTY for a CRM source: its schema is code, and
            // snapshotting it here would let a stored copy drift from the
            // catalogue silently. schemaFor() reads the catalogue every time.
            `INSERT INTO report_datasets (org_id, name, kind, source_key, created_by)
             VALUES ($1, btrim($2), 'crm', $3, $4)
             RETURNING id, name, kind, source_key, columns, row_count, created_at`,
            [orgId, input.name ?? source.name, input.sourceKey, userId],
          );
          await this.reports.audit(client, orgId, userId, "report.dataset_create", dataset.id, {
            kind: "crm",
            sourceKey: input.sourceKey,
          });
          return {
            dataset: {
              ...dataset,
              columns: crmSourceCatalogue().find((c) => c.key === input.sourceKey)?.columns ?? [],
            },
          };
        } catch (err) {
          throw nameConflict(err, input.name ?? source.name);
        }
      });
    }

    const { columns, rows } = inferUpload(input.headers, input.rows);

    return this.db.withOrg(orgId, async (client) => {
      try {
        const {
          rows: [dataset],
        } = await client.query(
          `INSERT INTO report_datasets
             (org_id, name, kind, columns, row_count, schema_fingerprint, refreshed_at, created_by)
           VALUES ($1, btrim($2), 'upload', $3::jsonb, $4, $5, now(), $6)
           RETURNING id, name, kind, source_key, columns, row_count, schema_fingerprint,
                     refreshed_at, created_at`,
          [
            orgId,
            input.name,
            JSON.stringify(columns),
            rows.length,
            schemaFingerprint(columns),
            userId,
          ],
        );
        await insertRows(client, orgId, dataset.id, rows);
        await this.reports.audit(client, orgId, userId, "report.dataset_create", dataset.id, {
          kind: "upload",
          rows: rows.length,
        });
        return { dataset };
      } catch (err) {
        throw nameConflict(err, input.name);
      }
    });
  }

  /**
   * Replace an upload's rows - the "refresh the data" path.
   *
   * ── SCHEMA DRIFT IS REPORTED, NEVER RESOLVED ───────────────────────────
   *
   * The new file's schema is inferred, compared with the old fingerprint, and
   * if it moved, every widget in every report that touches this dataset is
   * re-checked and the mismatches are returned. Nothing is repaired: a column
   * renamed from `created` to `created_at` is a decision only the author can
   * make, and a builder that guesses produces a chart with the right title and
   * the wrong number. Prompt requirement 3.2 and acceptance criterion 7.
   *
   * The rows are replaced regardless - refusing the upload because a widget
   * would break leaves the tenant with stale data AND a broken widget.
   */
  @Post(":id/rows")
  @RequireCrmPermission("deal", "view")
  async replaceRows(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const parsed = ReplaceRows.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const existing = await this.reports.dataset(orgId, id);
    if (existing.kind !== "upload") {
      throw new BadRequestException(
        "A CRM data source is always live - there is nothing to re-upload. Its numbers are recomputed on every read.",
      );
    }

    const { columns, rows } = inferUpload(parsed.data.headers, parsed.data.rows);
    const fingerprint = schemaFingerprint(columns);
    const drifted = fingerprint !== existing.schema_fingerprint;

    await this.db.withOrg(orgId, async (client) => {
      await client.query(`DELETE FROM report_dataset_rows WHERE dataset_id = $1`, [id]);
      await client.query(
        `UPDATE report_datasets
            SET columns = $2::jsonb, row_count = $3, schema_fingerprint = $4, refreshed_at = now()
          WHERE id = $1 AND deleted_at IS NULL`,
        [id, JSON.stringify(columns), rows.length, fingerprint],
      );
      await insertRows(client, orgId, id, rows);
      await this.reports.audit(client, orgId, actorUserId(req), "report.dataset_refresh", id, {
        rows: rows.length,
        drifted,
      });
    });

    // Only walk the reports when the SHAPE actually changed. A weekly re-upload
    // of the same file must not make the console cry wolf, which is how a
    // warning stops being read.
    const issues = drifted ? await this.driftIssues(orgId, id) : [];

    return {
      dataset: { id, rowCount: rows.length, columns, schemaFingerprint: fingerprint },
      drifted,
      issues,
    };
  }

  /** Which widgets, in which reports, this dataset's new shape has broken. */
  private async driftIssues(orgId: string, datasetId: string) {
    const { rows } = await this.db.withOrg(orgId, (client) =>
      client.query<{ id: string; name: string; draft_doc: unknown }>(
        `SELECT id, name, draft_doc FROM reports
          WHERE org_id = $1 AND status <> 'archived'
            AND draft_doc::text LIKE '%' || $2 || '%'`,
        [orgId, datasetId],
      ),
    );

    const out: Array<{ reportId: string; reportName: string; issues: unknown[] }> = [];
    for (const report of rows) {
      const doc = ReportDocOrNull(report.draft_doc);
      if (!doc) continue;
      const issues = await this.reports.bindingIssues(orgId, doc);
      if (issues.length > 0) out.push({ reportId: report.id, reportName: report.name, issues });
    }
    return out;
  }

  /**
   * Run one query. THE endpoint every widget renders from (design doc D2).
   *
   * A POST rather than a GET because the spec is a nested object that would be
   * a 2KB query string, and because a URL is the one place a filter value -
   * which can be a customer's name - must not end up: it would land in every
   * access log and browser history along the way.
   */
  @Post(":id/query")
  @RequireCrmPermission("deal", "view")
  async query(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = QuerySpec.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    return this.reports.runWidget(orgId, id, parsed.data, recordScope);
  }

  @Delete(":id")
  @RequireCrmPermission("deal", "view")
  async remove(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      // The uploaded rows used to cascade away with the dataset, which meant
      // deleting a data source destroyed the sheet somebody had imported and
      // there was no way back. Nothing is deleted now (0108), so the rows stay
      // put and a restore is one UPDATE.
      await this.reports.audit(client, orgId, actorUserId(req), "report.dataset_delete", id);
      const removed = await softDelete(client, "report_dataset", id, req);
      if (!removed) throw new BadRequestException("data source not found");
      return { deleted: true };
    });
  }
}

// ── input shapes ───────────────────────────────────────────────────────────

/**
 * A parsed CSV cell. Papa Parse yields strings, numbers, booleans and nulls
 * depending on its dynamicTyping setting; all four are accepted and normalised
 * to text on the way into jsonb, so the query compiler's casts are the single
 * place a type decision is made.
 */
const CellValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const UploadPayload = z.object({
  name: z.string().min(1).max(120),
  kind: z.literal("upload"),
  headers: z.array(z.string().min(1).max(120)).min(1).max(120),
  rows: z.array(z.record(z.string(), CellValue)).min(1).max(MAX_UPLOAD_ROWS),
});

const CrmPayload = z.object({
  name: z.string().min(1).max(120).optional(),
  kind: z.literal("crm"),
  sourceKey: z.string().min(1).max(60),
});

const CreateDataset = z.discriminatedUnion("kind", [CrmPayload, UploadPayload]);

const ReplaceRows = z.object({
  headers: z.array(z.string().min(1).max(120)).min(1).max(120),
  rows: z.array(z.record(z.string(), CellValue)).min(1).max(MAX_UPLOAD_ROWS),
});

// ── helpers ────────────────────────────────────────────────────────────────

function actorUserId(req: PrincipalRequest): string | null {
  // Same validate-or-null the merge controller learned the hard way: on the
  // dev admin-key path `principal.userId` is the literal string "admin-key",
  // and inserting that into a uuid FK throws 22P02.
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}

/**
 * Infer the schema and normalise the rows.
 *
 * Cells are stored as TEXT in jsonb, even numeric ones, because the type is a
 * property of the COLUMN and not of the cell: one row with "N/A" in an amount
 * column must not make that cell a string while its neighbours are numbers.
 * The query compiler casts on read, from the inferred column type, which is
 * the single decision point.
 */
function inferUpload(
  headers: string[],
  rawRows: Array<Record<string, unknown>>,
): { columns: ColumnMeta[]; rows: Array<Record<string, string>> } {
  const seen = new Set<string>();
  for (const header of headers) {
    const key = header.trim().toLowerCase();
    if (key === "") throw new BadRequestException("A column heading cannot be blank.");
    if (seen.has(key)) {
      throw new BadRequestException(
        `Two columns are both called "${header}". Rename one before uploading - a mapping cannot tell them apart.`,
      );
    }
    seen.add(key);
  }

  const columns = inferSchema(headers, rawRows);
  const rows = rawRows.map((row) => {
    const out: Record<string, string> = {};
    for (const header of headers) {
      const value = row[header];
      out[header] = value === null || value === undefined ? "" : String(value).trim();
    }
    return out;
  });
  return { columns, rows };
}

/**
 * Bulk-insert rows in chunks.
 *
 * 500 rows per statement: Postgres's own bind-parameter ceiling is 65,535, and
 * one parameter per row (the whole row as one jsonb) leaves plenty of headroom
 * while keeping the number of round trips for a 50,000-row file at 100 rather
 * than 50,000.
 */
async function insertRows(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  orgId: string,
  datasetId: string,
  rows: Array<Record<string, string>>,
): Promise<void> {
  const CHUNK = 500;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [orgId, datasetId];
    chunk.forEach((row, i) => {
      params.push(start + i, JSON.stringify(row));
      values.push(`($1, $2, $${params.length - 1}, $${params.length}::jsonb)`);
    });
    await client.query(
      `INSERT INTO report_dataset_rows (org_id, dataset_id, row_index, data) VALUES ${values.join(", ")}`,
      params,
    );
  }
}

/**
 * Parse a stored doc, or null.
 *
 * A document written by an older version of the schema must not 500 the
 * refresh endpoint - the drift report is a nicety, and skipping one
 * unparseable report is far better than failing the upload that already
 * succeeded.
 */
function ReportDocOrNull(raw: unknown) {
  const parsed = ReportDoc.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

function nameConflict(err: unknown, name: string): unknown {
  if (typeof err !== "object" || err === null) return err;
  if ((err as { code?: string }).code !== "23505") return err;
  return new ConflictException(`a data source named "${name}" already exists`);
}
