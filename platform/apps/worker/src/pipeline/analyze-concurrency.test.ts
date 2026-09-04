import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The analyze stage after the lane split (A4), and what it is still on the hook
 * for.
 *
 * THIS SUITE USED TO BE ABOUT CONCURRENCY. Conversation intelligence and the
 * tenant's field extraction both ran here, sharing nothing, so they were started
 * together and the stage cost one provider round trip instead of two. That
 * overlap is gone - not regressed, removed: intelligence moved to the enrichment
 * lane entirely, because the lead never needed it and waiting for it delayed
 * every lead by the difference between the two reads.
 *
 * What is left in this stage is the half that IS the call's purpose, and the
 * properties worth pinning are about failure rather than timing:
 *
 *  1. A failing extraction fails the CALL - unlike everything in the enrichment
 *     lane, this one is not "non-blocking", and a call that silently reached
 *     COMPLETE with no facts would produce no lead and no error to explain why.
 *  2. A rejection that lands before anything awaits it must not crash the
 *     process. The promise is still settled at the point it is created for this
 *     reason, even though the window is now short.
 *  3. The stage must NOT do the enrichment lane's work - no conversation read,
 *     no dispatch. That is the split itself, and re-adding either here would put
 *     the ninety seconds, or the empty-summary CRM send, straight back.
 */

const CALL_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "00000000-0000-4000-8000-000000000001";

const { analyzeConversation, analyzeTranscript, publishEnrich } = vi.hoisted(() => ({
  analyzeConversation: vi.fn(),
  analyzeTranscript: vi.fn(),
  publishEnrich: vi.fn(async () => {}),
}));

vi.mock("@aura/llm", () => ({ analyzeConversation, analyzeTranscript }));
vi.mock("@aura/queue", () => ({ publishEnrich }));
// Hands every phase the same recording client, so `issued` stays one ordered
// log of the whole run even though it spans several transactions (A1).
vi.mock("@aura/db", () => ({
  withOrgContext: (_orgId: string, fn: (client: unknown) => Promise<unknown>) => fn(fakeClient()),
}));
vi.mock("./crm-objects", () => ({ projectLeadToCrm: vi.fn(async () => ({ reason: "skipped" })) }));
vi.mock("./leads", () => ({
  upsertLead: vi.fn(async () => ({ leadId: null, reason: "no facts" })),
}));

import { runPostAsrStages, stageHelpers } from "./pipeline";

interface Recorded {
  text: string;
  values: unknown[];
}
let issued: Recorded[] = [];

const AGENT_ROW = {
  id: "22222222-2222-4222-8222-222222222222",
  version: 1,
  system_prompt: "extract",
  field_schema: { fields: [{ key: "full_name", type: "string", description: "name" }] },
};

function fakeClient() {
  return {
    query: async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      if (/FROM transcripts WHERE call_id/.test(text)) {
        return { rows: [{ text: "hello", segments: [], diarized: true }], rowCount: 1 };
      }
      if (/FROM agents a/.test(text)) return { rows: [AGENT_ROW], rowCount: 1 };
      if (/SELECT vocabulary FROM organizations/.test(text)) {
        return { rows: [{ vocabulary: [] }], rowCount: 1 };
      }
      if (/SELECT direction FROM calls/.test(text)) {
        return { rows: [{ direction: "outgoing" }], rowCount: 1 };
      }
      if (/SELECT pipeline_attempts/.test(text)) {
        return { rows: [{ pipeline_attempts: 0 }], rowCount: 1 };
      }
      if (/pipeline_attempts = pipeline_attempts \+ 1/.test(text)) {
        return { rows: [{ pipeline_attempts: 1 }], rowCount: 1 };
      }
      if (/UPDATE calls SET status = \$3/.test(text)) {
        return { rows: [{ id: CALL_ID }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const EXTRACTION = {
  output: { full_name: "Aakash" },
  validationStatus: "valid",
  validationErrors: [],
  provider: "sarvam",
  model: "sarvam-105b",
  tokensIn: 1,
  tokensOut: 1,
};

function run() {
  // `alreadyAnalyzing` so the stage does not need the row to be in TRANSCRIBING.
  return runPostAsrStages(ORG_ID, CALL_ID, stageHelpers(fakeClient() as never, CALL_ID, 0), true);
}

/** Did any statement matching `re` run? */
function ran(re: RegExp): boolean {
  return issued.some((q) => re.test(q.text));
}

const WROTE_EXTRACTION = /INSERT INTO ai_outputs/;
const WROTE_INTELLIGENCE = /SET intelligence = \$2::jsonb|SET segments = \$2::jsonb/;
const FAILED = /pipeline_attempts = pipeline_attempts \+ 1/;

beforeEach(() => {
  issued = [];
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("analyze - the lead lane's own work", () => {
  it("writes the extraction and reaches the end of the stage", async () => {
    analyzeTranscript.mockResolvedValue(EXTRACTION);

    await run();

    expect(ran(WROTE_EXTRACTION)).toBe(true);
    expect(ran(FAILED)).toBe(false);
  });

  it("fails the call when the tenant extraction throws", async () => {
    // Not "non-blocking" like everything in the enrichment lane: this half IS
    // the call's purpose, and a silent COMPLETE with no facts would leave no
    // lead and nothing anywhere to explain the absence.
    analyzeTranscript.mockRejectedValue(new Error("sarvam: 503"));

    await run();

    const failed = issued.find((q) => FAILED.test(q.text));
    expect(failed).toBeDefined();
    expect(failed!.values[1]).toBe("FAILED_ANALYZE");
  });

  it("survives a rejection that lands before anything awaits it", async () => {
    // The promise is settled into a value at the point it is created rather
    // than left bare: unhandled for even a moment, this Node version turns the
    // rejection into a process crash.
    analyzeTranscript.mockRejectedValue(new Error("sarvam: 400 bad request"));

    await expect(run()).resolves.toBeUndefined();

    expect(issued.find((q) => FAILED.test(q.text))!.values[1]).toBe("FAILED_ANALYZE");
  });
});

describe("analyze - the split itself", () => {
  it("does not run the conversation read", async () => {
    analyzeTranscript.mockResolvedValue(EXTRACTION);

    await run();

    // Re-adding this here is the regression the whole lane split exists to
    // prevent: it puts ~90s back on the path to every lead.
    expect(analyzeConversation).not.toHaveBeenCalled();
    expect(ran(WROTE_INTELLIGENCE)).toBe(false);
  });

  it("hands the call to the enrichment lane once the lead is written", async () => {
    analyzeTranscript.mockResolvedValue(EXTRACTION);

    await run();

    expect(publishEnrich).toHaveBeenCalledWith({ callId: CALL_ID, orgId: ORG_ID });
  });

  it("does not hand off a call that failed before producing a lead", async () => {
    // Enriching it would pay for a conversation read on a call with no facts
    // and no lead, and would release a CRM send for a record that is not there.
    analyzeTranscript.mockRejectedValue(new Error("sarvam: 503"));

    await run();

    expect(publishEnrich).not.toHaveBeenCalled();
  });
});
