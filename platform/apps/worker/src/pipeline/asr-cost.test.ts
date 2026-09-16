import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What each call asks the ASR provider for, and what it records having spent.
 *
 * Both halves of this are money rather than behaviour, which is why they get
 * their own suite: a regression here does not break a call, it silently changes
 * the invoice. Diarization is charged at ₹45/audio-hour against ₹30 without it
 * (migration 0083), and before B0 the ASR spend - ~82% of what a call costs -
 * was written to no ledger at all, so no tenant could be billed for or measured
 * against the largest thing they consumed.
 *
 * The batch path returns immediately after submitting, so nothing past the ASR
 * stage needs mocking here.
 */

const CALL_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "00000000-0000-4000-8000-000000000001";

interface Recorded {
  text: string;
  values: unknown[];
}

let issued: Recorded[] = [];
/** The options the pipeline handed the provider, captured from the submit. */
let submittedWith: Record<string, unknown> | null = null;
/** The instance's own settings, as the organizations row would return them. */
let orgSettings: Record<string, unknown> = {};
/** What the handset reported, in seconds. */
let durationS = 180;
/** ASR minutes this org has already used this month. */
let usedMinutes = 0;

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
              ...orgSettings,
            },
          ],
          rowCount: 1,
        };
      }
      if (/COALESCE\(sum\(quantity\), 0\)/.test(text)) {
        return { rows: [{ minutes: String(usedMinutes) }], rowCount: 1 };
      }
      // Duration and recording key come back in one statement since A1.
      if (/FROM calls c LEFT JOIN recordings/.test(text)) {
        return { rows: [{ duration_s: durationS, s3_key: "org/call.m4a" }], rowCount: 1 };
      }
      if (/UPDATE calls\s+SET status = \$3/.test(text)) {
        return { rows: [{ id: CALL_ID }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

vi.mock("@aura/db", () => ({
  withOrgContext: (_orgId: string, fn: (client: unknown) => Promise<unknown>) => fn(fakeClient()),
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
  sarvamAsrConfigured: () => true,
  sarvamAsrModel: () => "saaras:v3",
  startSarvamAsrJob: async (_audio: unknown, _callId: string, opts: Record<string, unknown>) => {
    submittedWith = opts;
    return "job-1";
  },
}));

vi.mock("./asr", () => ({ transcribe: vi.fn() }));

import { processCall } from "./pipeline";

/** The usage_events insert, if the call recorded one. */
function usageRow(): Recorded | undefined {
  return issued.find((q) => /INSERT INTO usage_events/.test(q.text));
}

beforeEach(() => {
  issued = [];
  submittedWith = null;
  orgSettings = {};
  durationS = 180;
  usedMinutes = 0;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("diarization is the instance's decision, not the deployment's", () => {
  it("asks for diarization when the instance pays for it", async () => {
    orgSettings = { asr_diarization: true };

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(submittedWith?.diarize).toBe(true);
  });

  it("does not ask for it when the instance has it switched off", async () => {
    orgSettings = { asr_diarization: false };

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(submittedWith?.diarize).toBe(false);
  });

  it("falls to the CHEAP tier when the column is missing entirely", async () => {
    // An org row read by older code, or a deployment mid-migration. The failure
    // mode of an absent flag must be a plain transcript, never a silent 50%
    // surcharge on every call in the deployment.
    orgSettings = { asr_diarization: undefined };

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(submittedWith?.diarize).toBe(false);
  });
});

describe("ASR spend reaches the tenant's ledger", () => {
  it("records the minutes it just submitted", async () => {
    durationS = 180;

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    const row = usageRow();
    expect(row).toBeDefined();
    expect(row!.values[0]).toBe(ORG_ID);
    expect(row!.values[2]).toBeCloseTo(3, 6);
    expect(row!.values[3]).toBe(CALL_ID);
  });

  it("prices the row at the tier it actually bought", async () => {
    // The rate tier belongs to the EVENT. A cost query that had to join back to
    // the org's current setting would misprice every call recorded before
    // someone flipped it.
    orgSettings = { asr_diarization: true };
    await processCall({ callId: CALL_ID, orgId: ORG_ID });
    expect(usageRow()!.values[1]).toBe("asr_minutes_diarized");

    issued = [];
    orgSettings = { asr_diarization: false };
    await processCall({ callId: CALL_ID, orgId: ORG_ID });
    expect(usageRow()!.values[1]).toBe("asr_minutes");
  });

  it("meters on submission, because that is when the provider starts billing", async () => {
    // The job is charged once accepted. A submitted-then-never-collected call
    // still cost money and still belongs on the ledger.
    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    const submitted = issued.findIndex((q) => /SET asr_job_id = \$2/.test(q.text));
    const metered = issued.findIndex((q) => /INSERT INTO usage_events/.test(q.text));
    expect(submitted).toBeGreaterThanOrEqual(0);
    expect(metered).toBeGreaterThan(submitted);
  });

  it("writes no row at all when the handset reported no duration", async () => {
    // A quantity of 0 is a measurement claiming the call was free, which is
    // worse than a visible gap.
    durationS = 0;

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(usageRow()).toBeUndefined();
  });
});

describe("the monthly ASR ceiling", () => {
  it("transcribes normally while the instance is under its budget", async () => {
    orgSettings = { asr_monthly_minutes_budget: 1000 };
    usedMinutes = 400;

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(submittedWith).not.toBeNull();
  });

  it("stops submitting once the ceiling is reached", async () => {
    orgSettings = { asr_monthly_minutes_budget: 500 };
    usedMinutes = 500;

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    // The provider is never called, which is the entire point - the bill stops.
    expect(submittedWith).toBeNull();
    expect(usageRow()).toBeUndefined();
  });

  it("still stores the call and says why it was not transcribed", async () => {
    // The customer's call log must stay complete; only the paid stages are
    // skipped. And an operator has to be able to tell this apart from an
    // instance with transcription switched off on purpose.
    orgSettings = { asr_monthly_minutes_budget: 500 };
    usedMinutes = 900;

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    const moves = issued
      .filter((q) => /UPDATE calls SET status = \$3/.test(q.text))
      .map((q) => String(q.values[2]));
    expect(moves).toContain("TRANSCRIPTION_OFF");

    const reason = issued.find((q) => /SET error_message = \$2/.test(q.text));
    expect(String(reason!.values[1])).toContain("monthly ASR budget");
  });

  it("does not query usage at all for an instance with no ceiling", async () => {
    // An aggregate on the hot path of every call. Instances without a budget -
    // which is nearly all of them - must not pay for the feature.
    orgSettings = { asr_monthly_minutes_budget: null };

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(issued.some((q) => /COALESCE\(sum\(quantity\), 0\)/.test(q.text))).toBe(false);
  });
});
