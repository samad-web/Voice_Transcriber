import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * THE 62-DAY OUTAGE, AS A TEST.
 *
 * On 2026-10-14 production had transcribed 17 of the previous week's 403
 * audio-bearing calls. Every one of the 2,792 failures over the preceding month
 * carried the same vendor message - HTTP 402, "No credits available." - and the
 * account had been empty since 2026-08-13.
 *
 * Three separate mechanisms had to be wrong for that to last two months, and
 * this suite pins all three closed:
 *
 *   1. ROUTING. The provider was chosen on key presence, so a vendor refusing
 *      us kept getting every call while a funded one sat configured and idle.
 *   2. THE RETRY BUDGET. A provider-level error consumed the CALL's five
 *      attempts, so ~14,000 pointless 402s later each call was permanently
 *      FAILED_ASR - a vendor's billing problem recorded as a defect in 2,792
 *      customer recordings.
 *   3. ESCALATION. Nothing told a human. The queue that exists for this waits
 *      for a client to complain, and the clients were being told their phones
 *      recorded badly.
 *
 * The harness drives the real `processCall`, so these are assertions about what
 * the pipeline does rather than about what the router returns.
 */

const CALL_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "00000000-0000-4000-8000-000000000001";

/** The production message, byte for byte. */
const PROD_402 =
  'Status code: 402\nBody: { "error": { "message": "No credits available.", ' +
  '"code": "insufficient_quota_error", "request_id": "req_abc123" } }';

interface Recorded {
  text: string;
  values: unknown[];
}

let issued: Recorded[] = [];
/** The `asr_provider_health` rows, mutated by the real park/success statements. */
let health: Array<{ provider: string; parked_until: Date | null; last_reason: string | null }> = [];
/** What startSarvamAsrJob should do when called. */
let sarvamThrows: Error | null = null;
let sarvamSubmits = 0;
let inlineTranscribes = 0;
let escalations: Array<{ stage: string; reason: string | null }> = [];

function fakeClient() {
  return {
    query: async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });

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
              asr_max_seconds: null,
              min_transcribe_seconds: null,
              asr_monthly_minutes_budget: null,
            },
          ],
          rowCount: 1,
        };
      }
      if (/COALESCE\(sum\(quantity\), 0\)/.test(text)) {
        return { rows: [{ minutes: "0" }], rowCount: 1 };
      }
      if (/FROM calls c LEFT JOIN recordings/.test(text)) {
        return { rows: [{ duration_s: 180, s3_key: "org/call.m4a" }], rowCount: 1 };
      }
      // advance()
      if (/UPDATE calls SET status = \$3/.test(text)) {
        return { rows: [{ id: CALL_ID }], rowCount: 1 };
      }
      // The failure UPDATE returns the attempt count the row now holds. $8 is
      // the "spend this attempt" flag, so the fake honours it - otherwise the
      // escalation branch would be tested against arithmetic the database is
      // not doing.
      if (/UPDATE calls\s+SET status = \$2,[\s\S]*error_message = \$3/.test(text)) {
        return { rows: [{ pipeline_attempts: values[7] === true ? 1 : 0 }], rowCount: 1 };
      }
      // ── asr_provider_health ──────────────────────────────────────────────
      if (/SELECT provider, parked_until/.test(text)) return { rows: health, rowCount: health.length };
      if (/INSERT INTO asr_provider_health[\s\S]*parked_until = GREATEST/.test(text)) {
        const [provider, until, reason] = values as [string, Date, string];
        const row = health.find((r) => r.provider === provider);
        if (row) {
          const current = row.parked_until ? row.parked_until.getTime() : 0;
          row.parked_until = new Date(Math.max(current, until.getTime()));
          row.last_reason = reason;
        } else {
          health.push({ provider, parked_until: until, last_reason: reason });
        }
        return { rows: [], rowCount: 0 };
      }
      if (/INSERT INTO asr_provider_health[\s\S]*last_success_at = now/.test(text)) {
        const [provider] = values as [string];
        const row = health.find((r) => r.provider === provider);
        if (row) row.parked_until = null;
        else health.push({ provider, parked_until: null, last_reason: null });
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

vi.mock("@aura/db", () => ({
  withOrgContext: (_orgId: string, fn: (client: unknown) => Promise<unknown>) => fn(fakeClient()),
  getAdminPool: () => fakeClient(),
  readEffectiveLimits: async () => ({
    planKey: null,
    planName: null,
    family: null,
    region: "IN",
    handsets: null,
    transcriptionMinutes: null,
    transcriptionHours: null,
    toppedUpHours: 0,
    audioRetentionDays: null,
    storageCapBytes: null,
    speakerSeparation: true,
    aiAnalysis: true,
    transcriptionAllowed: true,
    recordingProhibited: false,
  }),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: class {
    async send() {
      return { Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } };
    }
  },
  GetObjectCommand: class {},
}));

vi.mock("./asr-sarvam", () => ({
  sarvamAsrKey: () => "sk-sarvam-test",
  sarvamAsrConfigured: () => true,
  sarvamAsrModel: () => "saaras:v3",
  startSarvamAsrJob: async () => {
    sarvamSubmits++;
    if (sarvamThrows) throw sarvamThrows;
    return "job-1";
  },
}));

vi.mock("./asr", () => ({
  transcribe: async () => {
    inlineTranscribes++;
    return {
      engine: "gemini/gemini-3.5-flash",
      language: "en",
      text: "hello",
      segments: [{ speaker: "S1", text: "hello", startMs: 0, endMs: 1000 }],
      diarized: false,
    };
  },
}));

vi.mock("./platform-escalation", () => ({
  escalatePlatformFailure: async (
    _client: unknown,
    args: { stage: string; classified: { reason: string | null } },
  ) => {
    escalations.push({ stage: args.stage, reason: args.classified.reason });
    return { action: "opened", ref: 1, occurrences: 1 };
  },
}));

// The post-ASR stages are irrelevant here; every assertion is about the ASR
// stage's own decision. The inline path runs them, so they are stubbed to
// nothing rather than mocked per-case.
vi.mock("@aura/llm", () => ({
  analyzeTranscript: async () => {
    throw new Error("analyze not exercised by this suite");
  },
}));

import { processCall } from "./pipeline";
import { resetProviderHealthCache } from "./asr-route";

/** The failure UPDATE, if the call recorded one. */
function failure(): Recorded | undefined {
  return issued.find((q) => /UPDATE calls\s+SET status = \$2,[\s\S]*error_message = \$3/.test(q.text));
}

beforeEach(() => {
  issued = [];
  health = [
    { provider: "sarvam", parked_until: null, last_reason: null },
    { provider: "gemini", parked_until: null, last_reason: null },
  ];
  sarvamThrows = null;
  sarvamSubmits = 0;
  inlineTranscribes = 0;
  escalations = [];
  resetProviderHealthCache();
  vi.stubEnv("SARVAM_API_KEY", "sk-sarvam-test");
  vi.stubEnv("GEMINI_API_KEY", "sk-gemini-test");
  vi.stubEnv("ASR_STUB", "");
  vi.stubEnv("ASR_PROVIDER_ORDER", "");
  vi.stubEnv("ASR_HEALTH_CACHE_MS", "0");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("a vendor refusing us", () => {
  it("parks the vendor instead of spending the call's retry budget", async () => {
    sarvamThrows = new Error(PROD_402);

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    // The vendor is parked, for the six hours a wallet needs a human to refill.
    const parked = health.find((r) => r.provider === "sarvam");
    expect(parked?.last_reason).toBe("provider_out_of_credit");
    const hours = (parked!.parked_until!.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(5.9);
    expect(hours).toBeLessThan(6.1);

    // And the CALL keeps its attempts. This is the line that matters: before
    // it, 2,792 calls each burned five attempts on a billing problem.
    const failed = failure();
    expect(failed).toBeDefined();
    expect(failed!.values[7]).toBe(false);
  });

  it("schedules the retry for NOW, because another provider is usable", async () => {
    sarvamThrows = new Error(PROD_402);

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    // $9 is the explicit retry time. It must be immediate rather than a
    // backoff: the call transcribes on its next attempt through Gemini instead
    // of dying on its last through Sarvam.
    const retryAt = failure()!.values[8] as Date;
    expect(retryAt).toBeInstanceOf(Date);
    expect(Math.abs(retryAt.getTime() - Date.now())).toBeLessThan
      (60_000);
  });

  it("records the failure as OURS, so the client is never blamed", async () => {
    sarvamThrows = new Error(PROD_402);

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    // $6/$7 are failure_class and failure_reason_code (migration 0201). The
    // console's wording for 'platform' is "Processing delayed - nothing is
    // wrong with the call or the recording".
    expect(failure()!.values[5]).toBe("platform");
    expect(failure()!.values[6]).toBe("provider_out_of_credit");
  });

  it("raises a ticket on the FIRST occurrence, not the fifth attempt", async () => {
    sarvamThrows = new Error(PROD_402);

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    // Without this, fixing the hammering would have traded a loud wrong answer
    // for a silent one: no call ever reaches attempt five any more, so the
    // last-attempt trigger alone would never fire on the very incident this
    // machinery was built for. 0201's unique index keeps it to one row.
    expect(escalations).toEqual([{ stage: "ASR", reason: "provider_out_of_credit" }]);
  });

  it("does NOT park the vendor for a failure that is ours", async () => {
    sarvamThrows = new Error("NoSuchKey: the specified key does not exist");

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(health.find((r) => r.provider === "sarvam")?.parked_until).toBeNull();
    // And it DOES spend the attempt, because retrying might genuinely work.
    expect(failure()!.values[7]).toBe(true);
  });
});

describe("routing on health", () => {
  it("sends the call to Gemini while Sarvam is parked", async () => {
    health = [
      {
        provider: "sarvam",
        parked_until: new Date(Date.now() + 6 * 3_600_000),
        last_reason: "provider_out_of_credit",
      },
      { provider: "gemini", parked_until: null, last_reason: null },
    ];

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    // Sarvam's key is set. Under the old key-presence gate this submitted to
    // Sarvam anyway - which is the entire incident.
    expect(sarvamSubmits).toBe(0);
    expect(inlineTranscribes).toBe(1);
  });

  it("clears the park when a provider demonstrably works again", async () => {
    await processCall({ callId: CALL_ID, orgId: ORG_ID });
    expect(sarvamSubmits).toBe(1);
    // A submit the vendor ACCEPTED is where the credit check passes, so it is
    // evidence the account is funded - which ends a stale park without waiting
    // out the cooldown.
    const success = issued.find((q) =>
      /INSERT INTO asr_provider_health[\s\S]*last_success_at = now/.test(q.text),
    );
    expect(success?.values[0]).toBe("sarvam");
  });
});

describe("every provider parked", () => {
  beforeEach(() => {
    const soon = new Date(Date.now() + 900_000);
    health = [
      { provider: "sarvam", parked_until: new Date(Date.now() + 6 * 3_600_000), last_reason: "provider_out_of_credit" },
      { provider: "gemini", parked_until: soon, last_reason: "provider_rate_limited" },
    ];
  });

  it("calls no vendor at all", async () => {
    await processCall({ callId: CALL_ID, orgId: ORG_ID });
    expect(sarvamSubmits).toBe(0);
    expect(inlineTranscribes).toBe(0);
  });

  it("defers the call to the earliest expiry without spending an attempt", async () => {
    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    const failed = failure()!;
    expect(failed.values[7]).toBe(false);
    const retryAt = failed.values[8] as Date;
    // 15 minutes, not six hours: the rate limit clears first, and the call
    // should be waiting on the soonest thing that could work.
    const minutes = (retryAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(13);
    expect(minutes).toBeLessThan(16);
  });

  it("still reads to the client as ours, not as a bad recording", async () => {
    await processCall({ callId: CALL_ID, orgId: ORG_ID });
    expect(failure()!.values[5]).toBe("platform");
  });
});
