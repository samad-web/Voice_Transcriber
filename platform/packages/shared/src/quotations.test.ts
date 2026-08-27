import { describe, expect, it } from "vitest";
import { computeDocumentTotals, computeLineTotal, splitGst } from "./quotations";

describe("computeLineTotal", () => {
  it("applies the line discount before tax", () => {
    // 10 * 100 = 1000, less 10% discount = 900, plus 18% tax = 1062
    expect(computeLineTotal({ quantity: 10, unitPrice: 100, discountPct: 10, taxRate: 18 })).toBe(1062);
  });

  it("handles zero quantity without dividing by zero", () => {
    expect(computeLineTotal({ quantity: 0, unitPrice: 100, discountPct: 0, taxRate: 18 })).toBe(0);
  });
});

describe("computeDocumentTotals", () => {
  const lines = [
    { quantity: 2, unitPrice: 500, discountPct: 0, taxRate: 18 }, // 1000, tax 180
    { quantity: 1, unitPrice: 1000, discountPct: 0, taxRate: 18 }, // 1000, tax 180
  ];

  it("sums a plain two-line document with no header discount", () => {
    const totals = computeDocumentTotals(lines, { type: null, value: 0 });
    expect(totals.subtotal).toBe(2000);
    expect(totals.discountAmount).toBe(0);
    expect(totals.taxTotal).toBe(360);
    expect(totals.total).toBe(2360);
  });

  it("applies a percent header discount before tax, proportionally per line", () => {
    const totals = computeDocumentTotals(lines, { type: "percent", value: 10 });
    // 2000 - 10% = 1800 taxable base; tax is 18% of each line's discounted
    // share, which sums back to 18% of 1800 since both lines share one rate.
    expect(totals.discountAmount).toBe(200);
    expect(totals.taxTotal).toBe(324);
    expect(totals.total).toBe(2124);
  });

  it("caps an amount discount at the pre-tax subtotal instead of going negative", () => {
    const totals = computeDocumentTotals(lines, { type: "amount", value: 5000 });
    expect(totals.discountAmount).toBe(2000);
    expect(totals.taxTotal).toBe(0);
    expect(totals.total).toBe(0);
  });

  it("returns zero totals for an empty line list", () => {
    const totals = computeDocumentTotals([], { type: null, value: 0 });
    expect(totals).toEqual({ subtotal: 0, discountAmount: 0, taxTotal: 0, total: 0 });
  });
});

describe("splitGst", () => {
  it("splits an intra-state tax total evenly into cgst/sgst", () => {
    expect(splitGst(360, false)).toEqual({ cgst: 180, sgst: 180, igst: 0 });
  });

  it("puts the whole tax total into igst for an inter-state sale", () => {
    expect(splitGst(360, true)).toEqual({ cgst: 0, sgst: 0, igst: 360 });
  });

  it("splits an odd total without losing a paisa", () => {
    const { cgst, sgst } = splitGst(101, false);
    expect(cgst + sgst).toBe(101);
  });
});
