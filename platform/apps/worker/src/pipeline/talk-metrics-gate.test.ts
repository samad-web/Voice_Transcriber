import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Talk metrics are only computed from REAL speaker separation.
 *
 * This is the one place migration 0083 could have made a call lie rather than
 * simply cost less. With diarization off, ASR returns timestamped chunks that
 * all carry the same acoustic tag; `analyzeConversation` then has a single tag
 * to map, so `roleOf` labels EVERY segment "Agent". Those segments have genuine
 * offsets, so they pass every filter `computeTalkMetrics` applies, and the call
 * reports a talk ratio of 1.0 with the customer silent for its whole duration -
 * a confident, precise, wrong coaching number on a dashboard someone manages
 * people against.
 *
 * The existing all-nulls guard inside computeTalkMetrics does not catch it:
 * that fires on missing or malformed TIMING, and the timings here are fine. So
 * the gate lives at the call site, on the ASR-level `diarized` fact - which
 * since A4 is in the enrichment lane, along with everything else derived from
 * the conversation read.
 */

const CALL_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const LEAD_ID = "33333333-3333-4333-8333-333333333333";

const { analyzeConversation, computeTalkMetrics, upsertCallAnalytics } = vi.hoisted(() => ({
  analyzeConversation: vi.fn(),
  // Typed signatures, not bare vi.fn(): the assertions read `mock.calls[0][n]`,
  // which on an untyped mock is an empty tuple and fails to compile.
  computeTalkMetrics: vi.fn((_segments: unknown): { talkRatio: number | null } => ({
    talkRatio: null,
  })),
  upsertCallAnalytics: vi.fn(
    async (
      _client: unknown,
      _orgId: string,
      _callId: string,
      _payload: { qualityScore: number },
    ): Promise<void> => {},
  ),
}));

/** What the transcripts row reports about ACOUSTIC separation. */
let transcriptDiarized = true;

function fakeClient() {
  return {
    query: async (text: string) => {
      // The enrichment claim, pending -> running.
      if (/SET enrichment_status = 'running'/.test(text)) {
        return { rows: [{ enrichment_attempts: 1 }], rowCount: 1 };
      }
      // The inputs read.
      if (/FROM calls c/.test(text) && /LEFT JOIN transcripts/.test(text)) {
        return {
          rows: [
            {
              text: "hello there",
              // Real offsets, one acoustic speaker - the shape that defeats
              // every filter downstream.
              segments: [
                { speaker: "S1", text: "hello", startMs: 0, endMs: 1000 },
                { speaker: "S1", text: "there", startMs: 1000, endMs: 2600 },
              ],
              diarized: transcriptDiarized,
              direction: "outgoing",
              vocabulary: [],
              leadId: LEAD_ID,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

vi.mock("@aura/db", () => ({
  withOrgContext: (_orgId: string, fn: (client: unknown) => Promise<unknown>) => fn(fakeClient()),
  getAdminPool: () => ({ query: async () => ({ rows: [] }) }),
}));
vi.mock("@aura/llm", () => ({ analyzeConversation }));
vi.mock("./call-analytics", () => ({ computeTalkMetrics, upsertCallAnalytics }));
vi.mock("./outbox", () => ({ enqueueDispatch: vi.fn(async () => {}) }));
vi.mock("./projects", () => ({
  detectCallProjects: vi.fn(async () => ({ hits: [], reason: "" })),
}));

import { enrichCall } from "./enrich";

const INTEL = {
  // Two labelled turns with real timings - what the analyzer produces from
  // single-tag ASR output.
  turns: [
    { index: 0, speaker: "Agent", text: "hello", intent: "greeting" },
    { index: 1, speaker: "Agent", text: "there", intent: "pitch" },
  ],
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

beforeEach(() => {
  vi.clearAllMocks();
  transcriptDiarized = true;
  computeTalkMetrics.mockReturnValue({ talkRatio: null });
  analyzeConversation.mockResolvedValue(INTEL);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("talk metrics and acoustic diarization", () => {
  it("computes them from the segments when ASR really separated the speakers", async () => {
    transcriptDiarized = true;

    await enrichCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(computeTalkMetrics).toHaveBeenCalledTimes(1);
    expect(computeTalkMetrics.mock.calls[0]![0]).not.toBeNull();
  });

  it("refuses to compute them from a single-speaker transcript", async () => {
    transcriptDiarized = false;

    await enrichCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(computeTalkMetrics).toHaveBeenCalledTimes(1);
    expect(computeTalkMetrics.mock.calls[0]![0]).toBeNull();
  });

  it("still records the rest of the analytics for an undiarized call", async () => {
    // Quality score and risk flags are read from the transcript text and do not
    // depend on who said what, so switching diarization off must not cost them.
    transcriptDiarized = false;

    await enrichCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(upsertCallAnalytics).toHaveBeenCalledTimes(1);
    expect(upsertCallAnalytics.mock.calls[0]![3].qualityScore).toBe(70);
  });
});
