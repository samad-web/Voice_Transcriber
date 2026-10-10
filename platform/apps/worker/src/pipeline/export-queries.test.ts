import { describe, expect, it } from "vitest";

import {
  EXPORT_LIMITS,
  type OwnerRecordScope,
  exportDataset,
  visibleColumns,
} from "@aura/shared";

import {
  CURSOR_COLUMN,
  IMPLEMENTED_DATASETS,
  buildCountQuery,
  buildDatasetQuery,
  type ResolvedScope,
} from "./export-queries";
// 0188: `resolvedScopeFor` is where the grid's user id is chosen, so it is
// where the subject-substitution escalation would occur.
import { resolvedScopeFor } from "./export-scope";

/**
 * The SQL an export runs (doc 35 SS3.3, migration 0148).
 *
 * WHAT THIS SUITE IS FOR. Every statement here is assembled from template
 * literals, and generated SQL is invisible to the typechecker: a SELECT that
 * aliases a column to the wrong name produces a file with a blank column, and a
 * scope predicate that is built and then never appended produces a file with
 * everybody's rows. Both compile perfectly.
 *
 * So the two things pinned hardest are the two that cannot be caught anywhere
 * else: that the SQL's output aliases are EXACTLY the registry's column names,
 * and that a narrowed scope actually reaches the WHERE clause.
 */

const UNSCOPED: OwnerRecordScope = {
  role: "owner",
  scope: "all",
  userId: "11111111-1111-1111-1111-111111111111",
  telecallerId: null,
};

const TELECALLER: OwnerRecordScope = {
  role: "telecaller",
  scope: "own",
  userId: "22222222-2222-2222-2222-222222222222",
  telecallerId: "33333333-3333-3333-3333-333333333333",
};

const wide: ResolvedScope = { owner: UNSCOPED, crmUserId: null, subject: null };
const narrow: ResolvedScope = { owner: TELECALLER, crmUserId: null, subject: null };

/** The aliases a SELECT list actually produces, in order. */
function aliasesOf(sql: string): string[] {
  const select = sql.slice(sql.indexOf("SELECT ") + 7, sql.indexOf("FROM "));
  return Array.from(select.matchAll(/AS "([^"]+)"/g), (m) => m[1]);
}

describe("buildDatasetQuery", () => {
  /**
   * THE test. The registry is the contract the file's header row, the manifest
   * and the drawer all read; this SQL is what fills it. The first draft of the
   * registry offered `leads.phone` and `contacts.phone`, columns the schema has
   * never held - this is the assertion that would have caught it.
   */
  it.each(IMPLEMENTED_DATASETS)("selects exactly the registry's columns for %s", (key) => {
    const dataset = exportDataset(key);
    const query = buildDatasetQuery(dataset, wide, true, null);
    // Plus the cursor column, which is infrastructure rather than data: it
    // carries the sort value as text so the keyset cannot lose microseconds,
    // and the CSV writer never sees it because it writes registry names.
    expect(aliasesOf(query.sql)).toEqual([...dataset.columns.map((c) => c.name), CURSOR_COLUMN]);
  });

  it.each(IMPLEMENTED_DATASETS)("drops exactly the gated columns for %s", (key) => {
    const dataset = exportDataset(key);
    const query = buildDatasetQuery(dataset, wide, false, null);
    expect(aliasesOf(query.sql)).toEqual([
      ...visibleColumns(dataset, false).map((c) => c.name),
      CURSOR_COLUMN,
    ]);
  });

  /**
   * The bug this exists to prevent: a cursor built from a JS `Date` truncates
   * Postgres's microseconds to milliseconds, and the next page then excludes
   * every row sharing that second. It dropped a real row the first time these
   * queries met a database.
   */
  it.each(IMPLEMENTED_DATASETS)("renders the cursor value as text for %s", (key) => {
    const query = buildDatasetQuery(exportDataset(key), wide, true, null);
    expect(query.sql).toContain(`::text AS "${CURSOR_COLUMN}"`);
  });

  /**
   * The recording key must not merely be blank in the output - it must never be
   * selected. A query that reads it and discards it has still put the key in a
   * result set, a log and a query plan.
   */
  it("never names the recording key or the AI read without the grant", () => {
    const sql = buildDatasetQuery(exportDataset("calls"), wide, false, null).sql;
    expect(sql).not.toContain("s3_key");
    expect(sql).not.toContain("intelligence");
    const granted = buildDatasetQuery(exportDataset("calls"), wide, true, null).sql;
    expect(granted).toContain("r.s3_key");
    expect(granted).toContain("intelligence ->> 'summary'");
  });

  describe("row scope", () => {
    it("adds no predicate for a persona that sees everything", () => {
      for (const key of IMPLEMENTED_DATASETS) {
        const query = buildDatasetQuery(exportDataset(key), wide, true, null);
        expect(query.sql, key).not.toContain("telecaller_id = $");
        expect(query.sql, key).not.toContain("WHERE");
      }
    });

    /**
     * The lead union, which is the predicate most easily got wrong: scoping on
     * assignment alone gives a telecaller an EMPTY console, because the
     * worker's lead-creation path writes `telecaller_id` and never
     * `assigned_telecaller_id`.
     */
    it("scopes leads on assignment OR attribution", () => {
      const query = buildDatasetQuery(exportDataset("leads"), narrow, true, null);
      expect(query.sql).toContain("l.assigned_telecaller_id = $1");
      expect(query.sql).toContain("l.assigned_telecaller_id IS NULL AND l.telecaller_id = $1");
      expect(query.params[0]).toBe(TELECALLER.telecallerId);
    });

    it("scopes calls on the telecaller snapshot", () => {
      const query = buildDatasetQuery(exportDataset("calls"), narrow, true, null);
      expect(query.sql).toContain("c.telecaller_id = $1");
      expect(query.params[0]).toBe(TELECALLER.telecallerId);
    });

    /**
     * Contacts have no persona axis - `OwnerScopedObject` has no "contact" -
     * so a telecaller persona alone must not narrow them. The GRID is the only
     * axis that can, and it does so on owner_user_id.
     */
    it("scopes contacts on the grid, not the persona", () => {
      const personaOnly = buildDatasetQuery(exportDataset("contacts"), narrow, true, null);
      expect(personaOnly.sql).not.toContain("telecaller");

      const gridNarrowed = buildDatasetQuery(
        exportDataset("contacts"),
        { owner: TELECALLER, crmUserId: TELECALLER.userId, subject: null },
        true,
        null,
      );
      expect(gridNarrowed.sql).toContain("ct.owner_user_id = $1");
      expect(gridNarrowed.params[0]).toBe(TELECALLER.userId);
    });

    /**
     * The negative assertion that matters most: an own-scoped persona with no
     * telecaller row gets a predicate matching NOTHING, not one matching
     * everything. An empty export beats everyone's export.
     */
    it("matches nothing for an own-scoped persona with no telecaller identity", () => {
      const orphan: ResolvedScope = {
        owner: { ...TELECALLER, telecallerId: null },
        crmUserId: null,
        subject: null,
      };
      const query = buildDatasetQuery(exportDataset("calls"), orphan, true, null);
      expect(query.sql).toContain("c.telecaller_id = $1");
      expect(query.params[0]).toBe("00000000-0000-0000-0000-000000000000");
    });

    it("intersects both axes rather than choosing one", () => {
      // `deals` is the dataset that carries both. Not implemented in E1, but
      // the predicate builder is shared, so the composition is testable now.
      const query = buildDatasetQuery(
        exportDataset("leads"),
        { owner: TELECALLER, crmUserId: TELECALLER.userId, subject: null },
        true,
        null,
      );
      // leads have no grid column, so only the persona predicate appears -
      // and crucially the grid's user id is NOT smuggled in against a column
      // that does not exist.
      expect(query.sql).not.toContain("owner_user_id");
    });
  });

  describe("keyset paging", () => {
    it("orders by the sort column then the id, both descending", () => {
      const query = buildDatasetQuery(exportDataset("leads"), wide, true, null);
      expect(query.sql).toContain("ORDER BY l.created_at DESC, l.id DESC");
    });

    it("compares the row value against the cursor, not an OFFSET", () => {
      const query = buildDatasetQuery(exportDataset("leads"), wide, true, {
        sortValue: "2026-09-30T00:00:00.000Z",
        id: "44444444-4444-4444-4444-444444444444",
      });
      expect(query.sql).toContain("(l.created_at, l.id) < (");
      expect(query.sql).not.toContain("OFFSET");
    });

    it("binds the page size last", () => {
      const query = buildDatasetQuery(exportDataset("leads"), wide, true, null);
      expect(query.params[query.params.length - 1]).toBe(EXPORT_LIMITS.pageRows);
      expect(query.sql).toContain(`LIMIT $${query.params.length}`);
    });

    it("keeps one parameter per placeholder across both scope axes and the cursor", () => {
      const query = buildDatasetQuery(
        exportDataset("leads"),
        narrow,
        true,
        { sortValue: "2026-09-30T00:00:00.000Z", id: "44444444-4444-4444-4444-444444444444" },
      );
      // The highest $n in the statement must equal the parameter count, or the
      // driver throws "bind message supplies N parameters" at runtime.
      const highest = Math.max(
        ...Array.from(query.sql.matchAll(/\$(\d+)/g), (m) => Number(m[1])),
      );
      expect(highest).toBe(query.params.length);
    });
  });
});

describe("buildCountQuery", () => {
  it("keeps every predicate the page query had, and drops the limit", () => {
    const page = buildDatasetQuery(exportDataset("leads"), narrow, true, null);
    const count = buildCountQuery(exportDataset("leads"), narrow);
    expect(count.sql).toContain("count(*)");
    expect(count.sql).toContain("l.assigned_telecaller_id = $1");
    expect(count.sql).not.toContain("LIMIT");
    expect(count.sql).not.toContain("ORDER BY");
    expect(count.params).toEqual(page.params.slice(0, -1));
  });

  it("counts the same rows a narrowed export would write", () => {
    const wideCount = buildCountQuery(exportDataset("calls"), wide);
    const narrowCount = buildCountQuery(exportDataset("calls"), narrow);
    expect(wideCount.sql).not.toContain("telecaller_id = $");
    expect(narrowCount.sql).toContain("c.telecaller_id = $1");
  });
});

describe("IMPLEMENTED_DATASETS", () => {
  it("throws for a dataset E1 does not implement, rather than exporting nothing", () => {
    expect(() => buildDatasetQuery(exportDataset("invoices"), wide, true, null)).toThrow(
      /not implemented in E1/,
    );
  });
});

describe("the person scope (0188)", () => {
  const SUBJECT_TC = "44444444-4444-4444-4444-444444444444";
  const SUBJECT_USER = "55555555-5555-5555-5555-555555555555";
  const subject = { telecallerId: SUBJECT_TC, userId: SUBJECT_USER };

  it("ANDs the subject's predicate on top of the requester's", () => {
    // A manager (scope 'all', so no persona predicate of their own) exporting
    // one person: exactly one telecaller predicate, bound to the SUBJECT.
    const query = buildDatasetQuery(
      exportDataset("calls"),
      { owner: UNSCOPED, crmUserId: null, subject },
      true,
      null,
    );
    expect(query.sql).toContain("c.telecaller_id = $1");
    expect(query.params[0]).toBe(SUBJECT_TC);
  });

  it("keeps BOTH predicates when the requester is also narrowed", () => {
    // A telecaller exporting themselves. The requester's own predicate and the
    // subject's both appear - the composition is an intersection, so even the
    // degenerate "both are me" case keeps two clauses rather than collapsing
    // one away and losing the guarantee.
    const query = buildDatasetQuery(
      exportDataset("calls"),
      { owner: TELECALLER, crmUserId: null, subject },
      true,
      null,
    );
    const clauses = query.sql.match(/c\.telecaller_id = \$\d+/g) ?? [];
    expect(clauses).toHaveLength(2);
    expect(query.sql).toContain(" AND ");
    expect(query.params[0]).toBe(TELECALLER.telecallerId);
    expect(query.params[1]).toBe(SUBJECT_TC);
  });

  /**
   * THE ESCALATION THIS DESIGN EXISTS TO PREVENT.
   *
   * The obvious implementation of a person export is to point the requester's
   * scope at the subject. `crmUserId` is derived from `owner.userId`, so doing
   * that would make a requester holding only an `owned` grid grant see rows
   * owned by the SUBJECT - rows the grid never granted them. The subject is a
   * separate axis precisely so this cannot happen.
   */
  it("never re-points the grid axis at the subject", () => {
    // Asserted at `resolvedScopeFor`, which is WHERE the escalation would
    // happen: `crmUserId` is derived from `owner.userId`, so a design that
    // swapped the subject into `owner` would silently change which user the
    // grid narrows on. `deals` is the only dataset carrying both axes and it
    // has no FROM clause yet, so the decision point is the only place this is
    // expressible - and it is the better place anyway, being the cause rather
    // than the symptom.
    const resolved = resolvedScopeFor(TELECALLER, "owned", subject);
    expect(resolved.crmUserId).toBe(TELECALLER.userId);
    expect(resolved.crmUserId).not.toBe(SUBJECT_USER);
    // The subject rides alongside rather than replacing anything.
    expect(resolved.subject).toEqual(subject);
    expect(resolved.owner.telecallerId).toBe(TELECALLER.telecallerId);
  });

  it("adds no grid predicate at all when the grant is `all`", () => {
    // Guards the other direction: a person export must not acquire a grid
    // predicate it did not have, which would narrow the subject's rows to
    // those the REQUESTER happens to own.
    expect(resolvedScopeFor(UNSCOPED, "all", subject).crmUserId).toBeNull();
  });

  /**
   * `contacts` has `ownerScope: null`, so there is no column saying whose row
   * it is. Exporting it "for one person" would silently return the whole
   * tenant under that person's name. The API refuses this first; the engine
   * refuses it again, because the cost of being wrong is a leak and not a 500.
   */
  it("throws rather than export a dataset no one person can hold", () => {
    expect(() =>
      buildDatasetQuery(
        exportDataset("contacts"),
        { owner: UNSCOPED, crmUserId: null, subject },
        true,
        null,
      ),
    ).toThrow(/no per-person column/);
  });

  it("adds nothing at all when there is no subject", () => {
    // The other three scopes must be byte-identical to before 0188.
    const withSubject = buildDatasetQuery(exportDataset("calls"), wide, true, null);
    expect(withSubject.sql).not.toContain("telecaller_id = $");
  });

  it("binds the matches-nothing id for a subject whose identity is empty", () => {
    // Cannot arise through the API - 0188's CHECK requires a subject - but the
    // predicate must still deny rather than match everything if it ever does.
    const query = buildDatasetQuery(
      exportDataset("calls"),
      {
        owner: UNSCOPED,
        crmUserId: null,
        subject: { telecallerId: "00000000-0000-0000-0000-000000000000", userId: null },
      },
      true,
      null,
    );
    expect(query.params[0]).toBe("00000000-0000-0000-0000-000000000000");
  });
});
