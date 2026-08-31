import { beforeEach, describe, expect, it, vi } from "vitest";

import { CallStatus } from "@aura/shared";
// Safe despite the mock below: vitest hoists every vi.mock above the imports,
// so pipeline.ts is loaded against the fake @aura/db, not the real pool.
import { MAX_PIPELINE_ATTEMPTS, processCall, retryBackoffSeconds } from "./pipeline";

/**
 * The failure path of each pipeline stage.
 *
 * The thing under test is not "does transcode work" - it is a pass-through
 * today and cannot work incorrectly. It is what happens when a stage *throws*,
 * which is the one path in this file that used to have no code at all: report
 * 12 §4.3 records that `fail()` was only ever called with `'ASR'` and
 * `'ANALYZE'`, so a throw in transcode escaped `processCall` with no
 * `error_message`, no attempt increment and no `next_attempt_at`, stranding the
 * call in `TRANSCODING` where neither sweeper in retry.ts looks. Nothing
 * alerted; the recording was simply never transcribed. §2.3's ffmpeg work is
 * what will start throwing there, so this suite exists before it lands.
 *
 * No database and no S3 is opened: `withOrgContext` is mocked to hand
 * `processCall` a fake client that records every statement and can be told to
 * throw on one of them, which is exactly how a stage failure reaches the
 * state machine.
 */

const CALL_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "00000000-0000-4000-8000-000000000001";

interface Recorded {
  text: string;
  values: unknown[];
}

/** Every statement `processCall` issued, in order. */
let issued: Recorded[] = [];
/** When set, the fake client throws on the first statement it matches. */
let throwOn: { match: RegExp; error: Error } | null = null;
/** false models another worker having already moved the call out of UPLOADED. */
let claimSucceeds = true;

function fakeClient() {
  return {
    query: async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      if (throwOn && throwOn.match.test(text)) throw throwOn.error;

      // priorAttempts - a first run, so nothing failed yet.
      if (/SELECT pipeline_attempts/.test(text)) {
        return { rows: [{ pipeline_attempts: 0 }], rowCount: 1 };
      }
      // The org row: transcription on, provider defaults.
      if (/FROM organizations/.test(text)) {
        return {
          rows: [{ transcription_enabled: true, asr_language: null, asr_mode: null }],
          rowCount: 1,
        };
      }
      // fail() - returns the attempt it just recorded.
      if (/pipeline_attempts = pipeline_attempts \+ 1/.test(text)) {
        return { rows: [{ pipeline_attempts: 1 }], rowCount: 1 };
      }
      // advance() - the optimistic transition, which wins unless a test is
      // modelling the row having been moved by someone else.
      if (/UPDATE calls\s+SET status = \$3/.test(text)) {
        return claimSucceeds ? { rows: [{ id: CALL_ID }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// Referenced lazily (inside the function body, not at factory evaluation) so
// the module-level state above is initialised by the time it is read.
vi.mock("@aura/db", () => ({
  withOrgContext: (_orgId: string, fn: (client: unknown) => Promise<unknown>) => fn(fakeClient()),
}));

/** The `advance(from, to)` transitions attempted, in order. */
function transitions(): Array<[string, string]> {
  return issued
    .filter((q) => /UPDATE calls\s+SET status = \$3/.test(q.text))
    .map((q) => [String(q.values[1]), String(q.values[2])] as [string, string]);
}

/** The single `fail()` write, if one happened. */
function failure(): Recorded | undefined {
  return issued.find((q) => /pipeline_attempts = pipeline_attempts \+ 1/.test(q.text));
}

beforeEach(() => {
  issued = [];
  throwOn = null;
  claimSucceeds = true;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("processCall - transcode failure", () => {
  // Everything inside the transcode stage runs under one try; this is the
  // statement that stage issues today, and the ffmpeg call will sit beside it.
  const IN_TRANSCODE = /error_message = NULL, next_attempt_at = NULL/;

  it("lands the call on FAILED_TRANSCODE rather than letting the throw escape", async () => {
    throwOn = { match: IN_TRANSCODE, error: new Error("ffmpeg: exited with code 1") };

    await expect(processCall({ callId: CALL_ID, orgId: ORG_ID })).resolves.toBeUndefined();

    const failed = failure();
    expect(failed).toBeDefined();
    expect(failed!.values[0]).toBe(CALL_ID);
    expect(failed!.values[1]).toBe("FAILED_TRANSCODE");
  });

  it("writes a status the CHECK constraint and the sweepers both accept", async () => {
    // A typo here (FAILED_TRANSCODING, say) would be rejected by
    // calls_status_check at runtime and would never match the sweeper's
    // `status LIKE 'FAILED_%'`, so the call would strand exactly as before -
    // with the code looking correct.
    throwOn = { match: IN_TRANSCODE, error: new Error("ffmpeg: exited with code 1") };
    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    const status = String(failure()!.values[1]);
    expect(CallStatus.options).toContain(status);
    expect(status.startsWith("FAILED_")).toBe(true);
  });

  it("records the provider's reason so the drawer shows why", async () => {
    throwOn = { match: IN_TRANSCODE, error: new Error("ffmpeg: exited with code 1") };
    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(failure()!.values[2]).toBe("ffmpeg: exited with code 1");
  });

  it("schedules the retry on the same budget and backoff as an ASR failure", async () => {
    throwOn = { match: IN_TRANSCODE, error: new Error("ffmpeg: exited with code 1") };
    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    const failed = failure()!;
    // next_attempt_at is computed in SQL from these two, so they are what
    // decides whether retryDueCalls ever picks the call back up: the budget it
    // is compared against, and the delay for the attempt this failure becomes.
    expect(failed.values[3]).toBe(MAX_PIPELINE_ATTEMPTS);
    expect(failed.values[4]).toBe(retryBackoffSeconds(1));
    expect(failed.text).toMatch(/next_attempt_at = CASE/);
    // Attempt counted, and any stale batch-ASR job dropped - a retry submits
    // its own, and the poller must not be left holding the old id.
    expect(failed.text).toMatch(/pipeline_attempts = pipeline_attempts \+ 1/);
    expect(failed.text).toMatch(/asr_job_id = NULL/);
  });

  it("stops after failing instead of walking on into ASR", async () => {
    throwOn = { match: IN_TRANSCODE, error: new Error("ffmpeg: exited with code 1") };
    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    // Only the claim happened. Advancing to TRANSCRIBING after a failed
    // transcode would hand ASR audio that was never produced.
    expect(transitions()).toEqual([["UPLOADED", "TRANSCODING"]]);
  });

  it("does not fail a call it never claimed", async () => {
    // Idempotent replay: another worker already moved the call out of UPLOADED,
    // so the claim matches nothing. Stamping FAILED_TRANSCODE here would fail
    // that worker's run rather than ours - which is why the claim deliberately
    // sits OUTSIDE the try, and this is the test that keeps it there.
    claimSucceeds = false;
    throwOn = { match: IN_TRANSCODE, error: new Error("ffmpeg: exited with code 1") };

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(failure()).toBeUndefined();
    // It returned at the claim, so the stage never ran at all.
    expect(issued.some((q) => IN_TRANSCODE.test(q.text))).toBe(false);
  });
});

describe("processCall - the other stages still fail as they did", () => {
  it("still lands an ASR-stage throw on FAILED_ASR", async () => {
    // The recording lookup is the first statement of the ASR stage. It sits
    // inside that stage's try - including the duration read that precedes it,
    // which used to be outside and could throw straight out of processCall.
    throwOn = {
      match: /SELECT s3_key FROM recordings/,
      error: new Error("sarvam: 429 rate limited"),
    };

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(failure()!.values[1]).toBe("FAILED_ASR");
    expect(transitions()).toEqual([
      ["UPLOADED", "TRANSCODING"],
      ["TRANSCODING", "TRANSCRIBING"],
    ]);
  });

  it("fails ASR when the duration read itself throws", async () => {
    // Pins the fix: this query runs after the call is already in TRANSCRIBING,
    // so before it moved inside the try a blip on it stranded the call in a
    // state neither sweeper claimed.
    throwOn = {
      match: /SELECT duration_s FROM calls/,
      error: new Error("canceling statement due to statement timeout"),
    };

    await processCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(failure()!.values[1]).toBe("FAILED_ASR");
  });
});
