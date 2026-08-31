import { parsePipelineStages } from "@aura/shared";
import { ReportsService, stageProbability } from "./reports.service";
import { furthestOpenStage } from "../crm-objects/stage-history";
import type { DbService } from "../../db/db.service";

/**
 * The arithmetic in these reports is the product - a wrong conversion rate is
 * worse than no conversion rate, because somebody acts on it. A fake DbService
 * routes each query by a distinguishing substring, the same approach the
 * worker's crm-objects.test.ts uses.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const PIPELINE_ID = "22222222-2222-4222-8222-222222222222";

const STAGES = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "qualified", label: "Qualified" },
  { key: "negotiation", label: "Negotiation" },
  { key: "won", label: "Won", terminal: "won" },
  { key: "lost", label: "Lost", terminal: "lost" },
];

interface FakeRows {
  /**
   * One row per deal for the conversion query - `visited` being every stage
   * the transition ledger (migration 0046) records it having entered, which
   * is what replaced the old "infer it from the current stage" guess.
   */
  deals?: Array<{ status: string; visited: string[] | null }>;
  /** rows for the pipeline snapshot query */
  counts?: Array<{ stage: string; deals: string; amount: string; avg_days: string | null }>;
  velocity?: { avg_days: string | null; won: string };
  perf?: Array<Record<string, string | null>>;
}

function fakeDb(rows: FakeRows = {}): DbService {
  return {
    withOrg: async <T>(_orgId: string, fn: (client: unknown) => Promise<T>): Promise<T> =>
      fn({
        query: async (sql: string) => {
          if (sql.includes("FROM deal_pipelines")) {
            return { rows: [{ id: PIPELINE_ID, name: "Sales", stages: STAGES }], rowCount: 1 };
          }
          if (sql.includes("deal_stage_transitions")) {
            return { rows: rows.deals ?? [], rowCount: (rows.deals ?? []).length };
          }
          if (sql.includes("status = 'won'") && sql.includes("avg(")) {
            return { rows: [rows.velocity ?? { avg_days: null, won: "0" }], rowCount: 1 };
          }
          if (sql.includes("GROUP BY stage")) {
            return { rows: rows.counts ?? [], rowCount: (rows.counts ?? []).length };
          }
          if (sql.includes("deal_stats")) {
            return { rows: rows.perf ?? [], rowCount: (rows.perf ?? []).length };
          }
          if (sql.includes("FROM tasks")) {
            return { rows: [{ completed: "0", overdue: "0" }], rowCount: 1 };
          }
          if (sql.includes("FROM interactions")) {
            return { rows: [{ total: "0" }], rowCount: 1 };
          }
          throw new Error(`fakeDb: unexpected query: ${sql.slice(0, 60)}`);
        },
      }),
  } as unknown as DbService;
}

describe("stageProbability", () => {
  const stages = parsePipelineStages(STAGES);

  it("rises with position across the open stages", () => {
    expect(stages.slice(0, 4).map((_, i) => stageProbability(stages, i))).toEqual([
      0.2, 0.4, 0.6, 0.8,
    ]);
  });

  it("treats terminal stages as certainties, not estimates", () => {
    expect(stageProbability(stages, 4)).toBe(1); // won
    expect(stageProbability(stages, 5)).toBe(0); // lost
  });
});

describe("ReportsService.pipeline", () => {
  it("renders every open stage, including ones holding no deals", async () => {
    const service = new ReportsService(
      fakeDb({ counts: [{ stage: "new", deals: "4", amount: "1000", avg_days: "3.25" }] }),
    );
    const result = await service.pipeline(ORG);

    // Driven by the pipeline's stage list, not by what the deals table
    // happens to contain - an empty column must read as a real zero.
    expect(result.rows.map((r) => r.stage)).toEqual(["new", "contacted", "qualified", "negotiation"]);
    expect(result.rows[1]).toMatchObject({ deals: 0, amount: 0, avgDaysInStage: null });
  });

  it("discounts each stage's value by its probability", async () => {
    const service = new ReportsService(
      fakeDb({
        counts: [
          { stage: "new", deals: "2", amount: "1000", avg_days: null },
          { stage: "negotiation", deals: "1", amount: "1000", avg_days: null },
        ],
      }),
    );
    const result = await service.pipeline(ORG);

    expect(result.rows[0].weightedAmount).toBe(200); // 1000 * 0.2
    expect(result.rows[3].weightedAmount).toBe(800); // 1000 * 0.8
    expect(result.totals).toMatchObject({ deals: 3, amount: 2000, weightedAmount: 1000 });
  });

  it("excludes terminal stages from the forecast", async () => {
    const service = new ReportsService(fakeDb());
    const result = await service.pipeline(ORG);
    expect(result.rows.some((r) => r.stage === "won" || r.stage === "lost")).toBe(false);
  });
});

describe("ReportsService.conversion", () => {
  const run = (deals: FakeRows["deals"]) =>
    new ReportsService(fakeDb({ deals })).conversion(ORG, "2026-01-01", "2026-12-31");

  /** n identical deals - the ledger shape, one row each. */
  const many = (n: number, status: string, visited: string[] | null) =>
    Array.from({ length: n }, () => ({ status, visited }));

  it("counts a deal as having reached every stage it entered", async () => {
    const result = await run(many(5, "open", ["new", "contacted", "qualified"]));
    expect(result.rows.map((r) => r.reached)).toEqual([5, 5, 5, 0]);
  });

  it("credits a won deal with the whole funnel", async () => {
    // Its ledger stops at whatever stage it was in when it closed; winning is
    // by definition having passed everything before it.
    const result = await run(many(2, "won", ["new", "won"]));
    expect(result.rows.map((r) => r.reached)).toEqual([2, 2, 2, 2]);
  });

  it("credits a LOST deal with how far it actually got - the point of 0046", async () => {
    // The old report could only floor this at the entry stage, because
    // `deals.stage` had been overwritten with 'lost'. The ledger remembers
    // that it reached Negotiation, so a late loss and an early one stop
    // looking identical.
    const result = await run(many(7, "lost", ["new", "contacted", "qualified", "negotiation", "lost"]));
    expect(result.rows.map((r) => r.reached)).toEqual([7, 7, 7, 7]);
  });

  it("still floors a deal with no usable history at the entry stage", async () => {
    // Nothing in the ledger, or only terminal stages in it. It certainly
    // entered the pipeline; dropping it would shrink every denominator below.
    for (const visited of [null, [], ["lost"]]) {
      const result = await run(many(3, "lost", visited));
      expect(result.rows.map((r) => r.reached)).toEqual([3, 0, 0, 0]);
    }
  });

  it("counts a deal that was moved BACKWARDS once, at its high-water mark", async () => {
    // Furthest-reached, not current - otherwise a deal pulled back from
    // Negotiation to Contacted would silently reduce the Negotiation count of
    // a period that already happened.
    const result = await run(many(1, "open", ["new", "contacted", "negotiation"]));
    expect(result.rows.map((r) => r.reached)).toEqual([1, 1, 1, 1]);
  });

  it("never lets the top of the funnel disagree with deals created", async () => {
    // The invariant that caught the original bug: 34 created rendered as 32
    // reached, because lost deals fell out entirely.
    const result = await run([
      ...many(29, "open", ["new"]),
      ...many(3, "won", ["new", "won"]),
      ...many(2, "lost", ["new", "contacted", "lost"]),
    ]);
    expect(result.rows[0].reached).toBe(result.summary?.created);
    expect(result.summary).toMatchObject({ created: 34, won: 3, lost: 2, open: 29, winRate: 0.6 });
  });

  it("reports no win rate rather than 0% when nothing has closed", async () => {
    const result = await run(many(10, "open", ["new"]));
    expect(result.summary?.winRate).toBeNull();
  });

  it("gives the first stage no conversion rate - there is nothing before it", async () => {
    const result = await run(many(10, "open", ["new"]));
    expect(result.rows[0].conversionFromPrevious).toBeNull();
  });
});

describe("furthestOpenStage", () => {
  const order = new Map([
    ["new", 0],
    ["contacted", 1],
    ["qualified", 2],
    ["negotiation", 3],
  ]);

  it("ignores terminal stages, which are not positions in the funnel", () => {
    expect(furthestOpenStage(order, ["new", "contacted", "lost"], "lost", 4)).toBe(1);
  });

  it("returns -1 when nothing in the history is a known open stage", () => {
    // The caller floors this at the entry stage; returning 0 here instead
    // would make "I know it reached New" indistinguishable from "I know
    // nothing", which are different claims.
    expect(furthestOpenStage(order, ["lost"], "lost", 4)).toBe(-1);
    expect(furthestOpenStage(order, [], "open", 4)).toBe(-1);
  });

  it("gives a won deal the last open stage regardless of its history", () => {
    expect(furthestOpenStage(order, ["new"], "won", 4)).toBe(3);
  });

  it("is order-independent - it takes the maximum, not the last entry", () => {
    expect(furthestOpenStage(order, ["negotiation", "contacted"], "open", 4)).toBe(3);
  });
});

describe("ReportsService.performance", () => {
  it("reports no win rate for a rep who has closed nothing", async () => {
    const service = new ReportsService(
      fakeDb({
        perf: [
          {
            rep_id: null,
            rep: "Unassigned",
            open_deals: "4",
            won_deals: "0",
            lost_deals: "0",
            open_value: "500",
            won_value: "0",
          },
        ],
      }),
    );
    const result = await service.performance(ORG, "2026-01-01", "2026-12-31");
    expect(result.reps[0]).toMatchObject({ rep: "Unassigned", openDeals: 4, winRate: null });
  });

  it("computes win rate over decided deals only, ignoring the open ones", async () => {
    const service = new ReportsService(
      fakeDb({
        perf: [
          {
            rep_id: "r1",
            rep: "Asha",
            open_deals: "10",
            won_deals: "3",
            lost_deals: "1",
            open_value: "0",
            won_value: "900",
          },
        ],
      }),
    );
    const result = await service.performance(ORG, "2026-01-01", "2026-12-31");
    expect(result.reps[0].winRate).toBe(0.75);
  });
});
