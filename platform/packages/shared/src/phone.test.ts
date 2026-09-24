import { describe, expect, it } from "vitest";
import {
  checkPhone,
  dialCode,
  formatNationalAsYouType,
  isE164Phone,
  isTooLongForCountry,
  mainCountryForCallingCode,
  phoneCountries,
  searchPhoneCountries,
  splitPhone,
  toE164,
  toPhoneCountry,
} from "./phone";

describe("checkPhone", () => {
  it("accepts a 10-digit Indian mobile and stores E.164", () => {
    const r = checkPhone("98765 43210", "IN");
    expect(r).toMatchObject({ ok: true, empty: false, e164: "+919876543210", country: "IN" });
  });

  it("accepts the national trunk prefix and the 00 international prefix", () => {
    expect(toE164("09876543210", "IN")).toBe("+919876543210");
    expect(toE164("0091 98765 43210", "IN")).toBe("+919876543210");
    expect(toE164("+91-98765-43210", "IN")).toBe("+919876543210");
  });

  it("refuses a number one digit short, with the country in the message", () => {
    const r = checkPhone("98765 4321", "IN");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problem).toBe("too_short");
      expect(r.message).toContain("India (+91)");
    }
  });

  it("refuses a number one digit long", () => {
    const r = checkPhone("98765 432101", "IN");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toBe("too_long");
  });

  it("refuses a right-length number no Indian operator issues", () => {
    const r = checkPhone("55555 55555", "IN");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toBe("invalid");
  });

  it("checks each country's own length - a UAE mobile is 9 digits", () => {
    expect(toE164("50 123 4567", "AE")).toBe("+971501234567");
    expect(checkPhone("50 123 456", "AE").ok).toBe(false);
    expect(toE164("7911 123456", "GB")).toBe("+447911123456");
    expect(toE164("(201) 555-0123", "US")).toBe("+12015550123");
  });

  it("refuses an international number for a different calling code than the one selected", () => {
    const r = checkPhone("+971 50 123 4567", "IN");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problem).toBe("wrong_country");
      expect(r.message).toContain("+971");
    }
  });

  it("accepts a number from a country that shares the selected calling code", () => {
    // Toronto, typed with the US selected: both are +1.
    const r = checkPhone("(416) 555-0123", "US");
    expect(r.ok).toBe(true);
    if (r.ok && !r.empty) expect(r.country).toBe("CA");
  });

  it("treats blank as valid unless required", () => {
    expect(checkPhone("", "IN")).toEqual({ ok: true, empty: true, e164: null });
    expect(checkPhone("  ", "IN", { required: true })).toMatchObject({ ok: false, problem: "required" });
  });

  it("refuses letters", () => {
    expect(checkPhone("98765 abcde", "IN")).toMatchObject({ ok: false, problem: "not_a_number" });
    expect(checkPhone("call me", "IN")).toMatchObject({ ok: false, problem: "not_a_number" });
  });
});

describe("isE164Phone", () => {
  it("is true only for a valid, already-normalised number", () => {
    expect(isE164Phone("+919876543210")).toBe(true);
    expect(isE164Phone("+91 98765 43210")).toBe(false);
    expect(isE164Phone("+915555555555")).toBe(false);
    expect(isE164Phone("9876543210")).toBe(false);
    expect(isE164Phone(null)).toBe(false);
  });
});

describe("splitPhone", () => {
  it("splits a stored E.164 value into its own country and a formatted national part", () => {
    expect(splitPhone("+971501234567", "IN")).toEqual({ country: "AE", national: "50 123 4567" });
    expect(splitPhone("+919876543210", "AE").country).toBe("IN");
  });

  it("reads a legacy national value under the fallback country", () => {
    expect(splitPhone("98765 43210", "IN")).toEqual({ country: "IN", national: "98765 43210" });
  });

  it("keeps unparseable legacy text exactly as stored, so nothing is lost", () => {
    expect(splitPhone("ask reception", "IN")).toEqual({ country: "IN", national: "ask reception" });
  });

  it("gives +1 numbers to the US rather than the first +1 country alphabetically", () => {
    expect(splitPhone("+1 201 555 0123", "IN").country).toBe("US");
    expect(mainCountryForCallingCode("1")).toBe("US");
    expect(mainCountryForCallingCode("91")).toBe("IN");
  });
});

describe("typing helpers", () => {
  it("formats the national part as it is typed", () => {
    expect(formatNationalAsYouType("9876543210", "IN")).toBe("98765 43210");
    expect(formatNationalAsYouType("", "IN")).toBe("");
  });

  it("knows when another digit would be too long", () => {
    expect(isTooLongForCountry("9876543210", "IN")).toBe(false);
    expect(isTooLongForCountry("98765432101", "IN")).toBe(true);
  });
});

describe("country catalogue", () => {
  it("lists every country once, by name, with its dial code", () => {
    const list = phoneCountries();
    expect(list.length).toBeGreaterThan(200);
    expect(new Set(list.map((c) => c.iso)).size).toBe(list.length);
    expect(list.find((c) => c.iso === "IN")).toEqual({ iso: "IN", name: "India", dial: "+91" });
    expect(dialCode("AE")).toBe("+971");
  });

  it("finds a country by name, ISO code or dial code", () => {
    expect(searchPhoneCountries("ind")[0]?.iso).toBe("IN");
    expect(searchPhoneCountries("IN")[0]?.iso).toBe("IN");
    expect(searchPhoneCountries("+91")[0]?.iso).toBe("IN");
    expect(searchPhoneCountries("971")[0]?.iso).toBe("AE");
    expect(searchPhoneCountries("zzzz")).toEqual([]);
  });

  it("falls back to the default for an unknown stored country", () => {
    expect(toPhoneCountry("ae")).toBe("AE");
    expect(toPhoneCountry("XX")).toBe("IN");
    expect(toPhoneCountry(null, "GB")).toBe("GB");
  });
});
