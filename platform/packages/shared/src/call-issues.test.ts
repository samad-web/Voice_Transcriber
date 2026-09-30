import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CALL_ISSUE_CATEGORIES,
  CALL_ISSUE_LIVE_STATUSES,
  CALL_ISSUE_SEVERITIES,
  CallIssueCategory,
  CallIssueEventKind,
  CallIssueResolution,
  CallIssueSeverity,
  CallIssueStatus,
  CallIssueVisibility,
  callIssueRef,
} from "./call-issues";

/** Same walk-up as notification-kinds.test.ts - the package compiles as CommonJS. */
const MIGRATIONS_DIR = (() => {
  let dir = resolve(process.cwd());
  for (let up = 0; up < 6; up++) {
    const candidate = join(dir, "packages", "db", "migrations");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("packages/db/migrations not found above " + process.cwd());
})();

/** Every migration, in apply order, with line comments stripped: the CHECK lists
 *  carry explanatory comments between their values. */
const SQL = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
  .join("\n")
  .replace(/--[^\n]*/g, "");

/** Whitespace flattened, so a CHECK that wraps onto the next line reads the same
 *  as one that does not. */
const FLAT = SQL.replace(/\s+/g, " ");

/**
 * One `CREATE TABLE`'s column list, by balanced parentheses rather than by
 * regex.
 *
 * Both narrowings this helper applies were bought the hard way, in one sitting:
 *
 *   * matching "the last CHECK naming this column" across all migrations found
 *     0147's own table-level invariant, `CHECK (status IN ('resolved',
 *     'rejected', 'duplicate', 'withdrawn') OR ...)` - a different constraint
 *     saying something else entirely;
 *   * and then it found `export_jobs.status` from 0148, a table with nothing to
 *     do with this one. Any two tables in this schema may name a column the
 *     same, so the table has to bound the search.
 */
function tableBody(table: string): string {
  const start = FLAT.indexOf(`CREATE TABLE IF NOT EXISTS ${table} (`);
  expect(start, `CREATE TABLE ${table} not found in any migration`).toBeGreaterThanOrEqual(0);
  const open = FLAT.indexOf("(", start);
  let depth = 0;
  for (let i = open; i < FLAT.length; i++) {
    if (FLAT[i] === "(") depth++;
    else if (FLAT[i] === ")" && --depth === 0) return FLAT.slice(open + 1, i);
  }
  throw new Error(`unbalanced parentheses in CREATE TABLE ${table}`);
}

/**
 * The values of a COLUMN DEFINITION's own `CHECK (col IN (...))`, inside one
 * table.
 *
 * The non-greedy `[^,]*?` cannot cross into another column, because the only
 * thing between a column's name and its own CHECK is modifiers with no comma in
 * them.
 *
 * Reads the column definition and NOT a later `ALTER TABLE ... ADD CONSTRAINT`,
 * so a migration that widens one of these vocabularies later has to update this
 * test too. That is the intended cost: the failure is visible and names the
 * column, which is the whole point of the file.
 */
function valuesInColumnCheck(table: string, column: string): string[] {
  const body = tableBody(table);
  const re = new RegExp(`\\b${column} text[^,]*?CHECK \\(${column} IN \\(([^)]*)\\)`, "g");
  const all = [...body.matchAll(re)];
  expect(all.length, `no column CHECK (${column} IN (...)) on ${table}`).toBe(1);
  return Array.from(all[0][1].matchAll(/'([^']*)'/g), (m) => m[1]).sort();
}

/**
 * ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
 *
 * The same drift 0100's header records for `notifications.kind`, one table over:
 * a value the zod enum knows and the CHECK does not is a 23514 at runtime, on
 * the write path, in production - and a value the CHECK knows and the enum does
 * not is a row no console can render. Five vocabularies now have to agree, so
 * the comparison is machine-made rather than remembered.
 */
describe("call issue vocabulary vs migration 0147", () => {
  it("matches the call_issue_reports.category CHECK", () => {
    expect([...CallIssueCategory.options].sort()).toEqual(valuesInColumnCheck("call_issue_reports", "category"));
  });

  it("matches the severity CHECK", () => {
    expect([...CallIssueSeverity.options].sort()).toEqual(valuesInColumnCheck("call_issue_reports", "severity"));
  });

  it("matches the status CHECK", () => {
    expect([...CallIssueStatus.options].sort()).toEqual(valuesInColumnCheck("call_issue_reports", "status"));
  });

  it("matches the resolution CHECK", () => {
    expect([...CallIssueResolution.options].sort()).toEqual(valuesInColumnCheck("call_issue_reports", "resolution"));
  });

  it("matches the call_issue_events.visibility CHECK", () => {
    expect([...CallIssueVisibility.options].sort()).toEqual(valuesInColumnCheck("call_issue_events", "visibility"));
  });

  /**
   * `kind` is deliberately checked against the INLINE table CHECK and not the
   * `notifications_kind_check` constraint that 0147 also rewrites - two columns
   * in the same file are both called `kind`, and the loose regex would otherwise
   * compare the event vocabulary against the bell's.
   */
  it("matches the call_issue_events.kind CHECK", () => {
    expect([...CallIssueEventKind.options].sort()).toEqual(valuesInColumnCheck("call_issue_events", "kind"));
  });
});

/**
 * The two partial indexes ARE the dedupe rule and the work queue. If this list
 * and their predicates drift, a double-press quietly becomes two tickets (the
 * unique index stops covering a status somebody added) or a live ticket vanishes
 * from the queue - neither of which fails anything else.
 */
describe("CALL_ISSUE_LIVE_STATUSES", () => {
  it("is exactly what both partial indexes call live", () => {
    const predicates = [
      ...SQL.matchAll(
        /CREATE (?:UNIQUE )?INDEX IF NOT EXISTS call_issue_reports_(?:queue|live)[\s\S]*?WHERE status IN \(([^)]*)\)/g,
      ),
    ];
    expect(predicates).toHaveLength(2);
    for (const [, list] of predicates) {
      expect(Array.from(list.matchAll(/'([^']*)'/g), (m) => m[1]).sort()).toEqual(
        [...CALL_ISSUE_LIVE_STATUSES].sort(),
      );
    }
  });

  it("holds no terminal status", () => {
    for (const status of CALL_ISSUE_LIVE_STATUSES) {
      expect(["resolved", "rejected", "duplicate", "withdrawn"]).not.toContain(status);
    }
  });
});

describe("the console-facing labels", () => {
  it("words every category and severity, and nothing else", () => {
    expect(Object.keys(CALL_ISSUE_CATEGORIES).sort()).toEqual([...CallIssueCategory.options].sort());
    expect(Object.keys(CALL_ISSUE_SEVERITIES).sort()).toEqual([...CallIssueSeverity.options].sort());
  });

  /**
   * A missed call from the handset's log (0133) has no recording and no
   * transcript. The dialog offers only the categories that can be true of it, so
   * at least one must be - otherwise that call has a Report button and nothing
   * to report.
   */
  it("leaves something reportable on a call with no recording", () => {
    const withoutAudio = Object.entries(CALL_ISSUE_CATEGORIES).filter(
      ([, spec]) => !spec.needsRecording,
    );
    expect(withoutAudio.length).toBeGreaterThan(1);
    expect(withoutAudio.map(([key]) => key)).toContain("missing_call");
  });
});

describe("callIssueRef", () => {
  it("pads to six digits and grows past them", () => {
    expect(callIssueRef(1)).toBe("AUR-000001");
    expect(callIssueRef(141)).toBe("AUR-000141");
    expect(callIssueRef(1234567)).toBe("AUR-1234567");
  });
});
