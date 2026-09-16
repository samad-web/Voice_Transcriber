import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * No database connection is held across a provider call (A1).
 *
 * This is the whole point of the read/compute/write phasing, and it is exactly
 * the kind of property that regresses silently: wrapping the stage in one more
 * `withOrgContext` - or moving a query a few lines - reinstates the long-held
 * transaction without breaking a single other test. Nothing would fail; the
 * worker would simply go back to holding a pooled connection, and an open
 * transaction, for the several minutes each call spends waiting on Sarvam,
 * putting the ceiling back at DB_POOL_MAX concurrent calls instead of the
 * provider's own limit.
 *
 * So this counts transactions that are open at the moment a provider is called,
 * and requires the answer to be zero.
 */

const CALL_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "00000000-0000-4000-8000-000000000001";

const { analyzeConversation, analyzeTranscript, startSarvamAsrJob, transcribe } = vi.hoisted(
  () => ({
    analyzeConversation: vi.fn(),
    analyzeTranscript: vi.fn(),
    startSarvamAsrJob: vi.fn(),
    transcribe: vi.fn(),
  }),
);

/** Transactions currently open, and the worst reading taken inside a provider. */
let openNow = 0;
let openDuringProvider = 0;

/** Records what any phase was holding when a provider was called. */
function sampleInsideProvider() {
  openDuringProvider = Math.max(openDuringProvider, openNow);
}

let sarvamConfigured = true;
let orgSettings: Record<string, unknown> = {};

function fakeClient() {
  return {
    query: async (text: string) => {
      if (/SELECT pipeline_attempts/.test(text)) {
        return { rows: [{ pipeline_attempts: 0 }], rowCount: 1 };
      }
      if (/FROM organizations/.test(text)) {
        return {
          rows: [
            {
              transcription_enabled: true,
              asr_language: null,
              asr_mode: null,
              asr_diarization: false,
              vocabulary: [],
              ...orgSettings,
            },
          ],
          rowCount: 1,
        };
      }
      if (/FROM calls c LEFT JOIN recordings/.test(text)) {
        return { rows: [{ duration_s: 180, s3_key: "org/call.m4a" }], rowCount: 1 };
      }
      if (/FROM transcripts WHERE call_id/.test(text)) {
        return { rows: [{ text: "hello", segments: [], diarized: true }], rowCount: 1 };
      }
      // The enrichment lane's claim and its inputs read.
      if (/SET enrichment_status = 'running'/.test(text)) {
        return { rows: [{ enrichment_attempts: 1 }], rowCount: 1 };
      }
      if (/FROM calls c/.test(text) && /LEFT JOIN transcripts/.test(text)) {
        return {
          rows: [
            {
              text: "hello",
              segments: [],
              diarized: true,
              direction: "outgoing",
              vocabulary: [],
              leadId: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (/FROM agents a/.test(text)) {
        return {
          rows: [
            {
              id: "22222222-2222-4222-8222-222222222222",
              version: 1,
              system_prompt: "extract",
              field_schema: { fields: [{ key: "full_name", type: "string", description: "n" }] },
            },
          ],
          rowCount: 1,
        };
      }
      if (/SELECT direction FROM calls/.test(text)) {
        return { rows: [{ direction: "outgoing" }], rowCount: 1 };
      }
      if (/UPDATE calls SET status = \$3/.test(text)) {
        return { rows: [{ id: CALL_ID }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

vi.mock("@aura/db", () => ({
  withOrgContext: async (_orgId: string, fn: (client: unknown) => Promise<unknown>) => {
    openNow++;
    try {
      return await fn(fakeClient());
    } finally {
      openNow--;
    }
  },
}));

vi.mock("@aura/llm", () => ({ analyzeConversation, analyzeTranscript }));
vi.mock("./asr", () => ({ transcribe }));
vi.mock("./asr-sarvam", () => ({
  sarvamAsrConfigured: () => sarvamConfigured,
  sarvamAsrModel: () => "saaras:v3",
  startSarvamAsrJob,
}));
vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      return { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } };
    }
  },
  GetObjectCommand: class {},
}));
vi.mock("./call-analytics", () => ({
  computeTalkMetrics: () => ({}),
  upsertCallAnalytics: vi.fn(async () => {}),
}));
vi.mock("./crm-objects", () => ({ projectLeadToCrm: vi.fn(async () => ({ reason: "skipped" })) }));
vi.mock("@aura/queue", () => ({
  publishEnrich: vi.fn(async () => {}),
  // A change signal, not work: the pipeline calls it after a status
  // transition. Stubbed so these tests need no broker.
  publishEvent: vi.fn(),
}));
vi.mock("./leads", () => ({ upsertLead: vi.fn(async () => ({ leadId: null, reason: "none" })) }));
vi.mock("./outbox", () => ({ enqueueDispatch: vi.fn(async () => {}) }));
vi.mock("./projects", () => ({ detectCallProjects: vi.fn(async () => {}) }));

import { enrichCall } from "./enrich";
import { orgStageHelpers, processCall, runPostAsrStages } from "./pipeline";

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

beforeEach(() => {
  vi.clearAllMocks();
  openNow = 0;
  openDuringProvider = 0;
  sarvamConfigured = true;
  orgSettings = {};
  analyzeConversation.mockImplementation(async () => {
    sampleInsideProvider();
    return INTEL;
  });
  analyzeTranscript.mockImplementation(async () => {
    sampleInsideProvider();
    return {
      output: { full_name: "Aakash" },
      validationStatus: "valid",
      validationErrors: [],
      provider: "sarvam",
      model: "sarvam-105b",
      tokensIn: 1,
      tokensOut: 1,
    };
  });
  startSarvamAsrJob.mockImplementation(async () => {
    sampleInsideProvider();
    return "job-1";
  });
  transcribe.mockImplementation(async () => {
    sampleInsideProvider();
    return { engine: "stub", language: "ta", text: "hello", segments: [], diarized: false };
  });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("the analyze stage", () => {
  it("holds no transaction while the extraction is running", async () => {
    await runPostAsrStages(ORG_ID, CALL_ID, orgStageHelpers(ORG_ID, CALL_ID, 0), true);

    expect(analyzeTranscript).toHaveBeenCalled();
    expect(openDuringProvider).toBe(0);
  });

  it("closes every transaction it opened", async () => {
    await runPostAsrStages(ORG_ID, CALL_ID, orgStageHelpers(ORG_ID, CALL_ID, 0), true);

    expect(openNow).toBe(0);
  });
});

describe("the enrichment lane", () => {
  it("holds no transaction while the conversation read is running", async () => {
    // The longest provider call in the system, on the lane with its own
    // concurrency - so this is where holding a connection would exhaust the
    // pool fastest.
    await enrichCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(analyzeConversation).toHaveBeenCalled();
    expect(openDuringProvider).toBe(0);
  });

  it("closes every transaction it opened", async () => {
    await enrichCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(openNow).toBe(0);
  });
});

describe("the ASR stage", () => {
  it("holds no transaction while the batch job is being submitted", async () => {
    sarvamConfigured = true;

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(startSarvamAsrJob).toHaveBeenCalled();
    expect(openDuringProvider).toBe(0);
  });

  it("holds no transaction while an inline provider transcribes", async () => {
    // The inline path is the one that used to hold a connection for the whole
    // of transcription, since it never returns early the way the batch path does.
    sarvamConfigured = false;

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(transcribe).toHaveBeenCalled();
    expect(openDuringProvider).toBe(0);
  });
});
