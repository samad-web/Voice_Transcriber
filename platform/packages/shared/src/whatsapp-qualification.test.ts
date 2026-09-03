import { describe, expect, it } from "vitest";

import {
  buildQualificationTranscript,
  heuristicQualify,
  parseStatedBudget,
  QUALIFICATION_TRANSCRIPT_LIMIT,
  QualificationVerdict,
  scoreBand,
  type QualifiableMessage,
} from "./whatsapp-qualification";

const msg = (
  direction: "incoming" | "outgoing",
  body: string | null,
): QualifiableMessage => ({ direction, body, occurredAt: null });

describe("parseStatedBudget", () => {
  /**
   * The regression 0078 shipped: `Number("")` is 0, so a budget field reading
   * "lots" became a ZERO-VALUE deal that counted as a real figure in every
   * revenue report. Null and zero are opposite claims and only null is ever
   * true here, so each of these is pinned rather than left to the parser.
   */
  it("returns null - never 0 - for anything that is not a stated number", () => {
    for (const junk of ["", "   ", "lots", "n/a", "-", "call me", "?", "budget"]) {
      expect([junk, parseStatedBudget(junk)]).toEqual([junk, null]);
    }
    expect(parseStatedBudget(null)).toBeNull();
    expect(parseStatedBudget(undefined)).toBeNull();
    expect(parseStatedBudget({})).toBeNull();
  });

  it("refuses a zero or negative number from the model", () => {
    expect(parseStatedBudget(0)).toBeNull();
    expect(parseStatedBudget(-5)).toBeNull();
    expect(parseStatedBudget("0")).toBeNull();
  });

  it("reads the Indian shorthand these threads actually use", () => {
    expect(parseStatedBudget("2L")).toBe(200_000);
    expect(parseStatedBudget("1.5 lakh")).toBe(150_000);
    expect(parseStatedBudget("3cr")).toBe(30_000_000);
    expect(parseStatedBudget("50k")).toBe(50_000);
    expect(parseStatedBudget("₹40,000")).toBe(40_000);
    expect(parseStatedBudget(250000)).toBe(250_000);
  });
});

describe("scoreBand", () => {
  /**
   * Disposition outranks score. A 90-confidence "wrong number" is a very
   * confident piece of junk, and a queue that shows it as hot because the
   * number is high loses its reader in one screen.
   */
  it("bands a confident non-prospect as junk regardless of score", () => {
    expect(scoreBand(95, "wrong_number")).toBe("junk");
    expect(scoreBand(95, "spam")).toBe("junk");
    expect(scoreBand(95, "vendor")).toBe("junk");
    expect(scoreBand(88, "existing_customer")).toBe("junk");
    expect(scoreBand(88, "unclear")).toBe("junk");
  });

  it("bands a prospect by score", () => {
    expect(scoreBand(70, "prospect")).toBe("hot");
    expect(scoreBand(69, "prospect")).toBe("warm");
    expect(scoreBand(40, "prospect")).toBe("warm");
    expect(scoreBand(39, "prospect")).toBe("cold");
    expect(scoreBand(0, "prospect")).toBe("cold");
  });
});

describe("buildQualificationTranscript", () => {
  it("labels speakers by role, not by the database's direction words", () => {
    const text = buildQualificationTranscript([
      msg("incoming", "what is the price"),
      msg("outgoing", "sending you the list"),
    ]);
    expect(text).toBe("Customer: what is the price\nBusiness: sending you the list");
  });

  it("skips empty and null bodies rather than emitting blank speaker lines", () => {
    const text = buildQualificationTranscript([
      msg("incoming", null),
      msg("incoming", "   "),
      msg("incoming", "hello"),
    ]);
    expect(text).toBe("Customer: hello");
  });

  /**
   * The load-bearing property: qualification asks "is there a live enquiry
   * here", which the RECENT end answers. A truncation that dropped the newest
   * message would cut off the one sentence stating the enquiry and score a
   * real lead as junk.
   */
  it("keeps the NEWEST messages when the thread exceeds the budget", () => {
    const old = Array.from({ length: 400 }, (_, i) => msg("incoming", `old message ${i}`));
    const text = buildQualificationTranscript([...old, msg("incoming", "MY BUDGET IS 5L")]);

    expect(text.length).toBeLessThanOrEqual(QUALIFICATION_TRANSCRIPT_LIMIT);
    expect(text).toContain("MY BUDGET IS 5L");
    expect(text.endsWith("Customer: MY BUDGET IS 5L")).toBe(true);
    // and it really did drop the far end
    expect(text).not.toContain("old message 0");
  });

  it("preserves chronological order in what it does keep", () => {
    const text = buildQualificationTranscript([
      msg("incoming", "first"),
      msg("incoming", "second"),
      msg("incoming", "third"),
    ]);
    expect(text).toBe("Customer: first\nCustomer: second\nCustomer: third");
  });
});

describe("heuristicQualify", () => {
  it("returns a verdict that satisfies the persisted schema", () => {
    const v = heuristicQualify([msg("incoming", "what is the price of the 2bhk")]);
    expect(() => QualificationVerdict.parse(v)).not.toThrow();
  });

  it("calls a stated wrong number exactly that, and scores it zero", () => {
    const v = heuristicQualify([msg("incoming", "sorry wrong number")]);
    expect(v.disposition).toBe("wrong_number");
    expect(v.score).toBe(0);
  });

  it("does not classify a bare greeting as a prospect", () => {
    const v = heuristicQualify([msg("incoming", "hi")]);
    expect(v.disposition).toBe("unclear");
    expect(v.score).toBeLessThan(15);
  });

  it("reads only INBOUND text - the business's own pitch is not evidence", () => {
    // Outbound carries every buying keyword there is. If the heuristic scored
    // it, every thread the business ever messaged first would look like a hot
    // lead, which is the most expensive way to be wrong here.
    const v = heuristicQualify([
      msg("outgoing", "our price list, availability, quote and demo booking are attached"),
      msg("incoming", "ok"),
    ]);
    expect(v.disposition).not.toBe("prospect");
  });

  it("never exceeds the confidence its evidence supports", () => {
    const v = heuristicQualify([
      msg("incoming", "price? cost? quote? rate? availability? interested! demo? brochure?"),
    ]);
    // Keyword matching is a hint that a human should look, never a judgment
    // strong enough to outrank a verdict a model actually reasoned about.
    expect(v.score).toBeLessThanOrEqual(55);
    expect(scoreBand(v.score, v.disposition)).not.toBe("hot");
  });

  it("returns unclear, not prospect, for a thread with no inbound body at all", () => {
    const v = heuristicQualify([msg("outgoing", "hello?"), msg("incoming", null)]);
    expect(v.disposition).toBe("unclear");
    expect(v.score).toBe(0);
  });
});
