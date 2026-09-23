import { describe, expect, it } from "vitest";
import { BusinessProfileInput, businessProfileComplete } from "./business-profile";

const FORM = {
  displayName: "Acme Realty",
  legalName: "Acme Realty Private Limited",
  tradeName: null,
  gstin: null,
  pan: null,
  addressLine1: "12 MG Road",
  addressLine2: null,
  city: "Pune",
  postalCode: "411001",
  stateCode: "27",
  country: "IN",
  baseCurrency: "INR",
  fyStartMonth: 4,
  timezone: "Asia/Kolkata",
  contactEmail: null,
  contactPhone: null,
  website: null,
};

describe("businessProfileComplete", () => {
  it("needs a legal name, and a state for an Indian business", () => {
    expect(businessProfileComplete({ legalName: "Acme", country: "IN", stateCode: "27" })).toBe(true);
    expect(businessProfileComplete({ legalName: "Acme", country: "IN", stateCode: null })).toBe(false);
    expect(businessProfileComplete({ legalName: "   ", country: "IN", stateCode: "27" })).toBe(false);
    expect(businessProfileComplete({ legalName: null, country: "IN", stateCode: "27" })).toBe(false);
  });

  it("needs no state outside India", () => {
    expect(businessProfileComplete({ legalName: "Acme LLC", country: "US", stateCode: null })).toBe(true);
  });

  it("does not need a GSTIN - unregistered businesses can finish it", () => {
    expect(businessProfileComplete({ legalName: "Acme", country: "IN", stateCode: "29" })).toBe(true);
  });

  it("is false with no row at all", () => {
    expect(businessProfileComplete(null)).toBe(false);
  });
});

describe("BusinessProfileInput", () => {
  it("accepts an unregistered business and blanks empty strings to null", () => {
    const parsed = BusinessProfileInput.parse({ ...FORM, tradeName: "  ", website: "" });
    expect(parsed.tradeName).toBeNull();
    expect(parsed.website).toBeNull();
    expect(parsed.gstin).toBeNull();
  });

  it("derives the PAN from the GSTIN, whatever the form sent", () => {
    const parsed = BusinessProfileInput.parse({ ...FORM, gstin: "27aapfu0939f1zv", pan: "ZZZZZ9999Z" });
    expect(parsed.gstin).toBe("27AAPFU0939F1ZV");
    expect(parsed.pan).toBe("AAPFU0939F");
  });

  it("refuses a GSTIN from another state", () => {
    const result = BusinessProfileInput.safeParse({ ...FORM, stateCode: "29", gstin: "27AAPFU0939F1ZV" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path).toEqual(["gstin"]);
  });

  it("refuses a GSTIN with a bad checksum", () => {
    expect(BusinessProfileInput.safeParse({ ...FORM, gstin: "27AAPFU0939F1ZW" }).success).toBe(false);
  });

  it("drops the state outside India, and refuses a GSTIN there", () => {
    expect(BusinessProfileInput.parse({ ...FORM, country: "us", stateCode: "27" }).stateCode).toBeNull();
    expect(BusinessProfileInput.safeParse({ ...FORM, country: "US", gstin: "27AAPFU0939F1ZV" }).success).toBe(false);
  });

  it("refuses a state that is not a GST code", () => {
    expect(BusinessProfileInput.safeParse({ ...FORM, stateCode: "25" }).success).toBe(false);
  });

  it("fills nothing in: every field must be sent", () => {
    const { website: _omitted, ...rest } = FORM;
    expect(BusinessProfileInput.safeParse(rest).success).toBe(false);
  });
});
