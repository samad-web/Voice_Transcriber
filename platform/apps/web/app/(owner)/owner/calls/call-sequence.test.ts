import { describe, expect, it } from "vitest";
import { ordinal } from "./calls-explorer";

/**
 * The call log labels a repeat call by its place in the run ("3rd call with
 * this person"), so the ordinal is read by whoever is deciding how to open the
 * conversation. Production already holds a run of 28 calls with one customer,
 * which puts the teens well inside real data rather than in theory.
 */
describe("ordinal", () => {
  it("names the ones the last digit gets right", () => {
    expect(ordinal(1)).toBe("1st");
    expect(ordinal(2)).toBe("2nd");
    expect(ordinal(3)).toBe("3rd");
    expect(ordinal(4)).toBe("4th");
    expect(ordinal(9)).toBe("9th");
  });

  it("does not say 11st, 12nd or 13rd", () => {
    // The whole reason this function is not `n + suffix[n % 10]`.
    expect(ordinal(11)).toBe("11th");
    expect(ordinal(12)).toBe("12th");
    expect(ordinal(13)).toBe("13th");
  });

  it("keeps counting past the teens", () => {
    expect(ordinal(21)).toBe("21st");
    expect(ordinal(22)).toBe("22nd");
    expect(ordinal(23)).toBe("23rd");
    expect(ordinal(28)).toBe("28th");
    // A second run of teens, a hundred calls in - same exception, again.
    expect(ordinal(111)).toBe("111th");
    expect(ordinal(112)).toBe("112th");
    expect(ordinal(121)).toBe("121st");
  });
});
