"use client";

import { useState } from "react";

/**
 * The line-item row model shared by invoices, quotations, and the
 * new-quotation dialog — previously the `ItemRow`/`ItemDraft` type, its
 * `toRows`/`newRow` helpers, and its per-row validation loop were duplicated
 * near-verbatim in all three files. This module is the one copy; the three
 * call sites use `useLineItemRows()` for the row state and `parse()` (backed
 * by `parseLineItemRows`) to validate before saving.
 */
export interface LineItemRow {
  key: string;
  productId?: string;
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

/** The shape common to InvoiceItem and QuotationItem — everything a row needs to hydrate from. */
export interface LineItemSource {
  id: string;
  product_id: string | null;
  description: string;
  quantity: string;
  unit_price: string;
  discount_pct: string | null;
  tax_rate: string | null;
  line_total: string;
}

let rowSeq = 0;

/** A fresh, empty row — quantity defaults to "1" the way every "+ Add item" always has. */
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

export function sourceToLineItemRows(items: LineItemSource[]): LineItemRow[] {
  return items.map((item) => ({
    key: item.id,
    productId: item.product_id ?? undefined,
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
 * "content" — it's an empty slot nobody has used yet, and saving with it
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

/**
 * Row state + add/update/remove, seeded either from an existing item list
 * (the invoice/quotation edit pages) or from a single blank row (the
 * new-quotation dialog).
 */
export function useLineItemRows(initialItems?: LineItemSource[]) {
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

  const parse = (emptyMessage: string) => parseLineItemRows(rows, emptyMessage);

  return { rows, setRows, updateRow, removeRow, addRow, parse };
}
