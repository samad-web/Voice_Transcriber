import { describe, expect, it } from "vitest";
import { importPhone } from "./import-phone";
import { checkPhone } from "./phone";

describe("importPhone", () => {
  // The whole point (X5): every spelling of one Indian number becomes the ONE
  // E.164 the console's own form would store for it, so the hash agrees.
  it.each(["98765 43210", "9876543210", "098765 43210", "+91 98765 43210", "0091 98765 43210", "+91-98765-43210"])(
    "reads %s as the console's E.164",
    (raw) => {
      const consoleE164 = checkPhone("+91 98765 43210", "IN");
      expect(consoleE164.ok && !consoleE164.empty && consoleE164.e164).toBe("+919876543210");
      expect(importPhone(raw, "IN")).toEqual({ ok: true, e164: "+919876543210" });
    },
  );

  it("reads back the number Excel stored without its '+', for the workspace's own code", () => {
    expect(importPhone("919876543210", "IN")).toEqual({ ok: true, e164: "+919876543210" });
  });

  it("does not guess a foreign country for a bare number with no '+'", () => {
    const result = importPhone("971501234567", "IN");
    expect(result.ok).toBe(false);
  });

  it("accepts an explicit '+' number from another country - it names its own", () => {
    expect(importPhone("+971 50 123 4567", "IN")).toEqual({ ok: true, e164: "+971501234567" });
  });

  it("treats a blank cell as no phone, not an error", () => {
    expect(importPhone("", "IN")).toEqual({ ok: true, e164: null });
    expect(importPhone("   ", "IN")).toEqual({ ok: true, e164: null });
    expect(importPhone(null, "IN")).toEqual({ ok: true, e164: null });
  });

  it("refuses junk below the six-digit floor, naming the country", () => {
    for (const raw of ["n/a", "-", "0", "12345"]) {
      const result = importPhone(raw, "IN");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toContain("is not a valid phone number for India");
    }
  });

  it("refuses a number the country does not issue rather than hashing it as typed", () => {
    // Too short, too long (an 11-digit mobile), and a prefix India never issues.
    for (const raw of ["98765 432", "98765 432109", "00000 00000"]) {
      const result = importPhone(raw, "IN");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message).toMatch(/^".+" is not a valid phone number for India - /u);
    }
  });

  it("reads national numbers against the workspace's country, not India's", () => {
    expect(importPhone("(415) 555-2671", "US")).toEqual({ ok: true, e164: "+14155552671" });
    const result = importPhone("98765 43210", "US");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("for United States");
  });
});
