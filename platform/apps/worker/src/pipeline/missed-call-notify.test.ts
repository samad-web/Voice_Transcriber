import { describe, expect, it, vi } from "vitest";
import { notifyMissedCallOwner } from "./missed-call-notify";

function client(...results: Array<{ rows: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const r of results) query.mockResolvedValueOnce(r);
  return { query };
}

describe("notifyMissedCallOwner", () => {
  it("does nothing, and writes nothing, when the lead has nobody bound to a login", async () => {
    const c = client({ rows: [{ user_id: null }] });
    const sent = await notifyMissedCallOwner(c as never, "org-1", {
      callId: "call-1",
      leadId: "lead-1",
      callerTitle: "…6789",
    });
    expect(sent).toBe(false);
    expect(c.query).toHaveBeenCalledTimes(1);
  });

  it("also does nothing when the lead itself has no assigned telecaller (the LEFT JOIN finds no row)", async () => {
    const c = client({ rows: [] });
    const sent = await notifyMissedCallOwner(c as never, "org-1", {
      callId: "call-1",
      leadId: "lead-1",
      callerTitle: "…6789",
    });
    expect(sent).toBe(false);
    expect(c.query).toHaveBeenCalledTimes(1);
  });

  it("writes exactly one 'missed_call' notification, deduped on the call", async () => {
    const c = client({ rows: [{ user_id: "user-1" }] }, { rowCount: 1, rows: [] });
    const sent = await notifyMissedCallOwner(c as never, "org-1", {
      callId: "call-1",
      leadId: "lead-1",
      callerTitle: "…6789",
    });
    expect(sent).toBe(true);

    const [sql, params] = c.query.mock.calls[1];
    expect(String(sql)).toContain("'missed_call'");
    expect(String(sql)).toContain("ON CONFLICT (user_id, dedupe_key)");
    expect(params).toEqual([
      "org-1",
      "user-1",
      "A call went unanswered",
      "…6789 rang and nobody picked up.",
      "/owner/leads?focus=lead-1",
      "missed_call:call-1",
    ]);
  });

  it("reports false when the insert is absorbed by the dedupe conflict (already notified)", async () => {
    const c = client({ rows: [{ user_id: "user-1" }] }, { rowCount: 0, rows: [] });
    const sent = await notifyMissedCallOwner(c as never, "org-1", {
      callId: "call-1",
      leadId: "lead-1",
      callerTitle: "…6789",
    });
    expect(sent).toBe(false);
  });
});
