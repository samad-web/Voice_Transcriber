"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, FormField, Input, Select, useAlert } from "@aura/ui";
import { createQuotationAction } from "./actions";
import { createLineItemRow, useLineItemRows } from "../use-line-item-rows";

/**
 * Start a quotation from a blank slate. No account/contact/deal picker -
 * that stays for a later pass; this dialog is deliberately just currency,
 * discount, and a repeatable line-item list, because that is everything the
 * create endpoint strictly needs.
 *
 * On success the browser is sent straight to the new quotation's detail page
 * - there's nothing useful left to do from the list.
 */
export function NewQuotationDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [currency, setCurrency] = useState("INR");
  const [discountType, setDiscountType] = useState<"none" | "percent" | "amount">("none");
  const [discountValue, setDiscountValue] = useState("0");
  const [validUntil, setValidUntil] = useState("");
  const [notes, setNotes] = useState("");
  const { rows, setRows, updateRow, removeRow, addRow, parse } = useLineItemRows();
  const [pending, startTransition] = useTransition();
  const alert = useAlert();

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
            <Button type="button" variant="secondary" size="sm" className="mt-3" onClick={addRow}>
              + Add item
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
