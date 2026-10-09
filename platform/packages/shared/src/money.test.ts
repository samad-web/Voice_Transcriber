import { describe, expect, it } from "vitest";

import {
  MAX_MINOR,
  MoneyRangeError,
  apportion,
  currencyExponent,
  formatMoney,
  formatMoneyCompact,
  groupIndian,
  percentOf,
  percentage,
  ratio,
  splitEvenly,
  sumMinor,
  toMajor,
  toMinor,
  toNumericString,
} from "./money";

/**
 * The cases here are the ones a float gets wrong. Each `it` is a specific way
 * money goes missing, not a demonstration that addition works.
 */

describe("toMinor", () => {
  it("parses the strings node-postgres actually returns", () => {
    expect(toMinor("1999.99")).toBe(199999);
    expect(toMinor("0.01")).toBe(1);
    expect(toMinor("1000")).toBe(100000);
    expect(toMinor("-0.50")).toBe(-50);
    expect(toMinor("0.00")).toBe(0);
  });

  it("does not go through a fractional double", () => {
    // 1999.99 * 100 is 199998.99999999997 in IEEE-754. Math.round rescues
    // this one; the string path means there is no case left that needs luck.
    expect(toMinor("1999.99")).toBe(199999);
    expect(toMinor("8.165")).toBe(816); // truncated, not 817 - see below
    expect(toMinor("70.675")).toBe(7067);
  });

  it("truncates sub-paise instead of inventing money", () => {
    // These arrive from a numeric column with more scale than INR has. A
    // tenth of a paise rounded UP is money no instrument can move.
    expect(toMinor("12.3456")).toBe(1234);
    expect(toMinor("-12.3456")).toBe(-1234);
  });

  it("treats absent and empty as zero, and a blank column as collected nothing", () => {
    expect(toMinor(null)).toBe(0);
    expect(toMinor(undefined)).toBe(0);
    expect(toMinor("")).toBe(0);
  });

  it("accepts the exponent notation numeric output is allowed to use", () => {
    expect(toMinor("1e3")).toBe(100000);
    expect(toMinor("1.5e2")).toBe(15000);
    expect(toMinor("1e-2")).toBe(1);
  });

  it("refuses something that is not an amount rather than returning NaN", () => {
    expect(() => toMinor("abc")).toThrow(MoneyRangeError);
    expect(() => toMinor("1,000")).toThrow(MoneyRangeError);
    expect(() => toMinor(".")).toThrow(MoneyRangeError);
    expect(() => toMinor(Number.NaN)).toThrow(MoneyRangeError);
    expect(() => toMinor(Number.POSITIVE_INFINITY)).toThrow(MoneyRangeError);
  });

  it("refuses an amount past the exact range instead of losing a digit", () => {
    expect(() => toMinor(String(MAX_MINOR))).toThrow(MoneyRangeError);
  });

  it("scales by the currency's own exponent, not by 100", () => {
    expect(currencyExponent("JPY")).toBe(0);
    expect(toMinor("1000", "JPY")).toBe(1000);
    expect(toMinor("1.234", "KWD")).toBe(1234);
    // Unrecognised currency falls back to 2 rather than throwing: a quotation
    // in a currency nobody catalogued is still a quotation.
    expect(toMinor("1.00", "XYZ")).toBe(100);
  });
});

describe("toNumericString", () => {
  it("round-trips every value toMinor produced", () => {
    for (const text of ["0.00", "0.01", "1999.99", "-0.50", "123456.78"]) {
      expect(toNumericString(toMinor(text))).toBe(text.replace(/^(-?)(\.)/, "$10$2"));
    }
  });

  it("is a string, so what reaches the query is what was computed", () => {
    expect(toNumericString(199999)).toBe("1999.99");
    expect(typeof toNumericString(1)).toBe("string");
    expect(toNumericString(-1)).toBe("-0.01");
    expect(toNumericString(1000, "JPY")).toBe("1000");
  });

  it("gives a major-unit number only at the API edge", () => {
    expect(toMajor(199999)).toBe(1999.99);
    expect(toMajor(0)).toBe(0);
  });
});

describe("sumMinor", () => {
  it("adds the case that breaks a float", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in doubles. In paise it is 30.
    expect(sumMinor([toMinor("0.1"), toMinor("0.2")])).toBe(30);
    expect(toNumericString(sumMinor([toMinor("0.1"), toMinor("0.2")]))).toBe("0.30");
  });

  it("is exact over a hundred 18% tax lines", () => {
    const line = percentOf(toMinor("1999.99"), 18);
    const hundred = sumMinor(Array.from({ length: 100 }, () => line));
    expect(hundred).toBe(line * 100);
    expect(toNumericString(hundred)).toBe("36000.00");
  });

  it("refuses to overflow the exact range quietly", () => {
    expect(() => sumMinor([MAX_MINOR, MAX_MINOR])).toThrow(MoneyRangeError);
  });
});

describe("percentOf", () => {
  it("rounds half-up, the way every Indian invoice does", () => {
    expect(percentOf(100, 50)).toBe(50);
    expect(percentOf(101, 50)).toBe(51); // 50.5 -> 51, not banker's 50
    expect(percentOf(199999, 18)).toBe(36000);
  });

  it("rounds a negative away from zero, so a reversal is the exact mirror", () => {
    // A clawback of 18% of -1999.99 must cancel the earn of 18% of 1999.99.
    expect(percentOf(-199999, 18)).toBe(-36000);
    expect(percentOf(-101, 50)).toBe(-51);
    expect(percentOf(199999, 18) + percentOf(-199999, 18)).toBe(0);
  });
});

describe("splitEvenly", () => {
  it("makes the instalments add up to the deal", () => {
    const three = splitEvenly(toMinor("100.00"), 3);
    expect(three).toEqual([3334, 3333, 3333]);
    expect(sumMinor(three)).toBe(toMinor("100.00"));
  });

  it("puts the spare paise first, so the last instalment is never the odd one", () => {
    expect(splitEvenly(10, 4)).toEqual([3, 3, 2, 2]);
    expect(splitEvenly(toMinor("1000.00"), 7).at(-1)).toBe(14285);
  });

  it("mirrors for a credit note", () => {
    const negative = splitEvenly(toMinor("-100.00"), 3);
    expect(sumMinor(negative)).toBe(toMinor("-100.00"));
    expect(negative).toEqual([-3334, -3333, -3333]);
  });

  it("refuses a nonsense part count", () => {
    expect(() => splitEvenly(100, 0)).toThrow(MoneyRangeError);
    expect(() => splitEvenly(100, 1.5)).toThrow(MoneyRangeError);
  });
});

describe("apportion", () => {
  it("attributes a cost without inventing or losing a paisa", () => {
    const shares = apportion(toMinor("1000.00"), [1, 1, 1]);
    expect(sumMinor(shares)).toBe(toMinor("1000.00"));
  });

  it("gives the leftover to the weights cut hardest, not to the first one", () => {
    // 10 paise over weights 1/2/3: exact shares 1.67/3.33/5.00. The two with
    // fractions take the spare units.
    expect(apportion(10, [1, 2, 3])).toEqual([2, 3, 5]);
    expect(sumMinor(apportion(10, [1, 2, 3]))).toBe(10);
  });

  it("falls back to an even split when there is no driver to attribute by", () => {
    // A cost with no measured driver is a real situation; dropping the money
    // would make the column stop reconciling with the ledger.
    expect(apportion(100, [0, 0])).toEqual([50, 50]);
    expect(apportion(0, [5, 5])).toEqual([0, 0]);
    expect(apportion(100, [])).toEqual([]);
  });

  it("refuses a negative weight", () => {
    expect(() => apportion(100, [1, -1])).toThrow(MoneyRangeError);
  });
});

describe("formatMoney", () => {
  it("groups the Indian way for rupees", () => {
    expect(groupIndian("1234567")).toBe("12,34,567");
    expect(formatMoney(toMinor("1234567.00"))).toBe("₹12,34,567.00");
    expect(formatMoney(toMinor("999.00"))).toBe("₹999.00");
  });

  it("groups the western way for a western currency", () => {
    expect(formatMoney(toMinor("1234567.00"), { currency: "USD" })).toBe("$1,234,567.00");
  });

  it("makes a negative unmistakable", () => {
    expect(formatMoney(-50000)).toBe("-₹500.00");
    expect(formatMoney(-50000, { negative: "parentheses" })).toBe("(₹500.00)");
  });

  it("drops the paise when a tile has no room", () => {
    expect(formatMoney(toMinor("1234.56"), { whole: true })).toBe("₹1,235");
    expect(formatMoney(toMinor("1234.56"), { symbol: false })).toBe("1,234.56");
  });

  it("reads in lakhs and crores, because that is how the readers talk", () => {
    expect(formatMoneyCompact(toMinor("12345678.00"))).toBe("₹1.2 Cr");
    expect(formatMoneyCompact(toMinor("234567.00"))).toBe("₹2.3 L");
    expect(formatMoneyCompact(toMinor("5500.00"))).toBe("₹5.5 K");
    expect(formatMoneyCompact(toMinor("-234567.00"))).toBe("-₹2.3 L");
    expect(formatMoneyCompact(toMinor("999.00"))).toBe("₹999");
  });
});

describe("ratio / percentage", () => {
  it("is null with nothing to divide by, so a quiet month is not 0% collected", () => {
    expect(ratio(0, 0)).toBeNull();
    expect(percentage(500, 0)).toBeNull();
  });

  it("rounds a percentage to one decimal", () => {
    expect(percentage(1, 3)).toBe(33.3);
    expect(percentage(2, 3)).toBe(66.7);
    expect(percentage(7, 7)).toBe(100);
  });
});
