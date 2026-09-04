import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The analyze queue's consumer, and why it checks a status first (A2).
 *
 * Every other stage claims its work with an optimistic `advance(from, to)`: two
 * workers race, one UPDATE matches, the loser does nothing. This stage has no
 * such transition available - the ASR poller has already moved the call to
 * ANALYZING and committed before publishing, so by the time a consumer sees the
 * message the claim it would have made is gone.
 *
 * That matters because RabbitMQ redelivers. A nack, a consumer that dies
 * mid-message, a broker restart, or simply the same call being published twice
 * all put a second copy in front of a consumer - and without a guard both copies
 * would run BOTH provider calls (paying twice), write a second ai_outputs row
 * and re-deliver the lead to the tenant's CRM, which is not retractable.
 *
 * Reading the status is the claim. It is the cheapest possible one - a single
 * round trip that also carries the attempt count - and it is what makes a
 * redelivery a no-op instead of a duplicate.
 *
 * Asserted by EFFECT rather than by spying on `runPostAsrStages`: the two live
 * in one module, so a module mock does not intercept the call between them and
 * would pass while testing nothing. "Did the stage proceed" is observable
 * without that - a stage that runs reads the transcript, and a guarded one
 * issues exactly the status read and stops.
 */

const CALL_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "00000000-0000-4000-8000-000000000001";

/** Every statement the consumer issued, across all its transactions. */
let issued: string[] = [];
/** What the calls row reports when the consumer looks. */
let callState: { status: string; pipeline_attempts: number } | undefined;

vi.mock("@aura/db", () => ({
  withOrgContext: async (_orgId: string, fn: (client: unknown) => Promise<unknown>) =>
    fn({
      query: async (text: string) => {
        issued.push(text);
        if (/SELECT status, pipeline_attempts/.test(text)) {
          return { rows: callState ? [callState] : [], rowCount: callState ? 1 : 0 };
        }
        if (/FROM transcripts WHERE call_id/.test(text)) {
          return { rows: [{ text: null, segments: [], diarized: false }], rowCount: 1 };
        }
        if (/UPDATE calls SET status = \$3/.test(text)) {
          return { rows: [{ id: CALL_ID }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    }),
}));

vi.mock("@aura/llm", () => ({ analyzeConversation: vi.fn(), analyzeTranscript: vi.fn() }));
vi.mock("./call-analytics", () => ({
  computeTalkMetrics: () => ({}),
  upsertCallAnalytics: vi.fn(async () => {}),
}));
vi.mock("./crm-objects", () => ({ projectLeadToCrm: vi.fn(async () => ({ reason: "skipped" })) }));
vi.mock("./leads", () => ({ upsertLead: vi.fn(async () => ({ leadId: null, reason: "none" })) }));
vi.mock("./outbox", () => ({ enqueueDispatch: vi.fn(async () => {}) }));
vi.mock("./projects", () => ({ detectCallProjects: vi.fn(async () => {}) }));

import { analyzeCall } from "./pipeline";

/** The stage proceeded past its guard iff it went looking for the transcript. */
function stageRan(): boolean {
  return issued.some((t) => /FROM transcripts WHERE call_id/.test(t));
}

beforeEach(() => {
  issued = [];
  callState = { status: "ANALYZING", pipeline_attempts: 0 };
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("analyzeCall", () => {
  it("analyses a call the poller has parked in ANALYZING", async () => {
    await analyzeCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(stageRan()).toBe(true);
  });

  it("ignores a redelivery of a call that already completed", async () => {
    callState = { status: "COMPLETE", pipeline_attempts: 0 };

    await analyzeCall({ callId: CALL_ID, orgId: ORG_ID });

    // Re-analysing pays both providers again and re-delivers the lead.
    expect(stageRan()).toBe(false);
  });

  it("ignores a call another consumer has already carried past this stage", async () => {
    callState = { status: "SYNCING", pipeline_attempts: 0 };

    await analyzeCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(stageRan()).toBe(false);
  });

  it("ignores a call that has since failed and is awaiting its retry", async () => {
    // The retry sweep owns this one; analysing it now would race the rewind.
    callState = { status: "FAILED_ANALYZE", pipeline_attempts: 2 };

    await analyzeCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(stageRan()).toBe(false);
  });

  it("does nothing for a call that no longer exists", async () => {
    // Deleted by the retention reaper between publish and delivery.
    callState = undefined;

    await analyzeCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(stageRan()).toBe(false);
  });

  it("spends exactly one statement rejecting a redelivery", async () => {
    // The guard is on the hot path of every duplicate message, so it must not
    // itself become a cost. One read, no transaction left open, nothing else.
    callState = { status: "COMPLETE", pipeline_attempts: 0 };

    await analyzeCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatch(/SELECT status, pipeline_attempts/);
  });
});
