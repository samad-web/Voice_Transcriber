import { describe, expect, it } from "vitest";
import {
  GST_STATES,
  gstStateName,
  gstinCheckChar,
  gstinProblem,
  isGstStateCode,
  normaliseGstin,
  panFromGstin,
} from "./gstin";

/**
 * Real, publicly printed GSTINs - the portal's own worked examples and two
 * company registrations - so the checksum is checked against the GST network's
 * answer rather than against this file's own arithmetic.
 */
const VALID = [
  ["27AAPFU0939F1ZV", "27"],
  ["29AAGCB7383J1Z4", "29"],
  ["33AAACH7409R1Z8", "33"],
] as const;

describe("gstinProblem", () => {
  it.each(VALID)("accepts %s in state %s", (gstin, state) => {
    expect(gstinProblem(gstin, state)).toBeNull();
  });

  it("rejects a bad checksum", () => {
    expect(gstinProblem("27AAPFU0939F1ZW", "27")).toBe("checksum");
  });

  it("catches two swapped characters, which the regex cannot", () => {
    // AAPFU0939F -> AAPFU0993F: same shape, different number.
    expect(gstinProblem("27AAPFU0993F1ZV", "27")).toBe("checksum");
  });

  it("rejects a state prefix that contradicts the chosen state", () => {
    expect(gstinProblem("27AAPFU0939F1ZV", "29")).toBe("state");
  });

  it("skips the state check when no state is chosen", () => {
    expect(gstinProblem("27AAPFU0939F1ZV", null)).toBeNull();
  });

  it.each(["", "27AAPFU0939F1Z", "27AAPFU0939F1YV", "2AAAPFU0939F1ZV", "27aapfu0939f1zv"])(
    "rejects the malformed %s as format",
    (gstin) => {
      expect(gstinProblem(gstin, "27")).toBe("format");
    },
  );
});

describe("gstinCheckChar", () => {
  it("refuses a wrong length or a foreign character", () => {
    expect(gstinCheckChar("27AAPFU0939F1")).toBeNull();
    expect(gstinCheckChar("27AAPFU0939F1-")).toBeNull();
  });
});

describe("panFromGstin", () => {
  it("is characters 3 to 12", () => {
    expect(panFromGstin("27AAPFU0939F1ZV")).toBe("AAPFU0939F");
  });

  it("is null for something that is not a GSTIN", () => {
    expect(panFromGstin("not a gstin")).toBeNull();
  });
});

describe("normaliseGstin", () => {
  it("upper-cases and strips spaces, the way people paste it", () => {
    expect(normaliseGstin(" 27aapfu 0939f1zv ")).toBe("27AAPFU0939F1ZV");
  });
});

describe("GST_STATES", () => {
  it("has unique two-digit codes", () => {
    const codes = GST_STATES.map((s) => s.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^\d{2}$/);
  });

  it("knows the states a GSTIN prefix names", () => {
    expect(isGstStateCode("27")).toBe(true);
    expect(gstStateName("29")).toBe("Karnataka");
    expect(isGstStateCode("25")).toBe(false);
    expect(isGstStateCode(null)).toBe(false);
  });
});
