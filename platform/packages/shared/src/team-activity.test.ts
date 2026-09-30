import { describe, expect, it } from "vitest";

import {
  MIN_WORKLOAD_FLOOR,
  type ActivityEvent,
  type LeaderboardRow,
  type WorkloadRow,
  activityPhrase,
  activitySummary,
  actorName,
  capacityBand,
  groupActivityByDay,
  leaderboard,
  openLoad,
  workloadInsight,
  workloadMatrix,
} from "./team-activity";

function event(over: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: "lst:1",
    kind: "lead_stage",
    at: "2026-09-30T09:15:00.000Z",
    actor: "Asha",
    actorKind: "user",
    subject: "Priya Sharma",
    href: "/owner/leads/1",
    detail: "Negotiation",
    ...over,
  };
}

function person(over: Partial<WorkloadRow> = {}): WorkloadRow {
  return {
    telecallerId: "t1",
    displayName: "Asha",
    userId: "u1",
    openLeads: 10,
    stalledLeads: 0,
    unansweredLeads: 0,
    openTasks: 5,
    overdueTasks: 0,
    calls: 100,
    activeDays: 20,
    ...over,
  };
}

/** A floor big enough for bands to be published, everyone on the median. */
function floor(count = MIN_WORKLOAD_FLOOR): WorkloadRow[] {
  return Array.from({ length: count }, (_, i) =>
    person({ telecallerId: `t${i}`, displayName: `Rep ${i}` }),
  );
}

function board(over: Partial<LeaderboardRow> = {}): LeaderboardRow {
  return {
    telecallerId: "t1",
    displayName: "Asha",
    won: 4,
    wonValue: 400_000,
    leads: 40,
    calls: 200,
    connected: 120,
    tasksDone: 12,
    ...over,
  };
}

describe("activityPhrase", () => {
  it("words a win as a close, in the tenant's own stage label", () => {
    const p = activityPhrase(event({ kind: "lead_won", detail: "Enrolled" }));
    expect(p).toEqual({ verb: "closed", subject: "Priya Sharma", tail: "as Enrolled" });
  });

  it("falls back to 'won' when the ledger carried no label", () => {
    expect(activityPhrase(event({ kind: "lead_won", detail: null })).tail).toBe("as won");
  });

  it("words an ordinary move as a move", () => {
    expect(activityPhrase(event()).verb).toBe("moved");
    expect(activityPhrase(event()).tail).toBe("to Negotiation");
  });

  it("drops the tail rather than printing a null stage", () => {
    expect(activityPhrase(event({ detail: null })).tail).toBe("");
  });

  it("needs no tail on a completed task", () => {
    expect(activityPhrase(event({ kind: "task_done", detail: null }))).toEqual({
      verb: "completed",
      subject: "Priya Sharma",
      tail: "",
    });
  });
});

describe("actorName", () => {
  it("names a machine rather than hiding it", () => {
    expect(actorName(event({ actor: null, actorKind: "machine" }))).toBe("Automation");
  });

  it("does not call an unrecorded actor a machine", () => {
    expect(actorName(event({ actor: null, actorKind: "unknown" }))).toBe("Someone");
  });
});

describe("groupActivityByDay", () => {
  const dayOf = (iso: string) => iso.slice(0, 10);

  it("puts the newest day first and the newest event first inside it", () => {
    const groups = groupActivityByDay(
      [
        event({ id: "a", at: "2026-09-28T10:00:00.000Z" }),
        event({ id: "b", at: "2026-09-30T08:00:00.000Z" }),
        event({ id: "c", at: "2026-09-30T17:00:00.000Z" }),
      ],
      dayOf,
    );
    expect(groups.map((g) => g.day)).toEqual(["2026-09-30", "2026-09-28"]);
    expect(groups[0]!.events.map((e) => e.id)).toEqual(["c", "b"]);
  });
});

describe("activitySummary", () => {
  it("separates what people did from what the machine did", () => {
    const summary = activitySummary([
      event({ id: "1" }),
      event({ id: "2", actor: null, actorKind: "machine" }),
      event({ id: "3", kind: "lead_won" }),
    ]);
    expect(summary).toBe("3 updates · 2 by people · 1 closed won.");
  });

  it("says nothing moved rather than reporting zero of everything", () => {
    expect(activitySummary([])).toBe("Nothing has moved in this range.");
  });
});

describe("openLoad", () => {
  it("adds the two open counts", () => {
    expect(openLoad(person({ openLeads: 10, openTasks: 5 }))).toBe(15);
  });

  it("counts an unlinked person's unknown tasks as nothing rather than guessing", () => {
    expect(openLoad(person({ openLeads: 10, openTasks: null }))).toBe(10);
  });
});

describe("capacityBand", () => {
  const medians = { openLeads: 10, openTasks: 5 };

  it("withholds a band on a floor small enough to name a colleague", () => {
    expect(capacityBand(person(), medians, MIN_WORKLOAD_FLOOR - 1)).toBe("unknown");
  });

  it("calls half again as much work over", () => {
    expect(capacityBand(person({ openLeads: 23 }), medians, 8)).toBe("over");
  });

  it("calls a fifth more heavy, and noise steady", () => {
    expect(capacityBand(person({ openLeads: 13 }), medians, 8)).toBe("heavy");
    expect(capacityBand(person({ openLeads: 11 }), medians, 8)).toBe("steady");
  });

  it("calls half the floor's load capacity", () => {
    expect(capacityBand(person({ openLeads: 2, openTasks: 1 }), medians, 8)).toBe("light");
  });

  it("refuses a band when the floor carries nothing at all", () => {
    expect(
      capacityBand(person({ openLeads: 0, openTasks: 0 }), { openLeads: 0, openTasks: 0 }, 8),
    ).toBe("unknown");
  });
});

describe("workloadMatrix", () => {
  it("puts the heaviest first, because the panel exists to find who to unload", () => {
    const matrix = workloadMatrix([
      person({ telecallerId: "a", displayName: "Asha", openLeads: 4, openTasks: 1 }),
      person({ telecallerId: "b", displayName: "Bala", openLeads: 30, openTasks: 9 }),
    ]);
    expect(matrix.rows.map((r) => r.displayName)).toEqual(["Bala", "Asha"]);
  });

  it("breaks a tie deterministically so the table does not reshuffle", () => {
    const rows = [
      person({ telecallerId: "b", displayName: "Bala" }),
      person({ telecallerId: "a", displayName: "Asha" }),
    ];
    expect(workloadMatrix(rows).rows.map((r) => r.displayName)).toEqual(["Asha", "Bala"]);
    expect(workloadMatrix([...rows].reverse()).rows.map((r) => r.displayName)).toEqual([
      "Asha",
      "Bala",
    ]);
  });

  it("scales both series on one axis", () => {
    const matrix = workloadMatrix([person({ openLeads: 3, openTasks: 17 })]);
    expect(matrix.max).toBe(17);
  });

  it("reports that somebody is unlinked so the page can say so", () => {
    expect(workloadMatrix([person({ userId: null, openTasks: null })]).someUnlinked).toBe(true);
    expect(workloadMatrix([person()]).someUnlinked).toBe(false);
  });
});

describe("workloadInsight", () => {
  it("stays quiet on a floor too small to publish bands for", () => {
    expect(workloadInsight(workloadMatrix(floor(MIN_WORKLOAD_FLOOR - 1)))).toBeNull();
  });

  it("names who is over and who is free", () => {
    const rows = [
      ...floor(),
      person({ telecallerId: "x", displayName: "Heavy", openLeads: 40, openTasks: 20 }),
      person({ telecallerId: "y", displayName: "Free", openLeads: 1, openTasks: 0 }),
    ];
    const insight = workloadInsight(workloadMatrix(rows));
    expect(insight).toContain("Heavy");
    expect(insight).toContain("Free");
  });

  it("says the work is spread evenly when nobody is over", () => {
    expect(workloadInsight(workloadMatrix(floor(6)))).toBe(
      "Open work is spread evenly across the floor.",
    );
  });
});

describe("leaderboard", () => {
  it("ranks on the chosen count, best first", () => {
    const ranked = leaderboard(
      [
        board({ telecallerId: "a", displayName: "Asha", won: 2 }),
        board({ telecallerId: "b", displayName: "Bala", won: 9 }),
      ],
      "won",
    );
    expect(ranked.map((r) => r.displayName)).toEqual(["Bala", "Asha"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2]);
  });

  it("gives tied people the same rank and skips the one after", () => {
    const ranked = leaderboard(
      [
        board({ telecallerId: "a", displayName: "Asha", won: 4 }),
        board({ telecallerId: "b", displayName: "Bala", won: 4 }),
        board({ telecallerId: "c", displayName: "Chetan", won: 1 }),
      ],
      "won",
    );
    expect(ranked.map((r) => r.rank)).toEqual([1, 1, 3]);
  });

  it("keeps somebody who closed nothing on the board", () => {
    const ranked = leaderboard([board({ won: 0 })], "won");
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.rank).toBe(1);
  });

  it("sorts an unknown figure last and leaves it unranked", () => {
    const ranked = leaderboard(
      [
        board({ telecallerId: "a", displayName: "Unlinked", tasksDone: null }),
        board({ telecallerId: "b", displayName: "Bala", tasksDone: 3 }),
      ],
      "tasks",
    );
    expect(ranked.map((r) => r.displayName)).toEqual(["Bala", "Unlinked"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, null]);
  });

  it("ranks value and count independently, because they disagree", () => {
    const rows = [
      board({ telecallerId: "a", displayName: "Volume", won: 9, wonValue: 90_000 }),
      board({ telecallerId: "b", displayName: "Whale", won: 1, wonValue: 900_000 }),
    ];
    expect(leaderboard(rows, "won")[0]!.displayName).toBe("Volume");
    expect(leaderboard(rows, "value")[0]!.displayName).toBe("Whale");
  });
});
