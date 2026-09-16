import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The exact request that decides the rate.
 *
 * `withDiarization` is the difference between ₹30 and ₹45 per audio-hour, so
 * this asserts the field the provider actually receives rather than the option
 * the caller passed - the two were the same line of code until 0083, and the
 * whole saving lives in them staying in step. asr-cost.test.ts covers the other
 * half: that the instance's setting reaches this function at all.
 */

let createJobArgs: Record<string, unknown> | null = null;

vi.mock("sarvamai", () => ({
  SarvamAIClient: class {
    speechToTextJob = {
      createJob: async (args: Record<string, unknown>) => {
        createJobArgs = args;
        return {
          jobId: "job-1",
          uploadFiles: async () => undefined,
          start: async () => undefined,
        };
      },
    };
  },
}));

vi.mock("@aura/llm", () => ({
  withProviderRetry: <T>(fn: () => Promise<T>) => fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdtemp: async () => "/tmp/aura-asr-test",
  writeFile: async () => undefined,
  rm: async () => undefined,
}));

import { startSarvamAsrJob } from "./asr-sarvam";

const AUDIO = Buffer.from([1, 2, 3]);
const CALL_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  createJobArgs = null;
  process.env.SARVAM_API_KEY = "test-key";
});

afterEach(() => {
  delete process.env.SARVAM_API_KEY;
  delete process.env.SARVAM_STT_SPEAKERS;
});

describe("what the provider is asked to bill for", () => {
  it("requests diarization only when the instance asked for it", async () => {
    await startSarvamAsrJob(AUDIO, CALL_ID, { diarize: true });
    expect(createJobArgs?.withDiarization).toBe(true);

    await startSarvamAsrJob(AUDIO, CALL_ID, { diarize: false });
    expect(createJobArgs?.withDiarization).toBe(false);
  });

  it("treats an omitted flag as the cheap tier", async () => {
    await startSarvamAsrJob(AUDIO, CALL_ID, {});

    expect(createJobArgs?.withDiarization).toBe(false);
  });

  it("omits numSpeakers when there is no diarizer to hint", async () => {
    // A speaker-count hint on a request that is not separating speakers is at
    // best ignored; sending it invites the provider to treat the job as the
    // diarized kind, which is the expensive one.
    await startSarvamAsrJob(AUDIO, CALL_ID, { diarize: false });

    expect(createJobArgs).not.toHaveProperty("numSpeakers");
  });

  it("sends the speaker hint when it is diarizing", async () => {
    await startSarvamAsrJob(AUDIO, CALL_ID, { diarize: true });

    expect(createJobArgs?.numSpeakers).toBe(2);
  });

  it("keeps timestamps on either tier", async () => {
    // Without diarization the timestamps.chunks fallback in toAsrResult is the
    // only thing standing between the console and one undifferentiated blob of
    // transcript, so this is not an add-on that rides along with diarization.
    await startSarvamAsrJob(AUDIO, CALL_ID, { diarize: false });

    expect(createJobArgs?.withTimestamps).toBe(true);
  });
});
