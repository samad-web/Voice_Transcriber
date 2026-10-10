import { describe, expect, it } from "vitest";

import {
  AMOUNT_RESOLVER_VERSION,
  type AmountContext,
  type AmountResolution,
  amountMinorOf,
  isAmountActionable,
  normaliseAmountPhrase,
  resolveAmountPhrase,
} from "./amount-phrases";

/** ₹1,00,000 as the lead's one known total, so "aadha" has something to halve. */
const WITH_TOTAL: AmountContext = { totalsMinor: [100_000_00] };
const NO_TOTAL: AmountContext = { totalsMinor: [] };

function rupees(r: AmountResolution): number | null {
  const minor = amountMinorOf(r);
  return minor === null ? null : minor / 100;
}

type Case = [string, number | "needs_total" | "unresolved"];

/** Absolute amounts - no total required. */
const ABSOLUTE: Case[] = [
  ["50000", 50_000],
  ["₹50000", 50_000],
  ["rs 50000", 50_000],
  ["50,000", 50_000],
  ["1,25,000", 125_000],
  ["125,000", 125_000],
  ["rupees 2500", 2_500],
  ["15k", 15_000],
  ["15 k", 15_000],
  ["50k", 50_000],
  ["50 thousand", 50_000],
  ["fifty thousand", 50_000],
  ["pachaas hazaar", 50_000],
  ["pachas hazaar", 50_000],
  ["pachaas hazar", 50_000],
  ["das hazaar", 10_000],
  ["ek lakh", 100_000],
  ["1 lakh", 100_000],
  ["one lakh", 100_000],
  ["do lakh", 200_000],
  ["2 lakh", 200_000],
  ["1.5 lakh", 150_000],
  ["dedh lakh", 150_000],
  ["dhai lakh", 250_000],
  ["sava lakh", 125_000],
  ["aadha lakh", 50_000],
  ["ek crore", 10_000_000],
  ["1 cr", 10_000_000],
  ["do crore", 20_000_000],
  ["paanch sau", 500],
  ["5 sau", 500],
  ["teen hazaar", 3_000],
  ["pandrah hazaar", 15_000],
  ["bees hazaar", 20_000],
  ["pachchees hazaar", 25_000],
  ["twentyfive thousand", 25_000],
  ["₹2,499.50", 2_499.5],
  ["2499.50 rupees", 2_499.5],
  ["लाख", "unresolved"],
  ["दो लाख", 200_000],
  ["पचास हजार", 50_000],
  ["५०००० rupees", 50_000],
];

/** Relative amounts - these need a total, and must refuse without one. */
const RELATIVE: Case[] = [
  ["aadha", 50_000],
  ["adha", 50_000],
  ["aadhi", 50_000],
  ["half", 50_000],
  ["half of it", 50_000],
  ["aadha de dunga", 50_000],
  ["quarter", 25_000],
  ["chauthai", 25_000],
  ["three quarters", 75_000],
  ["teen chauthai", 75_000],
  ["one third", 100_000 / 3],
  ["two thirds", (100_000 * 2) / 3],
  ["pura", 100_000],
  ["poora amount", 100_000],
  ["full payment", 100_000],
  ["the whole thing", 100_000],
  ["20 percent", 20_000],
  ["20%", 20_000],
  ["50 percent", 50_000],
  ["10 per cent", 10_000],
  ["25 pratishat", 25_000],
  ["आधा", 50_000],
  ["पूरा", 100_000],
];

/** Phrases that are not amounts, and must not become one. */
const NOT_AMOUNTS: Case[] = [
  ["", "unresolved"],
  ["   ", "unresolved"],
  ["some money", "unresolved"],
  ["kuch paise", "unresolved"],
  ["later", "unresolved"],
  ["as discussed", "unresolved"],
  // A bare small number is a time, a quantity, a door number - anything.
  ["5", "unresolved"],
  ["at 5", "unresolved"],
  ["5 baje", "unresolved"],
  ["two", "unresolved"],
  ["do", "unresolved"],
];

describe("resolveAmountPhrase - absolute amounts", () => {
  for (const [phrase, expected] of ABSOLUTE) {
    it(`reads ${JSON.stringify(phrase)}`, () => {
      const result = resolveAmountPhrase(phrase, NO_TOTAL);
      if (expected === "unresolved") {
        expect(result.kind).toBe("unresolved");
        return;
      }
      if (expected === "needs_total") {
        expect(result.kind).toBe("needs_total");
        return;
      }
      expect(result.kind).toBe("exact");
      expect(rupees(result)).toBeCloseTo(expected, 2);
    });
  }
});

describe("resolveAmountPhrase - shares of a known total", () => {
  for (const [phrase, expected] of RELATIVE) {
    it(`reads ${JSON.stringify(phrase)} against a ₹1,00,000 total`, () => {
      const result = resolveAmountPhrase(phrase, WITH_TOTAL);
      expect(isAmountActionable(result)).toBe(true);
      expect(rupees(result)).toBeCloseTo(expected as number, 2);
    });

    it(`refuses ${JSON.stringify(phrase)} with no total to take it of`, () => {
      const result = resolveAmountPhrase(phrase, NO_TOTAL);
      expect(result.kind).toBe("needs_total");
      expect(isAmountActionable(result)).toBe(false);
      // The whole point: there is no amount on the object to read by mistake.
      expect(amountMinorOf(result)).toBeNull();
    });
  }
});

describe("resolveAmountPhrase - things that are not amounts", () => {
  for (const [phrase] of NOT_AMOUNTS) {
    it(`refuses ${JSON.stringify(phrase)}`, () => {
      const result = resolveAmountPhrase(phrase, WITH_TOTAL);
      expect(result.kind).toBe("unresolved");
      expect(amountMinorOf(result)).toBeNull();
    });
  }
});

describe("a fraction of a magnitude is absolute, not relative (§7.2)", () => {
  it('reads "aadha lakh" as ₹50,000 and not as half the deal', () => {
    // The lead's total is ₹1,00,000, so "half the deal" would also be ₹50,000.
    // Use a different total so the two readings differ.
    const result = resolveAmountPhrase("aadha lakh", { totalsMinor: [900_000_00] });
    expect(result.kind).toBe("exact");
    expect(rupees(result)).toBe(50_000);
  });

  it('reads a bare "aadha" as half the total', () => {
    const result = resolveAmountPhrase("aadha", { totalsMinor: [900_000_00] });
    expect(result.kind).toBe("fraction");
    expect(rupees(result)).toBe(450_000);
  });

  it('needs no total for "dedh lakh"', () => {
    const result = resolveAmountPhrase("dedh lakh", NO_TOTAL);
    expect(result.kind).toBe("exact");
    expect(rupees(result)).toBe(150_000);
  });
});

describe("the total that is used is the FIRST the caller supplied", () => {
  it("takes the outstanding balance over the deal value", () => {
    // Ordering is the caller's decision, and it matters: "aadha" said on a
    // call about an overdue invoice means half the balance.
    const result = resolveAmountPhrase("aadha", { totalsMinor: [20_000_00, 500_000_00] });
    expect(rupees(result)).toBe(10_000);
  });

  it("skips a zero or negative total rather than resolving to nothing", () => {
    const result = resolveAmountPhrase("half", { totalsMinor: [0, -5, 40_000_00] });
    expect(rupees(result)).toBe(20_000);
  });

  it("refuses when every supplied total is unusable", () => {
    expect(resolveAmountPhrase("half", { totalsMinor: [0, -1] }).kind).toBe("needs_total");
  });
});

describe("minor-unit arithmetic (§4.1 of the decisions)", () => {
  it("halves an odd paise figure without a floating-point tail", () => {
    const result = resolveAmountPhrase("aadha", { totalsMinor: [2_499_99] });
    expect(amountMinorOf(result)).toBe(125_000); // ₹1,250.00 exactly
  });

  it("keeps a fraction's amount an integer number of paise", () => {
    const result = resolveAmountPhrase("one third", { totalsMinor: [100_00] });
    expect(Number.isInteger(amountMinorOf(result))).toBe(true);
  });

  it("refuses an amount beyond the safe integer range rather than wrapping", () => {
    const result = resolveAmountPhrase("99999999999 crore", NO_TOTAL);
    expect(result.kind).toBe("unresolved");
    if (result.kind !== "unresolved") throw new Error("unreachable");
    expect(result.reason).toMatch(/out of range/);
  });
});

describe("normaliseAmountPhrase", () => {
  it("strips Indian digit grouping without touching the decimal point", () => {
    expect(normaliseAmountPhrase("1,25,000.50")).toBe("125000.50");
  });

  it("maps the rupee symbol and its spellings to one word", () => {
    expect(normaliseAmountPhrase("₹500")).toBe("rupees 500");
    expect(normaliseAmountPhrase("Rs. 500")).toBe("rupees 500");
    expect(normaliseAmountPhrase("500 रुपये")).toBe("500 rupees");
  });

  it("maps Devanagari numerals and magnitude words", () => {
    expect(normaliseAmountPhrase("२ लाख")).toBe("2 lakh");
    expect(normaliseAmountPhrase("आधा")).toBe("aadha");
  });

  it("keeps the percent sign", () => {
    expect(normaliseAmountPhrase("20%")).toBe("20%");
  });
});

describe("version", () => {
  it("is recorded on every decision", () => {
    expect(AMOUNT_RESOLVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
