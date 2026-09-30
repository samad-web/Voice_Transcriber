import { describe, expect, it } from "vitest";
import { computeDocumentTotals, computeLineTotal } from "@aura/shared";
import {
  createLineItemRow,
  createLineItemRowFromProduct,
  parseLineItemRows,
  previewLineInputs,
  rowLineTotal,
  sourceToLineItemRows,
  type LineItemProduct,
  type LineItemRow,
} from "./use-line-item-rows";

/**
 * The two things this module claimed to do and did not: fill a line from the
 * price list, and preview a total with the same engine the API saves with.
 */

const WIDGET: LineItemProduct = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Acme Widget",
  unit_price: "1200.00",
  tax_rate: "18.00",
  currency: "INR",
};

function row(patch: Partial<LineItemRow> = {}): LineItemRow {
  return { ...createLineItemRow(), ...patch };
}

describe("createLineItemRowFromProduct", () => {
  it("fills the line from the catalogue entry and records which entry it was", () => {
    const filled = createLineItemRowFromProduct(WIDGET, "INR");

    expect(filled.productId).toBe(WIDGET.id);
    expect(filled.productName).toBe("Acme Widget");
    expect(filled.description).toBe("Acme Widget");
    expect(filled.quantity).toBe("1");
    expect(filled.unitPrice).toBe("1200");
    expect(filled.taxRate).toBe("18");
  });

  it("matches the currency case-insensitively", () => {
    expect(createLineItemRowFromProduct(WIDGET, "inr").unitPrice).toBe("1200");
  });

  it("does NOT carry a price across currencies - the number would be a lie", () => {
    const filled = createLineItemRowFromProduct({ ...WIDGET, currency: "USD" }, "INR");

    expect(filled.unitPrice).toBe("");
    // Everything else still comes across, so only the one unknowable field is
    // left for a person to fill in.
    expect(filled.description).toBe("Acme Widget");
    expect(filled.taxRate).toBe("18");
    expect(filled.productId).toBe(WIDGET.id);
  });

  it("survives a save: the link is what parseLineItemRows sends to the API", () => {
    const parsed = parseLineItemRows([createLineItemRowFromProduct(WIDGET, "INR")], "none");

    expect(parsed.error).toBeNull();
    expect(parsed.items?.[0]).toMatchObject({
      productId: WIDGET.id,
      description: "Acme Widget",
      quantity: 1,
      unitPrice: 1200,
      taxRate: 18,
    });
  });

  it("comes back from the API as a named link", () => {
    const [hydrated] = sourceToLineItemRows([
      {
        id: "line-1",
        product_id: WIDGET.id,
        product_name: "Acme Widget",
        description: "Acme Widget",
        quantity: "2",
        unit_price: "1200.00",
        discount_pct: null,
        tax_rate: "18.00",
        line_total: "2832.00",
      },
    ]);

    expect(hydrated.productId).toBe(WIDGET.id);
    expect(hydrated.productName).toBe("Acme Widget");
  });
});

describe("rowLineTotal", () => {
  it("is exactly what the API will compute for the same line", () => {
    const line = row({ description: "x", quantity: "3", unitPrice: "100", discountPct: "10", taxRate: "18" });

    expect(rowLineTotal(line)).toBe(
      computeLineTotal({ quantity: 3, unitPrice: 100, discountPct: 10, taxRate: 18 }),
    );
    // 300 less 10% is 270, plus 18% tax.
    expect(rowLineTotal(line)).toBe(318.6);
  });

  it("treats a blank discount and tax rate as zero, the way saving does", () => {
    expect(rowLineTotal(row({ quantity: "2", unitPrice: "50" }))).toBe(100);
  });

  it("is null while the row has no price yet, rather than showing 0", () => {
    expect(rowLineTotal(row({ quantity: "1", unitPrice: "" }))).toBeNull();
    expect(rowLineTotal(row({ quantity: "", unitPrice: "50" }))).toBeNull();
  });

  it("is null for numbers the API would reject, so no preview promises a save that fails", () => {
    expect(rowLineTotal(row({ quantity: "1", unitPrice: "50", taxRate: "180" }))).toBeNull();
    expect(rowLineTotal(row({ quantity: "1", unitPrice: "50", discountPct: "150" }))).toBeNull();
    expect(rowLineTotal(row({ quantity: "1", unitPrice: "-5" }))).toBeNull();
    expect(rowLineTotal(row({ quantity: "1", unitPrice: "abc" }))).toBeNull();
  });
});

describe("previewLineInputs", () => {
  it("skips the rows saving would skip, so the preview totals what gets stored", () => {
    const rows = [
      row({ description: "priced", quantity: "1", unitPrice: "100" }),
      createLineItemRow(), // the untouched trailing slot every editor opens with
      row({ description: "no price yet", quantity: "4", unitPrice: "" }),
    ];

    expect(previewLineInputs(rows)).toEqual([
      { quantity: 1, unitPrice: 100, discountPct: 0, taxRate: 0 },
    ]);
  });

  it("agrees with the document totals the API writes for the same rows", () => {
    const rows = [
      row({ description: "a", quantity: "2", unitPrice: "500", taxRate: "18" }),
      row({ description: "b", quantity: "1", unitPrice: "1000", taxRate: "5" }),
    ];
    const discount = { type: "percent" as const, value: 10 };

    const preview = computeDocumentTotals(previewLineInputs(rows), discount);
    const asTheApiSeesThem = computeDocumentTotals(
      [
        { quantity: 2, unitPrice: 500, discountPct: 0, taxRate: 18 },
        { quantity: 1, unitPrice: 1000, discountPct: 0, taxRate: 5 },
      ],
      discount,
    );

    expect(preview).toEqual(asTheApiSeesThem);
  });
});
