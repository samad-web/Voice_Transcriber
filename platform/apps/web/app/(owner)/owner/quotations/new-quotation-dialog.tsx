"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { computeDocumentTotals } from "@aura/shared";
import { Button, Dialog, FormField, Input, Select, useAlert } from "@aura/ui";
import { formatMoney } from "../lib/format-money";
import { PriceListPicker } from "../price-list-picker";
import type { Product } from "../products/actions";
import {
  createLineItemRow,
  previewLineInputs,
  rowLineTotal,
  useLineItemRows,
} from "../use-line-item-rows";
import { createQuotationAction } from "./actions";

/**
 * Start a quotation from a blank slate. No account/contact/deal picker -
 * that stays for a later pass; this dialog is deliberately just currency,
 * discount, and a repeatable line-item list, because that is everything the
 * create endpoint strictly needs.
 *
 * Lines come off the price list (`products`) or are typed by hand, and the
 * running total is computed from them by the same `@aura/shared` function the
 * API will use when it saves - before this, you priced a quotation blind and
 * found out what it came to on the page after.
 *
 * On success the browser is sent straight to the new quotation's detail page
 * - there's nothing useful left to do from the list.
 */
export function NewQuotationDialog({ products }: { products: Product[] | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [currency, setCurrency] = useState("INR");
  const [discountType, setDiscountType] = useState<"none" | "percent" | "amount">("none");
  const [discountValue, setDiscountValue] = useState("0");
  const [validUntil, setValidUntil] = useState("");
  const [notes, setNotes] = useState("");
  const { rows, setRows, updateRow, removeRow, addRow, addProductRow, unlinkRow, parse } =
    useLineItemRows();
  const [pending, startTransition] = useTransition();
  const alert = useAlert();

  const discountNumber = Number(discountValue.trim() || "0");
  const preview = computeDocumentTotals(previewLineInputs(rows), {
    type: discountType === "none" ? null : discountType,
    // A half-typed discount is not a discount; validation on submit is what
    // tells somebody about it, not a total that reads NaN while they type.
    value: Number.isFinite(discountNumber) && discountNumber >= 0 ? discountNumber : 0,
  });

  const reset = () => {
    setCurrency("INR");
    setDiscountType("none");
    setDiscountValue("0");
    setValidUntil("");
    setNotes("");
    setRows([createLineItemRow()]);
  };

  const submit = () => {
    const parsed = parse("Add at least one line item");
    if (parsed.items === null) {
      void alert({
        title: "Couldn't create the quotation",
        body: parsed.error,
        tone: "danger",
      });
      return;
    }

    const trimmedDiscount = discountValue.trim();
    const discountNum = trimmedDiscount === "" ? 0 : Number(trimmedDiscount);
    if (trimmedDiscount !== "" && (!Number.isFinite(discountNum) || discountNum < 0)) {
      void alert({
        title: "Couldn't create the quotation",
        body: "Enter a valid discount value",
        tone: "danger",
      });
      return;
    }

    startTransition(async () => {
      const result = await createQuotationAction({
        currency: currency.trim() || "INR",
        discount: { type: discountType === "none" ? null : discountType, value: discountNum },
        validUntil: validUntil || undefined,
        notes: notes.trim() || undefined,
        items: parsed.items,
      });
      if (result.error || !result.quotation) {
        await alert({
          title: "Couldn't create the quotation",
          body: result.error ?? "Could not create quotation",
          tone: "danger",
        });
        return;
      }
      const id = result.quotation.id;
      setOpen(false);
      reset();
      router.push(`/owner/quotations/${id}`);
    });
  };

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>
        New Quotation
      </Button>

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          reset();
        }}
        title="New quotation"
        footer={
          <>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" loading={pending} onClick={submit}>
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <FormField label="Currency" name="currency" required>
              <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
            </FormField>
            <FormField label="Valid until" name="validUntil">
              <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </FormField>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <FormField label="Discount type" name="discountType">
              <Select
                value={discountType}
                onChange={(e) => setDiscountType(e.target.value as typeof discountType)}
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
                disabled={discountType === "none"}
                value={discountValue}
                onChange={(e) => setDiscountValue(e.target.value)}
              />
            </FormField>
          </div>

          <FormField label="Notes" name="notes">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted hover:border-text-subtle"
            />
          </FormField>

          <div>
            <p className="text-sm font-medium text-text">Line items</p>
            <div className="mt-2 space-y-3">
              {rows.map((row) => (
                <div key={row.key} className="rounded-md border border-border p-3">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 space-y-2">
                      {row.productId ? (
                        <p className="flex items-center gap-2 text-xs text-text-muted">
                          <span className="min-w-0 truncate">
                            Price list: {row.productName ?? "linked item"}
                          </span>
                          <button
                            type="button"
                            onClick={() => unlinkRow(row.key)}
                            className="shrink-0 hover:text-text"
                          >
                            Unlink
                          </button>
                        </p>
                      ) : null}
                      <Input
                        aria-label="Description"
                        placeholder="Description"
                        value={row.description}
                        onChange={(e) => updateRow(row.key, { description: e.target.value })}
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          aria-label="Quantity"
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="Qty"
                          value={row.quantity}
                          onChange={(e) => updateRow(row.key, { quantity: e.target.value })}
                        />
                        <Input
                          aria-label="Unit price"
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="Unit price"
                          value={row.unitPrice}
                          onChange={(e) => updateRow(row.key, { unitPrice: e.target.value })}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          aria-label="Discount percent"
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="Discount %"
                          value={row.discountPct}
                          onChange={(e) => updateRow(row.key, { discountPct: e.target.value })}
                        />
                        <Input
                          aria-label="Tax rate percent"
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="Tax %"
                          value={row.taxRate}
                          onChange={(e) => updateRow(row.key, { taxRate: e.target.value })}
                        />
                      </div>
                      <p className="text-xs text-text-muted tabular-nums">
                        Line total:{" "}
                        {(() => {
                          const live = rowLineTotal(row);
                          return live === null ? "-" : formatMoney(live, currency);
                        })()}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeRow(row.key)}
                      disabled={rows.length === 1}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button type="button" variant="secondary" size="sm" onClick={addRow}>
                + Add item
              </Button>
              <PriceListPicker
                currency={currency}
                initialProducts={products}
                onPick={(product) => addProductRow(product, currency)}
              />
            </div>

            <dl className="mt-4 space-y-1.5 border-t border-border pt-3 text-xs">
              <div className="flex justify-between">
                <dt className="text-text-muted">Subtotal</dt>
                <dd className="font-medium text-text tabular-nums">
                  {formatMoney(preview.subtotal, currency)}
                </dd>
              </div>
              {preview.discountAmount > 0 ? (
                <div className="flex justify-between">
                  <dt className="text-text-muted">Discount</dt>
                  <dd className="font-medium text-text tabular-nums">
                    -{formatMoney(preview.discountAmount, currency)}
                  </dd>
                </div>
              ) : null}
              {preview.taxTotal > 0 ? (
                <div className="flex justify-between">
                  <dt className="text-text-muted">Tax</dt>
                  <dd className="font-medium text-text tabular-nums">
                    {formatMoney(preview.taxTotal, currency)}
                  </dd>
                </div>
              ) : null}
              <div className="flex justify-between border-t border-border pt-1.5">
                <dt className="font-medium text-text">Total</dt>
                <dd className="font-semibold text-text tabular-nums">
                  {formatMoney(preview.total, currency)}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </Dialog>
    </>
  );
}
