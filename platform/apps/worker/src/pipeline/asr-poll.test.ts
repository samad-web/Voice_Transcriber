import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The batch-ASR poller's transaction boundaries.
 *
 * WHY THIS SUITE EXISTS. `withOrgContext` is BEGIN…COMMIT, and the poller used
 * to run the claim, the transcript write, the TRANSCRIBING → ANALYZING advance
 * and the whole of `runPostAsrStages` inside ONE of them. Nothing was visible
 * to a reader until all of it committed, so a call sat on "Transcribing" for
 * the entire analyze - which on a real call was nine seconds of ASR followed by
 * eight minutes reported as transcription - and then jumped straight to
 * Complete, never once showing "Analysing". The status was not merely
 * imprecise; it named the wrong stage for 98% of the wait.
 *
 * The first fix split it in two. A2 went further and took the analysis out of
 * this sweep altogether: the poller now commits the claim, the transcript and
 * the advance in ONE transaction and publishes to `aura.analyze`, where a
 * consumer picks the call up - possibly in another process. So the sweep is
 * short again, and the reader still sees "Analysing" before a single provider
 * request is made.
 *
 * Both properties regress silently if someone later "tidies" the analysis back
 * inline, so they are pinned here by transaction index and by hand-off rather
 * than by outcome.
 */

const CALL_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const JOB_ID = "20260901_job";

interface Recorded {
  /** 1-based index of the withOrgContext transaction this ran inside. */
  tx: number;
  text: string;
  values: unknown[];
}

let issued: Recorded[] = [];
let txCount = 0;
/** false models the claim losing to another worker. */
let claimWins = true;
/** false models the ANALYZING advance finding the call already moved. */
let advanceWins = true;

function fakeClient(tx: number) {
  return {
    query: async (text: string, values: unknown[] = []) => {
      issued.push({ tx, text, values });

      // The claim: clears asr_job_id under a status check.
      if (/SET asr_job_id = NULL, asr_job_started_at = NULL/.test(text)) {
        return claimWins ? { rows: [{ id: CALL_ID }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      // advance()
      if (/UPDATE calls SET status = \$3/.test(text)) {
        return advanceWins ? { rows: [{ id: CALL_ID }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (/SELECT pipeline_attempts/.test(text)) {
        return { rows: [{ pipeline_attempts: 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

vi.mock("@aura/db", () => ({
  getAdminPool: () => ({
    query: async () => ({
      rows: [
        {
          id: CALL_ID,
          org_id: ORG_ID,
          asr_job_id: JOB_ID,
          asr_job_started_at: new Date(),
        },
      ],
    }),
  }),
  withOrgContext: async (_orgId: string, fn: (client: unknown) => Promise<unknown>) => {
    txCount += 1;
    return fn(fakeClient(txCount));
  },
}));

vi.mock("./asr-sarvam", () => ({
  sarvamAsrConfigured: () => true,
  collectSarvamAsrJob: async () => ({
    state: "done" as const,
    result: {
      engine: "sarvam/saaras:v3",
      language: "ta-IN",
      diarized: true,
      text: "hello",
      segments: [{ speaker: "Agent", text: "hello" }],
    },
  }),
}));

// Only the last stage is replaced: `stageHelpers` and `persistTranscript` stay
// real, because the transition this suite is about is the one THEY issue.
//
// vi.hoisted, not a plain const: the vi.mock factory below is hoisted above
// every import, so a const declared here is still in its temporal dead zone
// when the factory runs - "Cannot access before initialization", at module
// load, before a single test starts.
const { runPostAsrStages, publishAnalyze } = vi.hoisted(() => ({
  runPostAsrStages: vi.fn(async () => {}),
  publishAnalyze: vi.fn(async () => {}),
}));
vi.mock("./pipeline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pipeline")>();
  return { ...actual, runPostAsrStages };
});
// The hand-off (A2). Recorded so the tests can assert the poller PUBLISHES
// rather than analyses, and that it only does so once it owns the call.
vi.mock("@aura/queue", () => ({ publishAnalyze }));

// Safe despite the mocks above: vitest hoists every vi.mock over the imports,
// so asr-poll.ts is loaded against the fakes. A static import rather than a
// top-level await because this package does not compile with a module target
// that allows one.
import { pollAsrJobs } from "./asr-poll";

/** The transaction index each `advance(from, to)` ran in. */
function advances(): Array<{ tx: number; from: string; to: string }> {
  return issued
    .filter((q) => /UPDATE calls SET status = \$3/.test(q.text))
    .map((q) => ({ tx: q.tx, from: String(q.values[1]), to: String(q.values[2]) }));
}

beforeEach(() => {
  issued = [];
  txCount = 0;
  claimWins = true;
  advanceWins = true;
  runPostAsrStages.mockClear();
  publishAnalyze.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("pollAsrJobs - the status a reader can actually see", () => {
  it("commits the advance and the transcript, then hands the call off", async () => {
    await pollAsrJobs();

    // ONE transaction now (A2): claim, transcript and advance together, and
    // then the call is handed to the analyze queue rather than analysed here.
    // The property this suite has always been about is unchanged - the advance
    // is COMMITTED before any provider is called - it is just that the provider
    // is now called in another process entirely.
    expect(txCount).toBe(1);

    const moves = advances();
    expect(moves).toEqual([{ tx: 1, from: "TRANSCRIBING", to: "ANALYZING" }]);

    // The expensive half is no longer this sweep's job at all. Running it here
    // is what capped the whole deployment at one call at a time.
    expect(runPostAsrStages).not.toHaveBeenCalled();
    expect(publishAnalyze).toHaveBeenCalledTimes(1);
  });

  it("writes the transcript in the same transaction as the advance", async () => {
    await pollAsrJobs();

    const transcriptWrite = issued.find((q) => /INSERT INTO transcripts/.test(q.text));
    expect(transcriptWrite).toBeDefined();
    // Together or not at all: a committed advance with no transcript behind it
    // would have the console showing "Analysing" over nothing to analyse.
    expect(transcriptWrite!.tx).toBe(1);
  });

  it("hands the call to the analyze queue, addressed to its own tenant", async () => {
    await pollAsrJobs();

    // The consumer re-enters the org's RLS context from this message, so an
    // orgId that did not match the call would analyse it under the wrong
    // tenant - or, more likely, find nothing and strand it.
    expect(publishAnalyze).toHaveBeenCalledWith({ callId: CALL_ID, orgId: ORG_ID });
  });

  it("hands nothing off when the claim is lost", async () => {
    claimWins = false;

    await pollAsrJobs();

    // Losing the claim is the normal outcome for a second worker, not an
    // error - but analysing a call somebody else owns is not.
    expect(txCount).toBe(1);
    expect(publishAnalyze).not.toHaveBeenCalled();
  });

  it("hands nothing off when the advance is lost to another writer", async () => {
    advanceWins = false;

    await pollAsrJobs();

    // The claim took but the row moved underneath us before the advance - an
    // operator pressing Reprocess, say. The transcript is written and correct;
    // driving the rest of the pipeline from here would fight whoever now owns
    // the call.
    expect(txCount).toBe(1);
    expect(publishAnalyze).not.toHaveBeenCalled();
  });
});
