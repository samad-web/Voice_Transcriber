import { describe, expect, it } from "vitest";
import { isLeadStageMove, recordLeadStageTransition } from "./lead-stage-history";

/**
 * The lead stage ledger's single writer.
 *
 * A fake client, so these prove the control flow and the parameters, not the
 * SQL itself - the statement is exercised against a real database by the
 * migration run and by a live PATCH (see the commit that introduced this).
 */

interface Call {
  sql: string;
  params: unknown[];
}

function fakeClient() {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      query: async <R = Record<string, unknown>>(sql: string, params?: unknown[]) => {
        calls.push({ sql, params: params ?? [] });
        return { rows: [] as R[], rowCount: 1 };
      },
    },
  };
}

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";

describe("isLeadStageMove", () => {
  it("is a move when the stage or the status changes", () => {
    expect(isLeadStageMove({ fromStage: "new", toStage: "contacted", fromStatus: "open", toStatus: "open" })).toBe(true);
    expect(isLeadStageMove({ fromStage: "won", toStage: "won", fromStatus: "open", toStatus: "won" })).toBe(true);
  });

  it("is not a move to where the card already is", () => {
    expect(isLeadStageMove({ fromStage: "qualified", toStage: "qualified", fromStatus: "open", toStatus: "open" })).toBe(false);
  });
});

describe("recordLeadStageTransition", () => {
  it("writes one row with the move, the person and the source", async () => {
    const { calls, client } = fakeClient();
    const wrote = await recordLeadStageTransition(client, ORG, {
      leadId: LEAD,
      fromStage: "negotiation",
      toStage: "won",
      fromStatus: "open",
      toStatus: "won",
      source: "console",
      changedBy: USER,
    });
    expect(wrote).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("INSERT INTO lead_stage_transitions");
    expect(calls[0].params).toEqual([ORG, LEAD, "negotiation", "won", "open", "won", USER, null, "console"]);
  });

  it("resolves changed_by through users, so an id that names nobody records nobody instead of failing the move", async () => {
    const { calls, client } = fakeClient();
    await recordLeadStageTransition(client, ORG, {
      leadId: LEAD,
      fromStage: "new",
      toStage: "contacted",
      fromStatus: "open",
      toStatus: "open",
      source: "console",
      changedBy: USER,
    });
    expect(calls[0].sql).toMatch(/\(SELECT u\.id FROM users u WHERE u\.id = \$7::uuid\)/);
  });

  it("writes nothing for a non-move, so the ledger never fills with noise", async () => {
    const { calls, client } = fakeClient();
    const wrote = await recordLeadStageTransition(client, ORG, {
      leadId: LEAD,
      fromStage: "contacted",
      toStage: "contacted",
      fromStatus: "open",
      toStatus: "open",
      source: "console",
    });
    expect(wrote).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("records a machine's move with its label and no person", async () => {
    const { calls, client } = fakeClient();
    await recordLeadStageTransition(client, ORG, {
      leadId: LEAD,
      fromStage: "new",
      toStage: "contacted",
      fromStatus: "open",
      toStatus: "open",
      source: "automation",
      actorLabel: "automation: second qualified call",
    });
    expect(calls[0].params.slice(6)).toEqual([null, "automation: second qualified call", "automation"]);
  });
});
