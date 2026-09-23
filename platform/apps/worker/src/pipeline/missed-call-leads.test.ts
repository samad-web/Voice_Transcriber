import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The missed-call-lead sweep, tested at the per-call unit (createLeadFromMissedCall)
 * rather than by driving the org-scanning wrapper - the wrapper is the same
 * thin, already-proven shape as call-lead-link.ts's; what can actually go
 * wrong here is the lead this function builds, who it assigns it to, and what
 * it does and does not do when a race or a conflict shows up.
 */

const projectLeadToCrm = vi.fn();
const routeLead = vi.fn();
const notifyMissedCallOwner = vi.fn();
const adminQuery = vi.fn();
const withOrgContext = vi.fn();

vi.mock("@aura/db", () => ({
  getAdminPool: () => ({ query: adminQuery }),
  withOrgContext: (orgId: string, fn: (client: unknown) => unknown) => withOrgContext(orgId, fn) as unknown,
  projectLeadToCrm: (...args: unknown[]) => projectLeadToCrm(...args),
  routeLead: (...args: unknown[]) => routeLead(...args),
}));

vi.mock("./missed-call-notify", () => ({
  notifyMissedCallOwner: (...args: unknown[]) => notifyMissedCallOwner(...args),
}));

beforeEach(() => {
  vi.resetModules();
  projectLeadToCrm.mockReset().mockResolvedValue({ contactId: "contact-1", dealId: "deal-1" });
  routeLead.mockReset().mockResolvedValue({ assigned: false, telecallerId: null, ruleId: null, ruleName: null, telecallerName: null, reason: "no rule matched" });
  notifyMissedCallOwner.mockReset().mockResolvedValue(true);
  adminQuery.mockReset().mockResolvedValue({ rows: [] });
  withOrgContext.mockReset();
});

async function load() {
  return import("./missed-call-leads");
}

const CALL_ROW = {
  workspace_id: "ws-1",
  device_id: "device-1",
  telecaller_id: "tc-1",
  remote_name: null,
  remote_number_hash: "hash-1",
  remote_number_prefix: "98765",
  remote_number_last3: "210",
  started_at: "2026-09-22T09:00:00.000Z",
  lead_id: null,
  lead_stages: null,
};

function client(...responses: Array<{ rows: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const r of responses) query.mockResolvedValueOnce(r);
  return { query };
}

describe("createLeadFromMissedCall - already spoken for", () => {
  it("creates nothing when the call is already linked to a lead (the race the hash sweep can win)", async () => {
    const c = client({ rows: [{ ...CALL_ROW, lead_id: "lead-existing" }] });
    const { createLeadFromMissedCall } = await load();
    expect(await createLeadFromMissedCall(c as never, "org-1", "call-1")).toBe(false);
    expect(c.query).toHaveBeenCalledTimes(1);
    expect(projectLeadToCrm).not.toHaveBeenCalled();
  });

  it("creates nothing for a caller with no usable number - nobody could be called back anyway", async () => {
    const c = client({ rows: [{ ...CALL_ROW, remote_number_hash: null }] });
    const { createLeadFromMissedCall } = await load();
    expect(await createLeadFromMissedCall(c as never, "org-1", "call-1")).toBe(false);
  });
});

describe("createLeadFromMissedCall - a genuinely new lead", () => {
  it("builds a thin, hot, entry-stage lead assigned to the telecaller whose handset missed the call", async () => {
    const c = client(
      { rows: [CALL_ROW] }, // SELECT ... FOR UPDATE
      { rowCount: 1, rows: [{ id: "lead-1", created: true }] }, // INSERT ... RETURNING
      { rowCount: 1, rows: [] }, // UPDATE calls SET lead_id
      { rows: [{ user_id: "user-1" }] }, // SELECT user_id FROM telecallers
      { rowCount: 1, rows: [] }, // INSERT INTO tasks
    );
    const { createLeadFromMissedCall } = await load();
    expect(await createLeadFromMissedCall(c as never, "org-1", "call-1")).toBe(true);

    const insertLeadCall = c.query.mock.calls[1];
    expect(String(insertLeadCall[0])).toContain("'missed_call'");
    expect(String(insertLeadCall[0])).toContain("'hot'");
    const params = insertLeadCall[1] as unknown[];
    // stage ($8) and telecaller_id/assigned_telecaller_id ($11, reused): the
    // call's own attribution, never the round-robin engine, for a call that
    // already has a human on it.
    expect(params[7]).toBe("new"); // entryStage of the default pack
    expect(params[10]).toBe("tc-1");

    // Never routed - the call already had a telecaller.
    expect(routeLead).not.toHaveBeenCalled();

    // Exactly one notification, straight from this function (not routeLead's).
    expect(notifyMissedCallOwner).toHaveBeenCalledTimes(1);
    expect(notifyMissedCallOwner).toHaveBeenCalledWith(
      c,
      "org-1",
      expect.objectContaining({ callId: "call-1", leadId: "lead-1" }),
    );

    const taskCall = c.query.mock.calls[4];
    expect(String(taskCall[0])).toContain("INSERT INTO tasks");
    const taskParams = taskCall[1] as unknown[];
    expect(taskParams[1]).toContain("Call back");
    expect(taskParams[3]).toBe("contact-1"); // contact_id from the projection
    expect(String(taskCall[0])).toContain("'high'");
  });

  it("routes through the distribution engine only when the call carries no telecaller attribution", async () => {
    const c = client(
      { rows: [{ ...CALL_ROW, telecaller_id: null }] },
      { rowCount: 1, rows: [{ id: "lead-1", created: true }] },
      { rowCount: 1, rows: [] },
      { rows: [{ user_id: "user-2" }] }, // SELECT user_id FROM telecallers, for the ROUTED telecaller
      { rowCount: 1, rows: [] }, // INSERT INTO tasks
    );
    routeLead.mockResolvedValue({ assigned: true, telecallerId: "tc-routed", ruleId: "r1", ruleName: "Round robin", telecallerName: "Priya", reason: "matched" });

    const { createLeadFromMissedCall } = await load();
    expect(await createLeadFromMissedCall(c as never, "org-1", "call-1")).toBe(true);

    expect(routeLead).toHaveBeenCalledWith(c, "org-1", { leadId: "lead-1", dealId: "deal-1", trigger: "intake" });
    // routeLead already told the telecaller it was assigned to them - a second
    // bell for the same event would be noise.
    expect(notifyMissedCallOwner).not.toHaveBeenCalled();

    const telecallerLookup = c.query.mock.calls[3];
    expect(telecallerLookup[1]).toEqual(["tc-routed", "org-1"]);
  });

  it("still creates the lead when nobody at all can be assigned - unassigned is visible, not lost", async () => {
    const c = client(
      { rows: [{ ...CALL_ROW, telecaller_id: null }] },
      { rowCount: 1, rows: [{ id: "lead-1", created: true }] },
      { rowCount: 1, rows: [] },
    );
    routeLead.mockResolvedValue({ assigned: false, telecallerId: null, ruleId: null, ruleName: null, telecallerName: null, reason: "nothing configured" });

    const { createLeadFromMissedCall } = await load();
    expect(await createLeadFromMissedCall(c as never, "org-1", "call-1")).toBe(true);
    // No telecaller lookup, no task, no notification - there is nobody to give either to.
    expect(c.query).toHaveBeenCalledTimes(3);
    expect(notifyMissedCallOwner).not.toHaveBeenCalled();
  });

  it("still creates the lead (unassigned) when the CRM projection itself fails", async () => {
    projectLeadToCrm.mockRejectedValue(new Error("projection exploded"));
    const c = client(
      { rows: [CALL_ROW] },
      { rowCount: 1, rows: [{ id: "lead-1", created: true }] },
      { rowCount: 1, rows: [] },
      { rows: [{ user_id: "user-1" }] },
      { rowCount: 1, rows: [] },
    );
    const { createLeadFromMissedCall } = await load();
    expect(await createLeadFromMissedCall(c as never, "org-1", "call-1")).toBe(true);
    // The task is still created, just with no contact/deal to attach to.
    const taskParams = c.query.mock.calls[4][1] as unknown[];
    expect(taskParams[3]).toBeNull();
    expect(taskParams[4]).toBeNull();
  });
});

describe("createLeadFromMissedCall - the conflict path", () => {
  it("was not actually unknown: notifies the existing owner and creates nothing new", async () => {
    const c = client(
      { rows: [CALL_ROW] },
      { rowCount: 1, rows: [{ id: "lead-existing", created: false }] },
      { rowCount: 1, rows: [] }, // UPDATE calls SET lead_id (still links this call)
    );
    const { createLeadFromMissedCall } = await load();
    expect(await createLeadFromMissedCall(c as never, "org-1", "call-1")).toBe(false);

    expect(notifyMissedCallOwner).toHaveBeenCalledWith(
      c,
      "org-1",
      expect.objectContaining({ callId: "call-1", leadId: "lead-existing" }),
    );
    // Nothing about an already-existing lead gets re-derived - no projection,
    // no routing, no task, no stage/temperature second-guessing.
    expect(projectLeadToCrm).not.toHaveBeenCalled();
    expect(routeLead).not.toHaveBeenCalled();
    expect(c.query).toHaveBeenCalledTimes(3);
  });
});

describe("runMissedCallLeadCreate - the org-scanning wrapper", () => {
  it("asks only for active orgs with a genuinely unknown missed caller outstanding", async () => {
    withOrgContext.mockResolvedValue([]);
    const { runMissedCallLeadCreate } = await load();
    await runMissedCallLeadCreate();

    const sql = String(adminQuery.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("o.status = 'active'");
    expect(sql).toContain("c.lead_id IS NULL");
    expect(sql).toContain("c.remote_number_hash IS NOT NULL");
    expect(sql).toContain("c.status = 'NO_AUDIO'");
  });

  it("does no per-org work when nothing is outstanding", async () => {
    const { runMissedCallLeadCreate } = await load();
    expect(await runMissedCallLeadCreate()).toBe(0);
    expect(withOrgContext).not.toHaveBeenCalled();
  });

  it("claims candidates, then processes each call in its own transaction - one bad call costs only itself", async () => {
    adminQuery.mockResolvedValue({ rows: [{ id: "org-1" }] });
    let call = 0;
    withOrgContext.mockImplementation(async (_orgId: string, fn: (client: unknown) => unknown) => {
      call++;
      if (call === 1) {
        // The claim query: two candidate call ids.
        return fn({ query: vi.fn().mockResolvedValue({ rows: [{ id: "call-1" }, { id: "call-2" }] }) });
      }
      if (call === 2) throw new Error("call-1's transaction blew up");
      // call-2's own transaction: a call already linked by the hash sweep in
      // the meantime - a normal, harmless outcome, not an error.
      return fn({ query: vi.fn().mockResolvedValue({ rows: [{ ...CALL_ROW, lead_id: "lead-x" }] }) });
    });

    const { runMissedCallLeadCreate } = await load();
    // Neither the thrown error nor the harmless "already linked" result stops
    // the tick or propagates - both report as zero created, which is correct.
    await expect(runMissedCallLeadCreate()).resolves.toBe(0);
    expect(withOrgContext).toHaveBeenCalledTimes(3);
  });

  it("keeps going when one ORG's claim query itself throws", async () => {
    adminQuery.mockResolvedValue({ rows: [{ id: "org-1" }, { id: "org-2" }] });
    withOrgContext.mockImplementation(async (orgId: string) => {
      if (orgId === "org-1") throw new Error("org-1 is unreachable");
      return [];
    });
    const { runMissedCallLeadCreate } = await load();
    await expect(runMissedCallLeadCreate()).resolves.toBe(0);
    expect(withOrgContext).toHaveBeenCalledTimes(2);
  });
});
