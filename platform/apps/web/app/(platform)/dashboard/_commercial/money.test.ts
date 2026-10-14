import { describe, expect, it } from "vitest";
import { ageFrom, hoursMinutes, money, moneyShort, pct, trendFromBp } from "./money";

/**
 * Money formatting on the operator's commercial dashboard (doc 49 P13c).
 *
 * ── WHY FORMATTING IS WORTH TESTING HERE ────────────────────────────────────
 *
 * Every amount arrives as an integer in MINOR units, and every way of getting
 * that wrong is silent and plausible:
 *
 *   - printing paise as rupees overstates revenue by 100x;
 *   - printing an AED figure with a ₹ sign is wrong about the currency, not
 *     about the number, so it survives every sanity check a reader applies;
 *   - Western grouping on an Indian figure (₹1,269,900 rather than ₹12,69,900)
 *     is read wrong by the person the screen is for;
 *   - a percentage rounded twice can move a headline share by a whole point.
 */

describe("money", () => {
  it("renders minor units as whole major units", () => {
    // Growth's own price: ₹12,699 a month, stored as 1,269,900 paise. Reading
    // the minor figure as rupees would put ₹12,69,900 on the screen - a
    // hundredfold overstatement that looks entirely plausible.
    expect(money(1_269_900, "INR")).toBe("₹12,699");
  });

  it("uses Indian grouping for INR", () => {
    // ₹12,69,900, because the operator reading an Indian price list thinks in
    // lakhs and ₹1,269,900 is a translation they have to do in their head.
    expect(money(126_990_000, "INR")).toBe("₹12,69,900");
    expect(money(10_000_000, "INR")).toBe("₹1,00,000");
  });

  it("never prints a rupee sign on another currency", () => {
    const aed = money(89_900, "AED");
    expect(aed).toContain("AED");
    expect(aed).not.toContain("₹");
  });

  it("falls back to INR only when no currency is given at all", () => {
    expect(money(99_900, null)).toBe("₹999");
  });

  it("prints an unknown currency code rather than guessing a symbol", () => {
    expect(money(1_000_00, "GBP")).toContain("GBP");
  });
});

describe("moneyShort", () => {
  it("uses lakh and crore for INR", () => {
    expect(moneyShort(1_269_900, "INR")).toBe("₹12.7k");
    // ₹5,00,000
    expect(moneyShort(50_000_000, "INR")).toBe("₹5L");
    // ₹50,00,000
    expect(moneyShort(500_000_000, "INR")).toBe("₹50L");
    // ₹2,50,00,000
    expect(moneyShort(2_500_000_000, "INR")).toBe("₹2.5Cr");
  });

  it("uses k and M for anything else", () => {
    expect(moneyShort(5_000_00, "AED")).toBe("AED 5k");
    expect(moneyShort(5_000_000_00, "AED")).toBe("AED 5M");
  });

  it("prints small amounts in full", () => {
    expect(moneyShort(99_900, "INR")).toBe("₹999");
  });
});

describe("pct", () => {
  it("renders basis points as a percentage, rounding once", () => {
    expect(pct(6834)).toBe("68.3%");
    expect(pct(6834, 0)).toBe("68%");
  });

  it("renders an em-dash for a figure with no basis", () => {
    // Not "0%". A rate with no denominator is unknown, and 0% is a claim.
    expect(pct(null)).toBe("—");
    expect(pct(undefined)).toBe("—");
  });

  it("renders a real zero as 0%", () => {
    expect(pct(0)).toBe("0.0%");
  });
});

describe("trendFromBp", () => {
  it("spells the direction out, with a glyph that is not the only signal", () => {
    expect(trendFromBp(1800, "last month")).toEqual({
      kind: "up",
      text: "▲ 18% vs last month",
    });
    expect(trendFromBp(-1800, "last month")!.kind).toBe("down");
  });

  it("omits the trend entirely when there is no basis", () => {
    // The API returns null when the previous month was zero. "+100%" for a
    // first customer is flattering nonsense, and the honest rendering is no
    // trend line at all.
    expect(trendFromBp(null, "last month")).toBeNull();
  });

  it("says level rather than drawing a zero-length arrow", () => {
    expect(trendFromBp(0, "last month")).toEqual({ kind: "flat", text: "level with last month" });
  });
});

describe("hoursMinutes", () => {
  it("reads as a duration, not as a decimal", () => {
    expect(hoursMinutes(90)).toBe("1h 30m");
    expect(hoursMinutes(120)).toBe("2h");
    expect(hoursMinutes(45)).toBe("45m");
    expect(hoursMinutes(0)).toBe("0m");
  });
});

describe("ageFrom", () => {
  const now = Date.parse("2026-10-14T12:00:00Z");

  it("counts hours under two days and days beyond", () => {
    expect(ageFrom("2026-10-14T09:00:00Z", now)).toBe("3 hours");
    expect(ageFrom("2026-10-09T12:00:00Z", now)).toBe("5 days");
  });

  it("says under an hour rather than 0 hours", () => {
    expect(ageFrom("2026-10-14T11:40:00Z", now)).toBe("under an hour");
  });

  it("returns null for nothing to age", () => {
    expect(ageFrom(null, now)).toBeNull();
    expect(ageFrom("not a date", now)).toBeNull();
  });
});
