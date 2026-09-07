import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SOP adherence is only scored from REAL speaker separation.
 *
 * The sibling of talk-metrics-gate.test.ts, guarding the same hazard one
 * feature over - and with a sharper consequence.
 *
 * With diarization off, ASR returns timestamped chunks that all carry the same
 * acoustic tag, so `roleOf` labels EVERY segment "Agent". A model then asked
 * "did the AGENT state the call is recorded" reads a transcript in which the
 * agent apparently said everything, including the customer's words - and
 * answers yes, with a quote, from the wrong speaker's mouth. The quote is real,
 * so the evidence rule in `coerceSopResults` does not catch it: the verdict
 * looks perfectly sourced and is attributed to the wrong person.
 *
 * That failure lands on `consent_disclosure`, which is the one step in the
 * default SOP with legal weight rather than commercial weight. A false pass
 * there is a record asserting a rep gave a notice they never gave.
 *
 * So the gate lives at the call site, on the ASR-level `diarized` fact, exactly
 * where the talk-metrics one does.
 */

const CALL_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const LEAD_ID = "33333333-3333-4333-8333-333333333333";
const TELECALLER_ID = "00000000-0000-4000-8000-00000000f001";
const STARTED_AT = new Date("2026-03-04T09:00:00Z");

const SOP = {
  id: "44444444-4444-4444-8444-444444444444",
  version: 3,
  steps: [
    {
      key: "consent_disclosure",
      label: "Disclosed recording",
      description: "The agent states the call is recorded.",
      required: true,
    },
  ],
};

const {
  analyzeConversation,
  computeTalkMetrics,
  upsertCallAnalytics,
  loadActiveSop,
  upsertSopResult,
} = vi.hoisted(() => ({
  analyzeConversation: vi.fn(),
  computeTalkMetrics: vi.fn((_segments: unknown): { talkRatio: number | null } => ({
    talkRatio: null,
  })),
  upsertCallAnalytics: vi.fn(async (): Promise<void> => {}),
  loadActiveSop: vi.fn(),
  // Typed signature, not a bare vi.fn(): the assertions below read
  // `mock.calls[0][n]`, which on an untyped mock is an empty tuple and fails
  // to compile. Same reason talk-metrics-gate.test.ts types its mocks.
  upsertSopResult: vi.fn(
    async (
      _client: unknown,
      _orgId: string,
      _callId: string,
      _telecallerId: string | null,
      _sop: unknown,
      _results: unknown,
      _model: string | null,
      _callStartedAt: Date | string | null,
    ): Promise<void> => {},
  ),
}));

/** What the transcripts row reports about ACOUSTIC separation. */
let transcriptDiarized = true;

function fakeClient() {
  return {
    query: async (text: string) => {
      if (/SET enrichment_status = 'running'/.test(text)) {
        return { rows: [{ enrichment_attempts: 1 }], rowCount: 1 };
      }
      if (/FROM calls c/.test(text) && /LEFT JOIN transcripts/.test(text)) {
        return {
          rows: [
            {
              text: "this call is being recorded",
              segments: [
                { speaker: "S1", text: "this call is being recorded", startMs: 0, endMs: 2000 },
              ],
              diarized: transcriptDiarized,
              direction: "outgoing",
              telecallerId: TELECALLER_ID,
              startedAt: STARTED_AT,
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
vi.mock("./call-sop", () => ({ loadActiveSop, upsertSopResult }));
vi.mock("./outbox", () => ({ enqueueDispatch: vi.fn(async () => {}) }));
vi.mock("./projects", () => ({
  detectCallProjects: vi.fn(async () => ({ hits: [], reason: "" })),
}));

import { enrichCall } from "./enrich";

const INTEL = {
  turns: [{ index: 0, speaker: "Agent", text: "this call is being recorded", intent: "consent" }],
  language: "en",
  summary: "a call",
  overall_intent: "",
  customer_intent: "",
  agent_intent: "",
  sentiment: "neutral" as const,
  outcome: "other",
  key_points: [],
  action_items: [],
  qualityScore: 70,
  qualityCriteria: null,
  riskFlags: [],
  sopResults: [{ key: "consent_disclosure", met: true, evidence: "this call is being recorded" }],
  provider: "sarvam",
  model: "sarvam-105b",
  tokensIn: 10,
  tokensOut: 10,
};

beforeEach(() => {
  vi.clearAllMocks();
  transcriptDiarized = true;
  analyzeConversation.mockResolvedValue(INTEL);
  loadActiveSop.mockResolvedValue(SOP);
});

describe("SOP scoring is gated on real speaker separation", () => {
  it("scores the call when ASR reported diarized audio", async () => {
    await enrichCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(loadActiveSop).toHaveBeenCalled();
    // The steps reach the model - 5th argument of analyzeConversation.
    expect(analyzeConversation.mock.calls[0]?.[4]).toStrictEqual(SOP.steps);
    expect(upsertSopResult).toHaveBeenCalled();
  });

  it("does not even LOAD the SOP for a call with no speaker separation", async () => {
    transcriptDiarized = false;

    await enrichCall({ callId: CALL_ID, orgId: ORG_ID });

    // Not merely "does not score" - does not ask. The steps must never reach
    // the prompt, because a verdict produced from single-tag audio is wrong in
    // a way no downstream check can detect.
    expect(loadActiveSop).not.toHaveBeenCalled();
    expect(analyzeConversation.mock.calls[0]?.[4]).toBeNull();
    expect(upsertSopResult).not.toHaveBeenCalled();
  });

  it("writes no row at all when the org has no active SOP", async () => {
    loadActiveSop.mockResolvedValue(null);

    await enrichCall({ callId: CALL_ID, orgId: ORG_ID });

    // No row, rather than a row of inconclusive steps: the console tells those
    // two cases apart, and a full checklist of unjudged steps would read as a
    // rep who failed every one.
    expect(upsertSopResult).not.toHaveBeenCalled();
  });

  it("attributes the score to the call's own clock, not to now()", async () => {
    // 0091's call_started_at. A backlog reprocess must not dump months of
    // adherence onto the day somebody re-ran the pipeline.
    await enrichCall({ callId: CALL_ID, orgId: ORG_ID });

    const args = upsertSopResult.mock.calls[0];
    expect(args?.[3]).toBe(TELECALLER_ID);
    expect(args?.[7]).toBe(STARTED_AT);
  });

  it("does not fail the call when scoring throws", async () => {
    // Non-blocking, like the analytics beside it: a lead is already on the
    // board, and a scoring failure must not cost the call its enrichment.
    upsertSopResult.mockRejectedValueOnce(new Error("db is having a day"));

    await expect(enrichCall({ callId: CALL_ID, orgId: ORG_ID })).resolves.not.toThrow();
    expect(upsertCallAnalytics).toHaveBeenCalled();
  });
});
