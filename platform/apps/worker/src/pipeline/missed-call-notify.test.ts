import { describe, expect, it, vi } from "vitest";
import { notifyMissedCallOwner } from "./missed-call-notify";

function client(result: { rows: unknown[]; rowCount?: number }) {
  const query = vi.fn().mockResolvedValue(result);
  return { query };
}

const params = { callId: "call-1", leadId: "lead-1", callerTitle: "…6789" };

describe("notifyMissedCallOwner", () => {
  it("writes a 'missed_call' notification deduped on the call", async () => {
    const c = client({ rowCount: 1, rows: [] });
    expect(await notifyMissedCallOwner(c as never, "org-1", params)).toBe(1);

    const [sql, values] = c.query.mock.calls[0];
    expect(String(sql)).toContain("'missed_call'");
    expect(String(sql)).toContain("ON CONFLICT (user_id, dedupe_key)");
    expect(values).toEqual([
      "org-1",
      "lead-1",
      "A call went unanswered",
      "…6789 rang and nobody picked up.",
      "/owner/leads?focus=lead-1",
      "missed_call:call-1",
      ["owner", "manager"],
    ]);
  });

  it("decides the recipients in ONE statement, so a login granted mid-sweep cannot be missed", async () => {
    const c = client({ rowCount: 1, rows: [] });
    await notifyMissedCallOwner(c as never, "org-1", params);
    expect(c.query).toHaveBeenCalledTimes(1);
  });

  it("falls back to the org's owners/managers only when the telecaller has no login", async () => {
    const c = client({ rowCount: 2, rows: [] });
    await notifyMissedCallOwner(c as never, "org-1", params);
    const sql = String(c.query.mock.calls[0][0]);
    // The telecaller branch of the UNION.
    expect(sql).toMatch(/SELECT tc\.user_id WHERE tc\.user_id IS NOT NULL/);
    // The fallback branch, gated on that same telecaller being absent - without
    // this predicate every missed call would also ring every owner's bell.
    expect(sql).toMatch(/WHERE tc\.user_id IS NULL/);
    expect(sql).toContain("m.owner_role = ANY($7::text[])");
    // Only live people: a deactivated staff member is not somebody to tell.
    expect(sql).toContain("m.status = 'active'");
    expect(sql).toContain("u.status = 'active'");
    expect(sql).toContain("tc.status = 'active'");
  });

  it("scopes the lead lookup to the org it was handed", async () => {
    // The leadId arrives from a sweep's RETURNING, but this statement writes
    // notifications - reading a lead without the org predicate would make a
    // mismatched pair address another tenant's people.
    const c = client({ rowCount: 1, rows: [] });
    await notifyMissedCallOwner(c as never, "org-1", params);
    expect(String(c.query.mock.calls[0][0])).toContain("l.org_id = $1");
  });

  it("reports 0 when the insert is absorbed by the dedupe conflict (already notified)", async () => {
    const c = client({ rowCount: 0, rows: [] });
    expect(await notifyMissedCallOwner(c as never, "org-1", params)).toBe(0);
  });
});
