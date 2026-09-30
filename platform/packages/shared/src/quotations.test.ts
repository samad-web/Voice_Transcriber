import { describe, expect, it } from "vitest";
import {
  QUOTATION_MANUAL_MOVES,
  QUOTATION_STATUSES,
  canMoveQuotation,
  canReviseQuotation,
  computeDocumentTotals,
  computeLineTotal,
  quotationEditable,
  quotationRevisionNumber,
  splitGst,
  type QuotationStatus,
} from "./quotations";

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

// ── The lifecycle (doc 37, R5) ──────────────────────────────────────────────

describe("QUOTATION_MANUAL_MOVES", () => {
  it("covers every status, so a new one cannot be added without deciding its moves", () => {
    for (const status of QUOTATION_STATUSES) {
      expect(QUOTATION_MANUAL_MOVES[status]).toBeDefined();
    }
    expect(Object.keys(QUOTATION_MANUAL_MOVES).sort()).toEqual([...QUOTATION_STATUSES].sort());
  });

  it("never offers `expired` - only the calendar may set it", () => {
    // Setting it by hand on a quotation still inside its validity would leave the
    // status contradicting the date on the customer's copy, and the sweep that
    // owns it would never put it back.
    for (const from of QUOTATION_STATUSES) {
      expect(QUOTATION_MANUAL_MOVES[from]).not.toContain("expired");
      expect(canMoveQuotation(from, "expired")).toBe(from === "expired");
    }
  });

  it("never offers `superseded` - only raising a revision may set it", () => {
    for (const from of QUOTATION_STATUSES) {
      expect(QUOTATION_MANUAL_MOVES[from]).not.toContain("superseded");
    }
  });

  it("walks draft to sent to an answer, and no further", () => {
    expect(canMoveQuotation("draft", "sent")).toBe(true);
    expect(canMoveQuotation("sent", "accepted")).toBe(true);
    expect(canMoveQuotation("sent", "rejected")).toBe(true);

    // The ends are terminal: a rejected quotation walked back to draft and
    // rewritten destroys the record of what the customer turned down. Revise it.
    expect(canMoveQuotation("accepted", "draft")).toBe(false);
    expect(canMoveQuotation("rejected", "draft")).toBe(false);
    expect(canMoveQuotation("expired", "draft")).toBe(false);
    expect(canMoveQuotation("superseded", "draft")).toBe(false);
    // And a sent quotation cannot be pulled back to a draft either.
    expect(canMoveQuotation("sent", "draft")).toBe(false);
  });

  it("accepts the current status as a no-op, so a form may post every field", () => {
    for (const status of QUOTATION_STATUSES) {
      expect(canMoveQuotation(status, status)).toBe(true);
    }
  });
});

describe("quotationEditable", () => {
  it("is true only for a draft", () => {
    expect(quotationEditable("draft")).toBe(true);
    for (const status of QUOTATION_STATUSES.filter((s) => s !== "draft")) {
      expect(quotationEditable(status)).toBe(false);
    }
  });
});

describe("canReviseQuotation", () => {
  it("covers everything issued, and nothing else", () => {
    // A draft is edited directly; a superseded row's newest revision is the one
    // to carry forward, and revising an old generation would fork the family.
    const revisable: QuotationStatus[] = ["sent", "accepted", "rejected", "expired"];
    for (const status of QUOTATION_STATUSES) {
      expect(canReviseQuotation(status)).toBe(revisable.includes(status));
    }
  });

  it("never overlaps with being editable - one or the other, never both", () => {
    for (const status of QUOTATION_STATUSES) {
      expect(quotationEditable(status) && canReviseQuotation(status)).toBe(false);
    }
  });
});

describe("quotationRevisionNumber", () => {
  it("appends the generation to the root's number", () => {
    expect(quotationRevisionNumber("Q-2026-0007", 2)).toBe("Q-2026-0007-r2");
    expect(quotationRevisionNumber("Q-2026-0007", 3)).toBe("Q-2026-0007-r3");
  });

  it("is given the ROOT's number, so generations do not nest", () => {
    // The controller passes the root's number, never the parent's - otherwise
    // revision 3 raised off r2 would read `Q-2026-0007-r2-r3`.
    expect(quotationRevisionNumber("Q-2026-0007", 3)).not.toContain("-r2-");
  });
});
