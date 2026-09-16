import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  applyDerived,
  applyTopN,
  MAX_RESULT_ROWS,
  ReportDoc,
  resolveBindings,
  type BindingIssue,
  type ColumnMeta,
  type QuerySpec,
  type ResultRow,
} from "@aura/shared";
import type { CrmRecordScope } from "../../common/crm-scope";
import { DbService } from "../../db/db.service";
import { crmSource, crmSourceSchema } from "./crm-sources";
import { compileCrmQuery, compileUploadQuery } from "./query-compiler";

/**
 * The Report Builder's one service (migration 0077).
 *
 * Holds the three things that must not be reimplemented per controller: how a
 * dataset resolves to a schema, how a widget's spec becomes rows, and who is
 * allowed to do what to a report. The last one especially - a permission check
 * copied into six handlers is a permission check that is wrong in one of them.
 */

export type ShareRole = "owner" | "editor" | "viewer";

/** Narrowest first. `atLeast` compares by index, so the order is the policy. */
const ROLE_RANK: ShareRole[] = ["viewer", "editor", "owner"];

export interface ReportAccess {
  reportId: string;
  role: ShareRole;
  status: "draft" | "published" | "archived";
  name: string;
  revision: number;
}

export interface WidgetResult {
  rows: ResultRow[];
  dimensionKeys: string[];
  measureKeys: string[];
  /** True when Top-N collapsed a tail into "Other" - the tile says so. */
  truncated: boolean;
  /** Populated instead of rows when the widget could not run. Never both. */
  error?: string;
}

export interface DatasetRecord {
  id: string;
  name: string;
  kind: "crm" | "upload";
  source_key: string | null;
  columns: ColumnMeta[];
  row_count: number;
  schema_fingerprint: string | null;
  refreshed_at: string | null;
  created_at: string;
}

type QueryClient = {
  query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number | null }>;
};

@Injectable()
export class ReportBuilderService {
  constructor(private readonly db: DbService) {}

  // ── datasets ──────────────────────────────────────────────────────────

  async dataset(orgId: string, datasetId: string): Promise<DatasetRecord> {
    const { rows } = await this.db.withOrg(orgId, (client) =>
      client.query<DatasetRecord>(
        `SELECT id, name, kind, source_key, columns, row_count, schema_fingerprint,
                refreshed_at, created_at
           FROM report_datasets WHERE id = $1 AND deleted_at IS NULL`,
        [datasetId],
      ),
    );
    const dataset = rows[0];
    if (!dataset) throw new NotFoundException("data source not found");
    return dataset;
  }

  /**
   * A dataset's schema, whichever kind it is.
   *
   * For an upload this is the stored inference; for a CRM source it is the
   * hand-written catalogue. Both come back as `ColumnMeta[]`, which is what
   * lets the mapper, the suggestion engine and the drift checker treat the two
   * identically - see crm-sources.ts's note on that symmetry.
   */
  schemaFor(dataset: DatasetRecord): ColumnMeta[] {
    if (dataset.kind === "upload") return dataset.columns ?? [];
    const source = dataset.source_key ? crmSource(dataset.source_key) : undefined;
    if (!source) {
      // The catalogue changed under a saved dataset - a column was removed in
      // a deploy. Loud, not silent: an empty schema would make every widget on
      // it render "no data" with nothing to explain why.
      throw new BadRequestException(
        `This data source points at "${dataset.source_key}", which no longer exists in this version of the platform.`,
      );
    }
    return crmSourceSchema(source);
  }

  /**
   * Run one widget's query.
   *
   * Never throws for a query-level problem - a single broken widget must not
   * take down the page it is on, and the prompt (3.7) is explicit that every
   * failure gets a message rather than a blank tile. Errors come back INSIDE
   * the result so the canvas can render them per-widget.
   */
  async runWidget(
    orgId: string,
    datasetId: string,
    spec: QuerySpec,
    recordScope: CrmRecordScope,
  ): Promise<WidgetResult> {
    try {
      const dataset = await this.dataset(orgId, datasetId);
      const compiled =
        dataset.kind === "crm"
          ? compileCrmQuery(this.requireSource(dataset.source_key), spec, orgId, recordScope)
          : compileUploadQuery(this.schemaFor(dataset), spec, orgId, dataset.id);

      const { rows } = await this.db.withOrg(orgId, (client) =>
        client.query<ResultRow>(compiled.sql, compiled.params),
      );

      // Order matters: derived fields may reference measures, and Top-N must
      // cut on the FINAL sort, so derivation runs first.
      const derived = applyDerived(rows, spec.derived ?? []);
      const measureKeys = [...compiled.measureKeys, ...(spec.derived ?? []).map((d) => d.alias)];
      const capped = applyTopN(derived, spec.topN, compiled.dimensionKeys, measureKeys);

      return {
        rows: capped,
        dimensionKeys: compiled.dimensionKeys,
        measureKeys,
        truncated: capped.length < derived.length,
      };
    } catch (err) {
      return {
        rows: [],
        dimensionKeys: [],
        measureKeys: [],
        truncated: false,
        error: errorMessage(err),
      };
    }
  }

  private requireSource(key: string | null) {
    const source = key ? crmSource(key) : undefined;
    if (!source) throw new BadRequestException(`Unknown CRM data source "${key}".`);
    return source;
  }

  /**
   * Which widgets in a document no longer line up with their data.
   *
   * Loads every referenced dataset's schema once and hands the whole map to
   * the shared `resolveBindings`, which is the same function the template
   * binder uses. One implementation of "is this mapping still valid", by
   * construction (design doc D4).
   */
  async bindingIssues(orgId: string, doc: ReportDoc): Promise<BindingIssue[]> {
    const ids = new Set<string>();
    for (const page of doc.pages) {
      for (const widget of page.widgets) {
        if (widget.datasetId) ids.add(widget.datasetId);
      }
    }
    if (ids.size === 0) return [];

    const schemaByDataset: Record<string, ColumnMeta[]> = {};
    for (const id of ids) {
      try {
        schemaByDataset[id] = this.schemaFor(await this.dataset(orgId, id));
      } catch {
        // Leave it absent. resolveBindings reports an absent dataset as a
        // broken widget with its own message, which is exactly right here.
      }
    }
    return resolveBindings(doc, schemaByDataset);
  }

  // ── access control ────────────────────────────────────────────────────

  /**
   * What this user may do to this report, or a 403/404.
   *
   * ── THE TWO LAYERS, AND WHY BOTH ────────────────────────────────────
   *
   * `CrmPermissionsGuard` has already established that the caller may see deal
   * data at all (design doc D7). This establishes whether THIS report is
   * theirs. Passing the first and failing the second is ordinary: a manager
   * who can read every deal in the org still has no business editing a report
   * somebody else built, and a report is a document with an author.
   *
   * Three ways to have access, in order:
   *   1. an explicit `report_shares` row - the normal path;
   *   2. being the creator, which is implicit ownership and survives someone
   *      deleting the share row by accident;
   *   3. holding the org-wide link, when the report is published and a link
   *      has been minted - read-only, and only ever `viewer`.
   *
   * `linkToken` is checked LAST and only ever widens to `viewer`, so a token
   * can never upgrade an editor into an owner or vice versa.
   */
  async access(
    orgId: string,
    reportId: string,
    userId: string | null,
    linkToken?: string,
  ): Promise<ReportAccess> {
    const { rows } = await this.db.withOrg(orgId, (client) =>
      client.query<{
        id: string;
        name: string;
        status: ReportAccess["status"];
        revision: number;
        created_by: string | null;
        public_token: string | null;
        share_role: ShareRole | null;
      }>(
        `SELECT r.id, r.name, r.status, r.revision, r.created_by, r.public_token,
                s.role AS share_role
           FROM reports r
           LEFT JOIN report_shares s ON s.report_id = r.id AND s.user_id = $2
          WHERE r.id = $1`,
        [reportId, userId],
      ),
    );

    const report = rows[0];
    if (!report) throw new NotFoundException("report not found");

    const role = this.roleFor(report, userId, linkToken);
    if (!role) throw new ForbiddenException("you do not have access to this report");

    return {
      reportId: report.id,
      role,
      status: report.status,
      name: report.name,
      revision: report.revision,
    };
  }

  private roleFor(
    report: { created_by: string | null; public_token: string | null; status: string },
    userId: string | null,
    linkToken: string | undefined,
  ): ShareRole | null {
    const shared = (report as { share_role?: ShareRole | null }).share_role ?? null;
    if (shared) return shared;
    if (userId && report.created_by === userId) return "owner";
    // A link only opens a PUBLISHED report. Handing out a link to a draft
    // would make "publish" meaningless - see design doc D9.
    if (
      linkToken &&
      report.public_token &&
      report.status === "published" &&
      timingSafeEqualish(linkToken, report.public_token)
    ) {
      return "viewer";
    }
    return null;
  }

  /** Throws unless `role` is at least `required`. */
  requireRole(access: ReportAccess, required: ShareRole): void {
    if (ROLE_RANK.indexOf(access.role) < ROLE_RANK.indexOf(required)) {
      throw new ForbiddenException(
        `this needs ${required} access to the report; you have ${access.role}`,
      );
    }
  }

  // ── runs ──────────────────────────────────────────────────────────────

  /**
   * Execute every widget in a document and freeze the results.
   *
   * The one place this feature stores data (migration 0077's `report_runs`
   * header explains why it earns the exception). A widget that fails is
   * recorded WITH its error rather than omitted, so a partial run renders as
   * "these four worked, this one did not, here is why" instead of a page that
   * is quietly missing a tile.
   */
  async renderSnapshot(
    orgId: string,
    doc: ReportDoc,
    recordScope: CrmRecordScope,
  ): Promise<{ snapshot: unknown; failures: string[] }> {
    const widgets: Record<string, WidgetResult> = {};
    const failures: string[] = [];

    for (const page of doc.pages) {
      for (const widget of page.widgets) {
        if (widget.type === "text" || widget.type === "divider") continue;
        if (!widget.datasetId || !widget.query) {
          widgets[widget.id] = {
            rows: [],
            dimensionKeys: [],
            measureKeys: [],
            truncated: false,
            error: "No data source is mapped to this widget yet.",
          };
          failures.push(`${widget.title ?? widget.id}: not mapped`);
          continue;
        }
        const result = await this.runWidget(orgId, widget.datasetId, widget.query, recordScope);
        widgets[widget.id] = result;
        if (result.error) failures.push(`${widget.title ?? widget.id}: ${result.error}`);
      }
    }

    return {
      // The doc travels WITH the snapshot so a run still renders correctly
      // after the report is re-laid-out, renamed, or deleted outright.
      snapshot: { doc, widgets, generatedAt: new Date().toISOString() },
      failures,
    };
  }

  /** The audit trail the prompt requires (3.4). One shape, every action. */
  async audit(
    client: QueryClient,
    orgId: string,
    actorUserId: string | null,
    action: string,
    targetId: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      // `actor_id` is `text NOT NULL`, so an unresolvable caller becomes the
      // literal 'system' rather than a null the insert would reject - an audit
      // row we cannot attribute is still far better than a lost one.
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
       VALUES ($1, $2, $3, $4, 'report', $5, $6)`,
      [
        orgId,
        actorUserId ? "user" : "system",
        actorUserId ?? "system",
        action,
        targetId,
        JSON.stringify(meta ?? {}),
      ],
    );
  }

  /** Rows for a widget's CSV export - the SAME call the chart renders from. */
  async exportRows(
    orgId: string,
    datasetId: string,
    spec: QuerySpec,
    recordScope: CrmRecordScope,
  ): Promise<WidgetResult> {
    // Deliberately the same method the chart uses, not a parallel "export"
    // path. Acceptance criterion 14 is that the CSV matches what is on screen;
    // the only way to guarantee that is for there to be one query.
    return this.runWidget(
      orgId,
      datasetId,
      { ...spec, limit: Math.min(spec.limit ?? MAX_RESULT_ROWS, MAX_RESULT_ROWS) },
      recordScope,
    );
  }
}

/**
 * Constant-ish time comparison for the share token.
 *
 * `timingSafeEqual` from node:crypto needs equal-length buffers and throws
 * otherwise, which itself leaks length - so length is checked first and the
 * comparison is a fixed-cost XOR fold. The token is 32 CSPRNG bytes, so timing
 * is not a realistic attack here; this is cheap and removes the question.
 */
function timingSafeEqualish(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A message a person can act on, never a stack trace.
 *
 * Nest exceptions carry a curated message (the compiler's "Unknown column X",
 * the scope refusal). Anything else is a Postgres or programming error whose
 * text could name a table or a constraint, so it is replaced - the detail is
 * still in the server log where the operator can reach it.
 */
function errorMessage(err: unknown): string {
  if (err instanceof BadRequestException || err instanceof ForbiddenException) {
    const response = err.getResponse();
    if (typeof response === "string") return response;
    const message = (response as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  if (err instanceof NotFoundException) return "The data source for this widget no longer exists.";
  console.error("[report-builder] widget query failed:", err);
  return "This widget could not be built. Check its column mapping.";
}
