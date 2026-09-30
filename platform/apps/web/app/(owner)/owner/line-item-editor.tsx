"use client";

import type { ReactNode } from "react";
import {
  Button,
  Card,
  FormField,
  Input,
  MonoLabel,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@aura/ui";
import { formatMoney } from "./lib/format-money";
import { PriceListPicker } from "./price-list-picker";
import type { Product } from "./products/actions";
import { rowLineTotal, type LineItemRowsApi } from "./use-line-item-rows";

/** What the document-level discount can be. `none` is the absence of one. */
export type DocumentDiscountType = "none" | "percent" | "amount";

/**
 * The line-item half of a quotation or an invoice: the table, the price-list
 * picker, the document discount, and the button that saves them.
 *
 * ── WHY IT IS ONE COMPONENT ────────────────────────────────────────────────
 *
 * `quotation-detail-client.tsx` and `invoice-detail-client.tsx` each carried
 * their own copy of this, ~180 lines, identical but for two things: whether the
 * fields are locked, and an invoice's GST selector sitting above the discount.
 * `use-line-item-rows.ts` already exists because the row STATE was triplicated;
 * the row MARKUP never got the same treatment, so adding the price-list picker
 * and the live totals meant making every edit twice, six times over.
 *
 * The two differences are `readOnly` and `extraControls`. Everything else the
 * two documents genuinely share, including the things that are easy to get
 * wrong once and right once: the `Popover` that must not open inside the table,
 * the line total that is computed rather than fetched, and the catalogue link
 * that has to survive a save.
 */
export function LineItemEditor({
  caption,
  currency,
  products,
  items,
  discountType,
  onDiscountTypeChange,
  discountValue,
  onDiscountValueChange,
  extraControls,
  readOnly = false,
  readOnlyNote,
  saving,
  onSave,
}: {
  /** The table's accessible name - "Quotation line items", "Invoice line items". */
  caption: string;
  /** The document's currency. A product priced in another one keeps its price to itself. */
  currency: string;
  /** The active price list, or `null` when this role may not read it (the picker then hides). */
  products: Product[] | null;
  items: LineItemRowsApi;
  discountType: DocumentDiscountType;
  onDiscountTypeChange: (next: DocumentDiscountType) => void;
  discountValue: string;
  onDiscountValueChange: (next: string) => void;
  /**
   * Controls rendered ahead of the discount fields, in the same two-column
   * grid - an invoice's GST treatment. Supply a trailing `<div />` to keep the
   * discount pair on its own row.
   */
  extraControls?: ReactNode;
  /** Locks every field. An invoice with money against it is a settled tax document. */
  readOnly?: boolean;
  /** Shown beside the save button when `readOnly` - why it is locked. */
  readOnlyNote?: ReactNode;
  saving: boolean;
  onSave: () => void;
}) {
  const { rows, updateRow, removeRow, addRow, addProductRow, unlinkRow } = items;

  return (
    <Card>
      <MonoLabel>Line items</MonoLabel>

      <div className="mt-3">
        <Table caption={caption}>
          <TableHead>
            <tr>
              <TableHeaderCell>Description</TableHeaderCell>
              <TableHeaderCell>Qty</TableHeaderCell>
              <TableHeaderCell>Unit price</TableHeaderCell>
              <TableHeaderCell>Discount %</TableHeaderCell>
              <TableHeaderCell>Tax %</TableHeaderCell>
              <TableHeaderCell>Line total</TableHeaderCell>
              <TableHeaderCell>
                <span className="sr-only">Remove</span>
              </TableHeaderCell>
            </tr>
          </TableHead>
          <TableBody>
            {rows.map((row) => {
              // Computed, not fetched: `@aura/shared`'s computeLineTotal, the
              // same function the API runs before it writes the column. Null
              // while the row has no usable quantity and price - which is not
              // the same as zero, and is why this is a dash rather than "0.00".
              const live = rowLineTotal(row);
              return (
                <TableRow key={row.key}>
                  <TableCell>
                    <Input
                      aria-label="Description"
                      value={row.description}
                      disabled={readOnly}
                      onChange={(e) => updateRow(row.key, { description: e.target.value })}
                    />
                    {/* `productName` comes from the API's LEFT JOIN. A linked
                        row from an older response has the id but no name, and
                        says so rather than printing a uuid. */}
                    {row.productId ? (
                      <p className="mt-1 flex items-center gap-2 text-xs text-text-muted">
                        <span className="min-w-0 truncate">
                          {row.productName ? `Price list: ${row.productName}` : "From the price list"}
                        </span>
                        {!readOnly ? (
                          <button
                            type="button"
                            onClick={() => unlinkRow(row.key)}
                            className="shrink-0 hover:text-text"
                          >
                            Unlink
                          </button>
                        ) : null}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label="Quantity"
                      type="number"
                      min="0"
                      step="0.01"
                      value={row.quantity}
                      disabled={readOnly}
                      onChange={(e) => updateRow(row.key, { quantity: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label="Unit price"
                      type="number"
                      min="0"
                      step="0.01"
                      value={row.unitPrice}
                      disabled={readOnly}
                      onChange={(e) => updateRow(row.key, { unitPrice: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label="Discount percent"
                      type="number"
                      min="0"
                      step="0.01"
                      value={row.discountPct}
                      disabled={readOnly}
                      onChange={(e) => updateRow(row.key, { discountPct: e.target.value })}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      aria-label="Tax rate percent"
                      type="number"
                      min="0"
                      step="0.01"
                      value={row.taxRate}
                      disabled={readOnly}
                      onChange={(e) => updateRow(row.key, { taxRate: e.target.value })}
                    />
                  </TableCell>
                  <TableCell className="tabular-nums text-text-muted">
                    {live === null ? "-" : formatMoney(live, currency)}
                  </TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeRow(row.key)}
                      disabled={readOnly || rows.length === 1}
                    >
                      Remove
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
            <TableRow>
              <TableCell colSpan={7}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={readOnly}
                  onClick={addRow}
                >
                  + Add item
                </Button>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>

      {/* Outside the table on purpose: the kit's Table wrapper is
          `overflow-x-auto`, and a Popover panel opened from inside a cell is
          clipped by it (doc 27's finding, in the sidebar's case). */}
      <div className="mt-3">
        <PriceListPicker
          currency={currency}
          initialProducts={products}
          disabled={readOnly}
          onPick={(product) => addProductRow(product, currency)}
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-4">
        {extraControls}
        <FormField label="Discount type" name="discountType">
          <Select
            value={discountType}
            disabled={readOnly}
            onChange={(e) => onDiscountTypeChange(e.target.value as DocumentDiscountType)}
          >
            <option value="none">None</option>
            <option value="percent">Percent</option>
            <option value="amount">Amount</option>
          </Select>
        </FormField>
        <FormField label="Discount value" name="discountValue">
          <Input
            type="number"
            min="0"
            step="0.01"
            disabled={readOnly || discountType === "none"}
            value={discountValue}
            onChange={(e) => onDiscountValueChange(e.target.value)}
          />
        </FormField>
      </div>

      <div className="mt-4 flex items-center justify-end gap-3">
        {readOnly && readOnlyNote ? (
          <p className="text-xs text-text-muted">{readOnlyNote}</p>
        ) : null}
        <Button type="button" loading={saving} disabled={readOnly} onClick={onSave}>
          Save items
        </Button>
      </div>
    </Card>
  );
}
