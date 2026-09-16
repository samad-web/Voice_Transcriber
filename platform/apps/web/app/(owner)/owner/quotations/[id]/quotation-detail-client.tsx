"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
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
  useAlert,
} from "@aura/ui";
import { createInvoiceFromQuotationAction } from "../../invoices/actions";
import {
  updateQuotationAction,
  type Quotation,
  type QuotationItem,
  type QuotationStatus,
} from "../actions";
import { formatMoney } from "../../lib/format-money";
import { sourceToLineItemRows, useLineItemRows } from "../../use-line-item-rows";

const STATUS_OPTIONS: QuotationStatus[] = ["draft", "sent", "accepted", "rejected", "expired"];

/**
 * The quotation detail page's interactive half - status/valid-until/notes as
 * one PATCH, the line-item table as another. Account/contact/deal are
 * rendered read-only in the parent server page; there's no picker yet.
 *
 * Every save uses the fresh `quotation`/`items` the action returns to update
 * local state directly, rather than relying on the server page re-rendering
 * around this component - the API recomputes subtotal/tax/total server-side,
 * and this is the one path that is guaranteed to reflect that recomputation
 * without a second round trip.
 */
export function QuotationDetail({
  quotation: initialQuotation,
  items: initialItems,
}: {
  quotation: Quotation;
  items: QuotationItem[];
}) {
  const router = useRouter();
  const alert = useAlert();

  const [quotation, setQuotation] = useState(initialQuotation);
  const [status, setStatus] = useState<QuotationStatus>(initialQuotation.status);
  const [validUntil, setValidUntil] = useState(
    initialQuotation.valid_until ? initialQuotation.valid_until.slice(0, 10) : "",
  );
  const [notes, setNotes] = useState(initialQuotation.notes ?? "");
  const [headerPending, startHeader] = useTransition();

  const { rows, setRows, updateRow, removeRow, addRow, parse } = useLineItemRows(initialItems);
  const [discountType, setDiscountType] = useState<"none" | "percent" | "amount">(
    initialQuotation.discount_type ?? "none",
  );
  const [discountValue, setDiscountValue] = useState(
    initialQuotation.discount_value ? String(Number(initialQuotation.discount_value)) : "0",
  );
  const [itemsPending, startItems] = useTransition();

  const [invoicePending, startInvoice] = useTransition();

  const saveHeader = () => {
    startHeader(async () => {
      const result = await updateQuotationAction(quotation.id, {
        status,
        validUntil: validUntil || null,
        notes: notes.trim() || null,
      });
      if (result.error || !result.quotation) {
        await alert({
          title: "Couldn't save the quotation",
          body: result.error ?? "Could not save",
          tone: "danger",
        });
        return;
      }
      setQuotation(result.quotation);
      setStatus(result.quotation.status);
      setValidUntil(result.quotation.valid_until ? result.quotation.valid_until.slice(0, 10) : "");
      setNotes(result.quotation.notes ?? "");
    });
  };

  const saveItems = () => {
    const parsed = parse("A quotation needs at least one line item");
    if (parsed.items === null) {
      void alert({
        title: "Couldn't save the line items",
        body: parsed.error,
        tone: "danger",
      });
      return;
    }

    const trimmedDiscount = discountValue.trim();
    const discountNum = trimmedDiscount === "" ? 0 : Number(trimmedDiscount);
    if (trimmedDiscount !== "" && (!Number.isFinite(discountNum) || discountNum < 0)) {
      void alert({
        title: "Couldn't save the line items",
        body: "Enter a valid discount value",
        tone: "danger",
      });
      return;
    }

    startItems(async () => {
      const result = await updateQuotationAction(quotation.id, {
        items: parsed.items,
        discount: {
          type: discountType === "none" ? null : discountType,
          value: discountNum,
        },
      });
      if (result.error || !result.quotation) {
        await alert({
          title: "Couldn't save the line items",
          body: result.error ?? "Could not save items",
          tone: "danger",
        });
        return;
      }
      setQuotation(result.quotation);
      if (result.items) setRows(sourceToLineItemRows(result.items));
      setDiscountType(result.quotation.discount_type ?? "none");
      setDiscountValue(
        result.quotation.discount_value ? String(Number(result.quotation.discount_value)) : "0",
      );
    });
  };

  const createInvoice = () => {
    startInvoice(async () => {
      const result = await createInvoiceFromQuotationAction(quotation.id);
      if (result.error || !result.invoice) {
        await alert({
          title: "Couldn't create the invoice",
          body: result.error ?? "Could not create invoice",
          tone: "danger",
        });
        return;
      }
      router.push(`/owner/invoices/${result.invoice.id}`);
    });
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
        <Card>
          <MonoLabel>Line items</MonoLabel>

          <div className="mt-3">
            <Table caption="Quotation line items">
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
                {rows.map((row) => (
                  <TableRow key={row.key}>
                    <TableCell>
                      <Input
                        aria-label="Description"
                        value={row.description}
                        onChange={(e) => updateRow(row.key, { description: e.target.value })}
                      />
                    </TableCell>
                    <TableCell>
                      <Input
                        aria-label="Quantity"
                        type="number"
                        min="0"
                        step="0.01"
                        value={row.quantity}
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
                        onChange={(e) => updateRow(row.key, { taxRate: e.target.value })}
                      />
                    </TableCell>
                    <TableCell className="tabular-nums text-text-muted">
                      {row.lineTotal ? formatMoney(row.lineTotal, quotation.currency) : "unsaved"}
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeRow(row.key)}
                        disabled={rows.length === 1}
                      >
                        Remove
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell colSpan={7}>
                    <Button type="button" variant="secondary" size="sm" onClick={addRow}>
                      + Add item
                    </Button>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-4 border-t border-border pt-4">
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

          <div className="mt-4 flex justify-end">
            <Button type="button" loading={itemsPending} onClick={saveItems}>
              Save items
            </Button>
          </div>
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <MonoLabel>Details</MonoLabel>
          <div className="mt-3 space-y-3">
            <FormField label="Status" name="status">
              <Select value={status} onChange={(e) => setStatus(e.target.value as QuotationStatus)}>
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Valid until" name="validUntil">
              <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
            </FormField>
            <FormField label="Notes" name="notes">
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-text placeholder:text-text-muted hover:border-text-subtle"
              />
            </FormField>
            <Button type="button" loading={headerPending} onClick={saveHeader}>
              Save
            </Button>
          </div>
        </Card>

        <Card>
          <MonoLabel>Totals</MonoLabel>
          <dl className="mt-3 space-y-2 text-xs">
            <div className="flex justify-between">
              <dt className="text-text-muted">Subtotal</dt>
              <dd className="font-medium text-text tabular-nums">
                {formatMoney(quotation.subtotal, quotation.currency)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Discount</dt>
              <dd className="font-medium text-text tabular-nums">
                {quotation.discount_type
                  ? quotation.discount_type === "percent"
                    ? `${Number(quotation.discount_value ?? 0)}%`
                    : formatMoney(quotation.discount_value, quotation.currency)
                  : "-"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Tax</dt>
              <dd className="font-medium text-text tabular-nums">
                {formatMoney(quotation.tax_total, quotation.currency)}
              </dd>
            </div>
            <div className="flex justify-between border-t border-border pt-2">
              <dt className="font-medium text-text">Total</dt>
              <dd className="font-semibold text-text tabular-nums">
                {formatMoney(quotation.total, quotation.currency)}
              </dd>
            </div>
          </dl>
        </Card>

        <Card>
          <MonoLabel>Linked to</MonoLabel>
          <dl className="mt-3 space-y-2.5 text-xs">
            <div>
              <dt className="text-text-muted">Account</dt>
              <dd className="mt-0.5 font-medium break-words text-text">
                {quotation.account_id ?? "-"}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Contact</dt>
              <dd className="mt-0.5 font-medium break-words text-text">
                {quotation.contact_id ?? "-"}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Deal</dt>
              <dd className="mt-0.5 font-medium break-words text-text">{quotation.deal_id ?? "-"}</dd>
            </div>
          </dl>
        </Card>

        <Card>
          <MonoLabel>Invoice</MonoLabel>
          <p className="mt-2 text-xs text-text-muted">
            Turns this quotation into a draft invoice, cloning its items and discount. Nothing sends
            automatically - you still generate and share the payment link yourself once it exists.
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-3"
            loading={invoicePending}
            onClick={createInvoice}
            disabled={quotation.status !== "accepted"}
          >
            Create invoice
          </Button>
          {quotation.status !== "accepted" ? (
            <p className="mt-2 text-xs text-text-muted">
              Only an accepted quotation can be turned into an invoice - set the status above to
              Accepted and save first.
            </p>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
