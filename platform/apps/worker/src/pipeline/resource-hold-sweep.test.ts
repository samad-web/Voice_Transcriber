import { describe, expect, it, vi } from "vitest";
import {
  CLAIM_EXPIRED_HOLDS_SQL,
  HOLD_RELEASED_AUDIT_SQL,
  ORGS_WITH_EXPIRED_HOLDS_SQL,
  RELEASE_EXPIRED_HOLDS_SQL,
  releaseExpiredHolds,
} from "./resource-hold-sweep";

/**
 * The hold sweep (migration 0165, doc 39 §24).
 *
 * Everything worth testing here is about ONE failure: releasing a hold that
 * became a booking in the same tick. It is silent, it loses a sale, and the
 * shape of the SQL is the only thing that prevents it - so the shape is what
 * these assert, not just the row counts.
 */

const ORG = "00000000-0000-4000-8000-0000000001aa";
const HELD = {
  id: "00000000-0000-4000-8000-0000000001b1",
  resource_type: "unit",
  code: "A-1203",
  name: "Flat A-1203",
  held_for_lead_id: "00000000-0000-4000-8000-0000000001c1",
  held_by_user_id: "00000000-0000-4000-8000-0000000001d1",
  held_until: "2026-03-01T09:00:00.000Z",
};

interface Issued {
  text: string;
  values: unknown[];
}

/**
 * `claimed` is what the locking SELECT returns; `released` is what the UPDATE
 * reports. They are supplied separately on purpose - the gap between them IS
 * the race this file is about.
 */
function fakeClient(opts: { claimed?: unknown[]; released?: unknown[] } = {}) {
  const issued: Issued[] = [];
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    issued.push({ text, values });
    if (text === CLAIM_EXPIRED_HOLDS_SQL) {
      const rows = opts.claimed ?? [];
      return { rows, rowCount: rows.length };
    }
    if (text === RELEASE_EXPIRED_HOLDS_SQL) {
      const rows = opts.released ?? [];
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 1 };
  });
  return { client: { query }, issued, query };
}

describe("the lock is taken outside any CTE", () => {
  /**
   * The load-bearing test. A lazy CTE does not lock what you think it locks -
   * the sub-select is a node in one plan and the planner pulls from it only as
   * the outer node demands, so the rows the UPDATE modifies are not reliably
   * the rows the FOR UPDATE locked. The lead stage ledger work established
   * this the hard way.
   */
  it("the claim is a bare SELECT ... FOR UPDATE, with no WITH anywhere in it", () => {
    expect(CLAIM_EXPIRED_HOLDS_SQL).toMatch(/^\s*SELECT\b/);
    expect(CLAIM_EXPIRED_HOLDS_SQL).toContain("FOR UPDATE");
    expect(CLAIM_EXPIRED_HOLDS_SQL).not.toMatch(/\bWITH\b/i);
  });

  it("the release is a separate statement that contains no FOR UPDATE of its own", () => {
    expect(RELEASE_EXPIRED_HOLDS_SQL).toMatch(/^\s*UPDATE\b/);
    expect(RELEASE_EXPIRED_HOLDS_SQL).not.toMatch(/\bWITH\b/i);
    expect(RELEASE_EXPIRED_HOLDS_SQL).not.toContain("FOR UPDATE");
  });

  it("skips a row another transaction is mid-booking rather than waiting on it", () => {
    // Waiting would let one slow booking stall a whole tenant's sweep, and the
    // row does not need expiring on this pass - by the next one it is either
    // booked or free.
    expect(CLAIM_EXPIRED_HOLDS_SQL).toContain("SKIP LOCKED");
  });

  /**
   * The predicate is repeated on rows that are already locked, so it cannot
   * fail. That is the point: it is free, and it is the only thing standing
   * between a booked flat and a released one the day somebody reorders these
   * two statements.
   */
  it("the release re-asserts the predicate rather than trusting the claim", () => {
    expect(RELEASE_EXPIRED_HOLDS_SQL).toContain("status = 'held'");
    expect(RELEASE_EXPIRED_HOLDS_SQL).toContain("held_until <= now()");
  });

  it("clears every hold column, not only the expiry", () => {
    // resources_held_has_expiry only ties held_until to the status, so a stale
    // held_for_lead_id would survive on an available row and the console would
    // render a live hold on something that is free.
    expect(RELEASE_EXPIRED_HOLDS_SQL).toContain("held_until       = NULL");
    expect(RELEASE_EXPIRED_HOLDS_SQL).toContain("held_for_lead_id = NULL");
    expect(RELEASE_EXPIRED_HOLDS_SQL).toContain("held_by_user_id  = NULL");
  });

  it("issues the two statements in order, on the same client", async () => {
    const { client, issued } = fakeClient({ claimed: [HELD], released: [{ id: HELD.id }] });
    await releaseExpiredHolds(client as never, ORG);
    expect(issued[0].text).toBe(CLAIM_EXPIRED_HOLDS_SQL);
    expect(issued[1].text).toBe(RELEASE_EXPIRED_HOLDS_SQL);
    // The ids the UPDATE acts on are exactly the ids the lock returned.
    expect(issued[1].values[0]).toEqual([HELD.id]);
  });
});

describe("a hold that became a booking in the same tick", () => {
  /**
   * The race, end to end. The claim locked the row and handed it back; by the
   * time the UPDATE ran, the booking had committed, so the UPDATE's own
   * `status = 'held'` re-check excluded it and RETURNING came back empty.
   */
  it("is not released, and no audit row claims it was", async () => {
    const { client, issued } = fakeClient({ claimed: [HELD], released: [] });
    expect(await releaseExpiredHolds(client as never, ORG)).toBe(0);
    expect(issued.some((i) => i.text === HOLD_RELEASED_AUDIT_SQL)).toBe(false);
  });

  it("is dropped from a mixed batch while its neighbours are still released", async () => {
    const other = { ...HELD, id: "00000000-0000-4000-8000-0000000001b2", code: "A-1204" };
    const { client, issued } = fakeClient({
      claimed: [HELD, other],
      // Only the second survived the re-check.
      released: [{ id: other.id }],
    });
    expect(await releaseExpiredHolds(client as never, ORG)).toBe(1);

    const audits = issued.filter((i) => i.text === HOLD_RELEASED_AUDIT_SQL);
    expect(audits).toHaveLength(1);
    expect(audits[0].values[1]).toBe(other.id);
  });
});

describe("the event", () => {
  it("is one audit_log row per RELEASED resource, as the system actor", async () => {
    const { client, issued } = fakeClient({ claimed: [HELD], released: [{ id: HELD.id }] });
    expect(await releaseExpiredHolds(client as never, ORG)).toBe(1);

    const audit = issued.find((i) => i.text === HOLD_RELEASED_AUDIT_SQL);
    expect(audit).toBeDefined();
    expect(HOLD_RELEASED_AUDIT_SQL).toContain("'system'");
    expect(HOLD_RELEASED_AUDIT_SQL).toContain("'resource.hold_expired'");
    expect(audit!.values[0]).toBe(ORG);
    expect(audit!.values[1]).toBe(HELD.id);
  });

  it("carries who held it and until when, because the row no longer does", async () => {
    const { client, issued } = fakeClient({ claimed: [HELD], released: [{ id: HELD.id }] });
    await releaseExpiredHolds(client as never, ORG);
    const audit = issued.find((i) => i.text === HOLD_RELEASED_AUDIT_SQL)!;
    expect(JSON.parse(String(audit.values[2]))).toEqual({
      resourceType: "unit",
      code: "A-1203",
      name: "Flat A-1203",
      heldForLeadId: HELD.held_for_lead_id,
      heldByUserId: HELD.held_by_user_id,
      heldUntil: HELD.held_until,
    });
  });

  /**
   * §33 reserves a `hold_expiring` notification kind for a WARNING before the
   * hold lapses. Adding a kind means moving the DB CHECK and the zod enum in
   * the same commit or it throws 23514 at runtime and reads like a bug in the
   * caller - which has already happened here with `notifications.kind`, in both
   * directions at once. Nothing in this sweep is urgent enough for that.
   */
  it("writes no notification and sends nothing", async () => {
    const { client, issued } = fakeClient({ claimed: [HELD], released: [{ id: HELD.id }] });
    await releaseExpiredHolds(client as never, ORG);
    for (const i of issued) {
      expect(i.text).not.toMatch(/INSERT INTO notifications/);
      expect(i.text).not.toMatch(/handset_alerts|conversation_messages/);
    }
  });
});

describe("an empty pass", () => {
  it("issues one statement and stops", async () => {
    const { client, query } = fakeClient({ claimed: [] });
    expect(await releaseExpiredHolds(client as never, ORG)).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("the org lookup is a cheap EXISTS rather than a scan of the inventory", () => {
    expect(ORGS_WITH_EXPIRED_HOLDS_SQL).toContain("EXISTS (SELECT 1");
    expect(ORGS_WITH_EXPIRED_HOLDS_SQL).toContain("r.status = 'held'");
    // `resource` is a `crm` object (PERMISSION_OBJECT_MODULE), so a
    // recorder-only tenant has no inventory to sweep.
    expect(ORGS_WITH_EXPIRED_HOLDS_SQL).toContain("'crm' = ANY(o.enabled_modules)");
    expect(ORGS_WITH_EXPIRED_HOLDS_SQL).toContain("o.status = 'active'");
  });
});

describe("the batch", () => {
  it("is bounded, so the first tick after a deploy does not walk the whole table", async () => {
    const { client, issued } = fakeClient({ claimed: [] });
    await releaseExpiredHolds(client as never, ORG, 7);
    expect(CLAIM_EXPIRED_HOLDS_SQL).toContain("LIMIT $1");
    expect(issued[0].values).toEqual([7]);
  });

  it("takes the oldest holds first", () => {
    // A hold that lapsed an hour ago is more urgent than one that lapsed a
    // second ago, and ordering makes a truncated batch deterministic.
    expect(CLAIM_EXPIRED_HOLDS_SQL).toContain("ORDER BY held_until");
  });
});
