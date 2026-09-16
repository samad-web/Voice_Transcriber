import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The enrichment lane, and the CRM send it is holding.
 *
 * This is the riskiest part of the lane split (A4). The dispatch payload carries
 * `intelligence` (crm-dispatch.ts), so the send cannot go out until this lane
 * has finished - otherwise a customer's own CRM fills with leads whose summary
 * is empty, and a delivered record cannot be recalled.
 *
 * But "wait for enrichment" must not become "wait forever". A tenant whose
 * conversation reads are failing - a bad API key, a provider outage, an org
 * whose calls are all in a language the analyser rejects - must still receive
 * their leads. So the send is released on any TERMINAL outcome: done, skipped,
 * or a failure that has run out of attempts. The only state that holds it is a
 * retry still pending.
 *
 * Both halves of that are silent when wrong. Releasing too early corrupts a
 * customer's CRM; releasing never means leads stop arriving and nothing logs an
 * error, because from this lane's point of view everything is simply "not done
 * yet".
 */

const CALL_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "00000000-0000-4000-8000-000000000001";
const LEAD_ID = "33333333-3333-4333-8333-333333333333";

const { analyzeConversation, enqueueDispatch } = vi.hoisted(() => ({
  analyzeConversation: vi.fn(),
  enqueueDispatch: vi.fn(async () => {}),
}));

/** Every statement the lane issued. */
let issued: Array<{ text: string; values: unknown[] }> = [];
/** false models the claim losing to another consumer or the sweeper. */
let claimWins = true;
/** null models a call with no transcript - nothing to enrich. */
let transcriptText: string | null = "hello there";
/** Which attempt the claim reports this as. */
let attemptNo = 1;
/** Whether a lead exists for the call. */
let leadId: string | null = LEAD_ID;

function fakeClient() {
  return {
    query: async (text: string, values: unknown[] = []) => {
      issued.push({ text, values });
      if (/SET enrichment_status = 'running'/.test(text)) {
        return claimWins
          ? { rows: [{ enrichment_attempts: attemptNo }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/FROM calls c/.test(text) && /LEFT JOIN transcripts/.test(text)) {
        return {
          rows: [
            {
              text: transcriptText,
              segments: [],
              diarized: true,
              direction: "outgoing",
              vocabulary: [],
              leadId,
            },
          ],
          rowCount: 1,
        };
      }
      if (/SELECT id FROM leads WHERE first_call_id/.test(text)) {
        return leadId ? { rows: [{ id: leadId }], rowCount: 1 } : { rows: [], rowCount: 0 };
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
vi.mock("./outbox", () => ({ enqueueDispatch }));
vi.mock("./call-analytics", () => ({
  computeTalkMetrics: () => ({}),
  upsertCallAnalytics: vi.fn(async () => {}),
}));
vi.mock("./projects", () => ({
  detectCallProjects: vi.fn(async () => ({ hits: [], reason: "" })),
}));

import { enrichCall } from "./enrich";

const INTEL = {
  turns: [],
  language: "ta",
  summary: "the customer asked about pricing",
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

/** The enrichment_status this run settled on, if it settled. */
function settledTo(): string | undefined {
  const row = issued.find((q) => /SET enrichment_status = \$2/.test(q.text));
  return row ? String(row.values[1]) : undefined;
}

beforeEach(() => {
  issued = [];
  claimWins = true;
  transcriptText = "hello there";
  attemptNo = 1;
  leadId = LEAD_ID;
  vi.clearAllMocks();
  analyzeConversation.mockResolvedValue(INTEL);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("enrichCall - releasing the CRM send", () => {
  it("releases it once the conversation read has landed", async () => {
    await enrichCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(settledTo()).toBe("done");
    expect(enqueueDispatch).toHaveBeenCalledTimes(1);
  });

  it("releases it for a call with nothing to enrich", async () => {
    // Too short to transcribe, or transcription switched off. There is no
    // summary coming, so holding the send would hold it forever.
    transcriptText = null;

    await enrichCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(settledTo()).toBe("skipped");
    expect(enqueueDispatch).toHaveBeenCalledTimes(1);
  });

  it("releases it when enrichment has run out of attempts", async () => {
    // A tenant whose conversation reads are permanently broken still gets their
    // leads - without the summary, which is the correct trade.
    attemptNo = 3;
    analyzeConversation.mockRejectedValue(new Error("sarvam: 401"));

    await enrichCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(settledTo()).toBe("failed");
    expect(enqueueDispatch).toHaveBeenCalledTimes(1);
  });

  it("holds it while a retry is still pending", async () => {
    // The one state that must NOT release: the summary is still coming, and
    // sending now would deliver a record that is about to be completed.
    attemptNo = 1;
    analyzeConversation.mockRejectedValue(new Error("sarvam: 429"));

    await enrichCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(enqueueDispatch).not.toHaveBeenCalled();
    // Scheduled rather than settled.
    expect(issued.some((q) => /next_enrichment_at = now\(\)/.test(q.text))).toBe(true);
  });

  it("tells dispatch the call qualified when a lead exists", async () => {
    leadId = LEAD_ID;

    await enrichCall({ callId: CALL_ID, orgId: ORG_ID });

    // The lead's existence IS the qualification - the lead lane writes one only
    // when qualifyLead said so. Getting this wrong silences every lead-only
    // connector.
    expect(enqueueDispatch).toHaveBeenCalledWith(expect.anything(), ORG_ID, CALL_ID, true);
  });

  it("tells dispatch it did not qualify when no lead was written", async () => {
    leadId = null;

    await enrichCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(enqueueDispatch).toHaveBeenCalledWith(expect.anything(), ORG_ID, CALL_ID, false);
  });
});

describe("enrichCall - the lead's summary", () => {
  it("backfills the summary the lead lane could not write", async () => {
    await enrichCall({ callId: CALL_ID, orgId: ORG_ID });

    const backfill = issued.find((q) => /UPDATE leads SET summary/.test(q.text));
    expect(backfill).toBeDefined();
    expect(backfill!.values[0]).toBe(LEAD_ID);
    expect(backfill!.values[1]).toBe("the customer asked about pricing");
  });

  it("does not try to backfill when the call produced no lead", async () => {
    leadId = null;

    await enrichCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(issued.some((q) => /UPDATE leads SET summary/.test(q.text))).toBe(false);
  });
});

describe("enrichCall - claiming", () => {
  it("does nothing at all when another consumer already holds the call", async () => {
    // A redelivery, or the sweeper racing the queue. Proceeding would pay for a
    // second conversation read and could release the send twice.
    claimWins = false;

    await enrichCall({ callId: CALL_ID, orgId: ORG_ID });

    expect(analyzeConversation).not.toHaveBeenCalled();
    expect(enqueueDispatch).not.toHaveBeenCalled();
    expect(settledTo()).toBeUndefined();
  });
});
