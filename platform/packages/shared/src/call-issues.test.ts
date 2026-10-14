import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CALL_ISSUE_CATEGORIES,
  CALL_ISSUE_LIVE_STATUSES,
  CALL_ISSUE_SEVERITIES,
  CallIssueCategory,
  CallIssueEventKind,
  CallIssueReporterRole,
  CallIssueResolution,
  CallIssueSeverity,
  CallIssueSource,
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
 */
function valuesInColumnDefinition(table: string, column: string): string[] | null {
  const body = tableBody(table);
  const re = new RegExp(`\\b${column} text[^,]*?CHECK \\(${column} IN \\(([^)]*)\\)`, "g");
  const all = [...body.matchAll(re)];
  if (all.length === 0) return null;
  expect(all.length, `ambiguous column CHECK (${column} IN (...)) on ${table}`).toBe(1);
  return Array.from(all[0][1].matchAll(/'([^']*)'/g), (m) => m[1]).sort();
}

/**
 * The LAST `ALTER TABLE <table> ADD CONSTRAINT ... CHECK (col IN (...))` across
 * every migration, or null if no migration ever widened this column.
 *
 * ── WHY THIS WAS ADDED (0201) ───────────────────────────────────────────────
 *
 * This file used to read the column definition and deliberately NOT a later
 * ALTER, on the stated reasoning that a migration which widens a vocabulary
 * "has to update this test too - that is the intended cost".
 *
 * 0201 widened three of these (`category`, `reported_by_role`, and
 * `call_issue_events.kind`) and paid that cost, and paying it showed the
 * reasoning was half right. The failure WAS visible and DID name the column,
 * exactly as intended. But the only repair available was to hard-code 0201's
 * new values into this file by hand - and a guard whose expected list is typed
 * out by the same person who typed the migration is not comparing two
 * independent sources any more. It is comparing a list to itself.
 *
 * So the ALTER is read instead. `effectiveValues` below is now the vocabulary
 * the DATABASE will really enforce after every migration has run, whether that
 * was set in the CREATE TABLE or widened by any migration since, and the
 * comparison against the zod enum stays a comparison of two independent
 * things.
 *
 * ONE RULE THIS IMPOSES ON FUTURE MIGRATIONS, and 0201 learned it the hard way:
 * the ALTER must spell its value list out literally. 0201's first draft built
 * the `kind` constraint at runtime with `pg_get_constraintdef` and `replace()`,
 * which is tidier SQL and completely invisible here - the list would have
 * existed only inside a live database, and this test would have gone on
 * passing while guarding nothing. If you cannot read the vocabulary out of the
 * .sql file, neither can this.
 */
function valuesInLatestAlter(table: string, column: string): string[] | null {
  // The trailing `\)\s*\)` is load-bearing, and it is the same trap the
  // `tableBody` helper above was written to avoid - rediscovered here the
  // moment this function existed.
  //
  // 0147 carries a table-level invariant on the SAME column:
  //
  //     CHECK (status IN ('resolved','rejected','duplicate','withdrawn')
  //            OR resolution IS NULL)
  //
  // That is not a vocabulary. It is a rule about when a resolution may be set,
  // which happens to name four of the vocabulary's members. A reader that
  // stops at the IN list's closing paren matches it happily and then reports
  // that `CallIssueStatus` has eight values too many.
  //
  // Requiring the CHECK's own paren to close immediately after the IN list is
  // what distinguishes "this column may only hold these values" from "this
  // column being one of these values implies something else".
  const re = new RegExp(
    `ALTER TABLE ${table} ADD CONSTRAINT \\S+ CHECK \\(\\s*${column} IN \\(([^)]*)\\)\\s*\\)`,
    "g",
  );
  const all = [...FLAT.matchAll(re)];
  if (all.length === 0) return null;
  const last = all[all.length - 1];
  return Array.from(last[1].matchAll(/'([^']*)'/g), (m) => m[1]).sort();
}

/** What the database will actually enforce once every migration has run. */
function effectiveValues(table: string, column: string): string[] {
  const widened = valuesInLatestAlter(table, column);
  if (widened !== null) return widened;
  const inline = valuesInColumnDefinition(table, column);
  expect(inline, `no CHECK (${column} IN (...)) for ${table}, inline or by ALTER`).not.toBeNull();
  return inline as string[];
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
describe("call issue vocabulary vs the migrations", () => {
  it("matches the call_issue_reports.category CHECK", () => {
    expect([...CallIssueCategory.options].sort()).toEqual(effectiveValues("call_issue_reports", "category"));
  });

  it("matches the severity CHECK", () => {
    expect([...CallIssueSeverity.options].sort()).toEqual(effectiveValues("call_issue_reports", "severity"));
  });

  it("matches the status CHECK", () => {
    expect([...CallIssueStatus.options].sort()).toEqual(effectiveValues("call_issue_reports", "status"));
  });

  it("matches the resolution CHECK", () => {
    expect([...CallIssueResolution.options].sort()).toEqual(effectiveValues("call_issue_reports", "resolution"));
  });

  it("matches the call_issue_events.visibility CHECK", () => {
    expect([...CallIssueVisibility.options].sort()).toEqual(effectiveValues("call_issue_events", "visibility"));
  });

  /**
   * `kind` is deliberately checked against the INLINE table CHECK and not the
   * `notifications_kind_check` constraint that 0147 also rewrites - two columns
   * in the same file are both called `kind`, and the loose regex would otherwise
   * compare the event vocabulary against the bell's.
   */
  it("matches the call_issue_events.kind CHECK", () => {
    expect([...CallIssueEventKind.options].sort()).toEqual(effectiveValues("call_issue_events", "kind"));
  });

  /** 0201: a report can now be filed by the system, which is not a persona
   *  anybody holds. Same guard as the five above - the role is snapshotted
   *  NOT NULL on the row, so an enum value the CHECK rejects is a 23514 on the
   *  escalation path, which runs precisely when something is already broken. */
  it("matches the call_issue_reports.reported_by_role CHECK", () => {
    expect([...CallIssueReporterRole.options].sort()).toEqual(
      effectiveValues("call_issue_reports", "reported_by_role"),
    );
  });

  /** 0201: and `source` says whether a person or the pipeline filed it. */
  it("matches the call_issue_reports.source CHECK", () => {
    expect([...CallIssueSource.options].sort()).toEqual(
      effectiveValues("call_issue_reports", "source"),
    );
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
