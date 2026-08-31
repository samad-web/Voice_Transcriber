import { z } from "zod";

/**
 * Line-item and document totals for quotations/invoices (migration 0059/0060).
 *
 * Pure and side-effect-free on purpose, same reasoning as automation-dryrun.ts:
 * money math computed twice by two different engines (a DB generated column
 * and application code, or the API and a web preview) drifts the moment either
 * one changes without the other. This is the ONE place the arithmetic lives;
 * the API writes its result as plain numeric columns, and the web line-item
 * editor imports this same function for a live preview that can never disagree
 * with what the server will actually save.
 */

export const LineItemInput = z.object({
  quantity: z.number().min(0),
  unitPrice: z.number().min(0),
  discountPct: z.number().min(0).max(100).default(0),
  taxRate: z.number().min(0).max(100).default(0),
});
export type LineItemInput = z.infer<typeof LineItemInput>;

export const DocumentDiscount = z.object({
  type: z.enum(["percent", "amount"]).nullable(),
  value: z.number().min(0).default(0),
});
export type DocumentDiscount = z.infer<typeof DocumentDiscount>;

/**
 * One line: quantity * unitPrice, less its own line-level discount, then its
 * own line-level tax on top of the discounted amount (tax-on-discounted-price
 * is the GST-correct order - taxing the pre-discount price overcharges tax).
 */
export function computeLineTotal(line: LineItemInput): number {
  const gross = line.quantity * line.unitPrice;
  const discounted = gross * (1 - line.discountPct / 100);
  const taxed = discounted * (1 + line.taxRate / 100);
  return round2(taxed);
}

export interface DocumentTotals {
  subtotal: number;
  discountAmount: number;
  taxTotal: number;
  total: number;
}

/**
 * Rolls a set of already-computed line totals up into a document total, after
 * a document-level discount (applied to the pre-tax subtotal, same as
 * Kailash's proven `discount_type`/`discount_value` header fields - reused as
 * a business-logic reference, not as code).
 *
 * `taxTotal` is reported separately from `total` because India-GST invoices
 * (migration 0060) need to show it broken out as cgst/sgst/igst on the
 * printed document even though this function doesn't know which split
 * applies - that's the caller's job (intra-state vs inter-state), this just
 * hands back the one number to split.
 */
export function computeDocumentTotals(lines: LineItemInput[], discount: DocumentDiscount): DocumentTotals {
  const rawSubtotal = lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0);
  const preTaxSubtotal = lines.reduce(
    (sum, l) => sum + l.quantity * l.unitPrice * (1 - l.discountPct / 100),
    0,
  );

  const discountAmount =
    discount.type === "percent"
      ? preTaxSubtotal * (discount.value / 100)
      : discount.type === "amount"
        ? Math.min(discount.value, preTaxSubtotal)
        : 0;

  const taxableBase = preTaxSubtotal - discountAmount;
  const taxTotal = lines.reduce((sum, l) => {
    const lineTaxableBase = l.quantity * l.unitPrice * (1 - l.discountPct / 100);
    // Spread the document discount across lines proportionally so each
    // line's tax is computed on ITS post-discount share, not the whole
    // document's - matters once lines carry different tax rates.
    const share = preTaxSubtotal > 0 ? lineTaxableBase / preTaxSubtotal : 0;
    const lineTaxableAfterDocDiscount = lineTaxableBase - discountAmount * share;
    return sum + lineTaxableAfterDocDiscount * (l.taxRate / 100);
  }, 0);

  return {
    subtotal: round2(rawSubtotal),
    discountAmount: round2(discountAmount),
    taxTotal: round2(taxTotal),
    total: round2(taxableBase + taxTotal),
  };
}

/**
 * Splits a computed tax total into India-GST's cgst/sgst (intra-state, half
 * each) or igst (inter-state, all of it) - the API decides which applies by
 * comparing the org's home state to the invoice's place_of_supply; this just
 * does the arithmetic once that decision is made.
 */
export function splitGst(taxTotal: number, interState: boolean): { cgst: number; sgst: number; igst: number } {
  if (interState) return { cgst: 0, sgst: 0, igst: round2(taxTotal) };
  const half = round2(taxTotal / 2);
  return { cgst: half, sgst: round2(taxTotal - half), igst: 0 };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
