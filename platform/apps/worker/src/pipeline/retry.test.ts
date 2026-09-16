import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The stall sweep - the third way a call goes missing.
 *
 * `retryDueCalls` covers a run that failed and said so, `requeueStuckUploads` a
 * wake-up that never arrived. Neither covers a worker killed while it held the
 * call: the row keeps the in-flight status of the stage it died in, which is
 * neither `FAILED_%` nor `UPLOADED`, so both existing sweeps skip it forever
 * and the customer's transcript never appears. What is asserted below is the
 * pair of properties that makes recovery safe rather than just possible - the
 * claim is conditional, and the failure goes through the same `fail()` an
 * inline stage failure does, so the retry machinery already in place picks the
 * call up unchanged.
 *
 * No database is opened: the admin pool and `withOrgContext` are both faked.
 */

const ORG_ID = "00000000-0000-4000-8000-000000000001";
const CALL_ID = "11111111-1111-4111-8111-111111111111";

interface Recorded {
  text: string;
  values: unknown[];
}

/** Rows the cross-tenant scan finds. */
let stalledRows: Array<Record<string, unknown>> = [];
/** Statements issued inside the tenant transaction, in order. */
let issued: Recorded[] = [];
/** Whether the conditional claim matches - false models losing the race. */
let claimSucceeds = true;

vi.mock("@aura/db", () => ({
  getAdminPool: () => ({
    query: async (_text: string, _values: unknown[] = []) => ({
      rows: stalledRows,
      rowCount: stalledRows.length,
    }),
  }),
  withOrgContext: (_orgId: string, fn: (client: unknown) => Promise<unknown>) =>
    fn({
      query: async (text: string, values: unknown[] = []) => {
        issued.push({ text, values });
        if (/SET updated_at = now\(\)/.test(text)) {
          return claimSucceeds
            ? { rows: [{ id: CALL_ID }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        // failStrandedAwaitingAudio's claim-and-write is one statement, not the
        // claim-then-fail() pair the branch above models - there is no shared
        // `fail()` call to split it from, and no next_attempt_at to schedule.
        if (/status = 'FAILED_UPLOAD'/.test(text)) {
          return claimSucceeds
            ? { rows: [{ id: CALL_ID }], rowCount: 1 }
            : { rows: [], rowCount: 0 };
        }
        if (/SELECT pipeline_attempts/.test(text)) {
          return { rows: [{ pipeline_attempts: 1 }], rowCount: 1 };
        }
        if (/pipeline_attempts = pipeline_attempts \+ 1/.test(text)) {
          return { rows: [{ pipeline_attempts: 2 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    }),
}));

// The sweep never publishes - it hands the call to retryDueCalls, which does.
vi.mock("@aura/queue", () => ({
  publishPipeline: vi.fn(),
  // A change signal, not work: the pipeline calls it after a status
  // transition. Stubbed so these tests need no broker.
  publishEvent: vi.fn(),
}));

/**
 * PIPELINE_STALL_MS is read at module load, so - exactly as report 12 §5.6
 * describes for PIPELINE_MAX_ATTEMPTS - a machine that exports it would change
 * what these tests assert. Stub it away and re-import so the timeout under test
 * is the code's, not the environment's.
 */
async function loadSweeper(stallMs?: string) {
  vi.stubEnv("PIPELINE_STALL_MS", stallMs);
  vi.resetModules();
  return await import("./retry");
}

function stalledRow(status: string, minutesAgo = 90) {
  return {
    id: CALL_ID,
    org_id: ORG_ID,
    status,
    updated_at: new Date(Date.now() - minutesAgo * 60_000),
  };
}

/** The `fail()` write, if one happened. */
function failure(): Recorded | undefined {
  return issued.find((q) => /pipeline_attempts = pipeline_attempts \+ 1/.test(q.text));
}

/** The AWAITING_AUDIO -> FAILED_UPLOAD write, if one happened. */
function uploadFailure(): Recorded | undefined {
  return issued.find((q) => /FAILED_UPLOAD/.test(q.text));
}

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(() => {
  stalledRows = [];
  issued = [];
  claimSucceeds = true;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("failStalledCalls", () => {
  // 15s, not the 5s default: this is the first test to call loadSweeper(),
  // which does vi.resetModules() and re-imports the module graph. That costs
  // ~3s on its own, and under a full parallel run it tips past the default and
  // fails a test that is doing nothing wrong.
  it("does nothing when no call has been sitting in a stage", { timeout: 15_000 }, async () => {
    const { failStalledCalls } = await loadSweeper();
    expect(await failStalledCalls()).toBe(0);
    expect(issued).toHaveLength(0);
  });

  it.each([
    ["TRANSCODING", "FAILED_TRANSCODE"],
    ["TRANSCRIBING", "FAILED_ASR"],
    ["ANALYZING", "FAILED_ANALYZE"],
    ["SYNCING", "FAILED_CRM"],
  ])("lands a call stalled in %s on %s", async (status, expected) => {
    // The stage that died is the stage that failed. Getting this mapping wrong
    // would send an operator reading the failed filter to the wrong provider.
    stalledRows = [stalledRow(status)];

    const { failStalledCalls } = await loadSweeper();
    expect(await failStalledCalls()).toBe(1);
    expect(failure()!.values[1]).toBe(expected);
  });

  it("hands the call to the existing retry machinery rather than requeueing it", async () => {
    stalledRows = [stalledRow("ANALYZING")];
    const { failStalledCalls } = await loadSweeper();
    await failStalledCalls();

    const failed = failure()!;
    // next_attempt_at is what retryDueCalls selects on, so without it the call
    // would be visible-but-dead rather than recovered.
    expect(failed.text).toMatch(/next_attempt_at = CASE/);
    // FAILED_% + a due next_attempt_at is exactly the shape that sweep claims.
    expect(String(failed.values[1]).startsWith("FAILED_")).toBe(true);
    // Counted, so a call that strands over and over retires to a human instead
    // of looping between the two sweeps forever.
    expect(failed.text).toMatch(/pipeline_attempts = pipeline_attempts \+ 1/);
  });

  it("records why, naming the state and how long it sat there", async () => {
    stalledRows = [stalledRow("TRANSCRIBING", 90)];
    const { failStalledCalls } = await loadSweeper();
    await failStalledCalls();

    expect(String(failure()!.values[2])).toContain("stalled in TRANSCRIBING");
    expect(String(failure()!.values[2])).toContain("90 minutes");
  });

  it("claims conditionally, on the same row and the same staleness it selected", async () => {
    stalledRows = [stalledRow("TRANSCODING")];
    const { failStalledCalls } = await loadSweeper();
    await failStalledCalls();

    const claim = issued[0];
    // Re-checking the status and the age inside the transaction is what stops
    // a second sweeper, or an operator's Reprocess landing in between the scan
    // and the write, from being overwritten by a stale decision.
    expect(claim.text).toMatch(/WHERE id = \$1/);
    expect(claim.text).toMatch(/AND status = \$2/);
    expect(claim.text).toMatch(/updated_at < now\(\) - make_interval/);
    expect(claim.values[0]).toBe(CALL_ID);
    expect(claim.values[1]).toBe("TRANSCODING");
  });

  it("fails nothing when the claim loses the race", async () => {
    // Someone else moved the row between the cross-tenant scan and the write -
    // another sweeper, or the operator pressing Reprocess. Writing FAILED_* now
    // would stamp over a call that is legitimately running again.
    stalledRows = [stalledRow("SYNCING")];
    claimSucceeds = false;

    const { failStalledCalls } = await loadSweeper();
    expect(await failStalledCalls()).toBe(0);
    expect(failure()).toBeUndefined();
  });

  it("uses a timeout generous enough that a merely slow call is never failed", async () => {
    stalledRows = [stalledRow("ANALYZING")];
    const { failStalledCalls } = await loadSweeper();
    await failStalledCalls();

    // Failing a slow call costs a second round of billed ASR + analyze, and on
    // SYNCING a second delivery into a customer's CRM, so the window is an hour
    // by default - and longer than asr-poll's own 30-minute job timeout, which
    // owns anything parked in TRANSCRIBING with a job outstanding.
    const seconds = Number(issued[0].values[2]);
    expect(seconds).toBeGreaterThanOrEqual(30 * 60);
    expect(seconds).toBe(60 * 60);
  });

  it("honours an operator's PIPELINE_STALL_MS rather than ignoring it", async () => {
    // The window is meant to be tunable per deployment; the test above pins the
    // default, this one proves the knob is wired.
    stalledRows = [stalledRow("ANALYZING")];
    const { failStalledCalls } = await loadSweeper(String(15 * 60 * 1000));
    await failStalledCalls();

    expect(Number(issued[0].values[2])).toBe(15 * 60);
  });
});

/**
 * The fourth way a call goes missing: the handset's upload never finished and
 * never will (the file was deleted, the app was uninstalled, the device is
 * gone for good). Unlike the three sweeps above, there is no audio in S3 to
 * resume - so this one does not hand the call back to retryDueCalls at all,
 * it lands it on a status with no next_attempt_at and stops there.
 */
describe("failStrandedAwaitingAudio", () => {
  it("does nothing when no call has been sitting in AWAITING_AUDIO", async () => {
    const { failStrandedAwaitingAudio } = await loadSweeper();
    expect(await failStrandedAwaitingAudio()).toBe(0);
    expect(issued).toHaveLength(0);
  });

  it("fails a stranded upload to FAILED_UPLOAD", async () => {
    stalledRows = [stalledRow("AWAITING_AUDIO")];
    const { failStrandedAwaitingAudio } = await loadSweeper();
    expect(await failStrandedAwaitingAudio()).toBe(1);
    expect(uploadFailure()).toBeDefined();
  });

  it("writes no next_attempt_at - nothing server-side can complete a call with no audio", async () => {
    stalledRows = [stalledRow("AWAITING_AUDIO")];
    const { failStrandedAwaitingAudio } = await loadSweeper();
    await failStrandedAwaitingAudio();

    // A next_attempt_at is what retryDueCalls selects on; writing one would
    // rewind this call to UPLOADED with nothing in S3 to transcode.
    expect(uploadFailure()!.text).not.toMatch(/next_attempt_at/);
    expect(uploadFailure()!.text).not.toMatch(/pipeline_attempts/);
  });

  it("claims conditionally, on the same row and the same staleness it selected", async () => {
    stalledRows = [stalledRow("AWAITING_AUDIO")];
    const { failStrandedAwaitingAudio } = await loadSweeper();
    await failStrandedAwaitingAudio();

    const claim = uploadFailure()!;
    expect(claim.text).toMatch(/WHERE id = \$1/);
    expect(claim.text).toMatch(/AND status = 'AWAITING_AUDIO'/);
    expect(claim.text).toMatch(/created_at < now\(\) - make_interval/);
    expect(claim.values[0]).toBe(CALL_ID);
  });

  it("fails nothing when the claim loses the race", async () => {
    // The client's own retry (0101) resumed the same row between the scan and
    // the write - it must not be stamped FAILED_UPLOAD out from under it.
    stalledRows = [stalledRow("AWAITING_AUDIO")];
    claimSucceeds = false;

    const { failStrandedAwaitingAudio } = await loadSweeper();
    expect(await failStrandedAwaitingAudio()).toBe(0);
  });

  it("defaults to a 6-hour window, generous enough that a device merely offline is never failed", async () => {
    stalledRows = [stalledRow("AWAITING_AUDIO")];
    const { failStrandedAwaitingAudio } = await loadSweeper();
    await failStrandedAwaitingAudio();

    expect(Number(uploadFailure()!.values[2])).toBe(6 * 60 * 60);
  });

  it("honours PIPELINE_AWAITING_AUDIO_STALL_MS rather than ignoring it", async () => {
    stalledRows = [stalledRow("AWAITING_AUDIO")];
    vi.stubEnv("PIPELINE_AWAITING_AUDIO_STALL_MS", String(60 * 60 * 1000));
    vi.resetModules();

    const { failStrandedAwaitingAudio } = await import("./retry");
    await failStrandedAwaitingAudio();

    expect(Number(uploadFailure()!.values[2])).toBe(60 * 60);
  });
});
