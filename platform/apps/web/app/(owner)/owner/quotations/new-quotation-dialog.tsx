"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button, Dialog, FormField, Input, Select } from "@aura/ui";
import { createQuotationAction, type QuotationItemInput } from "./actions";

interface ItemDraft {
  description: string;
  quantity: string;
  unitPrice: string;
  discountPct: string;
  taxRate: string;
}

const EMPTY_ITEM: ItemDraft = {
  description: "",
  quantity: "1",
  unitPrice: "",
  discountPct: "",
  taxRate: "",
};

/**
 * Start a quotation from a blank slate. No account/contact/deal picker —
 * that stays for a later pass; this dialog is deliberately just currency,
 * discount, and a repeatable line-item list, because that is everything the
 * create endpoint strictly needs.
 *
 * On success the browser is sent straight to the new quotation's detail page
 * — there's nothing useful left to do from the list.
 */
export function NewQuotationDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [currency, setCurrency] = useState("INR");
  const [discountType, setDiscountType] = useState<"none" | "percent" | "amount">("none");
  const [discountValue, setDiscountValue] = useState("0");
  const [validUntil, setValidUntil] = useState("");
  const [notes, setNotes] = useState("");
  const [items, setItems] = useState<ItemDraft[]>([{ ...EMPTY_ITEM }]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const reset = () => {
    setCurrency("INR");
    setDiscountType("none");
    setDiscountValue("0");
    setValidUntil("");
    setNotes("");
    setItems([{ ...EMPTY_ITEM }]);
    setError(null);
  };

  const updateItem = (index: number, patch: Partial<ItemDraft>) => {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const removeItem = (index: number) => {
    setItems((prev) => prev.filter((_, i) => i !== index));
  };

  const submit = () => {
    setError(null);

    const parsed: QuotationItemInput[] = [];
    for (const item of items) {
      if (!item.description.trim()) continue;
      const quantity = Number(item.quantity);
      const unitPrice = Number(item.unitPrice);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        setError(`Enter a valid quantity for "${item.description}"`);
        return;
      }
      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        setError(`Enter a valid unit price for "${item.description}"`);
        return;
      }
      parsed.push({
        description: item.description.trim(),
        quantity,
        unitPrice,
        discountPct: item.discountPct ? Number(item.discountPct) : undefined,
        taxRate: item.taxRate ? Number(item.taxRate) : undefined,
      });
    }
    if (parsed.length === 0) {
      setError("Add at least one line item");
      return;
    }

    startTransition(async () => {
      const result = await createQuotationAction({
        currency: currency.trim() || "INR",
        discount: { type: discountType === "none" ? null : discountType, value: Number(discountValue) || 0 },
        validUntil: validUntil || undefined,
        notes: notes.trim() || undefined,
        items: parsed,
      });
      if (result.error || !result.quotation) {
        setError(result.error ?? "Could not create quotation");
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
          {error ? (
            <p
              role="alert"
              className="rounded-md border border-danger bg-danger-subtle p-3 text-sm font-medium text-danger-text"
            >
              {error}
            </p>
          ) : null}

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
              {items.map((item, index) => (
                <div key={index} className="rounded-md border border-border p-3">
                  <div className="flex items-start gap-2">
                    <div className="flex-1 space-y-2">
                      <Input
                        aria-label="Description"
                        placeholder="Description"
                        value={item.description}
                        onChange={(e) => updateItem(index, { description: e.target.value })}
                      />
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          aria-label="Quantity"
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="Qty"
                          value={item.quantity}
                          onChange={(e) => updateItem(index, { quantity: e.target.value })}
                        />
                        <Input
                          aria-label="Unit price"
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="Unit price"
                          value={item.unitPrice}
                          onChange={(e) => updateItem(index, { unitPrice: e.target.value })}
                        />
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <Input
                          aria-label="Discount percent"
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="Discount %"
                          value={item.discountPct}
                          onChange={(e) => updateItem(index, { discountPct: e.target.value })}
                        />
                        <Input
                          aria-label="Tax rate percent"
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="Tax %"
                          value={item.taxRate}
                          onChange={(e) => updateItem(index, { taxRate: e.target.value })}
                        />
                      </div>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeItem(index)}
                      disabled={items.length === 1}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="mt-3"
              onClick={() => setItems((prev) => [...prev, { ...EMPTY_ITEM }])}
            >
              + Add item
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
