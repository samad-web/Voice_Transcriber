import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Where a failed call resumes from, and which queue gets told (A3).
 *
 * The rewind itself is a CASE inside the claim, so Postgres decides the stage
 * and this suite covers the half that JavaScript owns: routing the republish to
 * the queue that actually consumes the stage the call was rewound TO. Since A2
 * those are two different queues, and getting it wrong is silent - a call
 * resumed to ANALYZING but published to the admission queue is skipped by
 * `processCall` for not being in UPLOADED, then sits untouched until the stall
 * sweep fails it an hour later.
 *
 * The SQL half - that FAILED_ANALYZE with a transcript resumes while
 * FAILED_ASR, FAILED_TRANSCODE and a transcript-less FAILED_ANALYZE all go back
 * to UPLOADED - is verified against a real Postgres, since a CASE expression is
 * not something a fake client can meaningfully evaluate.
 */

const CALL_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "00000000-0000-4000-8000-000000000001";

const { publishPipeline, publishAnalyze } = vi.hoisted(() => ({
  publishPipeline: vi.fn(async () => {}),
  publishAnalyze: vi.fn(async () => {}),
}));
vi.mock("@aura/queue", () => ({
  publishPipeline,
  publishAnalyze,
  // A change signal, not work: the pipeline calls it after a status
  // transition. Stubbed so these tests need no broker.
  publishEvent: vi.fn(),
}));

/**
 * What each successive claim's CASE resolved to, as Postgres would return it.
 * A list rather than one value so a batch can mix stages, which any real
 * backlog does. The last entry repeats once the list runs out.
 */
let rewinds: Array<string | null> = ["UPLOADED"];
let claimNo = 0;
function nextRewind(): string | null {
  const v = rewinds[Math.min(claimNo, rewinds.length - 1)] ?? null;
  claimNo += 1;
  return v;
}
/** Calls the sweep finds due. */
let dueRows: Array<{ id: string; org_id: string }> = [];

vi.mock("@aura/db", () => ({
  getAdminPool: () => ({ query: async () => ({ rows: dueRows }) }),
  withOrgContext: async (_orgId: string, fn: (client: unknown) => Promise<unknown>) =>
    fn({
      query: async (text: string) => {
        if (/UPDATE calls c/.test(text)) {
          const status = nextRewind();
          return status ? { rows: [{ status }], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        return { rows: [], rowCount: 0 };
      },
    }),
}));

import { retryDueCalls } from "./retry";

beforeEach(() => {
  vi.clearAllMocks();
  rewinds = ["UPLOADED"];
  claimNo = 0;
  dueRows = [{ id: CALL_ID, org_id: ORG_ID }];
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

describe("retryDueCalls - republishing to the right stage", () => {
  it("sends a call rewound to UPLOADED back through admission", async () => {
    rewinds = ["UPLOADED"];

    expect(await retryDueCalls()).toBe(1);

    expect(publishPipeline).toHaveBeenCalledWith({ callId: CALL_ID, orgId: ORG_ID });
    expect(publishAnalyze).not.toHaveBeenCalled();
  });

  it("sends a call resumed at ANALYZING to the analyze queue instead", async () => {
    rewinds = ["ANALYZING"];

    expect(await retryDueCalls()).toBe(1);

    // Publishing this to the admission queue is the silent failure the routing
    // exists to prevent: processCall would skip it, and nothing else would look
    // at it until the stall sweep.
    expect(publishAnalyze).toHaveBeenCalledWith({ callId: CALL_ID, orgId: ORG_ID });
    expect(publishPipeline).not.toHaveBeenCalled();
  });

  it("publishes nothing when another sweeper won the claim", async () => {
    // Losing the claim is the normal outcome for a second sweeper. Publishing
    // anyway would hand the same call to two consumers.
    rewinds = [null];

    expect(await retryDueCalls()).toBe(0);

    expect(publishPipeline).not.toHaveBeenCalled();
    expect(publishAnalyze).not.toHaveBeenCalled();
  });

  it("routes each call by its own rewind, not by the batch's first", async () => {
    // Both stages are due together in any real backlog, and they are claimed in
    // one loop - so a single `status` read outside it would send every call in
    // the batch to whichever queue the first one needed.
    dueRows = [
      { id: CALL_ID, org_id: ORG_ID },
      { id: CALL_ID, org_id: ORG_ID },
    ];
    rewinds = ["UPLOADED", "ANALYZING"];

    expect(await retryDueCalls()).toBe(2);

    expect(publishPipeline).toHaveBeenCalledTimes(1);
    expect(publishAnalyze).toHaveBeenCalledTimes(1);
  });
});
