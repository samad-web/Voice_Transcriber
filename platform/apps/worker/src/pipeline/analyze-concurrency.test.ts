import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two halves of the analyze stage, and the order they are allowed to fail in.
 *
 * Conversation intelligence and the tenant's own field extraction share
 * nothing - different inputs, neither reading the other's output, both pure
 * provider calls. They used to run one after the other anyway, which cost a
 * full request's latency (~95s against Sarvam with real token headroom) on
 * every single call for no reason at all.
 *
 * Overlapping them is easy to get wrong in two specific ways, and both are
 * pinned here rather than left to review:
 *
 *  1. A `Promise.all` over both would let a FAILED intelligence pass reject the
 *     pair, turning a deliberately non-blocking failure into a failed call.
 *  2. Awaiting the extraction before the intelligence WRITES would mean a call
 *     whose extraction throws loses the summary and analytics that used to
 *     survive it - a reader would see an empty AI panel where they previously
 *     saw the read, for as long as the retry took.
 */

const CALL_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "00000000-0000-4000-8000-000000000001";

const { analyzeConversation, analyzeTranscript } = vi.hoisted(() => ({
  analyzeConversation: vi.fn(),
  analyzeTranscript: vi.fn(),
}));

vi.mock("@aura/llm", () => ({ analyzeConversation, analyzeTranscript }));
vi.mock("@aura/db", () => ({ withOrgContext: vi.fn() }));
vi.mock("./call-analytics", () => ({
  computeTalkMetrics: () => ({}),
  upsertCallAnalytics: vi.fn(async () => {}),
}));
vi.mock("./crm-objects", () => ({ projectLeadToCrm: vi.fn(async () => ({ reason: "skipped" })) }));
vi.mock("./leads", () => ({
  upsertLead: vi.fn(async () => ({ leadId: null, reason: "no facts" })),
}));
vi.mock("./outbox", () => ({ enqueueDispatch: vi.fn(async () => {}) }));
vi.mock("./projects", () => ({ detectCallProjects: vi.fn(async () => {}) }));

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

const INTEL = {
  turns: [],
  language: "ta",
  summary: "a call",
  overall_intent: "",
  customer_intent: "",
  agent_intent: "",
  sentiment: "neutral",
  outcome: "follow_up",
  key_points: [],
  action_items: [],
  qualityScore: 70,
  qualityCriteria: null,
  riskFlags: [],
  model: "sarvam-105b",
  tokensIn: 1,
  tokensOut: 1,
};

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
  const client = fakeClient();
  // `alreadyAnalyzing` so the stage does not need the row to be in TRANSCRIBING.
  return runPostAsrStages(
    client as never,
    ORG_ID,
    CALL_ID,
    stageHelpers(client as never, CALL_ID, 0),
    true,
  );
}

/** Did any statement matching `re` run? */
function ran(re: RegExp): boolean {
  return issued.some((q) => re.test(q.text));
}

const WROTE_INTELLIGENCE = /SET intelligence = \$2::jsonb|SET segments = \$2::jsonb/;
const WROTE_EXTRACTION = /INSERT INTO ai_outputs/;
const FAILED = /pipeline_attempts = pipeline_attempts \+ 1/;

beforeEach(() => {
  issued = [];
  analyzeConversation.mockReset();
  analyzeTranscript.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("analyze - the two provider calls overlap", () => {
  it("starts the conversation read while the extraction is still in flight", async () => {
    const events: string[] = [];
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    // The extraction is started FIRST and awaited last, so it is the one still
    // running when the conversation read begins.
    analyzeTranscript.mockImplementation(async () => {
      events.push("extraction:start");
      await delay(40);
      events.push("extraction:end");
      return EXTRACTION;
    });
    analyzeConversation.mockImplementation(async () => {
      events.push("conversation:start");
      await delay(5);
      events.push("conversation:end");
      return INTEL;
    });

    await run();

    // Run sequentially the log reads start,end,start,end and this fails. The
    // assertion is deliberately about the INTERVALS overlapping rather than a
    // fixed order, because which of the two finishes first depends on the
    // provider, not on us.
    expect(events.indexOf("conversation:start")).toBeLessThan(events.indexOf("extraction:end"));
    expect(events).toContain("conversation:end");
    expect(events).toContain("extraction:end");

    expect(ran(WROTE_INTELLIGENCE)).toBe(true);
    expect(ran(WROTE_EXTRACTION)).toBe(true);
  });
});

describe("analyze - failure stays asymmetric", () => {
  it("does not fail the call when conversation intelligence throws", async () => {
    analyzeConversation.mockRejectedValue(new Error("sarvam: 503"));
    analyzeTranscript.mockResolvedValue(EXTRACTION);

    await run();

    // Non-blocking by design: the tenant's extraction is the call's purpose and
    // still ran, so the call must not be marked failed.
    expect(ran(FAILED)).toBe(false);
    expect(ran(WROTE_EXTRACTION)).toBe(true);
  });

  it("fails the call when the tenant extraction throws", async () => {
    analyzeConversation.mockResolvedValue(INTEL);
    analyzeTranscript.mockRejectedValue(new Error("sarvam: 503"));

    await run();

    const failed = issued.find((q) => FAILED.test(q.text));
    expect(failed).toBeDefined();
    expect(failed!.values[1]).toBe("FAILED_ANALYZE");
  });

  it("keeps the intelligence it already wrote when the extraction throws", async () => {
    analyzeConversation.mockResolvedValue(INTEL);
    analyzeTranscript.mockRejectedValue(new Error("sarvam: 503"));

    await run();

    // The whole reason the extraction is awaited AFTER these writes rather than
    // alongside them. Await it first and this is false: the reader loses the
    // summary and the quality score for as long as the retry is pending, on a
    // call where the analyser had actually answered.
    expect(ran(WROTE_INTELLIGENCE)).toBe(true);
    expect(issued.findIndex((q) => WROTE_INTELLIGENCE.test(q.text))).toBeLessThan(
      issued.findIndex((q) => FAILED.test(q.text)),
    );
  });

  it("survives a rejection that lands while intelligence is still running", async () => {
    // The extraction is started first and can therefore reject minutes before
    // anything awaits it. Unhandled for that long, this Node version turns the
    // rejection into a process crash - which is why the promise is settled into
    // a value at the point it is created rather than left bare.
    analyzeTranscript.mockRejectedValue(new Error("sarvam: 400 bad request"));
    analyzeConversation.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return INTEL;
    });

    await expect(run()).resolves.toBeUndefined();

    expect(issued.find((q) => FAILED.test(q.text))!.values[1]).toBe("FAILED_ANALYZE");
  });
});
