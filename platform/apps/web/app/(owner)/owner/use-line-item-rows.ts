"use client";

import { useState, type Dispatch, type SetStateAction } from "react";
import { computeLineTotal } from "@aura/shared";

/**
 * The line-item row model shared by invoices, quotations, and the
 * new-quotation dialog - previously the `ItemRow`/`ItemDraft` type, its
 * `toRows`/`newRow` helpers, and its per-row validation loop were duplicated
 * near-verbatim in all three files. This module is the one copy; the three
 * call sites use `useLineItemRows()` for the row state and `parse()` (backed
 * by `parseLineItemRows`) to validate before saving.
 *
 * ── THE PRICE LIST AND THE PREVIEW ─────────────────────────────────────────
 *
 * Two things this model always claimed to do and did not:
 *
 * `productId` has been on the row, on the API's item schema, on
 * `quotation_items.product_id` and inside `assertInOrg` since migration 0059 -
 * with nothing anywhere that could SET it. Every line on every quotation and
 * invoice was hand-typed and every `product_id` was NULL, while the price-list
 * page told people "quotations and invoices pick their line items from this
 * list". `createLineItemRowFromProduct` is the missing half.
 *
 * And `packages/shared/src/quotations.ts` says in its header that "the web
 * line-item editor imports this same function for a live preview that can
 * never disagree with what the server will actually save". No web file
 * imported it: a row showed the literal word "unsaved" in its Line total cell
 * until a round trip came back. `rowLineTotal` and `previewLineInputs` are
 * that import, so the arithmetic on screen is the arithmetic that will be
 * stored, by construction rather than by two engines agreeing.
 */
export interface LineItemRow {
  key: string;
  productId?: string;
  /** Resolved by the API (`product_name`), so a linked row can name its catalogue entry. */
  productName?: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discountPct: string;
  taxRate: string;
  lineTotal: string | null;
}

/** What every `*ItemInput` (InvoiceItemInput, QuotationItemInput) looks like. */
export interface LineItemInput {
  productId?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  discountPct?: number;
  taxRate?: number;
}

/** The shape common to InvoiceItem and QuotationItem - everything a row needs to hydrate from. */
export interface LineItemSource {
  id: string;
  product_id: string | null;
  /** Absent from an older API response; the row simply shows no catalogue name. */
  product_name?: string | null;
  description: string;
  quantity: string;
  unit_price: string;
  discount_pct: string | null;
  tax_rate: string | null;
  line_total: string;
}

/**
 * The price-list fields a line item is filled from. Structural rather than an
 * import of `products/actions.ts`'s `Product`, so the row model stays
 * independent of that module (and of the fields a product has that a line does
 * not, like SKU and status).
 */
export interface LineItemProduct {
  id: string;
  name: string;
  /** Postgres numeric - a string. */
  unit_price: string;
  tax_rate: string;
  currency: string;
}

let rowSeq = 0;

/** A fresh, empty row - quantity defaults to "1" the way every "+ Add item" always has. */
export function createLineItemRow(): LineItemRow {
  rowSeq += 1;
  return {
    key: `new-${rowSeq}`,
    description: "",
    quantity: "1",
    unitPrice: "",
    discountPct: "",
    taxRate: "",
    lineTotal: null,
  };
}

/**
 * A row filled from a price-list entry: name into the description, catalogue
 * price and tax rate into the numbers, and the link itself into `productId` so
 * the saved line records WHICH catalogue entry it was sold as.
 *
 * ── A PRODUCT IN ANOTHER CURRENCY DOES NOT BRING ITS PRICE ─────────────────
 *
 * Products carry their own currency; a document has one. Copying a $500 price
 * onto an INR quotation because both are stored as `500` would quietly
 * under-bill by a factor of eighty, and a money document is the last place to
 * guess. So a currency mismatch fills everything EXCEPT the price and leaves
 * the field empty for a person to type - the row then fails validation until
 * they do, which is the right outcome. `documentCurrency` is compared
 * case-insensitively because the currency inputs upper-case as you type but
 * older rows were stored however they were sent.
 */
export function createLineItemRowFromProduct(
  product: LineItemProduct,
  documentCurrency: string,
): LineItemRow {
  const sameCurrency =
    product.currency.trim().toUpperCase() === documentCurrency.trim().toUpperCase();
  rowSeq += 1;
  return {
    key: `new-${rowSeq}`,
    productId: product.id,
    productName: product.name,
    description: product.name,
    quantity: "1",
    unitPrice: sameCurrency ? String(Number(product.unit_price)) : "",
    discountPct: "",
    taxRate: String(Number(product.tax_rate)),
    lineTotal: null,
  };
}

export function sourceToLineItemRows(items: LineItemSource[]): LineItemRow[] {
  return items.map((item) => ({
    key: item.id,
    productId: item.product_id ?? undefined,
    productName: item.product_name ?? undefined,
    description: item.description,
    quantity: String(Number(item.quantity)),
    unitPrice: String(Number(item.unit_price)),
    discountPct: item.discount_pct ? String(Number(item.discount_pct)) : "",
    taxRate: item.tax_rate ? String(Number(item.tax_rate)) : "",
    lineTotal: item.line_total,
  }));
}

/**
 * Whether a row carries anything beyond its just-created defaults. A row
 * fresh off "+ Add item" (quantity "1", everything else blank) is not
 * "content" - it's an empty slot nobody has used yet, and saving with it
 * still in that state should stay a silent no-op, same as today. The moment
 * someone types a price, a discount, a tax rate, or changes the quantity, the
 * row shows intent and a blank description on it becomes a real mistake
 * instead of an untouched slot.
 */
function rowHasContent(row: LineItemRow): boolean {
  return (
    row.unitPrice.trim() !== "" ||
    row.discountPct.trim() !== "" ||
    row.taxRate.trim() !== "" ||
    (row.quantity.trim() !== "" && row.quantity.trim() !== "1")
  );
}

/** A just-created slot nobody has touched: no description, no content, no product. */
function isUntouchedRow(row: LineItemRow): boolean {
  return row.description.trim() === "" && !row.productId && !rowHasContent(row);
}

function parseRow(row: LineItemRow, index: number): { item?: LineItemInput; error?: string } {
  const description = row.description.trim();
  if (!description) {
    if (!rowHasContent(row)) return {};
    return { error: `Enter a description for line item ${index + 1}` };
  }

  const quantity = Number(row.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return { error: `Enter a valid quantity for "${description}"` };
  }
  const unitPrice = Number(row.unitPrice);
  if (!Number.isFinite(unitPrice) || unitPrice < 0) {
    return { error: `Enter a valid unit price for "${description}"` };
  }

  return {
    item: {
      productId: row.productId,
      description,
      quantity,
      unitPrice,
      discountPct: row.discountPct ? Number(row.discountPct) : undefined,
      taxRate: row.taxRate ? Number(row.taxRate) : undefined,
    },
  };
}

export type ParsedLineItemRows =
  | { items: LineItemInput[]; error: null }
  | { items: null; error: string };

/**
 * Validate every row and turn it into the API's item-input shape.
 * `emptyMessage` is the caller's "an invoice/quotation needs at least one
 * line item" copy, since that's the one message that differs between the
 * three call sites.
 */
export function parseLineItemRows(rows: LineItemRow[], emptyMessage: string): ParsedLineItemRows {
  const items: LineItemInput[] = [];
  for (let i = 0; i < rows.length; i++) {
    const { item, error } = parseRow(rows[i], i);
    if (error) return { items: null, error };
    if (item) items.push(item);
  }
  if (items.length === 0) return { items: null, error: emptyMessage };
  return { items, error: null };
}

// ── The live preview ────────────────────────────────────────────────────────

/** Exactly what `computeLineTotal`/`computeDocumentTotals` take for one line. */
export interface LineItemNumbers {
  quantity: number;
  unitPrice: number;
  discountPct: number;
  taxRate: number;
}

/** Blank means zero - what `parseRow` already sends for an empty discount or tax rate. */
function blankAsZero(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return 0;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Blank means "not priced yet", which is not the same as zero. */
function blankAsMissing(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * A row's four numbers, or null when the row is not yet arithmetic: a blank or
 * nonsensical quantity or price, or a percentage past 100 (which the API's zod
 * schema rejects outright, so previewing a total for it would promise a save
 * that cannot happen).
 */
function rowNumbers(row: LineItemRow): LineItemNumbers | null {
  const quantity = blankAsMissing(row.quantity);
  const unitPrice = blankAsMissing(row.unitPrice);
  const discountPct = blankAsZero(row.discountPct);
  const taxRate = blankAsZero(row.taxRate);
  if (quantity === null || unitPrice === null || discountPct === null || taxRate === null) {
    return null;
  }
  if (discountPct > 100 || taxRate > 100) return null;
  return { quantity, unitPrice, discountPct, taxRate };
}

/**
 * One row's total as it is being typed, or null while the row has no usable
 * quantity and price. Replaces the literal "unsaved" the editors used to show
 * until the server answered.
 */
export function rowLineTotal(row: LineItemRow): number | null {
  const numbers = rowNumbers(row);
  return numbers === null ? null : computeLineTotal(numbers);
}

/**
 * The rows that are arithmetic, for a document-level preview. Rows that are not
 * are skipped rather than treated as zero - which is also what saving does with
 * them, so the preview totals what will actually be stored.
 */
export function previewLineInputs(rows: LineItemRow[]): LineItemNumbers[] {
  return rows
    .map(rowNumbers)
    .filter((numbers): numbers is LineItemNumbers => numbers !== null);
}

/**
 * Everything `useLineItemRows` hands back, named so it can be passed around as
 * one value - `LineItemEditor` takes it whole rather than as eight props.
 */
export interface LineItemRowsApi {
  rows: LineItemRow[];
  setRows: Dispatch<SetStateAction<LineItemRow[]>>;
  updateRow: (key: string, patch: Partial<LineItemRow>) => void;
  removeRow: (key: string) => void;
  addRow: () => void;
  addProductRow: (product: LineItemProduct, documentCurrency: string) => void;
  unlinkRow: (key: string) => void;
  parse: (emptyMessage: string) => ParsedLineItemRows;
}

/**
 * Row state + add/update/remove, seeded either from an existing item list
 * (the invoice/quotation edit pages) or from a single blank row (the
 * new-quotation dialog).
 */
export function useLineItemRows(initialItems?: LineItemSource[]): LineItemRowsApi {
  const [rows, setRows] = useState<LineItemRow[]>(() =>
    initialItems && initialItems.length > 0 ? sourceToLineItemRows(initialItems) : [createLineItemRow()],
  );

  const updateRow = (key: string, patch: Partial<LineItemRow>) => {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  };

  const removeRow = (key: string) => {
    setRows((prev) => prev.filter((row) => row.key !== key));
  };

  const addRow = () => {
    setRows((prev) => [...prev, createLineItemRow()]);
  };

  /**
   * Append a row filled from the price list.
   *
   * A trailing row nobody has typed into is REPLACED rather than pushed past:
   * every editor opens with one blank slot, so picking the first product would
   * otherwise leave an empty row above it that then blocks nothing but looks
   * like a mistake.
   */
  const addProductRow = (product: LineItemProduct, documentCurrency: string) => {
    const filled = createLineItemRowFromProduct(product, documentCurrency);
    setRows((prev) => {
      const last = prev[prev.length - 1];
      return last && isUntouchedRow(last) ? [...prev.slice(0, -1), filled] : [...prev, filled];
    });
  };

  /**
   * Break a row's link to the price list, keeping every number in it. Editing a
   * catalogue line's price or wording does NOT unlink it - a negotiated price on
   * a catalogue item is ordinary - so this is the one way to say "this is not
   * that product any more".
   */
  const unlinkRow = (key: string) => {
    setRows((prev) =>
      prev.map((row) =>
        row.key === key ? { ...row, productId: undefined, productName: undefined } : row,
      ),
    );
  };

  const parse = (emptyMessage: string) => parseLineItemRows(rows, emptyMessage);

  return { rows, setRows, updateRow, removeRow, addRow, addProductRow, unlinkRow, parse };
}
