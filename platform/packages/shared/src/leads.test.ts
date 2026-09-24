import { describe, expect, it } from "vitest";

import {
  DEFAULT_LEAD_RULES,
  DEFAULT_LEAD_STAGES,
  LEAD_TEMPERATURE_LABELS,
  LEAD_TEMPERATURE_ORDER,
  LeadTemperature,
  type LeadTemperatureSignals,
  deriveLeadTemperature,
  stageAfter,
  LeadRules,
  entryStage,
  isFilled,
  mergeFacts,
  parseLeadRules,
  parseLeadStages,
  qualifyLead,
  stageOnBoard,
  statusForStage,
  type LeadStages,
} from "./leads";

/**
 * The lead domain rules - the highest-consequence pure code in the platform.
 *
 * These functions decide whether a five-minute sales call becomes a card on a
 * customer's board or is thrown away, and nothing downstream reports the
 * decision: an over-strict rule loses revenue silently, an over-loose one fills
 * the board with wrong numbers. There is no monitoring that would catch either.
 *
 * FIXTURES ARE REAL, NOT INVENTED. `facts` here is shaped exactly as
 * `upsertLead` builds it (worker/src/pipeline/leads.ts:95-98): a jsonb object
 * from
 *   COALESCE(to_jsonb(value_num), to_jsonb(value_bool), to_jsonb(value_text))
 * over call_facts. So numbers arrive as JSON numbers, booleans as JSON booleans,
 * and a `string[]` field arrives as the JSON.stringify'd *string* the analyze
 * stage wrote (pipeline.ts:404-410) - not as an array. Tests below depend on
 * that, because a fixture that used a real array would test a shape this code
 * never sees in production.
 */

/** The real RD Interlock Brick agent's extraction, as qualifyLead receives it. */
const RD_FACTS: Record<string, unknown> = {
  customer_name: "Rajesh",
  brick_quantity: 5000,
  cost_per_brick: 32,
  follow_up: true,
  objections: '["price too high","delivery slow"]',
};

/** A tenant that has actually configured lead_rules rather than leaving `{}`. */
const CONFIGURED_RULES = LeadRules.parse({
  requiredFields: ["customer_name"],
  anyFields: ["brick_quantity", "total_budget"],
  minFilled: 2,
  titleField: "customer_name",
  valueField: "total_budget",
  allowFailedValidation: false,
});

describe("isFilled", () => {
  it("treats a whitespace-only string as nothing having been said", () => {
    expect(isFilled(" ")).toBe(false);
    expect(isFilled("\n\t ")).toBe(false);
  });

  it("treats the literal string \"[]\" as nothing having been said", () => {
    // call_facts stores a string[] field as JSON text, so an empty array arrives
    // as the two-character string "[]" and must not count as an answer.
    expect(isFilled("[]")).toBe(false);
  });

  it("treats an empty array as nothing having been said", () => {
    expect(isFilled([])).toBe(false);
  });

  it("treats null and undefined as nothing having been said", () => {
    expect(isFilled(null)).toBe(false);
    expect(isFilled(undefined)).toBe(false);
  });

  it("treats the number zero as an answer", () => {
    // "how many bricks?" - "none, I only wanted a price" is a real answer, and a
    // quantity of 0 must not silently disqualify the call.
    expect(isFilled(0)).toBe(true);
  });

  it("treats boolean false as an answer", () => {
    // follow_up:false is the model saying the caller did NOT ask to be rung
    // back, which is information, not absence.
    expect(isFilled(false)).toBe(true);
  });

  it("treats a non-empty string, array and object as answers", () => {
    expect(isFilled("Rajesh")).toBe(true);
    expect(isFilled(["price too high"])).toBe(true);
    expect(isFilled({ any: "object" })).toBe(true);
  });
});

describe("parseLeadRules", () => {
  it("returns the documented defaults for the production-default empty object", () => {
    // `{}` is what every real agents.lead_rules row holds today.
    expect(parseLeadRules({})).toStrictEqual({
      requiredFields: [],
      anyFields: [],
      minFilled: 1,
      allowFailedValidation: false,
    });
  });

  it("leaves titleField and valueField absent rather than null when unset", () => {
    // They are `.optional()`, not `.nullable()`. qualifyLead branches on
    // truthiness, so an accidental null would still work - but callers that
    // spread these rules into a JSON payload would start emitting nulls.
    expect("titleField" in DEFAULT_LEAD_RULES).toBe(false);
    expect("valueField" in DEFAULT_LEAD_RULES).toBe(false);
  });

  it("falls back to the defaults for undefined, null and garbage instead of throwing", () => {
    // A malformed agent config must not take the worker's lead stage down; the
    // call still becomes a lead under the standard rule.
    expect(parseLeadRules(undefined)).toStrictEqual(DEFAULT_LEAD_RULES);
    expect(parseLeadRules(null)).toStrictEqual(DEFAULT_LEAD_RULES);
    expect(parseLeadRules("garbage")).toStrictEqual(DEFAULT_LEAD_RULES);
    expect(parseLeadRules({ minFilled: -3 })).toStrictEqual(DEFAULT_LEAD_RULES);
    expect(parseLeadRules({ requiredFields: "customer_name" })).toStrictEqual(DEFAULT_LEAD_RULES);
  });

  it("keeps a valid tenant configuration intact", () => {
    expect(parseLeadRules(JSON.parse(JSON.stringify(CONFIGURED_RULES)))).toStrictEqual(
      CONFIGURED_RULES,
    );
  });
});

describe("parseLeadStages", () => {
  it("falls back to the migration 0010 defaults for null, empty and garbage", () => {
    expect(parseLeadStages(null)).toStrictEqual(DEFAULT_LEAD_STAGES);
    expect(parseLeadStages([])).toStrictEqual(DEFAULT_LEAD_STAGES);
    expect(parseLeadStages("garbage")).toStrictEqual(DEFAULT_LEAD_STAGES);
  });

  it("falls back when a stage key is not a snake_case identifier", () => {
    // The key is used as a column identifier by both the API and the console;
    // one bad key must not render a half-broken board.
    expect(parseLeadStages([{ key: "New Leads", label: "New" }])).toStrictEqual(
      DEFAULT_LEAD_STAGES,
    );
  });

  it("keeps a tenant's renamed columns", () => {
    const renamed = [
      { key: "enquiry", label: "Enquiry" },
      { key: "order_placed", label: "Order Placed", terminal: "won" },
    ];
    expect(parseLeadStages(renamed)).toStrictEqual(renamed);
  });
});

describe("entryStage", () => {
  it("returns the first non-terminal column for the default board", () => {
    expect(entryStage(DEFAULT_LEAD_STAGES)).toBe("new");
  });

  it("returns the tenant's own first open column, not a hardcoded \"new\"", () => {
    const renamed = parseLeadStages([
      { key: "enquiry", label: "Enquiry" },
      { key: "order_placed", label: "Order Placed", terminal: "won" },
    ]);
    expect(entryStage(renamed)).toBe("enquiry");
  });

  it("falls back to the first column when every column is terminal", () => {
    // Pathological but reachable config: without the `?? stages[0]` fallback
    // this would return undefined and write a NULL stage onto the lead.
    const allTerminal: LeadStages = [{ key: "won", label: "Won", terminal: "won" }];
    expect(entryStage(allTerminal)).toBe("won");
  });
});

describe("statusForStage", () => {
  it("maps the default terminal columns onto won and lost", () => {
    expect(statusForStage(DEFAULT_LEAD_STAGES, "won")).toBe("won");
    expect(statusForStage(DEFAULT_LEAD_STAGES, "lost")).toBe("lost");
  });

  it("leaves every non-terminal column open", () => {
    expect(statusForStage(DEFAULT_LEAD_STAGES, "negotiation")).toBe("open");
  });

  it("follows a renamed terminal column rather than the column's name", () => {
    // The whole point of `terminal`: a tenant who renamed Won to "Order Placed"
    // must still have the lead close as won.
    const renamed = parseLeadStages([
      { key: "enquiry", label: "Enquiry" },
      { key: "order_placed", label: "Order Placed", terminal: "won" },
    ]);
    expect(statusForStage(renamed, "order_placed")).toBe("won");
  });

  it("treats an unknown stage key as open rather than throwing", () => {
    expect(statusForStage(DEFAULT_LEAD_STAGES, "no_such_stage")).toBe("open");
  });
});

describe("stageOnBoard", () => {
  const website = parseLeadStages([
    { key: "enquiry", label: "Enquiry" },
    { key: "qualified", label: "Qualified" },
    { key: "won", label: "Won", terminal: "won" },
  ]);

  it("keeps the column when the target board has the same key", () => {
    expect(stageOnBoard(website, "qualified")).toBe("qualified");
    expect(stageOnBoard(website, "won")).toBe("won");
  });

  it("drops into the target's entry column when it has no such key", () => {
    expect(stageOnBoard(website, "negotiation")).toBe("enquiry");
    expect(stageOnBoard(website, null)).toBe("enquiry");
  });
});

describe("qualifyLead under the default rule", () => {
  it("rejects a call whose extraction came back completely empty", () => {
    // The wrong-number / unanswered-call case. This is the single behaviour the
    // default rule exists for: without it every ring-out becomes a board card.
    const verdict = qualifyLead({}, "valid", DEFAULT_LEAD_RULES);
    expect(verdict.qualified).toBe(false);
    expect(verdict.reason).toBe("only 0 field(s) extracted, 1 required");
    expect(verdict.filled).toBe(0);
  });

  it("rejects a call where every extracted fact is an empty string", () => {
    const verdict = qualifyLead(
      { customer_name: "", place: "   ", objections: "[]" },
      "valid",
      DEFAULT_LEAD_RULES,
    );
    expect(verdict.qualified).toBe(false);
    expect(verdict.filled).toBe(0);
  });

  it("qualifies a call that filled exactly one field", () => {
    const verdict = qualifyLead({ customer_name: "Rajesh" }, "valid", DEFAULT_LEAD_RULES);
    expect(verdict.qualified).toBe(true);
    expect(verdict.reason).toBe("qualified");
    expect(verdict.filled).toBe(1);
  });

  it("qualifies on a fact of zero or false alone", () => {
    // Mirrors isFilled: a quantity of 0 and follow_up:false are answers, so a
    // call that produced only those is still a lead.
    expect(qualifyLead({ brick_quantity: 0 }, "valid", DEFAULT_LEAD_RULES).qualified).toBe(true);
    expect(qualifyLead({ follow_up: false }, "valid", DEFAULT_LEAD_RULES).qualified).toBe(true);
  });

  it("applies the default rule when called without any rules argument", () => {
    expect(qualifyLead({ customer_name: "Rajesh" }, "valid").qualified).toBe(true);
    expect(qualifyLead({}, "valid").qualified).toBe(false);
  });

  it("qualifies when validation_status is NULL", () => {
    // NULL is what upsertLead reads for a call with no ai_outputs row at all.
    // Only the literal "failed" blocks; absence must not.
    expect(qualifyLead(RD_FACTS, null, DEFAULT_LEAD_RULES).qualified).toBe(true);
  });

  it("returns no title or value when the rules name no title/value field", () => {
    const verdict = qualifyLead(RD_FACTS, "valid", DEFAULT_LEAD_RULES);
    expect(verdict.title).toBeNull();
    expect(verdict.valueNum).toBeNull();
  });
});

describe("qualifyLead and extraction validation status", () => {
  it("blocks a failed extraction even when every field came back filled", () => {
    const verdict = qualifyLead(RD_FACTS, "failed", DEFAULT_LEAD_RULES);
    expect(verdict.qualified).toBe(false);
    expect(verdict.reason).toBe("extraction failed validation");
  });

  it("qualifies a repaired extraction - only \"failed\" blocks", () => {
    // ai_outputs.validation_status is valid|repaired|failed (0001). "repaired"
    // means the second LLM attempt validated cleanly, so it is trustworthy.
    expect(qualifyLead(RD_FACTS, "repaired", DEFAULT_LEAD_RULES).qualified).toBe(true);
  });

  it("lets a tenant opt back into failed extractions with allowFailedValidation", () => {
    const permissive = LeadRules.parse({ allowFailedValidation: true });
    const verdict = qualifyLead(RD_FACTS, "failed", permissive);
    expect(verdict.qualified).toBe(true);
  });

  it("still enforces the field rules when allowFailedValidation is on", () => {
    // allowFailedValidation only waives the validation gate; an empty
    // extraction must not become a lead just because the tenant is permissive.
    const permissive = LeadRules.parse({ allowFailedValidation: true });
    expect(qualifyLead({}, "failed", permissive).qualified).toBe(false);
  });
});

describe("qualifyLead with requiredFields", () => {
  it("rejects the call when a required field was not extracted", () => {
    const rules = LeadRules.parse({ requiredFields: ["customer_name", "place"] });
    const verdict = qualifyLead(RD_FACTS, "valid", rules);
    expect(verdict.qualified).toBe(false);
    expect(verdict.reason).toBe("missing required field(s): place");
  });

  it("names every missing field, not just the first", () => {
    const rules = LeadRules.parse({ requiredFields: ["place", "quotation_date"] });
    expect(qualifyLead(RD_FACTS, "valid", rules).reason).toBe(
      "missing required field(s): place, quotation_date",
    );
  });

  it("rejects the call when a required field is present but empty", () => {
    const rules = LeadRules.parse({ requiredFields: ["customer_name"] });
    const verdict = qualifyLead({ ...RD_FACTS, customer_name: "   " }, "valid", rules);
    expect(verdict.qualified).toBe(false);
    expect(verdict.reason).toBe("missing required field(s): customer_name");
  });

  it("fails closed on a required field name that no agent schema defines", () => {
    // A typo in the agent config (or a field renamed out from under the rules)
    // means the key is never in `facts`, so nothing can ever satisfy it. Failing
    // closed is right - silently ignoring an unknown key would turn a stricter
    // board into a looser one without telling anybody.
    const rules = LeadRules.parse({ requiredFields: ["custmer_name"] });
    const verdict = qualifyLead(RD_FACTS, "valid", rules);
    expect(verdict.qualified).toBe(false);
    expect(verdict.reason).toBe("missing required field(s): custmer_name");
  });
});

describe("qualifyLead with anyFields", () => {
  it("qualifies when at least one of the alternatives was filled", () => {
    // total_budget was never mentioned on this call; brick_quantity was.
    const rules = LeadRules.parse({ anyFields: ["brick_quantity", "total_budget"] });
    expect(qualifyLead(RD_FACTS, "valid", rules).qualified).toBe(true);
  });

  it("rejects when none of the alternatives was filled", () => {
    const rules = LeadRules.parse({ anyFields: ["total_budget", "quotation_date"] });
    const verdict = qualifyLead(RD_FACTS, "valid", rules);
    expect(verdict.qualified).toBe(false);
    expect(verdict.reason).toBe(
      "none of the qualifying fields were filled: total_budget, quotation_date",
    );
  });

  it("imposes no constraint when anyFields is empty", () => {
    const rules = LeadRules.parse({ anyFields: [] });
    expect(qualifyLead({ customer_name: "Rajesh" }, "valid", rules).qualified).toBe(true);
  });
});

describe("qualifyLead with minFilled", () => {
  it("counts every filled fact, whichever fields they are", () => {
    const rules = LeadRules.parse({ minFilled: 5 });
    const verdict = qualifyLead(RD_FACTS, "valid", rules);
    expect(verdict.filled).toBe(5);
    expect(verdict.qualified).toBe(true);
  });

  it("rejects one short of the floor and reports the exact counts", () => {
    const rules = LeadRules.parse({ minFilled: 6 });
    const verdict = qualifyLead(RD_FACTS, "valid", rules);
    expect(verdict.qualified).toBe(false);
    expect(verdict.reason).toBe("only 5 field(s) extracted, 6 required");
  });

  it("does not count empty facts towards the floor", () => {
    const rules = LeadRules.parse({ minFilled: 2 });
    const verdict = qualifyLead(
      { customer_name: "Rajesh", place: "", objections: "[]" },
      "valid",
      rules,
    );
    expect(verdict.filled).toBe(1);
    expect(verdict.qualified).toBe(false);
  });

  it("qualifies an empty extraction when a tenant sets minFilled to 0", () => {
    // Legal per the schema (min 0) and worth pinning: it disables the only
    // default protection against wrong numbers becoming leads.
    const rules = LeadRules.parse({ minFilled: 0 });
    expect(qualifyLead({}, "valid", rules).qualified).toBe(true);
  });
});

describe("qualifyLead card title and deal value", () => {
  it("takes the title from the named field and trims it", () => {
    const rules = LeadRules.parse({ titleField: "customer_name" });
    expect(qualifyLead({ customer_name: "  Rajesh  " }, "valid", rules).title).toBe("Rajesh");
  });

  it("takes the title and the value from the fields a real tenant configured", () => {
    const verdict = qualifyLead(RD_FACTS, "valid", CONFIGURED_RULES);
    expect(verdict.title).toBe("Rajesh");
    // total_budget is the configured valueField and this call never mentioned it.
    expect(verdict.valueNum).toBeNull();
  });

  it("returns a null title when the named title field was not extracted", () => {
    // The card then falls back to the number's digits (worker leadTitle), so a
    // null here is load-bearing rather than cosmetic - an empty string would
    // win that `||` chain and render a blank heading.
    const rules = LeadRules.parse({ titleField: "customer_name" });
    const verdict = qualifyLead({ brick_quantity: 5000 }, "valid", rules);
    expect(verdict.qualified).toBe(true);
    expect(verdict.title).toBeNull();
    // Present but blank must behave the same as absent.
    expect(qualifyLead({ customer_name: "   " }, "valid", rules).title).toBeNull();
  });

  it("reads a numeric deal value from the named field", () => {
    const rules = LeadRules.parse({ valueField: "total_budget" });
    expect(qualifyLead({ total_budget: 160000 }, "valid", rules).valueNum).toBe(160000);
  });

  it("reads a deal value that arrived as a numeric string", () => {
    // value_text is TEXT, so a number the analyze stage failed to type still
    // arrives as a string; Number() recovers it rather than dropping the value.
    const rules = LeadRules.parse({ valueField: "total_budget" });
    expect(qualifyLead({ total_budget: "160000" }, "valid", rules).valueNum).toBe(160000);
  });

  it("returns a null deal value - never NaN - when the named field is not numeric", () => {
    // Without the Number.isFinite guard this would be NaN, which serialises to
    // null in JSON but breaks any arithmetic on the board's pipeline total.
    const rules = LeadRules.parse({ valueField: "customer_name" });
    const verdict = qualifyLead(RD_FACTS, "valid", rules);
    expect(verdict.valueNum).toBeNull();
    expect(Number.isNaN(verdict.valueNum as number)).toBe(false);
  });

  it("returns a null deal value when the named field was not extracted", () => {
    const rules = LeadRules.parse({ valueField: "total_budget" });
    expect(qualifyLead({ customer_name: "Rajesh" }, "valid", rules).valueNum).toBeNull();
  });

  it("still reports title and value on a call it rejected", () => {
    // The worker logs the verdict; the title is what makes a skipped call
    // identifiable to a tenant asking why it never reached their board.
    // 64 is the schema's ceiling on minFilled, so this is the strictest legal
    // rule - no real call can satisfy it.
    const rules = LeadRules.parse({ titleField: "customer_name", minFilled: 64 });
    const verdict = qualifyLead(RD_FACTS, "valid", rules);
    expect(verdict.qualified).toBe(false);
    expect(verdict.title).toBe("Rajesh");
  });
});

describe("mergeFacts", () => {
  it("keeps facts the earlier call established and adds the new ones", () => {
    expect(mergeFacts({ total_budget: 50000 }, { brick_quantity: 200 })).toStrictEqual({
      total_budget: 50000,
      brick_quantity: 200,
    });
  });

  it("does not blank an established fact the follow-up call did not mention", () => {
    // The bug migration 0010 exists to prevent: a follow-up about delivery dates
    // returns null for budget, and a naive merge would erase the deal value.
    expect(mergeFacts({ total_budget: 50000 }, { total_budget: null })).toStrictEqual({
      total_budget: 50000,
    });
    expect(mergeFacts({ total_budget: 50000 }, { total_budget: "" })).toStrictEqual({
      total_budget: 50000,
    });
    expect(mergeFacts({ objections: '["price too high"]' }, { objections: "[]" })).toStrictEqual({
      objections: '["price too high"]',
    });
  });

  it("overwrites with a new value of zero or false, which are real answers", () => {
    expect(mergeFacts({ brick_quantity: 5000 }, { brick_quantity: 0 })).toStrictEqual({
      brick_quantity: 0,
    });
    expect(mergeFacts({ follow_up: true }, { follow_up: false })).toStrictEqual({
      follow_up: false,
    });
  });

  it("does not mutate the existing facts it was given", () => {
    const existing = { total_budget: 50000 };
    mergeFacts(existing, { total_budget: 90000 });
    expect(existing).toStrictEqual({ total_budget: 50000 });
  });
});

describe("deriveLeadTemperature", () => {
  const call = (o: Partial<LeadTemperatureSignals> = {}): LeadTemperatureSignals => ({
    outcome: null,
    sentiment: null,
    valueNum: null,
    ...o,
  });

  it("rates an explicitly interested customer hot", () => {
    expect(deriveLeadTemperature(call({ outcome: "interested" }))).toBe("hot");
  });

  it("rates a named figure hot, whatever the model made of the tone", () => {
    expect(deriveLeadTemperature(call({ outcome: "other", valueNum: 240000 }))).toBe("hot");
  });

  it("does not read a zero as a figure", () => {
    expect(deriveLeadTemperature(call({ outcome: "callback", valueNum: 0 }))).toBe("medium");
  });

  it("rates a positive follow-up hot, and a neutral one medium", () => {
    expect(deriveLeadTemperature(call({ outcome: "follow_up", sentiment: "positive" }))).toBe("hot");
    expect(deriveLeadTemperature(call({ outcome: "follow_up", sentiment: "neutral" }))).toBe("medium");
  });

  it.each(["not_interested", "wrong_number", "no_answer"])("rates %s cold", (outcome) => {
    expect(deriveLeadTemperature(call({ outcome }))).toBe("cold");
  });

  it("rates a POLITE refusal cold - the outcome outranks the tone", () => {
    // Production has this exact row: not_interested + positive. Reading the
    // sentiment first would file it as Hot and send someone back to a person
    // who already said no.
    expect(deriveLeadTemperature(call({ outcome: "not_interested", sentiment: "positive" }))).toBe(
      "cold",
    );
    expect(deriveLeadTemperature(call({ outcome: "no_answer", sentiment: "positive" }))).toBe("cold");
  });

  it("rates a negative call cold even on an otherwise engaged outcome", () => {
    expect(deriveLeadTemperature(call({ outcome: "callback", sentiment: "negative" }))).toBe("cold");
  });

  it("still rates a figure hot on a cold-sounding outcome? no - the refusal wins", () => {
    expect(deriveLeadTemperature(call({ outcome: "not_interested", valueNum: 500000 }))).toBe("cold");
  });

  it("returns null when the call said nothing either way", () => {
    expect(deriveLeadTemperature(call())).toBeNull();
    expect(deriveLeadTemperature(call({ outcome: "  ", sentiment: "" }))).toBeNull();
  });

  it("ignores case and padding from the model", () => {
    expect(deriveLeadTemperature(call({ outcome: " Not_Interested " }))).toBe("cold");
  });

  it("falls back to medium for an outcome this build has never seen", () => {
    expect(deriveLeadTemperature(call({ outcome: "escalated", sentiment: "neutral" }))).toBe("medium");
  });

  it("labels and orders every rating it can produce", () => {
    for (const t of LEAD_TEMPERATURE_ORDER) expect(LEAD_TEMPERATURE_LABELS[t]).toBeTruthy();
    expect(LEAD_TEMPERATURE_ORDER).toEqual(LeadTemperature.options);
  });
});

describe("stageAfter", () => {
  it("returns the next open column", () => {
    expect(stageAfter(DEFAULT_LEAD_STAGES, "new")).toBe("contacted");
    expect(stageAfter(DEFAULT_LEAD_STAGES, "qualified")).toBe("negotiation");
  });

  it("never advances into a terminal column - nothing automatic decides won or lost", () => {
    expect(stageAfter(DEFAULT_LEAD_STAGES, "negotiation")).toBeNull();
    expect(stageAfter([{ key: "new", label: "New" }, { key: "won", label: "Won", terminal: "won" }], "new")).toBeNull();
  });

  it("returns null for a stage the board does not have", () => {
    expect(stageAfter(DEFAULT_LEAD_STAGES, "nonexistent")).toBeNull();
  });

  it("returns null at the end of the board", () => {
    expect(stageAfter(DEFAULT_LEAD_STAGES, "lost")).toBeNull();
  });
});
