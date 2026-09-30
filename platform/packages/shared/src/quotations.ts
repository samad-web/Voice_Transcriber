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

// ── The quotation lifecycle (doc 37, R5) ────────────────────────────────────

/**
 * Every status a quotation can hold. `superseded` arrived with revisions
 * (migration 0149); the other five have existed since 0059.
 *
 * ONE definition, here, because there were seven: two zod enums in the
 * controller, the DB CHECK, its Supabase mirror, a `QuotationStatus` union in
 * the web's actions, the detail page's `STATUS_OPTIONS` and the list page's
 * filter tabs. `notifications.kind` is the standing lesson - its CHECK and its
 * zod enum drifted apart and threw 23514 at runtime - so the enum, the moves and
 * the locks live together and everything else imports them.
 */
export const QUOTATION_STATUSES = [
  "draft",
  "sent",
  "accepted",
  "rejected",
  "expired",
  "superseded",
] as const;
export type QuotationStatus = (typeof QUOTATION_STATUSES)[number];

/**
 * The status moves a PERSON may make by hand.
 *
 * ── TWO STATUSES NOBODY MAY TYPE ────────────────────────────────────────────
 *
 * `expired` is absent from every list: it means "the date on the document has
 * passed", and only the calendar can make that true. Setting it by hand on a
 * quotation still inside its validity would leave the status contradicting the
 * `valid_until` printed on the customer's copy, and the sweep that owns it
 * (worker `document-dates.ts`) would never put it back. `superseded` is absent
 * for the same kind of reason: it means a revision has replaced this row, and
 * only creating that revision makes it so.
 *
 * This mirrors the rule `MANUAL_STATUS_MOVES` already applies to invoices, where
 * `paid` is never a manual move because only a recorded payment makes it.
 *
 * ── WHY THE ENDS ARE TERMINAL ───────────────────────────────────────────────
 *
 * `accepted`, `rejected`, `expired` and `superseded` lead nowhere. Before this,
 * PATCH took any status from any status, so a rejected quotation could be walked
 * back to `draft` and rewritten - destroying the record of what the customer
 * actually turned down. With revisions there is a better answer for all four:
 * revise it, which keeps the old document intact and numbered.
 */
export const QUOTATION_MANUAL_MOVES: Record<QuotationStatus, readonly QuotationStatus[]> = {
  draft: ["sent"],
  sent: ["accepted", "rejected"],
  accepted: [],
  rejected: [],
  expired: [],
  superseded: [],
};

/** Sending the CURRENT status back is a no-op, not a move - a form may post every field. */
export function canMoveQuotation(from: QuotationStatus, to: QuotationStatus): boolean {
  if (from === to) return true;
  return QUOTATION_MANUAL_MOVES[from].includes(to);
}

/**
 * Whether the line items, the discount and the dates may still be changed.
 *
 * Only a draft. Once a quotation has been sent, its numbers are what a customer
 * was told; editing them in place rewrites history and leaves the copy in their
 * inbox disagreeing with the row. The invoice side has had this since 0139
 * (`moneyLocked`); the quotation side had no lock at all, and `PATCH` would
 * happily `DELETE` and re-insert the lines of a document already out for
 * signature.
 */
export function quotationEditable(status: QuotationStatus): boolean {
  return status === "draft";
}

/**
 * Whether a new revision may be raised from this one.
 *
 * Anything that has been issued and is not already replaced. Not a `draft` -
 * there is nothing to preserve, so edit it - and not a `superseded` row, because
 * the newest revision is the one to carry forward; revising an old one would
 * fork the family.
 */
export function canReviseQuotation(status: QuotationStatus): boolean {
  return status === "sent" || status === "accepted" || status === "rejected" || status === "expired";
}

/**
 * A revision's document number: the ROOT's number with the revision appended,
 * so `Q-2026-0007` begets `Q-2026-0007-r2`, `-r3` and so on.
 *
 * The root's number, never the immediate parent's, or revision 3 off revision 2
 * would read `Q-2026-0007-r2-r3`.
 */
export function quotationRevisionNumber(rootNumber: string, revision: number): string {
  return `${rootNumber}-r${revision}`;
}
