import { describe, expect, it } from "vitest";

import type { DbClient } from "./crm-dispatch";
import { leadTitle, upsertLead } from "./leads";

/**
 * The board card's heading.
 *
 * Small, but it is the only human-readable identifier on a lead: the full
 * number is not stored unless the org opted in, so if this returns something
 * empty or a raw identifier the owner cannot tell two cards apart.
 */

const ELLIPSIS = "…";

describe("leadTitle", () => {
  it("prefers the LLM-extracted name", () => {
    expect(leadTitle("Rajesh", "RD Site Contact", "98765", "321")).toBe("Rajesh");
  });

  it("falls back to the call log's contact name when nothing was extracted", () => {
    expect(leadTitle(null, "RD Site Contact", "98765", "321")).toBe("RD Site Contact");
  });

  it("skips a name that is only whitespace rather than titling the card with blanks", () => {
    expect(leadTitle("   ", "RD Site Contact", null, null)).toBe("RD Site Contact");
    expect(leadTitle("   ", "  ", "98765", "321")).toBe(`98765${ELLIPSIS}`);
  });

  it("falls back to the number's leading digits", () => {
    expect(leadTitle(null, null, "98765", "321")).toBe(`98765${ELLIPSIS}`);
  });

  it("falls back to the number's trailing digits when only those were stored", () => {
    expect(leadTitle(null, null, null, "321")).toBe(`${ELLIPSIS}321`);
  });

  it("returns \"Unknown caller\" rather than an empty heading when nothing identifies the caller", () => {
    // Withheld number plus a call the model extracted no name from. An empty
    // string here renders as a blank card.
    expect(leadTitle(null, null, null, null)).toBe("Unknown caller");
    expect(leadTitle("", "", "", "")).toBe("Unknown caller");
  });

  it("truncates a runaway extracted name to 200 characters", () => {
    // The model occasionally answers customer_name with a whole sentence; the
    // column is bounded and the board layout is not.
    const long = "a".repeat(300);
    expect(leadTitle(long, null, null, null)).toHaveLength(200);
  });

  it("trims surrounding whitespace off the name it chose", () => {
    expect(leadTitle("  Rajesh  ", null, null, null)).toBe("Rajesh");
    expect(leadTitle(null, "  RD Site Contact ", null, null)).toBe("RD Site Contact");
  });
});

/**
 * upsertLead's SQL merge contract — this is what A6's shadow-read
 * reconciliation and every future edit to this function is judged against.
 * No database is opened: a fake DbClient routes each query by a
 * distinguishing substring, the same approach crm-objects.test.ts uses for
 * projectLeadToCrm. The three query shapes below (call lookup, no-hash
 * fallback lookup/update, main upsert) share no substring with each other,
 * so match order doesn't matter.
 */

const CALL_ROW = {
  workspace_id: "00000000-0000-4000-8000-000000000002",
  device_id: "device-1",
  telecaller_id: null,
  remote_name: "Rajesh",
  remote_number_hash: "sha256:abcdef",
  remote_number_prefix: "98765",
  remote_number_last3: "321",
  started_at: new Date("2026-08-06T09:14:00.000Z"),
  agent_id: "agent-1",
  agent_version: 1,
  lead_rules: {},
  lead_stages: null,
  summary: "Asked the rate for 5000 solid bricks.",
  // notes/extra are what a model sends for "not mentioned" — isFilled()
  // must drop both before they reach the merge.
  facts: { customer_name: "Rajesh", brick_quantity: 5000, notes: "   ", extra: "[]" },
  validation_status: "validated",
};

interface Recorded {
  sql: string;
  params: unknown[];
}

interface FakeDbOptions {
  call?: Record<string, unknown> | null;
  existingNoHashLead?: { id: string } | null;
  created?: boolean;
  inserts?: Recorded[];
  noHashUpdates?: Recorded[];
}

function fakeDb(opts: FakeDbOptions = {}): DbClient {
  const callRows = "call" in opts ? (opts.call ? [opts.call] : []) : [CALL_ROW];
  return {
    query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (sql.includes("JOIN organizations o")) {
        return { rows: callRows as R[], rowCount: callRows.length };
      }
      if (sql.includes("SELECT id FROM leads")) {
        const rows = opts.existingNoHashLead ? [opts.existingNoHashLead] : [];
        return { rows: rows as R[], rowCount: rows.length };
      }
      if (sql.includes("UPDATE leads")) {
        opts.noHashUpdates?.push({ sql, params: params ?? [] });
        return { rows: [] as R[], rowCount: 1 };
      }
      if (sql.includes("INSERT INTO leads")) {
        opts.inserts?.push({ sql, params: params ?? [] });
        return {
          rows: [{ id: "lead-1", created: opts.created ?? true }] as R[],
          rowCount: 1,
        };
      }
      throw new Error(`fakeDb: unexpected query: ${sql.slice(0, 80)}`);
    },
  };
}

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CALL_ID = "22222222-2222-4222-8222-222222222222";

describe("upsertLead", () => {
  it("reports 'call not found' without writing anything", async () => {
    const result = await upsertLead(fakeDb({ call: null }), ORG_ID, "missing");
    expect(result).toEqual({ leadId: null, created: false, reason: "call not found" });
  });

  it("rejects an unqualified call without writing a lead", async () => {
    const inserts: Recorded[] = [];
    const noFacts = { ...CALL_ROW, facts: {} };
    const result = await upsertLead(fakeDb({ call: noFacts, inserts }), ORG_ID, CALL_ID);
    expect(result.leadId).toBeNull();
    expect(inserts).toHaveLength(0);
  });

  it("dedupes on (workspace_id, contact_number_hash), not the call", async () => {
    const inserts: Recorded[] = [];
    await upsertLead(fakeDb({ inserts }), ORG_ID, CALL_ID);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].sql).toContain("ON CONFLICT (workspace_id, contact_number_hash)");
    expect(inserts[0].params[1]).toBe(CALL_ROW.workspace_id);
    expect(inserts[0].params[3]).toBe(CALL_ROW.remote_number_hash);
  });

  it("drops blank strings and the model's '[]' placeholder before merging facts", async () => {
    const inserts: Recorded[] = [];
    await upsertLead(fakeDb({ inserts }), ORG_ID, CALL_ID);
    const factsParam = JSON.parse(inserts[0].params[11] as string);
    expect(factsParam).toEqual({ customer_name: "Rajesh", brick_quantity: 5000 });
  });

  it("never lets a reprocess overwrite the owner's stage, status or telecaller assignment", async () => {
    const inserts: Recorded[] = [];
    await upsertLead(fakeDb({ inserts }), ORG_ID, CALL_ID);
    const sql = inserts[0].sql;
    // The DO UPDATE clause must never reset these — see the "owner's, never
    // the pipeline's" comment in leads.ts. Bare column names in the INSERT
    // list (e.g. "stage") don't match "=", so this only catches an actual
    // assignment in the conflict clause.
    expect(sql).not.toMatch(/\bstage\s*=/);
    expect(sql).not.toMatch(/\bstatus\s*=/);
    expect(sql).not.toMatch(/telecaller_device_id\s*=/);
    expect(sql).not.toMatch(/telecaller_id\s*=\s*EXCLUDED/);
  });

  it("recomputes call_count from the calls table instead of incrementing it, so a replay can't inflate it", async () => {
    const inserts: Recorded[] = [];
    await upsertLead(fakeDb({ inserts }), ORG_ID, CALL_ID);
    expect(inserts[0].sql).toMatch(/GREATEST\(1, \(SELECT count\(\*\)::int FROM calls c/);
    expect(inserts[0].sql).not.toContain("call_count + 1");
  });

  it("reports created vs updated from the conflict outcome itself, not a separate lookup", async () => {
    expect(await upsertLead(fakeDb({ created: true }), ORG_ID, CALL_ID)).toEqual({
      leadId: "lead-1",
      created: true,
      reason: "created",
    });
    expect(await upsertLead(fakeDb({ created: false }), ORG_ID, CALL_ID)).toEqual({
      leadId: "lead-1",
      created: false,
      reason: "updated",
    });
  });

  it("falls back to matching by call id when the handset had no call-log permission", async () => {
    const noHashCall = { ...CALL_ROW, remote_number_hash: null };
    const inserts: Recorded[] = [];
    const noHashUpdates: Recorded[] = [];
    const result = await upsertLead(
      fakeDb({ call: noHashCall, existingNoHashLead: { id: "lead-existing" }, inserts, noHashUpdates }),
      ORG_ID,
      CALL_ID,
    );
    expect(result).toEqual({
      leadId: "lead-existing",
      created: false,
      reason: "updated (no contact number)",
    });
    expect(noHashUpdates).toHaveLength(1);
    // The no-hash update path returns early — the ON CONFLICT insert below
    // must never also run, or a numberless replay would fork a second lead.
    expect(inserts).toHaveLength(0);
  });

  it("inserts a brand-new numberless lead when no prior call-id match exists", async () => {
    const noHashCall = { ...CALL_ROW, remote_number_hash: null };
    const inserts: Recorded[] = [];
    await upsertLead(
      fakeDb({ call: noHashCall, existingNoHashLead: null, inserts }),
      ORG_ID,
      CALL_ID,
    );
    expect(inserts).toHaveLength(1);
  });
});
