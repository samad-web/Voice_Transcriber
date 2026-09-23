"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  Button,
  Card,
  FormField,
  Input,
  MonoLabel,
  Select,
  StatusChip,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  useAlert,
  useConfirm,
  useToast,
} from "@aura/ui";
import { Time } from "@/components/org-time";
import {
  createPaymentLinkAction,
  updateInvoiceAction,
  type Invoice,
  type InvoiceItem,
  type Payment,
  type InvoiceStatus,
} from "../actions";
import { formatMoney } from "../../lib/format-money";
import { sourceToLineItemRows, useLineItemRows } from "../../use-line-item-rows";

const STATUS_OPTIONS: InvoiceStatus[] = ["draft", "sent", "paid", "overdue", "void"];

function paymentTone(status: Payment["status"]): "solid" | "outline" | "danger" {
  if (status === "paid") return "solid";
  if (status === "failed") return "danger";
  return "outline";
}

/**
 * The invoice detail page's interactive half: header (status/due
 * date/GST/notes), the line-item table, payment history, and the one button
 * that actually matters - Collect Payment. That last one is deliberately its
 * own island of state: the payment link it mints has nowhere else to live
 * (the payments list the API returns has no URL field, only an id), so it
 * must survive whatever else on this page saves and re-renders around it.
 */
export function InvoiceDetail({
  invoice: initialInvoice,
  items: initialItems,
  payments,
}: {
  invoice: Invoice;
  items: InvoiceItem[];
  payments: Payment[];
}) {
  const [invoice, setInvoice] = useState(initialInvoice);
  const [status, setStatus] = useState<InvoiceStatus>(initialInvoice.status);
  const confirm = useConfirm();
  const alert = useAlert();
  const toast = useToast();
  const [dueDate, setDueDate] = useState(initialInvoice.due_date ? initialInvoice.due_date.slice(0, 10) : "");
  const [notes, setNotes] = useState(initialInvoice.notes ?? "");
  const [customerGstin, setCustomerGstin] = useState(initialInvoice.customer_gstin ?? "");
  const [placeOfSupply, setPlaceOfSupply] = useState(initialInvoice.place_of_supply ?? "");
  const [headerPending, startHeader] = useTransition();

  const { rows, setRows, updateRow, removeRow, addRow, parse } = useLineItemRows(initialItems);
  const [discountType, setDiscountType] = useState<"none" | "percent" | "amount">(
    initialInvoice.discount_type ?? "none",
  );
  const [discountValue, setDiscountValue] = useState(
    initialInvoice.discount_value ? String(Number(initialInvoice.discount_value)) : "0",
  );
  const [itemsPending, startItems] = useTransition();

  const [paymentUrl, setPaymentUrl] = useState<string | null>(null);
  const [paymentPending, startPayment] = useTransition();

  const saveHeader = () => {
    startHeader(async () => {
      const result = await updateInvoiceAction(invoice.id, {
        status,
        dueDate: dueDate || null,
        notes: notes.trim() || null,
        customerGstin: customerGstin.trim() || null,
        placeOfSupply: placeOfSupply.trim() || null,
      });
      if (result.error || !result.invoice) {
        await alert({
          title: "Couldn't save the invoice details",
          body: result.error ?? "The server did not return the updated invoice.",
          tone: "danger",
        });
        return;
      }
      setInvoice(result.invoice);
      setStatus(result.invoice.status);
      setDueDate(result.invoice.due_date ? result.invoice.due_date.slice(0, 10) : "");
      setNotes(result.invoice.notes ?? "");
      setCustomerGstin(result.invoice.customer_gstin ?? "");
      setPlaceOfSupply(result.invoice.place_of_supply ?? "");
    });
  };

  const saveItems = () => {
    const parsed = parse("An invoice needs at least one line item");
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
        title: "Enter a valid discount value",
        body: "The discount has to be a number, and not a negative one.",
        tone: "danger",
      });
      return;
    }

    startItems(async () => {
      const result = await updateInvoiceAction(invoice.id, {
        items: parsed.items,
        discount: {
          type: discountType === "none" ? null : discountType,
          value: discountNum,
        },
      });
      if (result.error || !result.invoice) {
        await alert({
          title: "Couldn't save the line items",
          body: result.error ?? "The server did not return the updated invoice.",
          tone: "danger",
        });
        return;
      }
      setInvoice(result.invoice);
      if (result.items) setRows(sourceToLineItemRows(result.items));
      setDiscountType(result.invoice.discount_type ?? "none");
      setDiscountValue(
        result.invoice.discount_value ? String(Number(result.invoice.discount_value)) : "0",
      );
    });
  };

  const collectPayment = () => {
    startPayment(async () => {
      const result = await createPaymentLinkAction(invoice.id);
      if (result.error || !result.paymentLinkUrl) {
        await alert({
          title: "Couldn't create a payment link",
          body: result.error ?? "The provider did not return a link.",
          tone: "danger",
        });
        return;
      }
      setPaymentUrl(result.paymentLinkUrl);
    });
  };

  const copyLink = async () => {
    if (!paymentUrl) return;
    try {
      await navigator.clipboard.writeText(paymentUrl);
      toast("Copied");
    } catch {
      await alert({
        title: "Couldn't copy the link",
        body: "Your browser blocked the clipboard. Select the link and copy it by hand.",
        tone: "danger",
      });
    }
  };

  const balanceDue = Number(invoice.total) - Number(invoice.amount_paid || 0);

  // "Paid" is a claim about money actually received - selecting it while a
  // balance is still outstanding is very likely a mistake, so it gets the same
  // confirmation dialog the rest of the console uses before any other
  // consequential, hard-to-undo action (e.g. team-manager.tsx's member
  // removal, device-actions.tsx's device actions).
  const handleStatusChange = async (next: InvoiceStatus) => {
    if (next === "paid" && next !== status && balanceDue > 0) {
      const ok = await confirm({
        title: "Mark this invoice paid?",
        body: `A balance of ${formatMoney(balanceDue, invoice.currency)} is still due. Marking it paid records money you may not have received.`,
        confirmLabel: "Mark paid",
        tone: "danger",
        // Recoverable: the status can be set back, and no record is destroyed.
        // Loud, but not a deletion.
        requireTyped: false,
      });
      if (!ok) return;
    }
    setStatus(next);
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
        <Card>
          <MonoLabel>Line items</MonoLabel>

          <div className="mt-3">
            <Table caption="Invoice line items">
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
                      {row.lineTotal ? formatMoney(row.lineTotal, invoice.currency) : "unsaved"}
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

        <Card>
          <MonoLabel>Payments</MonoLabel>
          {payments.length === 0 ? (
            <p className="mt-3 text-sm text-text-muted">No payment attempts yet.</p>
          ) : (
            <div className="mt-3">
              <Table caption="Payment history">
                <TableHead>
                  <tr>
                    <TableHeaderCell>Provider</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>Amount</TableHeaderCell>
                    <TableHeaderCell>Created</TableHeaderCell>
                    <TableHeaderCell>Captured</TableHeaderCell>
                  </tr>
                </TableHead>
                <TableBody>
                  {payments.map((payment) => (
                    <TableRow key={payment.id}>
                      <TableCell className="text-text-muted">{payment.provider}</TableCell>
                      <TableCell>
                        <StatusChip tone={paymentTone(payment.status)}>{payment.status}</StatusChip>
                      </TableCell>
                      <TableCell className="tabular-nums text-text-muted">
                        {formatMoney(payment.amount, payment.currency)}
                      </TableCell>
                      <TableCell className="text-text-muted">
                        <Time iso={payment.created_at} mode="datetime" />
                      </TableCell>
                      <TableCell className="text-text-muted">
                        {payment.captured_at ? <Time iso={payment.captured_at} mode="datetime" /> : "-"}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <MonoLabel>Details</MonoLabel>
          <div className="mt-3 space-y-3">
            <FormField label="Status" name="status">
              <Select
                value={status}
                onChange={(e) => void handleStatusChange(e.target.value as InvoiceStatus)}
              >
                {STATUS_OPTIONS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Due date" name="dueDate">
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </FormField>
            <FormField label="Customer GSTIN" name="customerGstin">
              <Input
                value={customerGstin}
                onChange={(e) => setCustomerGstin(e.target.value.toUpperCase())}
              />
            </FormField>
            <FormField label="Place of supply" name="placeOfSupply">
              <Input value={placeOfSupply} onChange={(e) => setPlaceOfSupply(e.target.value)} />
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
                {formatMoney(invoice.subtotal, invoice.currency)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Discount</dt>
              <dd className="font-medium text-text tabular-nums">
                {invoice.discount_type
                  ? invoice.discount_type === "percent"
                    ? `${Number(invoice.discount_value ?? 0)}%`
                    : formatMoney(invoice.discount_value, invoice.currency)
                  : "-"}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Tax</dt>
              <dd className="font-medium text-text tabular-nums">
                {formatMoney(invoice.tax_total, invoice.currency)}
              </dd>
            </div>
            {/* The API returns these as Postgres numeric strings (e.g. "0.00"),
                which are truthy even at zero - comparing the raw field would
                show a "₹0.00" row on every domestic invoice. */}
            {Number(invoice.cgst ?? 0) > 0 || Number(invoice.sgst ?? 0) > 0 ? (
              <div className="flex justify-between">
                <dt className="text-text-muted">CGST + SGST</dt>
                <dd className="font-medium text-text tabular-nums">
                  {formatMoney(Number(invoice.cgst ?? 0) + Number(invoice.sgst ?? 0), invoice.currency)}
                </dd>
              </div>
            ) : null}
            {Number(invoice.igst ?? 0) > 0 ? (
              <div className="flex justify-between">
                <dt className="text-text-muted">IGST</dt>
                <dd className="font-medium text-text tabular-nums">
                  {formatMoney(invoice.igst, invoice.currency)}
                </dd>
              </div>
            ) : null}
            <div className="flex justify-between border-t border-border pt-2">
              <dt className="font-medium text-text">Total</dt>
              <dd className="font-semibold text-text tabular-nums">
                {formatMoney(invoice.total, invoice.currency)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Amount paid</dt>
              <dd className="font-medium text-text tabular-nums">
                {formatMoney(invoice.amount_paid, invoice.currency)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Balance due</dt>
              <dd className="font-medium text-text tabular-nums">
                {formatMoney(balanceDue, invoice.currency)}
              </dd>
            </div>
          </dl>
        </Card>

        <Card>
          <MonoLabel>Linked to</MonoLabel>
          <dl className="mt-3 space-y-2.5 text-xs">
            <div>
              <dt className="text-text-muted">Account</dt>
              <dd className="mt-0.5 font-medium break-words text-text">{invoice.account_id ?? "-"}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Contact</dt>
              <dd className="mt-0.5 font-medium break-words text-text">{invoice.contact_id ?? "-"}</dd>
            </div>
            <div>
              <dt className="text-text-muted">Deal</dt>
              <dd className="mt-0.5 font-medium break-words text-text">{invoice.deal_id ?? "-"}</dd>
            </div>
            {invoice.quotation_id ? (
              <div>
                <dt className="text-text-muted">Quotation</dt>
                <dd className="mt-0.5">
                  <Link
                    href={`/owner/quotations/${invoice.quotation_id}`}
                    className="font-medium text-text hover:underline"
                  >
                    View quotation
                  </Link>
                </dd>
              </div>
            ) : null}
          </dl>
        </Card>

        <Card>
          <MonoLabel>Collect payment</MonoLabel>
          <p className="mt-2 text-xs text-text-muted">
            Generates a Razorpay payment link. Nothing is emailed or texted automatically - copy the
            link and share it yourself.
          </p>
          {paymentUrl ? (
            <div className="mt-3 flex items-center gap-2">
              <Input
                readOnly
                aria-label="Payment link"
                value={paymentUrl}
                onFocus={(e) => e.currentTarget.select()}
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void copyLink()}
              >
                Copy
              </Button>
            </div>
          ) : (
            <Button type="button" size="sm" className="mt-3" loading={paymentPending} onClick={collectPayment}>
              Collect Payment
            </Button>
          )}
        </Card>
      </div>
    </div>
  );
}
