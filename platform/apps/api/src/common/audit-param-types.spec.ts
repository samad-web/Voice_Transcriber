import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * No `audit_log` INSERT may reuse one placeholder for `org_id` and `target_id`.
 *
 * ── WHY THIS TEST EXISTS ────────────────────────────────────────────────────
 *
 * `org_id` is uuid and `target_id` is text. Writing the org id into both by
 * repeating the same `$n` looks obviously correct - it IS the same value - but
 * Postgres has to deduce one type per parameter, and a parameter used as both
 * uuid and text fails to prepare:
 *
 *     42P08  inconsistent types deduced for parameter $1
 *     DETAIL uuid versus text
 *
 * It fails at PREPARE, so the statement never runs and the endpoint 500s on
 * EVERY call, for every tenant, from the moment it ships. There is no partial
 * or intermittent version of this - which is the one mercy, and also why it
 * survives review: the diff reads fine and nothing short of executing the
 * statement catches it.
 *
 * Found on 2026-10-12 when applying a plan to a production tenant returned a
 * 500 and `POST /v1/admin/plans/orgs/:orgId` turned out never to have worked -
 * every org still had `plan_key = NULL`. A sweep then found the same shape in
 * `kpi.config_saved` (so no tenant could ever have saved a KPI set),
 * `org.task_settings`, and the dialer's settings audit. `admin.controller.ts`
 * had already hit it once and left a comment; the comment did not stop it
 * recurring three more times, so here is a test instead.
 *
 * ── WHAT IT CHECKS ──────────────────────────────────────────────────────────
 *
 * Source text, not behaviour. A real check would PREPARE every statement
 * against Postgres, which is the integration suite's job and needs a database;
 * this one needs nothing, runs in milliseconds, and catches the exact shape
 * that has now gone wrong four times. The fix is always the same: give
 * `target_id` its own parameter and pass the org id twice.
 */

const API_SRC = join(__dirname, "..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "dist") continue;
      out.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".spec.ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Every `INSERT INTO audit_log ... VALUES (...)` in the file, as
 * `{ columns, values }` with whitespace collapsed.
 */
function auditInserts(sql: string): { columns: string[]; values: string[] }[] {
  const found: { columns: string[]; values: string[] }[] = [];
  const NEEDLE = "INSERT INTO audit_log";

  // A hand-rolled scanner, not a regex: an earlier regex version of this
  // backtracked catastrophically over these files and crashed V8 outright.
  for (let at = sql.indexOf(NEEDLE); at !== -1; at = sql.indexOf(NEEDLE, at + 1)) {
    const colOpen = sql.indexOf("(", at);
    if (colOpen === -1) continue;
    const colClose = sql.indexOf(")", colOpen);
    if (colClose === -1) continue;
    const columns = sql
      .slice(colOpen + 1, colClose)
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);

    const valuesAt = sql.indexOf("VALUES", colClose);
    if (valuesAt === -1) continue;
    const open = sql.indexOf("(", valuesAt);
    if (open === -1) continue;

    // Walk to the matching close paren, respecting nesting and quotes.
    let depth = 0;
    let quote: string | null = null;
    let close = -1;
    for (let i = open; i < sql.length; i++) {
      const ch = sql[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) continue;

    const values: string[] = [];
    let depth2 = 0;
    let quote2: string | null = null;
    let cur = "";
    for (const ch of sql.slice(open + 1, close)) {
      if (quote2) {
        if (ch === quote2) quote2 = null;
        cur += ch;
        continue;
      }
      if (ch === "'" || ch === '"') quote2 = ch;
      if (ch === "(") depth2++;
      if (ch === ")") depth2--;
      if (ch === "," && depth2 === 0) {
        values.push(cur.trim());
        cur = "";
        continue;
      }
      cur += ch;
    }
    if (cur.trim()) values.push(cur.trim());
    found.push({ columns, values });
  }
  return found;
}

/** The `$n` in an expression like `$3::jsonb`, or null for a literal. */
function placeholderOf(expr: string): string | null {
  const m = expr.match(/\$(\d+)/);
  return m ? `$${m[1]}` : null;
}

describe("audit_log parameter types (42P08)", () => {
  const files = sourceFiles(API_SRC);

  it("finds the audit_log inserts at all - the regex must not silently match nothing", () => {
    const total = files.reduce((n, f) => n + auditInserts(readFileSync(f, "utf8")).length, 0);
    // If a refactor changes how these statements are written and the parser
    // stops seeing them, this test would pass by seeing nothing. It must not.
    expect(total).toBeGreaterThan(50);
  });

  it("never binds org_id (uuid) and target_id (text) to the same placeholder", () => {
    const offenders: string[] = [];

    for (const file of files) {
      for (const { columns, values } of auditInserts(readFileSync(file, "utf8"))) {
        if (columns.length !== values.length) continue; // not a shape we can read
        const orgAt = columns.indexOf("org_id");
        const targetAt = columns.indexOf("target_id");
        if (orgAt === -1 || targetAt === -1) continue;

        const org = placeholderOf(values[orgAt]);
        const target = placeholderOf(values[targetAt]);
        // A literal target_id (e.g. 'call-insights') is fine - only a SHARED
        // placeholder across the two columns is the bug.
        if (org && target && org === target) {
          offenders.push(`${file.replace(API_SRC, "")}: org_id and target_id both ${org}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
