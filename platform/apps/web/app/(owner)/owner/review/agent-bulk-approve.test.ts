import { describe, expect, it } from "vitest";
import type { ReviewAgentAction } from "@/lib/review-queue";
import { eligibleGroups, isBulkEligible } from "./agent-bulk-approve";

/**
 * §12's bulk approve is the one place in this feature where a reviewer acts
 * on items they have not read one by one, so the eligibility rule IS the
 * safety property - and it is the sort of condition that gets widened by
 * somebody making the button useful.
 *
 * Each case below is a way the rule could be loosened and must not be.
 */

function action(over: Partial<ReviewAgentAction> = {}): ReviewAgentAction {
  return {
    id: "a1",
    tool: "set_disposition",
    tier: "T0",
    capability: "record",
    params: {},
    state: "pending_review",
    policy_code: null,
    reason: null,
    final_score: 0.95,
    band: "high",
    requested_at: "2026-10-10T04:00:00.000Z",
    review_due_at: null,
    review_escalated_at: null,
    intent_id: "i1",
    intent_type: "call_outcome",
    intent_status: "confirmed",
    confidence: 0.95,
    slots: {},
    resolved: {},
    evidence: [],
    confidenceBreakdown: {},
    thresholds: { auto: 0.85, review: 0.6 },
    run_id: "r1",
    effective_mode: "suggest",
    model: "test",
    prompt_version: "1.0.0",
    schema_version: "1.0.0",
    resolver_version: "1.0.0",
    summary: null,
    call_id: "c1",
    language: "hi",
    telecaller_id: "t1",
    telecaller_name: "Asha",
    roles_inferred: false,
    stt_confidence: 0.9,
    started_at: "2026-10-10T03:50:00.000Z",
    lead_id: "l1",
    lead_name: "Priya",
    ...over,
  };
}

describe("isBulkEligible", () => {
  it("accepts an internal action that scored at or above its own automatic threshold", () => {
    expect(isBulkEligible(action({ final_score: 0.85 }))).toBe(true);
    expect(isBulkEligible(action({ final_score: 0.99 }))).toBe(true);
  });

  it("refuses anything below the threshold, including just below", () => {
    // 0.84 against an 0.85 threshold is exactly the item the queue exists for.
    expect(isBulkEligible(action({ final_score: 0.84 }))).toBe(false);
    expect(isBulkEligible(action({ final_score: 0.6 }))).toBe(false);
  });

  it("uses the item's OWN threshold, not a constant", () => {
    // An org that raised the bar for this intent to 0.95 must not have an
    // 0.9 item batch-approved because the console assumed 0.85.
    expect(
      isBulkEligible(action({ final_score: 0.9, thresholds: { auto: 0.95, review: 0.7 } })),
    ).toBe(false);
  });

  it("refuses every customer-visible tier whatever it scored", () => {
    expect(isBulkEligible(action({ tier: "T2", final_score: 1 }))).toBe(false);
    expect(isBulkEligible(action({ tier: "T3", final_score: 1 }))).toBe(false);
  });

  it("refuses an item that is not actually waiting", () => {
    // A frozen item (the owner switched the assistant off) and an approved one
    // both arrive here if a stale page is left open.
    expect(isBulkEligible(action({ state: "frozen" }))).toBe(false);
    expect(isBulkEligible(action({ state: "approved" }))).toBe(false);
  });

  it("refuses an item with no score or no thresholds rather than assuming", () => {
    expect(isBulkEligible(action({ final_score: null }))).toBe(false);
    expect(isBulkEligible(action({ thresholds: null }))).toBe(false);
  });
});

describe("eligibleGroups", () => {
  it("groups by tool and offers nothing for a tool with a single item", () => {
    const groups = eligibleGroups([
      action({ id: "a1", tool: "set_disposition" }),
      action({ id: "a2", tool: "set_disposition" }),
      action({ id: "a3", tool: "write_call_summary" }),
    ]);
    expect(groups).toEqual([{ tool: "set_disposition", ids: ["a1", "a2"] }]);
  });

  it("leaves ineligible items out of an otherwise eligible group", () => {
    const groups = eligibleGroups([
      action({ id: "a1" }),
      action({ id: "a2" }),
      action({ id: "a3", final_score: 0.5 }),
    ]);
    expect(groups[0].ids).toEqual(["a1", "a2"]);
  });

  it("caps a group at the API's own limit", () => {
    // `BulkApproveBody` takes at most 100 ids. Sending 150 would be refused
    // wholesale, so the button would do nothing at all on a busy floor.
    const many = Array.from({ length: 150 }, (_, i) => action({ id: `a${i}` }));
    expect(eligibleGroups(many)[0].ids).toHaveLength(100);
  });

  it("offers nothing when everything waiting needs reading", () => {
    expect(eligibleGroups([action({ final_score: 0.4 }), action({ tier: "T2" })])).toEqual([]);
  });
});
