import { describe, expect, it } from "vitest";
import { projectDryRun, type DryRunEvent } from "./automation-dryrun";
import type { AutomationSubject } from "./automation";

const NOW = new Date("2026-08-20T10:00:00Z");

const event = (
  id: string,
  payload: AutomationSubject,
  overrides: Partial<DryRunEvent> = {},
): DryRunEvent => ({
  id,
  trigger: "deal.stage_changed",
  subjectType: "deal",
  subjectId: `deal-${id}`,
  payload,
  occurredAt: new Date("2026-08-19T09:00:00Z"),
  ...overrides,
});

describe("projectDryRun - validation", () => {
  it("reports an invalid conditions shape instead of previewing", () => {
    const res = projectDryRun(
      { trigger: "deal.created", conditions: { amountGte: "lots" }, actions: [] },
      [],
      NOW,
    );
    expect(res.invalid).toBe("conditions failed validation");
    expect(res.firings).toHaveLength(0);
  });

  it("reports a rule with no actions - it would fire and do nothing", () => {
    const res = projectDryRun({ trigger: "deal.created", conditions: {}, actions: [] }, [], NOW);
    expect(res.invalid).toBe("the rule has no actions");
  });
});

describe("projectDryRun - matching mirrors the executor", () => {
  const rule = {
    trigger: "deal.stage_changed" as const,
    conditions: { toStage: ["won"] },
    actions: [{ type: "add_note" as const, body: "Closed - send the welcome pack" }],
  };

  it("fires only on matching events", () => {
    const res = projectDryRun(
      rule,
      [
        event("1", { toStage: "won", dealId: "d1" }),
        event("2", { toStage: "lost", dealId: "d2" }),
        event("3", { toStage: "won", dealId: "d3" }),
      ],
      NOW,
    );
    expect(res.eventsConsidered).toBe(3);
    expect(res.matched).toBe(2);
    expect(res.firings.map((f) => f.subjectId)).toEqual(["deal-1", "deal-3"]);
  });

  it("ignores events belonging to another trigger, and says so", () => {
    const res = projectDryRun(
      rule,
      [
        event("1", { toStage: "won" }),
        event("2", { toStage: "won" }, { trigger: "deal.created" }),
      ],
      NOW,
    );
    expect(res.eventsConsidered).toBe(1);
    expect(res.matched).toBe(1);
    expect(res.approximations.join(" ")).toContain("belong to other triggers");
  });

  it("says so when the window contained nothing for this trigger", () => {
    const res = projectDryRun(rule, [], NOW);
    expect(res.matched).toBe(0);
    expect(res.approximations.join(" ")).toContain("No events for this trigger");
  });

  it("orders firings newest first", () => {
    const res = projectDryRun(
      rule,
      [
        event("old", { toStage: "won" }, { occurredAt: new Date("2026-08-01T00:00:00Z") }),
        event("new", { toStage: "won" }, { occurredAt: new Date("2026-08-18T00:00:00Z") }),
      ],
      NOW,
    );
    expect(res.firings.map((f) => f.eventId)).toEqual(["new", "old"]);
  });
});

describe("projectDryRun - action projection", () => {
  it("resolves a task's assignee and its relative due date", () => {
    const res = projectDryRun(
      {
        trigger: "deal.stage_changed",
        conditions: {},
        actions: [
          { type: "create_task", title: "Call them back", dueInDays: 1, assignTo: "deal_owner" },
        ],
      },
      [event("1", { toStage: "won", dealOwnerUserId: "user-7" })],
      NOW,
    );
    const action = res.firings[0].actions[0];
    expect(action.targetUserId).toBe("user-7");
    // dueInDays is computed from the passed `now`, in UTC - the same
    // convention tasks.due_on needs to avoid reading a day early.
    expect(action.describe).toContain("due 2026-08-21");
    expect(action.describe).toContain("assigned to user-7");
  });

  it("flags an UNASSIGNED task rather than implying an owner", () => {
    const res = projectDryRun(
      {
        trigger: "deal.stage_changed",
        conditions: {},
        actions: [{ type: "create_task", title: "Follow up", dueInDays: 0, assignTo: "deal_owner" }],
      },
      [event("1", { toStage: "won" })], // no dealOwnerUserId
      NOW,
    );
    expect(res.firings[0].actions[0].describe).toContain("UNASSIGNED");
  });

  it("BLOCKS a notify with nobody to notify - the executor drops it", () => {
    const res = projectDryRun(
      {
        trigger: "deal.stage_changed",
        conditions: {},
        actions: [{ type: "notify", target: "deal_owner", title: "Deal won" }],
      },
      [event("1", { toStage: "won" })],
      NOW,
    );
    const action = res.firings[0].actions[0];
    expect(action.blocked).toBe("the subject has no owner to notify");
  });

  it("does NOT block a notify that has a target", () => {
    const res = projectDryRun(
      {
        trigger: "deal.stage_changed",
        conditions: {},
        actions: [{ type: "notify", target: "deal_owner", title: "Deal won" }],
      },
      [event("1", { toStage: "won", dealOwnerUserId: "user-3" })],
      NOW,
    );
    expect(res.firings[0].actions[0].blocked).toBeUndefined();
  });
});

describe("projectDryRun - approximations are stated, not assumed away", () => {
  it("admits it cannot validate a custom-field value", () => {
    const res = projectDryRun(
      {
        trigger: "deal.stage_changed",
        conditions: {},
        actions: [{ type: "set_custom_field", key: "priority", value: "high" }],
      },
      [event("1", { toStage: "won" })],
      NOW,
    );
    expect(res.approximations.join(" ")).toContain("priority");
    expect(res.approximations.join(" ")).toContain("does not check");
  });

  it("admits it cannot verify a target stage exists", () => {
    const res = projectDryRun(
      {
        trigger: "deal.stage_changed",
        conditions: {},
        actions: [{ type: "move_stage", stage: "nurture" }],
      },
      [event("1", { toStage: "won" })],
      NOW,
    );
    expect(res.approximations.join(" ")).toContain("nurture");
    expect(res.approximations.join(" ")).toContain("does not verify");
  });

  it("adds no approximation for actions that need no live state", () => {
    const res = projectDryRun(
      {
        trigger: "deal.stage_changed",
        conditions: {},
        actions: [{ type: "add_note", body: "noted" }],
      },
      [event("1", { toStage: "won" })],
      NOW,
    );
    expect(res.approximations).toEqual([]);
  });
});

describe("projectDryRun - purity", () => {
  it("gives the same answer twice for the same inputs", () => {
    const rule = {
      trigger: "deal.stage_changed" as const,
      conditions: {},
      actions: [{ type: "create_task" as const, title: "x", dueInDays: 3, assignTo: "deal_owner" as const }],
    };
    const events = [event("1", { toStage: "won", dealOwnerUserId: "u" })];
    expect(projectDryRun(rule, events, NOW)).toEqual(projectDryRun(rule, events, NOW));
  });
});
