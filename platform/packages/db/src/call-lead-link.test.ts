import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  contactNumberMatchKey,
  inheritCallsForLead,
  inheritCallsForLeadSafely,
} from "./call-lead-link";

/**
 * The retroactive call→lead binding (migration 0146), tested where it can
 * actually hurt.
 *
 * None of the failures here throw. A loosened predicate attaches another desk's
 * calls to this lead; a lost dismissal guard overturns a person's judgement; a
 * missing savepoint costs the LEAD rather than the link; a key computed
 * differently from the call side matches nothing at all and looks exactly like
 * "this customer had no history". So the guards are asserted directly, on the
 * SQL text and on the call sequence - the same approach
 * apps/worker/src/pipeline/call-lead-link.test.ts takes for the sweep.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";

const query = vi.fn();
const client = { query } as unknown as Parameters<typeof inheritCallsForLead>[0];

beforeEach(() => {
  query.mockReset().mockResolvedValue({ rows: [{ linked: 0 }], rowCount: 1 });
});

/** The one statement, whitespace-collapsed so assertions stay readable. */
function sql(): string {
  const found = query.mock.calls.find((c) => String(c[0]).includes("lead_for_unlinked_call"));
  return String(found?.[0] ?? "").replace(/\s+/g, " ");
}

const PARAMS = {
  leadId: LEAD,
  workspaceId: WORKSPACE,
  contactNumberHash: "hash-1",
  contactNumberKey: "key-1",
};

describe("contactNumberMatchKey", () => {
  /**
   * The value this returns is compared for equality against
   * `calls.remote_number_key`, which calls.controller.ts computes as
   * sha256(phoneMatchDigits(raw)). A difference does not throw - it silently
   * matches nothing, which is indistinguishable from a customer who has never
   * been called. So the digest is pinned, not just its shape.
   */
  it("hashes the last ten digits, exactly as the call side does", () => {
    const expected = createHash("sha256").update("9876543210").digest("hex");
    expect(contactNumberMatchKey("+91 98765 43210")).toBe(expected);
    expect(contactNumberMatchKey("098765-43210")).toBe(expected);
    expect(contactNumberMatchKey("9876543210")).toBe(expected);
  });

  it("collapses the formats that used to be three different customers", () => {
    // The whole reason 0146 exists: a web form reports the international form
    // and a handset's call log the national one, so the hash the two sides
    // dedupe on disagrees while this key agrees.
    expect(contactNumberMatchKey("+919876543210")).toBe(contactNumberMatchKey("09876543210"));
  });

  it("refuses junk rather than turning it into a match key", () => {
    // "n/a", "-", an extension. A short digit string that became a real key
    // would merge every future junk submission onto one lead, and a false merge
    // is worse than a duplicate because nobody can tell it happened.
    expect(contactNumberMatchKey("n/a")).toBeNull();
    expect(contactNumberMatchKey("12345")).toBeNull();
    expect(contactNumberMatchKey(null)).toBeNull();
    expect(contactNumberMatchKey(undefined)).toBeNull();
    expect(contactNumberMatchKey("")).toBeNull();
  });
});

describe("inheritCallsForLead - what it refuses to touch", () => {
  it("never reopens a dismissal", async () => {
    await inheritCallsForLead(client, ORG, PARAMS);
    // A wrong number, a personal call, a supplier ringing back. Somebody judged
    // it not business; a lead being created for that number later is not new
    // evidence. 0094's CHECK would reject the write anyway, so without this
    // guard the statement fails on rows it should be ignoring.
    expect(sql()).toContain("c.lead_link_dismissed_at IS NULL");
  });

  it("never re-links a call that already belongs to a lead", async () => {
    await inheritCallsForLead(client, ORG, PARAMS);
    // Idempotence, and what makes a console Link durable: a person attaching a
    // call to a lead the hash disagrees with must not be overwritten.
    expect(sql()).toContain("c.lead_id IS NULL");
  });

  it("stays inside the lead's own workspace", async () => {
    await inheritCallsForLead(client, ORG, PARAMS);
    // The contact hash is unique per WORKSPACE, not per org (0094), and two
    // workspaces in one org are two separate books of business. This is the one
    // predicate whose failure is another team's calls on this team's card.
    expect(sql()).toContain("c.workspace_id = $2::uuid");
    expect(sql()).toContain("c.org_id = $6::uuid");
  });

  it("writes first_responded_at nowhere - that is the trigger's job", async () => {
    await inheritCallsForLead(client, ORG, PARAMS);
    // 0094's calls_lead_link_marks_response fires on the UPDATE below, for
    // OUTGOING calls only. A second definition here would eventually count an
    // inbound call as somebody having responded, which inverts the report: the
    // worst-served leads, the ones that had to call back, would read as the
    // fastest-answered.
    expect(sql()).not.toContain("first_responded_at");
  });

  it("never moves the lead's own first_call_id or last_call_id", async () => {
    await inheritCallsForLead(client, ORG, PARAMS);
    // Provenance, not history: those two say which call PRODUCED the lead. A
    // web-form lead was not produced by a call, and overwriting them to tidy a
    // timeline makes the qualification trail lie.
    expect(sql()).not.toContain("first_call_id");
    expect(sql()).not.toContain("last_call_id");
  });

  it("delegates the match rather than re-deriving it", async () => {
    await inheritCallsForLead(client, ORG, PARAMS);
    // One rule, in lead_for_unlinked_call (0146), shared with the sweep. The
    // equality against the lead id is what makes this direction safe: an
    // ambiguous number resolves to a different lead, or to NULL, and is then
    // left alone rather than claimed.
    expect(sql()).toContain(
      "lead_for_unlinked_call(c.workspace_id, c.remote_number_hash, c.remote_number_key) = $1::uuid",
    );
  });
});

describe("inheritCallsForLead - how it behaves under contention", () => {
  it("skips locked rows instead of waiting on them", async () => {
    await inheritCallsForLead(client, ORG, PARAMS);
    // This runs inside a REQUEST on the API side. The sweep is updating the same
    // rows on its own schedule, so a plain UPDATE could block the lead's whole
    // transaction behind it. SKIP LOCKED makes contention free: a contended call
    // is left to whoever holds it, and the next sweep tick finds it either
    // linked or exactly as it was.
    expect(sql()).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("caps the work and leaves the remainder to the sweep", async () => {
    await inheritCallsForLead(client, ORG, PARAMS, 500);
    const text = sql();
    expect(text).toContain("LIMIT $5::int");
    // Oldest first, so a capped pass leaves the RECENT calls behind rather than
    // the ones the timeline opens on.
    expect(text).toContain("ORDER BY c.started_at");
    expect(query.mock.calls[0]?.[1]).toEqual([LEAD, WORKSPACE, "hash-1", "key-1", 500, ORG]);
  });

  it("reports hitting the cap, because there is then more to come", async () => {
    query.mockResolvedValue({ rows: [{ linked: 2 }], rowCount: 1 });
    expect(await inheritCallsForLead(client, ORG, PARAMS, 2)).toEqual({ linked: 2, capped: true });
    expect(await inheritCallsForLead(client, ORG, PARAMS, 5)).toEqual({ linked: 2, capped: false });
  });

  it("costs no round trip at all when there is nothing to match on", async () => {
    // An email-only web form, or a handset with no call-log permission. The
    // answer is known here, and production runs the app in Mumbai against a
    // database in Seoul - ~125ms for a query whose result cannot be anything
    // but zero.
    const result = await inheritCallsForLead(client, ORG, {
      ...PARAMS,
      contactNumberHash: null,
      contactNumberKey: null,
    });
    expect(result).toEqual({ linked: 0, capped: false });
    expect(query).not.toHaveBeenCalled();
  });

  it("raises call_count without ever lowering it", async () => {
    await inheritCallsForLead(client, ORG, PARAMS);
    const text = sql();
    // An intake lead starts at 0 because "an ad lead has had no calls"; after
    // inheriting eleven, a card reading "0 calls" over a timeline of eleven is
    // the same disconnect one column to the left. But upsertLead derives the
    // count from the contact HASH and that can legitimately exceed what is
    // linked, so this corrects an undercount and must be unable to cause one.
    expect(text).toContain("GREATEST( l.call_count,");
    // Added, not recounted: every CTE reads one snapshot, so the count of
    // already-linked calls cannot see the rows just claimed.
    expect(text).toContain("+ (SELECT count(*) FROM linked)");
  });

  it("never drags the lead's activity clock backwards", async () => {
    await inheritCallsForLead(client, ORG, PARAMS);
    // Inheriting a three-month-old call must not make a card created this
    // morning read as stale (0116). GREATEST is what makes the whole feature
    // safe to run on a brand-new lead.
    expect(sql()).toContain(
      "last_activity_at = GREATEST(l.last_activity_at, (SELECT max(started_at) FROM linked))",
    );
  });
});

describe("inheritCallsForLeadSafely - it must never cost the lead", () => {
  it("contains a failure in a savepoint and reports nothing linked", async () => {
    const calls: string[] = [];
    const failing = {
      query: vi.fn(async (text: string) => {
        calls.push(text.replace(/\s+/g, " ").slice(0, 40));
        if (text.includes("lead_for_unlinked_call")) throw new Error("boom");
        return { rows: [], rowCount: 0 };
      }),
    } as unknown as Parameters<typeof inheritCallsForLeadSafely>[0];

    // A bare try/catch would not be enough: every door runs this inside one
    // transaction that also writes the contact, the deal and the ledger, and a
    // failed statement there marks the whole transaction aborted - so the COMMIT
    // fails too and the LEAD ITSELF is lost. Only a savepoint contains it.
    expect(await inheritCallsForLeadSafely(failing, ORG, PARAMS)).toEqual({
      linked: 0,
      capped: false,
    });
    expect(calls[0]).toBe("SAVEPOINT lead_call_inherit");
    expect(calls).toContain("ROLLBACK TO SAVEPOINT lead_call_inherit");
    expect(calls).not.toContain("RELEASE SAVEPOINT lead_call_inherit");
  });

  it("releases the savepoint on the happy path, so the transaction is not left holding one", async () => {
    const calls: string[] = [];
    const ok = {
      query: vi.fn(async (text: string) => {
        calls.push(text.replace(/\s+/g, " ").slice(0, 40));
        return { rows: [{ linked: 4 }], rowCount: 1 };
      }),
    } as unknown as Parameters<typeof inheritCallsForLeadSafely>[0];

    expect(await inheritCallsForLeadSafely(ok, ORG, PARAMS)).toEqual({ linked: 4, capped: false });
    expect(calls).toContain("RELEASE SAVEPOINT lead_call_inherit");
    expect(calls).not.toContain("ROLLBACK TO SAVEPOINT lead_call_inherit");
  });

  it("spends no savepoint when there is nothing to do", async () => {
    const noop = { query: vi.fn() } as unknown as Parameters<typeof inheritCallsForLeadSafely>[0];
    await inheritCallsForLeadSafely(noop, ORG, {
      ...PARAMS,
      contactNumberHash: null,
      contactNumberKey: null,
    });
    expect(noop.query).not.toHaveBeenCalled();
  });
});
