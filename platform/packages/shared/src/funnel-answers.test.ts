import { describe, expect, it } from "vitest";
import {
  BUDGET_BANDS,
  BUSINESS_TYPES,
  CRM_SATISFACTION_OPTIONS,
  HAS_CRM_OPTIONS,
  INTENTS,
  TEAM_SIZES,
  WANTS_CUSTOM_CRM_OPTIONS,
} from "./funnel";
import { FUNNEL_QUESTIONS, describeAnswers } from "./funnel-answers";

/**
 * These guard the one thing this module exists to prevent: an operator reading
 * `below_10k` off a lead card instead of "Below ₹10,000", or reading an answer
 * with no question attached to it.
 */

describe("describeAnswers", () => {
  it("returns the question wording alongside the answer", () => {
    const out = describeAnswers({ budget_inr: "below_10k" });
    expect(out).toEqual([
      { key: "budget", question: "Monthly telemarketing budget", answer: "Below ₹10,000" },
    ]);
  });

  it("OMITS unanswered questions rather than inventing a value", () => {
    // A lead who skipped the budget question and one who chose "Below ₹10,000"
    // are different people, and the funnel already treats them differently.
    expect(describeAnswers({})).toEqual([]);
    expect(describeAnswers({ budget_inr: null, intent: undefined, team_size: "  " })).toEqual([]);
  });

  it("keeps the order the questions were asked in", () => {
    // Not alphabetical and not column order: an operator reading the panel is
    // walking the same path the visitor walked, and the CRM follow-ups have to
    // stay attached to the CRM question they hang off.
    const out = describeAnswers({
      wants_custom_crm: "yes",
      business_type: "agency",
      crm_satisfied: "mixed",
      has_crm: "yes",
      budget_inr: "not_sure",
      team_size: "solo",
      intent: "ready",
    });
    expect(out.map((a) => a.key)).toEqual([
      "businessType",
      "teamSize",
      "budget",
      "intent",
      "hasCrm",
      "crmSatisfied",
      "wantsCustomCrm",
    ]);
  });

  it("NEVER shows a raw enum value for any option the form can produce", () => {
    // The whole point. Every value the form can store must resolve to a label,
    // so adding an option to a catalogue without thinking about the console
    // fails here rather than on a lead card.
    const cases: Array<[keyof typeof FUNNEL_QUESTIONS, string, ReadonlyArray<{ value: string }>]> = [
      ["businessType", "business_type", BUSINESS_TYPES],
      ["teamSize", "team_size", TEAM_SIZES],
      ["budget", "budget_inr", BUDGET_BANDS],
      ["intent", "intent", INTENTS],
      ["hasCrm", "has_crm", HAS_CRM_OPTIONS],
      ["crmSatisfied", "crm_satisfied", CRM_SATISFACTION_OPTIONS],
      ["wantsCustomCrm", "wants_custom_crm", WANTS_CUSTOM_CRM_OPTIONS],
    ];

    for (const [key, column, options] of cases) {
      for (const option of options) {
        const [answered] = describeAnswers({ [column]: option.value });
        expect([key, option.value, answered?.answer]).not.toEqual([key, option.value, option.value]);
        expect([key, option.value, answered?.key]).toEqual([key, option.value, key]);
      }
    }
  });

  it("falls back to the stored value when a catalogue no longer knows it", () => {
    // Renaming an option leaves old rows behind. Showing the stored string is
    // ugly and true; "Unknown" would discard the only information there is.
    const [answered] = describeAnswers({ budget_inr: "a_band_we_retired" });
    expect(answered?.answer).toBe("a_band_we_retired");
  });

  it("passes free-typed CRM names through unchanged", () => {
    // `crm_name` is half catalogue, half free text - the form's "other" box
    // writes to the same column, so a lookup miss is normal here.
    const [answered] = describeAnswers({ crm_name: "Our own Excel thing" });
    expect(answered).toEqual({
      key: "crmName",
      question: "Which one?",
      answer: "Our own Excel thing",
    });
  });

  it("every question has non-empty wording", () => {
    for (const [key, text] of Object.entries(FUNNEL_QUESTIONS)) {
      expect([key, text.length > 0]).toEqual([key, true]);
    }
  });
});
