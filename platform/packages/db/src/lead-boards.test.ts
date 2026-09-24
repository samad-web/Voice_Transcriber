import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LEAD_STAGES } from "@aura/shared";
import type { DbClient } from "./crm-projection";
import { leadBoardStages, listLeadBoards, resolveLeadBoard } from "./lead-boards";

/**
 * Board resolution (0136). A fake client, so these prove the control flow -
 * what is asked, what an answer is turned into, and that a failure never takes
 * the surrounding lead write down - not that the SQL is valid; the migration
 * and the live check cover that.
 */

const flat = (sql: string) => sql.replace(/\s+/gu, " ").trim();

function fakeClient(answer: (sql: string, params: unknown[]) => Record<string, unknown>[]) {
  const log: string[] = [];
  const client: DbClient = {
    async query<R>(sql: string, params: unknown[] = []) {
      log.push(flat(sql));
      return { rows: answer(flat(sql), params) as R[] };
    },
  };
  return { client, log };
}

const ORG = "11111111-1111-1111-1111-111111111111";
const BOARD = "22222222-2222-2222-2222-222222222222";
const SOURCE = "33333333-3333-3333-3333-333333333333";

describe("resolveLeadBoard", () => {
  it("never looks anything up for a channel that cannot be routed", async () => {
    const { client, log } = fakeClient(() => []);
    for (const channel of ["call", "meta_ads", "api", null, undefined]) {
      expect(await resolveLeadBoard(client, ORG, { channel })).toBeNull();
    }
    expect(log).toEqual([]);
  });

  it("returns the routed board, asking for the exact source and the whole channel", async () => {
    const { client, log } = fakeClient((sql) => (sql.startsWith("SELECT board_id") ? [{ board_id: BOARD }] : []));
    expect(await resolveLeadBoard(client, ORG, { channel: "whatsapp", sourceId: SOURCE })).toBe(BOARD);
    expect(log[0]).toBe("SAVEPOINT lead_board_route");
    expect(log[1]).toContain("ORDER BY (source_id IS NULL)");
    expect(log[2]).toBe("RELEASE SAVEPOINT lead_board_route");
  });

  it("honours a route that names the Main board explicitly", async () => {
    // The exception row: "this number stays on Main" beats the channel's route.
    const { client } = fakeClient((sql) => (sql.startsWith("SELECT board_id") ? [{ board_id: null }] : []));
    expect(await resolveLeadBoard(client, ORG, { channel: "whatsapp", sourceId: SOURCE })).toBeNull();
  });

  it("answers the Main board when no route matches", async () => {
    const { client } = fakeClient(() => []);
    expect(await resolveLeadBoard(client, ORG, { channel: "manual" })).toBeNull();
  });

  it("falls back to the Main board, and leaves the transaction usable, when the lookup fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, log } = fakeClient((sql) => {
      if (sql.startsWith("SELECT board_id")) throw new Error("relation does not exist");
      return [];
    });
    expect(await resolveLeadBoard(client, ORG, { channel: "web_form", sourceId: SOURCE })).toBeNull();
    expect(log.at(-1)).toBe("ROLLBACK TO SAVEPOINT lead_board_route");
    error.mockRestore();
  });
});

describe("listLeadBoards", () => {
  it("names the Main board when the owner has not, and keeps the others' own names", async () => {
    const stages = [{ key: "enquiry", label: "Enquiry" }];
    const { client } = fakeClient(() => [
      { id: null, name: null, stages: DEFAULT_LEAD_STAGES },
      { id: BOARD, name: "Website", stages },
    ]);
    expect(await listLeadBoards(client, ORG)).toEqual([
      { id: null, name: "Main board", stages: DEFAULT_LEAD_STAGES },
      { id: BOARD, name: "Website", stages },
    ]);
  });
});

describe("leadBoardStages", () => {
  it("reads the Main board from the org, named by default", async () => {
    const { client, log } = fakeClient(() => [{ lead_stages: DEFAULT_LEAD_STAGES, main_lead_board_name: null }]);
    expect(await leadBoardStages(client, ORG, null)).toEqual({
      id: null,
      name: "Main board",
      stages: DEFAULT_LEAD_STAGES,
    });
    expect(log[0]).toContain("FROM organizations");
  });

  it("reads another board from its own row", async () => {
    const stages = [{ key: "enquiry", label: "Enquiry" }];
    const { client, log } = fakeClient(() => [{ id: BOARD, name: "Website", stages }]);
    expect(await leadBoardStages(client, ORG, BOARD)).toEqual({ id: BOARD, name: "Website", stages });
    expect(log[0]).toContain("FROM lead_boards");
  });

  it("returns null for a board this org does not have", async () => {
    const { client } = fakeClient(() => []);
    expect(await leadBoardStages(client, ORG, BOARD)).toBeNull();
  });
});
