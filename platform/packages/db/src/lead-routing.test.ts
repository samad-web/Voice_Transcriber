import { describe, expect, it, vi } from "vitest";
import { routeLead, type RoutingClient } from "./lead-routing";

/**
 * The SAFETY half of lead distribution (migration 0094).
 *
 * The fairness of the pick is proved in `@aura/shared`'s lead-routing.test.ts,
 * which runs a thousand leads through the pure algorithm. This file proves the
 * things that only exist once the algorithm meets a transaction, and every one
 * of them is a property that costs a customer real money when it breaks:
 *
 *   - a routing failure must never take the lead down with it
 *   - routing must never move a lead off somebody
 *   - a savepoint must never be left dangling
 *
 * A fake client rather than a database. That is a real limit and worth naming:
 * these tests cannot prove the SQL is valid, only that the control flow around
 * it is. The statements themselves are exercised by the migration running in
 * CI and by the integration suite.
 */

type Row = Record<string, unknown>;

interface Script {
  /** Matched as a substring of the SQL, in order of specificity. */
  [fragment: string]: Row[] | (() => Row[]);
}

/** The statements are multi-line, so both matching and the log run on this. */
const flat = (sql: string): string => sql.replace(/\s+/gu, " ").trim();

/**
 * Records every statement and answers from a script. Anything unmatched
 * returns no rows, which is what an UPDATE or an INSERT returns anyway.
 */
function fakeClient(script: Script = {}) {
  const log: string[] = [];
  const client: RoutingClient = {
    async query<R>(sql: string) {
      const normalised = flat(sql);
      log.push(normalised);
      for (const [fragment, rows] of Object.entries(script)) {
        if (normalised.includes(flat(fragment))) {
          const value = typeof rows === "function" ? rows() : rows;
          return { rows: value as R[] };
        }
      }
      return { rows: [] as R[] };
    },
  };
  return { client, log };
}

/** An unassigned lead, one active round-robin rule, one telecaller on it. */
function happyPath(): Script {
  return {
    "FROM leads WHERE id": [
      {
        workspace_id: "ws-1",
        source_channel: "web_form",
        lead_source_id: null,
        project_id: null,
        value_num: null,
        assigned_telecaller_id: null,
      },
    ],
    "FROM lead_routing_rules WHERE org_id": [
      {
        id: "rule-1",
        name: "Website enquiries",
        strategy: "round_robin",
        match: {},
        cursor: 0,
        workspace_id: null,
      },
    ],
    "FOR UPDATE": [{ cursor: 0, strategy: "round_robin", name: "Website enquiries" }],
    "FROM lead_routing_targets t": [
      {
        id: "target-1",
        telecaller_id: "tc-1",
        name: "Priya",
        position: 0,
        share_pct: "0",
        delivered: "0",
        paused: false,
        daily_cap: null,
        assigned_today: 0,
        counter_is_today: true,
        user_id: "user-1",
      },
    ],
    "UPDATE leads SET assigned_telecaller_id": [{ id: "lead-1" }],
  };
}

describe("routeLead - the assignment", () => {
  it("assigns an unassigned lead and says who and why", async () => {
    const { client } = fakeClient(happyPath());
    const result = await routeLead(client, "org-1", { leadId: "lead-1", trigger: "intake" });

    expect(result.assigned).toBe(true);
    expect(result.telecallerId).toBe("tc-1");
    expect(result.telecallerName).toBe("Priya");
    expect(result.ruleName).toBe("Website enquiries");
    expect(result.reason).toContain("Priya");
  });

  it("locks the rule before reading the counters it is about to advance", async () => {
    // The whole concurrency story. Without the lock two simultaneous leads read
    // the same cursor and both go to the same person - the one failure a
    // distribution engine cannot have, and the one that only appears under real
    // traffic.
    const { client, log } = fakeClient(happyPath());
    await routeLead(client, "org-1", { leadId: "lead-1", trigger: "intake" });

    const lockAt = log.findIndex((q) => q.includes("FOR UPDATE"));
    const targetsAt = log.findIndex((q) => q.includes("FROM lead_routing_targets t"));
    const cursorAt = log.findIndex((q) => q.includes("UPDATE lead_routing_rules SET cursor"));

    expect(lockAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(targetsAt);
    expect(targetsAt).toBeLessThan(cursorAt);
  });

  it("advances the rule cursor and both counters", async () => {
    const { client, log } = fakeClient(happyPath());
    await routeLead(client, "org-1", { leadId: "lead-1", trigger: "intake" });

    expect(log.some((q) => q.includes("UPDATE lead_routing_targets t SET delivered"))).toBe(true);
    expect(log.some((q) => q.includes("UPDATE lead_routing_rules SET cursor"))).toBe(true);
  });

  it("writes a decision row for the assignment", async () => {
    const { client, log } = fakeClient(happyPath());
    await routeLead(client, "org-1", { leadId: "lead-1", trigger: "intake" });
    expect(log.some((q) => q.includes("INSERT INTO lead_routing_assignments"))).toBe(true);
  });

  it("keeps the lead and its deal on the same person", async () => {
    // leads and deals carry the same column (0075). A lead assigned to Priya
    // whose deal is assigned to nobody reads differently on two pages of one
    // console, and reports built on deals would miss her entirely.
    const { client, log } = fakeClient(happyPath());
    await routeLead(client, "org-1", { leadId: "lead-1", dealId: "deal-1", trigger: "intake" });
    expect(log.some((q) => q.includes("UPDATE deals SET assigned_telecaller_id"))).toBe(true);
  });

  it("does not touch deals when there is no deal", async () => {
    const { client, log } = fakeClient(happyPath());
    await routeLead(client, "org-1", { leadId: "lead-1", trigger: "intake" });
    expect(log.some((q) => q.includes("UPDATE deals"))).toBe(false);
  });
});

describe("routeLead - what it refuses to touch", () => {
  it("never overwrites a lead somebody already owns", async () => {
    // HUMAN-OWNS-IT. A source pinned to a named owner, a manager who assigned
    // it by hand, an earlier rule - none of them may be overridden by a
    // rotation, and none of them may even cost the rule a turn.
    const script = happyPath();
    script["FROM leads WHERE id"] = [
      {
        workspace_id: "ws-1",
        source_channel: "web_form",
        lead_source_id: null,
        project_id: null,
        value_num: null,
        assigned_telecaller_id: "somebody-else",
      },
    ];
    const { client, log } = fakeClient(script);
    const result = await routeLead(client, "org-1", { leadId: "lead-1", trigger: "intake" });

    expect(result.assigned).toBe(false);
    expect(result.reason).toContain("already assigned");
    expect(log.some((q) => q.includes("UPDATE leads SET assigned_telecaller_id"))).toBe(false);
    expect(log.some((q) => q.includes("UPDATE lead_routing_rules SET cursor"))).toBe(false);
  });

  it("spends no turn when the conditional UPDATE loses a race", async () => {
    // Belt and braces over the read above. If the guarded UPDATE matches no
    // row, somebody won the race: the counters must NOT advance, or a lead
    // that was never handed out would still skew the rotation.
    const script = happyPath();
    script["UPDATE leads SET assigned_telecaller_id"] = [];
    const { client, log } = fakeClient(script);
    const result = await routeLead(client, "org-1", { leadId: "lead-1", trigger: "intake" });

    expect(result.assigned).toBe(false);
    expect(log.some((q) => q.includes("UPDATE lead_routing_rules SET cursor"))).toBe(false);
    expect(log.some((q) => q.includes("INSERT INTO lead_routing_assignments"))).toBe(false);
  });

  it("does nothing at all when the org has no rules", async () => {
    const { client, log } = fakeClient({
      "FROM leads WHERE id": [
        {
          workspace_id: "ws-1",
          source_channel: "web_form",
          lead_source_id: null,
          project_id: null,
          value_num: null,
          assigned_telecaller_id: null,
        },
      ],
    });
    const result = await routeLead(client, "org-1", { leadId: "lead-1", trigger: "intake" });

    expect(result.assigned).toBe(false);
    expect(result.reason).toContain("no active distribution rule");
    expect(log.some((q) => q.includes("UPDATE"))).toBe(false);
  });

  it("records why nobody could take it, so the rules page can show it", async () => {
    const script = happyPath();
    script["FROM lead_routing_targets t"] = [];
    const { client, log } = fakeClient(script);
    const result = await routeLead(client, "org-1", { leadId: "lead-1", trigger: "intake" });

    expect(result.assigned).toBe(false);
    expect(result.reason).toContain("no telecallers");
    // The refusal IS the record. An unassigned lead with no explanation is the
    // support ticket this row exists to prevent.
    expect(log.some((q) => q.includes("INSERT INTO lead_routing_assignments"))).toBe(true);
  });

  it("skips a rule whose criteria do not match the lead", async () => {
    const script = happyPath();
    script["FROM lead_routing_rules WHERE org_id"] = [
      {
        id: "rule-1",
        name: "Meta only",
        strategy: "round_robin",
        match: { sourceChannels: ["meta_ads"] },
        cursor: 0,
        workspace_id: null,
      },
    ];
    const { client } = fakeClient(script);
    const result = await routeLead(client, "org-1", { leadId: "lead-1", trigger: "intake" });
    expect(result.reason).toContain("no distribution rule matches");
  });
});

describe("routeLead - it cannot lose a lead", () => {
  it("rolls back to the savepoint and returns rather than throwing", async () => {
    // The direction of this trade is not negotiable. An unassigned lead is on
    // the board where somebody can pick it up; a lead lost to a rolled-back
    // intake transaction is invisible, and the provider's retry has already
    // been swallowed as a duplicate by the ledger claim.
    const client: RoutingClient = {
      async query<R>(sql: string) {
        if (sql.includes("FROM leads WHERE id")) throw new Error("connection reset");
        return { rows: [] as R[] };
      },
    };
    // The failure is the point of the test; its console.error is not.
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await routeLead(client, "org-1", { leadId: "lead-1", trigger: "intake" });
    quiet.mockRestore();

    expect(result.assigned).toBe(false);
    expect(result.reason).toContain("routing failed");
  });

  it("releases the savepoint on the failure path as well as the happy one", async () => {
    // ROLLBACK TO leaves the savepoint in place. Without the RELEASE after it,
    // a backfill of 500 leads would accumulate 500 savepoints on one
    // transaction.
    const { client, log } = fakeClient(happyPath());
    await routeLead(client, "org-1", { leadId: "lead-1", trigger: "intake" });
    expect(log.filter((q) => q === "SAVEPOINT lead_routing")).toHaveLength(1);
    expect(log.filter((q) => q === "RELEASE SAVEPOINT lead_routing")).toHaveLength(1);

    const failing: string[] = [];
    const bad: RoutingClient = {
      async query<R>(sql: string) {
        const normalised = flat(sql);
        failing.push(normalised);
        if (normalised.includes("FROM lead_routing_rules WHERE org_id")) throw new Error("boom");
        if (normalised.includes("FROM leads WHERE id")) {
          return {
            rows: [
              {
                workspace_id: null,
                source_channel: null,
                lead_source_id: null,
                project_id: null,
                value_num: null,
                assigned_telecaller_id: null,
              },
            ] as R[],
          };
        }
        return { rows: [] as R[] };
      },
    };
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    await routeLead(bad, "org-1", { leadId: "lead-1", trigger: "intake" });
    quiet.mockRestore();
    expect(failing).toContain("ROLLBACK TO SAVEPOINT lead_routing");
    expect(failing).toContain("RELEASE SAVEPOINT lead_routing");
  });

  it("survives a match column that no longer parses", async () => {
    // A hand-edited row or a rolled-back deploy must not take the whole org's
    // routing offline. `{}` is the documented meaning of an absent criterion.
    const script = happyPath();
    script["FROM lead_routing_rules WHERE org_id"] = [
      {
        id: "rule-1",
        name: "Corrupt",
        strategy: "round_robin",
        match: { sourceChannels: "not-an-array" },
        cursor: 0,
        workspace_id: null,
      },
    ];
    const { client } = fakeClient(script);
    const result = await routeLead(client, "org-1", { leadId: "lead-1", trigger: "intake" });
    expect(result.assigned).toBe(true);
  });
});

describe("routeLead - the notification", () => {
  it("tells the telecaller, keyed so a backfill cannot repeat it", async () => {
    const { client, log } = fakeClient(happyPath());
    await routeLead(client, "org-1", { leadId: "lead-1", trigger: "intake" });

    const notify = log.find((q) => q.includes("INSERT INTO notifications"));
    expect(notify).toBeDefined();
    expect(notify).toContain("ON CONFLICT (user_id, dedupe_key)");
  });

  it("stays silent for a telecaller with no console login", async () => {
    // A name against a handset with no user row. Normal for a recording-only
    // tenant, and no reason to refuse the assignment.
    const script = happyPath();
    script["FROM lead_routing_targets t"] = [
      {
        id: "target-1",
        telecaller_id: "tc-1",
        name: "Priya",
        position: 0,
        share_pct: "0",
        delivered: "0",
        paused: false,
        daily_cap: null,
        assigned_today: 0,
        counter_is_today: true,
        user_id: null,
      },
    ];
    const { client, log } = fakeClient(script);
    const result = await routeLead(client, "org-1", { leadId: "lead-1", trigger: "intake" });

    expect(result.assigned).toBe(true);
    expect(log.some((q) => q.includes("INSERT INTO notifications"))).toBe(false);
  });

  it("sends nothing per-lead when the backfill asks for quiet", async () => {
    const { client, log } = fakeClient(happyPath());
    await routeLead(client, "org-1", { leadId: "lead-1", trigger: "backfill", quiet: true });
    expect(log.some((q) => q.includes("INSERT INTO notifications"))).toBe(false);
  });
});

describe("routeLead - the daily counter", () => {
  it("treats a stale counter_day as zero rather than as today's count", async () => {
    // A stored counter with no date beside it is how a daily cap silently
    // becomes a lifetime cap: yesterday's 40 would keep a cap of 40 closed
    // forever.
    const script = happyPath();
    script["FROM lead_routing_targets t"] = [
      {
        id: "target-1",
        telecaller_id: "tc-1",
        name: "Priya",
        position: 0,
        share_pct: "0",
        delivered: "0",
        paused: false,
        daily_cap: 5,
        assigned_today: 40,
        counter_is_today: false,
        user_id: null,
      },
    ];
    const { client } = fakeClient(script);
    const result = await routeLead(client, "org-1", { leadId: "lead-1", trigger: "intake" });
    expect(result.assigned).toBe(true);
  });

  it("still refuses when the cap is genuinely reached today", async () => {
    const script = happyPath();
    script["FROM lead_routing_targets t"] = [
      {
        id: "target-1",
        telecaller_id: "tc-1",
        name: "Priya",
        position: 0,
        share_pct: "0",
        delivered: "0",
        paused: false,
        daily_cap: 5,
        assigned_today: 5,
        counter_is_today: true,
        user_id: null,
      },
    ];
    const { client } = fakeClient(script);
    const result = await routeLead(client, "org-1", { leadId: "lead-1", trigger: "intake" });
    expect(result.assigned).toBe(false);
    expect(result.reason).toContain("daily cap");
  });
});
