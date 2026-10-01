import {
  customerLabelSql,
  type EscalationRow,
  escalationPermissions,
  escalationReceivedText,
  escalationResolvedText,
  escalationVisibleSql,
  resolveRouting,
  type RoutingRow,
  toDetail,
  toDeviceView,
  toListItem,
} from "./call-escalations.service";

const routing = (over: Partial<RoutingRow> = {}): RoutingRow => ({
  tc_id: "tc-1",
  tc_name: "Brindha",
  tc_user_id: "u-brindha",
  et_id: null,
  et_user_id: null,
  et_role: null,
  et_status: null,
  et_user_status: null,
  et_senior: null,
  et_name: null,
  rt_id: null,
  rt_user_id: null,
  rt_role: null,
  rt_status: null,
  rt_user_status: null,
  rt_senior: null,
  rt_name: null,
  ...over,
});

const senior = {
  et_id: "m-kavya",
  et_user_id: "u-kavya",
  et_role: "telecaller",
  et_status: "active",
  et_user_status: "active",
  et_senior: true,
  et_name: "Kavya",
};
const manager = {
  rt_id: "m-asha",
  rt_user_id: "u-asha",
  rt_role: "manager",
  rt_status: "active",
  rt_user_status: "active",
  rt_senior: false,
  rt_name: "Asha",
};

describe("resolveRouting", () => {
  it("sends it to the chosen senior first", () => {
    expect(resolveRouting(routing({ ...senior, ...manager }))).toEqual({ membershipId: "m-kavya", name: "Kavya" });
  });

  it("falls back to the manager when the chosen person can no longer receive", () => {
    expect(resolveRouting(routing({ ...senior, et_user_status: "disabled", ...manager }))).toEqual({
      membershipId: "m-asha",
      name: "Asha",
    });
    // Un-marked as a senior since, and not an owner or manager.
    expect(resolveRouting(routing({ ...senior, et_senior: false, ...manager })).membershipId).toBe("m-asha");
  });

  it("never sends it to the raiser themselves", () => {
    expect(resolveRouting(routing({ ...senior, et_user_id: "u-brindha", ...manager })).membershipId).toBe("m-asha");
  });

  it("skips a reports-to pointer at anyone but an owner or manager, and falls to the pool", () => {
    expect(resolveRouting(routing({ ...manager, rt_role: "telecaller", rt_senior: true }))).toEqual({
      membershipId: null,
      name: null,
    });
    expect(resolveRouting(routing())).toEqual({ membershipId: null, name: null });
  });

  it("treats a pre-persona (NULL role) membership as an owner", () => {
    expect(resolveRouting(routing({ ...manager, rt_role: null })).membershipId).toBe("m-asha");
  });
});

describe("escalationPermissions", () => {
  const none = { assignedToMe: false, raisedByMe: false };

  it("lets an owner or manager act on any live escalation, including the pool's", () => {
    expect(escalationPermissions("open", true, none)).toEqual({ canAct: true, canWithdraw: false });
    expect(escalationPermissions("acknowledged", true, none).canAct).toBe(true);
  });

  it("lets anyone else act only on what is assigned to them", () => {
    expect(escalationPermissions("open", false, none).canAct).toBe(false);
    expect(escalationPermissions("open", false, { ...none, assignedToMe: true }).canAct).toBe(true);
  });

  it("lets only the raiser withdraw, and only while it is live", () => {
    expect(escalationPermissions("open", false, { ...none, raisedByMe: true })).toEqual({
      canAct: false,
      canWithdraw: true,
    });
    expect(escalationPermissions("resolved", true, { assignedToMe: true, raisedByMe: true })).toEqual({
      canAct: false,
      canWithdraw: false,
    });
    expect(escalationPermissions("withdrawn", false, { assignedToMe: true, raisedByMe: true }).canWithdraw).toBe(false);
  });
});

describe("escalationVisibleSql", () => {
  it("is unconditional for an owner or manager", () => {
    expect(escalationVisibleSql("e", "$2::uuid", true)).toBe("true");
  });

  it("is assigned-to-me OR raised-by-me OR acted-on for anyone else, all bound to the viewer", () => {
    const sql = escalationVisibleSql("e", "$2::uuid", false);
    expect(sql).toContain("e.assigned_membership_id IN");
    expect(sql).toContain("e.telecaller_id IN");
    expect(sql).toContain("vev.actor_user_id = $2::uuid");
    expect(sql.match(/\$2::uuid/g)).toHaveLength(3);
    // NULL IN (...) is NULL, not false - every arm is a real boolean.
    expect(sql.match(/COALESCE\(/g)).toHaveLength(2);
  });
});

describe("customerLabelSql", () => {
  it("prefers the contact name, and never falls back to a title with a digit in it", () => {
    const sql = customerLabelSql("l");
    expect(sql).toContain("l.contact_name");
    expect(sql).toContain("l.title !~ '[0-9]'");
  });
});

const row = (over: Partial<EscalationRow> = {}): EscalationRow => ({
  id: "e1",
  call_id: "c1",
  status: "open",
  reason: "price_approval",
  note: "Wants 10% off",
  source: "device",
  telecaller_id: "tc-1",
  telecaller_name: "Brindha",
  assigned_membership_id: null,
  assigned_to_name: null,
  created_at: new Date("2026-10-01T09:00:00Z"),
  acknowledged_at: null,
  acknowledged_by_name: null,
  resolved_at: null,
  resolved_by_name: null,
  resolution_note: null,
  forward_count: 0,
  call_started_at: new Date("2026-10-01T08:55:00Z"),
  call_direction: "outgoing",
  call_duration_s: 182,
  call_status: "COMPLETE",
  call_lead_id: "l1",
  customer_label: "Ravi Kumar",
  assigned_to_me: false,
  raised_by_me: false,
  ...over,
});

describe("toListItem", () => {
  it("maps a pool escalation for an owner", () => {
    expect(toListItem(row(), { admin: true })).toEqual({
      id: "e1",
      callId: "c1",
      status: "open",
      reason: "price_approval",
      note: "Wants 10% off",
      source: "device",
      telecallerId: "tc-1",
      telecallerName: "Brindha",
      assignedMembershipId: null,
      assignedToName: null,
      createdAt: "2026-10-01T09:00:00.000Z",
      acknowledgedAt: null,
      acknowledgedByName: null,
      resolvedAt: null,
      resolvedByName: null,
      resolutionNote: null,
      forwardCount: 0,
      call: {
        startedAt: "2026-10-01T08:55:00.000Z",
        direction: "outgoing",
        durationS: 182,
        status: "COMPLETE",
        leadId: "l1",
        customerLabel: "Ravi Kumar",
      },
      canAct: true,
      canWithdraw: false,
    });
  });

  it("gives a senior the action only on their own, and the raiser only the withdraw", () => {
    const mine = toListItem(row({ assigned_membership_id: "m-kavya", assigned_to_name: "Kavya", assigned_to_me: true }), {
      admin: false,
    });
    expect([mine.assignedToName, mine.canAct, mine.canWithdraw]).toEqual(["Kavya", true, false]);
    const raised = toListItem(row({ raised_by_me: true }), { admin: false });
    expect([raised.canAct, raised.canWithdraw]).toEqual([false, true]);
  });

  it("reads timestamps that arrive as strings (json_agg) as well as Dates", () => {
    const item = toListItem(row({ created_at: "2026-10-01T14:30:00+05:30", forward_count: "2" }), { admin: true });
    expect(item.createdAt).toBe("2026-10-01T09:00:00.000Z");
    expect(item.forwardCount).toBe(2);
  });
});

describe("toDetail", () => {
  it("adds the history and the forward targets, with personas resolved", () => {
    const detail = toDetail(
      {
        ...row(),
        events: [
          {
            id: "ev1",
            kind: "raised",
            actorName: "Brindha",
            toName: "All managers & owners",
            note: "Wants 10% off",
            createdAt: "2026-10-01T14:30:00.123456+05:30",
          },
        ],
        forward_targets: [{ membershipId: "m-owner", name: "Owner One", role: null, senior: false }],
      },
      { admin: true },
    );
    expect(detail.events).toEqual([
      {
        id: "ev1",
        kind: "raised",
        actorName: "Brindha",
        toName: "All managers & owners",
        note: "Wants 10% off",
        createdAt: "2026-10-01T09:00:00.123Z",
      },
    ]);
    expect(detail.forwardTargets).toEqual([{ membershipId: "m-owner", name: "Owner One", role: "owner", senior: false }]);
  });

  it("reads a missing history or target list as empty", () => {
    const detail = toDetail({ ...row(), events: null, forward_targets: null }, { admin: false });
    expect([detail.events, detail.forwardTargets]).toEqual([[], []]);
  });
});

describe("toDeviceView", () => {
  it("carries the reason's label so the phone keeps no copy of the list", () => {
    const view = toDeviceView(
      row({
        status: "resolved",
        resolved_at: new Date("2026-10-01T09:20:00Z"),
        resolved_by_name: "Asha",
        resolution_note: "Approved at 8%",
      }),
    );
    expect(view).toEqual({
      id: "e1",
      callId: "c1",
      status: "resolved",
      reason: "price_approval",
      reasonLabel: "Price or discount approval",
      note: "Wants 10% off",
      assignedToName: null,
      acknowledgedByName: null,
      resolvedByName: "Asha",
      resolutionNote: "Approved at 8%",
      createdAt: "2026-10-01T09:00:00.000Z",
      resolvedAt: "2026-10-01T09:20:00.000Z",
    });
  });
});

describe("what the bell and the phone say", () => {
  it("names the raiser, the reason, the lead and the telecaller's own note", () => {
    expect(
      escalationReceivedText({
        event: "raised",
        telecallerName: "Brindha",
        actorName: "Brindha",
        reason: "wants_senior",
        customerLabel: "Ravi Kumar",
        note: "Asked for the branch head",
      }),
    ).toEqual({
      title: "Brindha escalated a call",
      body: 'Customer wants a senior · Ravi Kumar - "Asked for the branch head"',
    });
  });

  it("says who passed it on, and whose call it is", () => {
    const t = escalationReceivedText({
      event: "forwarded",
      telecallerName: "Brindha",
      actorName: "Kavya",
      reason: "complaint",
      customerLabel: null,
      note: null,
    });
    expect(t).toEqual({ title: "Kavya passed you an escalation", body: "Brindha's call · Complaint or upset customer" });
  });

  it("answers with the resolver's note, or the reason when there is none", () => {
    expect(
      escalationResolvedText({ resolverName: "Asha", reason: "price_approval", customerLabel: "Ravi Kumar", note: "Go to 8%" }),
    ).toEqual({ title: "Asha answered your escalation about Ravi Kumar", body: "Go to 8%" });
    expect(escalationResolvedText({ resolverName: "Asha", reason: "price_approval", customerLabel: null, note: null })).toEqual({
      title: "Asha answered your escalation",
      body: "Price or discount approval",
    });
  });
});
