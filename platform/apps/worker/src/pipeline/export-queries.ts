import {
  EXPORT_LIMITS,
  type ExportDataset,
  type ExportDatasetKey,
  type OwnerRecordScope,
  ownerScopeClause,
  visibleColumns,
} from "@aura/shared";

/**
 * The SQL behind each exportable dataset (doc 35 SS3.3, migration 0148).
 *
 * ── WHY THE SELECT LIST IS WRITTEN OUT AND NOT GENERATED ────────────────────
 *
 * The registry in `@aura/shared/export-datasets` names the columns of the FILE
 * - the header row, the manifest, what the drawer offers. It is a contract with
 * the reader. This module names the columns of the DATABASE, and the two are
 * not the same thing: `leads.contact_number_prefix` is a real column,
 * `assigned_telecaller` is a join, and `phone` is neither because the schema
 * has never stored one.
 *
 * Generating the SQL from the registry would have required them to be the same,
 * which is how the first draft of that registry ended up offering `leads.phone`
 * and `contacts.phone` - columns no query could have filled. So: the SQL is
 * written by hand against the migrations, each output is ALIASED to the
 * registry's name, and `export-queries.test.ts` asserts the two lists match
 * exactly. A column added to one and not the other fails that test rather than
 * producing a file with a blank column or a missing one.
 *
 * ── WHAT IS NOT IN ANY OF THESE ─────────────────────────────────────────────
 *
 * A full phone number. `leads`, `calls` and `contacts` each store a per-org
 * HMAC plus a prefix and the last three digits and nothing else (0001, 0006),
 * so there is no column here to select and no join that reassembles one. This
 * is a property of the schema rather than a rule this file enforces, and it is
 * written down because "why does the export not have phone numbers" is a
 * question somebody will ask.
 *
 * ── KEYSET, NEVER OFFSET ────────────────────────────────────────────────────
 *
 * Every query takes a cursor of the previous page's last (sort value, id) and
 * asks for rows strictly after it. OFFSET on a million-row table re-scans the
 * whole prefix on every page, and at ~125ms per round trip the job would not
 * finish. The order always ENDS in `id`, because a non-unique sort silently
 * drops and duplicates rows across page boundaries - a file that is subtly
 * wrong with nothing to notice.
 */

export interface Cursor {
  /** The sort column's value on the last row of the previous page. */
  sortValue: string;
  id: string;
}

/**
 * The extra output column carrying the sort value as TEXT, for the cursor.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS NOT JUST THE SORT COLUMN ─────────────────
 *
 * Postgres timestamps carry MICROsecond precision; a JavaScript `Date` carries
 * milliseconds. Reading `created_at` back through the pg driver and sending it
 * out again as `toISOString()` therefore truncates `09:43:42.860494` to
 * `09:43:42.860` - an EARLIER instant - and the next page's
 * `(created_at, id) < ($cursor, $id)` then excludes every row that shares that
 * second. Rows vanish from the middle of the export, silently, and only when
 * two rows were written in the same transaction.
 *
 * That was not hypothetical: it dropped a seeded lead in
 * `tests/export-engine.test.ts` the first time these queries met a real
 * database, and no amount of asserting the SQL text would have shown it.
 *
 * So the cursor value never round-trips through a JS date type. Postgres renders
 * it as text, the worker hands that same text back, and Postgres parses its own
 * output. The column is prefixed and quoted so it cannot collide with a
 * registry column name, and the CSV writer never sees it - it writes the
 * registry's columns by name, and this is not one of them.
 */
export const CURSOR_COLUMN = "__cursor";

export interface DatasetQuery {
  sql: string;
  params: unknown[];
}

/** The scopes the engine resolved for the requester, already intersected. */
export interface ResolvedScope {
  owner: OwnerRecordScope;
  /** The grid's `owned` user id, or null when the grid did not narrow. */
  crmUserId: string | null;
}

/**
 * The sort column each dataset pages on - the first term of its
 * `defaultOrder`, as a column this module can name in a WHERE.
 *
 * Kept beside the SQL rather than parsed out of `defaultOrder`: parsing a
 * string that also contains "DESC, id DESC" to recover a column name is the
 * kind of cleverness that breaks the day somebody writes an expression there.
 */
const SORT_COLUMN: Record<ExportDatasetKey, string> = {
  leads: "l.created_at",
  lead_stage_transitions: "t.created_at",
  calls: "c.started_at",
  call_transcripts: "tr.created_at",
  contacts: "ct.created_at",
  accounts: "a.created_at",
  deals: "d.created_at",
  tasks: "tk.created_at",
  conversations: "cv.last_message_at",
  products: "p.created_at",
  quotations: "q.created_at",
  invoices: "iv.created_at",
  attendance: "at.day",
  members: "m.created_at",
  audit_log: "al.created_at",
};

/** The primary-key expression for the tiebreak, per dataset. */
const ID_COLUMN: Record<ExportDatasetKey, string> = {
  leads: "l.id",
  lead_stage_transitions: "t.id",
  calls: "c.id",
  call_transcripts: "tr.id",
  contacts: "ct.id",
  accounts: "a.id",
  deals: "d.id",
  tasks: "tk.id",
  conversations: "cv.id",
  products: "p.id",
  quotations: "q.id",
  invoices: "iv.id",
  attendance: "at.id",
  members: "m.id",
  audit_log: "al.id",
};

/**
 * The SELECT list for a dataset, aliased to the registry's column names.
 *
 * E1 implements three: leads, calls, contacts. The rest throw, which is the
 * honest failure - a dataset offered in the drawer but not implemented here
 * would otherwise produce an empty file rather than an error.
 */
function selectList(dataset: ExportDataset, canExportRecordings: boolean): string {
  const wanted = new Set(visibleColumns(dataset, canExportRecordings).map((c) => c.name));
  const pick = (expr: string, alias: string): string | null =>
    wanted.has(alias) ? `${expr} AS "${alias}"` : null;

  switch (dataset.key) {
    case "leads":
      return [
        pick("l.id", "id"),
        pick("l.title", "title"),
        pick("l.contact_name", "contact_name"),
        pick("l.contact_number_prefix", "contact_number_prefix"),
        pick("l.contact_number_last3", "contact_number_last3"),
        pick("l.stage", "stage"),
        pick("l.status", "status"),
        pick("l.temperature", "temperature"),
        pick("l.score", "score"),
        pick("l.value_num", "value_num"),
        // The assigned telecaller's display name, not the id - a uuid in a
        // spreadsheet helps nobody. LEFT JOIN so an unassigned lead still
        // exports, with a blank here rather than being dropped from the file.
        pick("atc.display_name", "assigned_telecaller"),
        pick("l.call_count", "call_count"),
        pick("l.last_activity_at", "last_activity_at"),
        pick("l.created_at", "created_at"),
        pick("l.updated_at", "updated_at"),
      ]
        .filter(Boolean)
        .join(", ");

    case "calls":
      return [
        pick("c.id", "id"),
        pick("c.direction", "direction"),
        pick("c.remote_number_prefix", "remote_number_prefix"),
        pick("c.remote_number_last3", "remote_number_last3"),
        pick("c.remote_name", "remote_name"),
        pick("tc.display_name", "telecaller"),
        pick("c.started_at", "started_at"),
        pick("c.ended_at", "ended_at"),
        pick("c.duration_s", "duration_s"),
        pick("c.status", "status"),
        pick("c.disposition_key", "disposition_key"),
        pick("c.missed_reason", "missed_reason"),
        // Everything below is behind recordings:export. `pick` returns null for
        // each of them when the grant is absent, so the columns are not merely
        // blanked - they are never selected, and the recording key never leaves
        // the database. That is the difference between redaction and a join
        // somebody can inspect in a log.
        pick("r.s3_key", "recording_url"),
        // The AI read lives in `transcripts.intelligence`, a jsonb blob added
        // by 0005 - there is no call_analyses table, and `call_facts` is an
        // EAV of extracted FIELDS rather than the call-level read. Same
        // `->> 'key'` access the calls API already uses
        // (owner-calls.controller.ts:126-128), so the export and the console
        // cannot disagree about what "summary" means.
        pick("tr.intelligence ->> 'summary'", "summary"),
        pick("tr.intelligence ->> 'sentiment'", "sentiment"),
        pick("tr.intelligence ->> 'intent'", "intent"),
      ]
        .filter(Boolean)
        .join(", ");

    case "contacts":
      return [
        pick("ct.id", "id"),
        pick("ct.display_name", "display_name"),
        pick("ct.first_name", "first_name"),
        pick("ct.last_name", "last_name"),
        pick("ct.email", "email"),
        pick("ct.phone_prefix", "phone_prefix"),
        pick("ct.phone_last3", "phone_last3"),
        // `title` on contacts is the person's JOB title. Aliased away from the
        // column name because a spreadsheet column called "title" beside a
        // lead export whose "title" is the board heading is a trap.
        pick("ct.title", "job_title"),
        pick("acc.name", "account"),
        pick("u.name", "owner"),
        pick("ct.status", "status"),
        pick("ct.created_at", "created_at"),
      ]
        .filter(Boolean)
        .join(", ");

    default:
      throw new Error(`export dataset not implemented in E1: ${dataset.key}`);
  }
}

/** The FROM/JOIN clause. Joins are LEFT throughout, for the reason above. */
function fromClause(key: ExportDatasetKey): string {
  switch (key) {
    case "leads":
      return `FROM leads l
              LEFT JOIN telecallers atc ON atc.id = l.assigned_telecaller_id`;
    case "calls":
      return `FROM calls c
              LEFT JOIN telecallers tc ON tc.id = c.telecaller_id
              LEFT JOIN recordings r ON r.call_id = c.id
              LEFT JOIN transcripts tr ON tr.call_id = c.id`;
    case "contacts":
      return `FROM contacts ct
              LEFT JOIN accounts acc ON acc.id = ct.account_id
              LEFT JOIN users u ON u.id = ct.owner_user_id`;
    default:
      throw new Error(`export dataset not implemented in E1: ${key}`);
  }
}

/**
 * Build one page of a dataset.
 *
 * ── THE SCOPE PREDICATES ARE APPLIED HERE, AND ONLY HERE ────────────────────
 *
 * Both axes, ANDed - never ORed. `ownerScopeClause` is imported from
 * `@aura/shared`, which is the SAME function the API's guards use: it moved
 * there for this caller precisely so the worker could not drift from it. The
 * grid's axis is a plain `owner_user_id = $n` where the dataset has that
 * column, per the registry.
 *
 * A dataset whose registry entry names neither axis is exported whole, and that
 * is correct for `products` and `members` - a price list belongs to the
 * workspace. It is a bug for anything person-owned, which is why the registry
 * test pins the axes per dataset.
 *
 * RLS is underneath all of this regardless: every query runs inside
 * `withOrgContext`, so a missing predicate here narrows too little within one
 * tenant and can never cross tenants.
 */
export function buildDatasetQuery(
  dataset: ExportDataset,
  scope: ResolvedScope,
  canExportRecordings: boolean,
  cursor: Cursor | null,
): DatasetQuery {
  const sortColumn = SORT_COLUMN[dataset.key];
  const idColumn = ID_COLUMN[dataset.key];
  const params: unknown[] = [];
  const where: string[] = [];

  // The table alias each dataset uses, for the scope predicate.
  const alias = fromClause(dataset.key).match(/FROM \w+ (\w+)/)?.[1] ?? "";

  if (dataset.ownerScope) {
    const clause = ownerScopeClause(dataset.ownerScope, scope.owner, params.length + 1, alias);
    if (clause) {
      where.push(clause);
      // Every placeholder in a returned predicate binds the SAME value, so one
      // parameter covers a two-placeholder predicate like the lead union.
      params.push(scope.owner.telecallerId ?? "00000000-0000-0000-0000-000000000000");
    }
  }

  if (dataset.crmScopeColumn && scope.crmUserId) {
    params.push(scope.crmUserId);
    where.push(`${alias}.${dataset.crmScopeColumn} = $${params.length}`);
  }

  if (cursor) {
    // Row-value comparison rather than the expanded OR form: one index scan,
    // and it cannot be got subtly wrong the way the expanded version can.
    params.push(cursor.sortValue, cursor.id);
    where.push(`(${sortColumn}, ${idColumn}) < ($${params.length - 1}, $${params.length})`);
  }

  params.push(EXPORT_LIMITS.pageRows);

  return {
    sql: `SELECT ${selectList(dataset, canExportRecordings)}, ${sortColumn}::text AS "${CURSOR_COLUMN}"
          ${fromClause(dataset.key)}
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY ${sortColumn} DESC, ${idColumn} DESC
          LIMIT $${params.length}`,
    params,
  };
}

/**
 * The row count for the progress bar, under the same predicates.
 *
 * Best effort: the caller skips it above a threshold rather than pay for a full
 * scan twice, and `rows_total` stays NULL - which the console renders as an
 * indeterminate bar. A count that costs more than the export is not progress.
 */
export function buildCountQuery(dataset: ExportDataset, scope: ResolvedScope): DatasetQuery {
  const query = buildDatasetQuery(dataset, scope, false, null);
  // Drop the LIMIT and its parameter; everything else - joins, both scope
  // predicates - must stay, or the count describes a different query than the
  // one that runs.
  const sql = query.sql.replace(/\s*ORDER BY[\s\S]*$/, "");
  return {
    sql: `SELECT count(*)::bigint AS n FROM (${sql}) s`,
    params: query.params.slice(0, -1),
  };
}

/** The datasets E1 can actually run. The API refuses the rest until E3. */
export const IMPLEMENTED_DATASETS: ExportDatasetKey[] = ["leads", "calls", "contacts"];
