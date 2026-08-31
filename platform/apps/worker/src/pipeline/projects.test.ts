import { describe, expect, it } from "vitest";

import type { DbClient } from "./crm-dispatch";
import { detectCallProjects } from "./projects";

/**
 * detectCallProjects' write contract. No database is opened: a fake DbClient
 * routes each query by a distinguishing substring, the same approach
 * leads.test.ts and crm-objects.test.ts use.
 *
 * The matching itself is tested exhaustively in @aura/shared's projects.test.ts
 * - this file is only about what gets WRITTEN, and specifically about the two
 * rules that are easy to break: reprocessing must not accumulate stale rows,
 * and a human's label must survive a later call.
 */

const CATALOGUE = [
  { id: "p-3d", name: "3D Website", aliases: ["3d site"], sort_order: 0 },
  { id: "p-lex", name: "LexDraft", aliases: [], sort_order: 1 },
];

interface Recorded {
  sql: string;
  params: unknown[];
}

interface FakeDbOptions {
  catalogue?: typeof CATALOGUE;
  haystack?: string | null;
  call?: boolean;
  /** rowCount the leads UPDATE reports - 0 means a human owns the column. */
  leadUpdateRowCount?: number;
  writes?: Recorded[];
}

function fakeDb(opts: FakeDbOptions = {}): DbClient {
  const catalogue = opts.catalogue ?? CATALOGUE;
  const record = (sql: string, params?: unknown[]) =>
    opts.writes?.push({ sql, params: params ?? [] });

  return {
    query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (sql.includes("FROM crm_projects")) {
        return { rows: catalogue as R[], rowCount: catalogue.length };
      }
      if (sql.includes("concat_ws")) {
        const rows =
          opts.call === false
            ? []
            : [{ workspace_id: "ws-1", haystack: opts.haystack ?? "we discussed the 3d site" }];
        return { rows: rows as R[], rowCount: rows.length };
      }
      if (sql.includes("DELETE FROM call_projects")) {
        record(sql, params);
        return { rows: [] as R[], rowCount: 0 };
      }
      if (sql.includes("INSERT INTO call_projects")) {
        record(sql, params);
        return { rows: [] as R[], rowCount: 1 };
      }
      if (sql.includes("UPDATE leads")) {
        record(sql, params);
        return { rows: [] as R[], rowCount: opts.leadUpdateRowCount ?? 1 };
      }
      if (sql.includes("UPDATE deals")) {
        record(sql, params);
        return { rows: [] as R[], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    },
  } as DbClient;
}

describe("detectCallProjects", () => {
  it("writes a call_projects row per hit and labels the lead with the strongest", async () => {
    const writes: Recorded[] = [];
    const result = await detectCallProjects(
      fakeDb({ haystack: "first the 3d site, then LexDraft and LexDraft again", writes }),
      "org-1",
      "call-1",
      "lead-1",
    );

    expect(result.hits.map((h) => h.projectId)).toEqual(["p-lex", "p-3d"]);
    expect(result.primaryProjectId).toBe("p-lex");

    const inserts = writes.filter((w) => w.sql.includes("INSERT INTO call_projects"));
    expect(inserts).toHaveLength(2);
    // org_id, call_id, project_id, confidence, matched_on
    expect(inserts[0].params.slice(0, 3)).toEqual(["org-1", "call-1", "p-lex"]);

    const leadUpdate = writes.find((w) => w.sql.includes("UPDATE leads"));
    expect(leadUpdate?.params).toEqual(["lead-1", "p-lex"]);
  });

  /**
   * The regression this guards: without the DELETE, reprocessing a call after
   * an alias was removed leaves the old hit behind forever, and the project
   * view keeps counting a conversation that no longer matches anything.
   */
  it("clears its OWN previous rows before rewriting, and only its own", async () => {
    const writes: Recorded[] = [];
    await detectCallProjects(fakeDb({ writes }), "org-1", "call-1", "lead-1");

    const del = writes.find((w) => w.sql.includes("DELETE FROM call_projects"));
    expect(del).toBeDefined();
    expect(del?.sql).toContain("source = 'extraction'");
    // The DELETE must precede the INSERTs or it removes what it just wrote.
    expect(writes.indexOf(del!)).toBeLessThan(
      writes.findIndex((w) => w.sql.includes("INSERT INTO call_projects")),
    );
  });

  it("never overwrites a project a human set - on the lead or the deal", async () => {
    const writes: Recorded[] = [];
    const result = await detectCallProjects(
      // rowCount 0 = the WHERE clause refused the row because source='human'.
      fakeDb({ writes, leadUpdateRowCount: 0 }),
      "org-1",
      "call-1",
      "lead-1",
    );

    expect(result.reason).toContain("human");
    const updates = writes.filter(
      (w) => w.sql.includes("UPDATE leads") || w.sql.includes("UPDATE deals"),
    );
    expect(updates).toHaveLength(2);
    for (const write of updates) expect(write.sql).toContain("<> 'human'");
  });

  it("still records the call's projects when the call produced no lead", async () => {
    const writes: Recorded[] = [];
    const result = await detectCallProjects(fakeDb({ writes }), "org-1", "call-1", null);

    expect(result.primaryProjectId).toBe("p-3d");
    expect(writes.some((w) => w.sql.includes("INSERT INTO call_projects"))).toBe(true);
    // Nothing to update, and nothing pretending there was. Matched on the
    // full statement rather than the bare word "UPDATE", which also appears
    // in the INSERT's own "DO NOTHING rather than DO UPDATE" comment.
    expect(writes.some((w) => w.sql.includes("UPDATE leads"))).toBe(false);
    expect(writes.some((w) => w.sql.includes("UPDATE deals"))).toBe(false);
  });

  it("does nothing at all when the tenant has no projects - not even a DELETE", async () => {
    const writes: Recorded[] = [];
    const result = await detectCallProjects(
      fakeDb({ catalogue: [], writes }),
      "org-1",
      "call-1",
      "lead-1",
    );

    expect(result).toEqual({ hits: [], primaryProjectId: null, reason: "no projects configured" });
    expect(writes).toHaveLength(0);
  });

  it("reports a missing call and an empty transcript distinctly, writing neither", async () => {
    const writes: Recorded[] = [];
    expect(
      (await detectCallProjects(fakeDb({ call: false, writes }), "org-1", "call-1", "lead-1"))
        .reason,
    ).toBe("call not found");
    expect(
      (await detectCallProjects(fakeDb({ haystack: "   ", writes }), "org-1", "call-1", "lead-1"))
        .reason,
    ).toBe("nothing to match against");
    expect(writes).toHaveLength(0);
  });

  /**
   * A call that mentioned nothing still clears its old rows - otherwise a
   * project removed from a call by a re-transcription would linger.
   */
  it("clears stale rows even when the new pass matches nothing", async () => {
    const writes: Recorded[] = [];
    const result = await detectCallProjects(
      fakeDb({ haystack: "a call about nothing in the catalogue", writes }),
      "org-1",
      "call-1",
      "lead-1",
    );

    expect(result.reason).toBe("no project mentioned");
    expect(writes.some((w) => w.sql.includes("DELETE FROM call_projects"))).toBe(true);
    expect(writes.some((w) => w.sql.includes("UPDATE leads"))).toBe(false);
  });
});
