import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { includeStageEnabled, reconcileEnabled, reconcileOrg } from "./crm-reconcile";

/**
 * The flags follow email-send.ts's convention exactly (strict "true", near
 * misses stay off) — pinned the same way email-send.spec.ts pins its own.
 */
describe("reconcileEnabled", () => {
  it("is OFF when unset", () => {
    expect(reconcileEnabled({})).toBe(false);
  });

  it.each(["1", "TRUE", "yes", " true", "true "])("is OFF for the near-miss %j", (v) => {
    expect(reconcileEnabled({ CRM_RECONCILE_ENABLED: v })).toBe(false);
  });

  it("is ON only for the exact string 'true'", () => {
    expect(reconcileEnabled({ CRM_RECONCILE_ENABLED: "true" })).toBe(true);
  });
});

describe("includeStageEnabled", () => {
  it("is OFF by default — stage/status only mean something once Milestone 2 is verified live", () => {
    expect(includeStageEnabled({})).toBe(false);
  });

  it("is ON only for the exact string 'true'", () => {
    expect(includeStageEnabled({ CRM_RECONCILE_INCLUDE_STAGE: "true" })).toBe(true);
  });
});

/**
 * reconcileOrg compares a lead against its dual-written deal/contact. No
 * database is opened: a fake client answers the join query with canned rows
 * and replays the SAME dedup rule the real migration's WHERE NOT EXISTS
 * clause enforces (only a CHANGED mismatch value logs), the same approach
 * crm-objects.test.ts uses for projectLeadToCrm.
 */

const MATCHING_ROW = {
  lead_id: "lead-1",
  lead_title: "Rajesh",
  lead_value_num: "5000",
  lead_facts: { customer_name: "Rajesh", brick_quantity: 5000 },
  lead_call_count: 2,
  lead_last_activity_at: new Date("2026-08-06T09:15:00.000Z"),
  lead_stage: "new",
  lead_status: "open",
  deal_id: "deal-1",
  deal_name: "Rajesh",
  deal_amount: "5000",
  deal_facts: { customer_name: "Rajesh", brick_quantity: 5000 },
  deal_call_count: 2,
  deal_last_activity_at: new Date("2026-08-06T09:15:00.000Z"),
  deal_stage: "contacted", // deliberately different — must be IGNORED unless includeStage
  deal_status: "open",
  contact_id: "contact-1",
  contact_name: "Rajesh",
  contact_facts: { customer_name: "Rajesh", brick_quantity: 5000 },
  contact_call_count: 2,
  contact_last_activity_at: new Date("2026-08-06T09:15:00.000Z"),
};

interface LoggedRow {
  leadId: string;
  field: string;
  leadValue: string | null;
  crmValue: string | null;
}

/** Replays the migration's own dedup rule in JS so the fake needs no real DB. */
function fakeReconcileDb(initialRows: Record<string, unknown>[]) {
  const state = { rows: initialRows };
  const priorByKey = new Map<string, { leadValue: string | null; crmValue: string | null }>();
  const logged: LoggedRow[] = [];
  return {
    logged,
    setRows: (rows: Record<string, unknown>[]) => {
      state.rows = rows;
    },
    client: {
      query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        if (sql.includes("FROM leads l")) return { rows: state.rows as R[] };
        if (sql.includes("INSERT INTO crm_reconciliation_log")) {
          const [, leadId, , , field, leadValue, crmValue] = params as [
            string,
            string,
            string | null,
            string | null,
            string,
            string | null,
            string | null,
          ];
          const key = `${leadId}::${field}`;
          const prior = priorByKey.get(key);
          const unchanged = prior && prior.leadValue === leadValue && prior.crmValue === crmValue;
          if (unchanged) return { rows: [] as R[] };
          priorByKey.set(key, { leadValue, crmValue });
          logged.push({ leadId, field, leadValue, crmValue });
          return { rows: [{ inserted: true }] as R[] };
        }
        throw new Error(`fakeReconcileDb: unexpected query: ${sql.slice(0, 80)}`);
      },
    },
  };
}

describe("reconcileOrg", () => {
  afterEach(() => {
    delete process.env.CRM_RECONCILE_INCLUDE_STAGE;
  });

  it("logs nothing when every compared field already matches", async () => {
    const { client, logged } = fakeReconcileDb([MATCHING_ROW]);
    await reconcileOrg(client, "org-1");
    expect(logged).toEqual([]);
  });

  it("flags a lead with no dual-written deal at all, and stops there", async () => {
    const { client, logged } = fakeReconcileDb([{ ...MATCHING_ROW, deal_id: null, deal_name: null }]);
    await reconcileOrg(client, "org-1");
    expect(logged).toEqual([{ leadId: "lead-1", field: "deal_missing", leadValue: "lead-1", crmValue: null }]);
  });

  it("flags a mismatched name, amount, facts and call_count, all independently", async () => {
    const { client, logged } = fakeReconcileDb([
      {
        ...MATCHING_ROW,
        deal_name: "Stale Name",
        deal_amount: "4000",
        deal_facts: { customer_name: "Rajesh" }, // missing brick_quantity
        deal_call_count: 1,
      },
    ]);
    await reconcileOrg(client, "org-1");
    const fields = logged.map((l) => l.field).sort();
    expect(fields).toEqual(["deal.amount", "deal.call_count", "deal.facts", "deal.name"]);
  });

  it("ignores a stage/status mismatch by default — Milestone 2 divergence is expected until verified live", async () => {
    const { client, logged } = fakeReconcileDb([MATCHING_ROW]); // deal_stage differs from lead_stage
    await reconcileOrg(client, "org-1");
    expect(logged.find((l) => l.field === "deal.stage")).toBeUndefined();
  });

  it("flags stage/status once CRM_RECONCILE_INCLUDE_STAGE=true", async () => {
    process.env.CRM_RECONCILE_INCLUDE_STAGE = "true";
    const { client, logged } = fakeReconcileDb([MATCHING_ROW]);
    await reconcileOrg(client, "org-1");
    expect(logged.map((l) => l.field)).toContain("deal.stage");
  });

  it("also compares the contact side independently of the deal side", async () => {
    const { client, logged } = fakeReconcileDb([{ ...MATCHING_ROW, contact_name: "Old Name" }]);
    await reconcileOrg(client, "org-1");
    expect(logged.map((l) => l.field)).toContain("contact.display_name");
    expect(logged.map((l) => l.field)).not.toContain("deal.name");
  });

  it("does not re-log an unchanged mismatch on a second sweep", async () => {
    const rows = [{ ...MATCHING_ROW, deal_name: "Stale Name" }];
    const { client, logged } = fakeReconcileDb(rows);
    await reconcileOrg(client, "org-1");
    await reconcileOrg(client, "org-1"); // same divergence, same sweep again
    expect(logged.filter((l) => l.field === "deal.name")).toHaveLength(1);
  });

  it("logs again when a mismatch's value actually changes between sweeps", async () => {
    const { client, logged, setRows } = fakeReconcileDb([{ ...MATCHING_ROW, deal_name: "Stale Name" }]);
    await reconcileOrg(client, "org-1");
    // The lead's title moved again — a fresh divergence, not the same one.
    setRows([{ ...MATCHING_ROW, lead_title: "Rajesh Kumar", deal_name: "Stale Name" }]);
    await reconcileOrg(client, "org-1");
    expect(logged.filter((l) => l.field === "deal.name")).toHaveLength(2);
  });
});
