"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import {
  GST_STATES,
  computeDocumentTotals,
  gstStateName,
  isGstStateCode,
  isInterStateSupply,
  splitGst,
} from "@aura/shared";
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
  useToast,
} from "@aura/ui";
import { Time } from "@/components/org-time";
import { useDraftState, useServerState } from "@/lib/use-server-state";
import { LineItemEditor } from "../../line-item-editor";
import type { Product } from "../../products/actions";
import { RecordPicker } from "../../record-picker";
import {
  createPaymentLinkAction,
  updateInvoiceAction,
  type Invoice,
  type InvoiceItem,
  type InvoicePatch,
  type Payment,
  type PaymentProvider,
  type InvoiceStatus,
} from "../actions";
import { selectableStatuses } from "../status-moves";
import { formatMoney } from "../../lib/format-money";
import { previewLineInputs, sourceToLineItemRows, useLineItemRows } from "../../use-line-item-rows";

const PROVIDER_LABEL: Record<PaymentProvider, string> = { razorpay: "Razorpay", stripe: "Stripe" };

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
 *
 * Lines can now be taken off the price list, and the Totals card is computed
 * from the rows on screen (including the CGST/SGST-vs-IGST split) by the same
 * `@aura/shared` functions the API uses when it writes the columns - see the
 * quotation editor's header for why one engine rather than two.
 */
export function InvoiceDetail({
  invoice: initialInvoice,
  items: initialItems,
  payments,
  gateways,
  products,
  homeStateCode,
}: {
  invoice: Invoice;
  items: InvoiceItem[];
  payments: Payment[];
  /** Which gateways a link can go through. Absent from an older API: Razorpay only. */
  gateways?: Record<PaymentProvider, boolean>;
  /** The active price list for the line picker, or `null` if this role may not read it. */
  products: Product[] | null;
  /**
   * The workspace's own GST state (`org_business_profile.state_code`, 0126).
   * With it and a place of supply, the intra/inter-state question answers itself
   * and stops being asked. Null when the workspace has never saved one.
   */
  homeStateCode: string | null;
}) {
  const [invoice, setInvoice] = useServerState(initialInvoice);
  const [status, setStatus] = useDraftState<InvoiceStatus>(initialInvoice.status);
  const alert = useAlert();
  const toast = useToast();
  const [dueDate, setDueDate] = useDraftState(initialInvoice.due_date ? initialInvoice.due_date.slice(0, 10) : "");
  const [notes, setNotes] = useDraftState(initialInvoice.notes ?? "");
  const [customerGstin, setCustomerGstin] = useDraftState(initialInvoice.customer_gstin ?? "");
  const [placeOfSupply, setPlaceOfSupply] = useDraftState(initialInvoice.place_of_supply ?? "");
  const [headerPending, startHeader] = useTransition();

  // Held whole, because `LineItemEditor` takes it whole; `rows` and the two
  // helpers below are the parts this component still needs for itself.
  const lineItems = useLineItemRows(initialItems);
  const { rows, setRows, parse } = lineItems;
  const [discountType, setDiscountType] = useDraftState<"none" | "percent" | "amount">(
    initialInvoice.discount_type ?? "none",
  );
  const [discountValue, setDiscountValue] = useDraftState(
    initialInvoice.discount_value ? String(Number(initialInvoice.discount_value)) : "0",
  );
  const [interState, setInterState] = useDraftState<boolean>(initialInvoice.is_inter_state ?? false);
  const [itemsPending, startItems] = useTransition();

  // Recomputed from the rows on screen on every keystroke, through the same two
  // functions the API runs before it writes subtotal/cgst/sgst/igst/total. No
  // effect, no state, no request.
  const discountNumber = Number(discountValue.trim() || "0");
  const preview = computeDocumentTotals(previewLineInputs(rows), {
    type: discountType === "none" ? null : discountType,
    // A half-typed discount is not a discount. Submit-time validation is what
    // tells somebody about it, rather than a total that reads NaN as they type.
    value: Number.isFinite(discountNumber) && discountNumber >= 0 ? discountNumber : 0,
  });
  /**
   * The intra/inter-state question, answered from the two states when both are
   * known - `isInterStateSupply` is the same rule the API applies before it
   * writes the split, so the preview and the save cannot disagree. `null` means
   * it cannot be told, and the rep's own answer stands.
   *
   * Derived from the SAVED place of supply, not the draft in the selector: the
   * items PATCH does not carry the place of supply, so the server will derive
   * from what is stored. Previewing off the draft would show a split that
   * pressing Save items does not produce. The hint under the GST row is how the
   * draft gets acknowledged instead.
   */
  const derivedInterState = isInterStateSupply(homeStateCode, invoice.place_of_supply);
  const effectiveInterState = derivedInterState ?? interState;
  /** What the treatment WOULD become once the header's draft place of supply is saved. */
  const draftInterState = isInterStateSupply(homeStateCode, placeOfSupply);

  const gst = splitGst(preview.taxTotal, effectiveInterState);
  // Exact comparison: both sides are round2 output from the same function.
  const unsaved =
    preview.subtotal !== Number(invoice.subtotal) ||
    preview.total !== Number(invoice.total) ||
    gst.cgst !== Number(invoice.cgst ?? 0) ||
    gst.sgst !== Number(invoice.sgst ?? 0) ||
    gst.igst !== Number(invoice.igst ?? 0);

  const [paymentUrl, setPaymentUrl] = useState<string | null>(null);
  const [paymentPending, startPayment] = useTransition();

  const [linkPending, startLink] = useTransition();
  const [linkError, setLinkError] = useState<string | null>(null);

  /**
   * Attach or detach the company, person or deal this invoice is for. Saves on
   * pick, optimistically, rolling back if the API refuses - see the quotation
   * editor's `saveLink` for the reasoning.
   *
   * Not gated on `moneyLocked`: the API locks the lines, the discount and the
   * GST treatment on a settled document but not who it is addressed to, and a
   * client-only lock the server does not share is theatre. Whether an issued
   * invoice should be re-pointable at all is a question for the document state
   * machine, not for this component.
   */
  const saveLink = (patch: InvoicePatch, optimistic: Partial<Invoice>) => {
    const previous = invoice;
    setInvoice({ ...invoice, ...optimistic });
    setLinkError(null);
    startLink(async () => {
      const result = await updateInvoiceAction(previous.id, patch);
      if (result.error || !result.invoice) {
        setInvoice(previous);
        setLinkError(result.error ?? "Could not save that link");
        return;
      }
      setInvoice(result.invoice);
    });
  };

  // A link already out through one gateway pins the invoice to it (the API
  // refuses the other). Otherwise every gateway the org can use is offered,
  // Razorpay first - what an unqualified link has always meant.
  const offeredProviders: PaymentProvider[] = invoice.payment_provider
    ? [invoice.payment_provider]
    : (["razorpay", "stripe"] as const).filter((p) =>
        gateways ? gateways[p] : p === "razorpay",
      );
  const [provider, setProvider] = useState<PaymentProvider>(offeredProviders[0] ?? "razorpay");

  const saveHeader = () => {
    startHeader(async () => {
      const result = await updateInvoiceAction(invoice.id, {
        // Only a CHANGE is sent: the API refuses moves it does not allow, and
        // an unchanged status is not a move.
        ...(status !== invoice.status ? { status } : {}),
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
        interState,
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
      setInterState(result.invoice.is_inter_state ?? false);
    });
  };

  const collectPayment = () => {
    startPayment(async () => {
      const result = await createPaymentLinkAction(invoice.id, provider);
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

  /** What the invoice as EDITED would leave outstanding - what the card shows. */
  const balanceDue = preview.total - Number(invoice.amount_paid || 0);
  /**
   * What the invoice as SAVED leaves outstanding. The Collect Payment guard uses
   * this one and not the preview: a gateway link is minted for the stored total,
   * so an unsaved edit must not be able to open or close that button.
   */
  const savedBalanceDue = Number(invoice.total) - Number(invoice.amount_paid || 0);
  // Mirrors the API's lock: once money is in, or the invoice is closed, the
  // lines, discount and GST treatment are a settled tax document.
  const moneyLocked =
    Number(invoice.amount_paid || 0) > 0 || invoice.status === "paid" || invoice.status === "void";

  return (
    <div className="grid gap-6 xl:grid-cols-[1fr_20rem]">
      <div className="space-y-6">
        <LineItemEditor
          caption="Invoice line items"
          currency={invoice.currency}
          products={products}
          items={lineItems}
          discountType={discountType}
          onDiscountTypeChange={setDiscountType}
          discountValue={discountValue}
          onDiscountValueChange={setDiscountValue}
          readOnly={moneyLocked}
          readOnlyNote={
            invoice.status === "void"
              ? "This invoice is void."
              : "Payment has been received, so the lines, discount and GST are locked."
          }
          extraControls={
            <>
              <FormField label="GST" name="gstTreatment">
                {derivedInterState === null ? (
                  // Still a question, because one of the two states is unknown:
                  // set a place of supply below, and the workspace's own state
                  // under Account -> Time & location, and it stops being asked.
                  <>
                    <Select
                      value={interState ? "inter" : "intra"}
                      disabled={moneyLocked}
                      onChange={(e) => setInterState(e.target.value === "inter")}
                    >
                      <option value="intra">CGST + SGST (same state)</option>
                      <option value="inter">IGST (another state)</option>
                    </Select>
                    <p className="mt-1 text-xs text-text-muted">
                      {homeStateCode
                        ? "Pick a place of supply and this is worked out for you."
                        : "Set your workspace's state under Account → Time & location and this is worked out for you."}
                    </p>
                  </>
                ) : (
                  // Not a control: under GST the comparison IS the rule, so a
                  // rep who could override it could only be making a mistake.
                  <p className="text-sm text-text">
                    {derivedInterState ? "IGST" : "CGST + SGST"}
                    <span className="mt-0.5 block text-xs text-text-muted">
                      {derivedInterState
                        ? `${gstStateName(homeStateCode)} to ${gstStateName(invoice.place_of_supply)}`
                        : `Both in ${gstStateName(homeStateCode)}`}
                    </span>
                  </p>
                )}
                {/* The header's place of supply has been changed but not saved,
                    and saving it will move the tax between heads. */}
                {draftInterState !== null && draftInterState !== effectiveInterState ? (
                  <p className="mt-1 text-xs text-text-muted">
                    Saving the place of supply below makes this{" "}
                    {draftInterState ? "IGST" : "CGST + SGST"}.
                  </p>
                ) : null}
              </FormField>
              {/* Keeps the discount pair together on the next grid row. */}
              <div />
            </>
          }
          saving={itemsPending}
          onSave={saveItems}
        />

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
              {/* Only the moves the API allows by hand. "paid" is never one:
                  an invoice becomes paid when a payment is recorded. */}
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value as InvoiceStatus)}
              >
                {selectableStatuses(invoice.status).map((s) => (
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
              {/* A GST state, not free text: it is half of what decides IGST vs
                  CGST + SGST, and "Bangalore office" decides nothing. An invoice
                  saved before this was a list keeps its own value as an extra
                  option, so opening an old invoice cannot silently blank it. */}
              <Select
                value={placeOfSupply}
                onChange={(e) => setPlaceOfSupply(e.target.value)}
              >
                <option value="">Not stated</option>
                {placeOfSupply && !isGstStateCode(placeOfSupply) ? (
                  <option value={placeOfSupply}>{placeOfSupply} (as previously entered)</option>
                ) : null}
                {GST_STATES.map((state) => (
                  <option key={state.code} value={state.code}>
                    {state.name}
                  </option>
                ))}
              </Select>
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
                {formatMoney(preview.subtotal, invoice.currency)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Discount</dt>
              {/* The percentage AND what it comes to. A bare "10%" left the one
                  number a customer will ask about to be worked out by hand. */}
              <dd className="font-medium text-text tabular-nums">
                {discountType === "none"
                  ? "-"
                  : discountType === "percent"
                    ? `${Number.isFinite(discountNumber) ? discountNumber : 0}% · ${formatMoney(preview.discountAmount, invoice.currency)}`
                    : formatMoney(preview.discountAmount, invoice.currency)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Tax</dt>
              <dd className="font-medium text-text tabular-nums">
                {formatMoney(preview.taxTotal, invoice.currency)}
              </dd>
            </div>
            {/* Driven by the GST selector above rather than by the stored
                columns, so switching intra-state to inter-state moves the tax
                between these two rows as you choose it. `> 0` because a zero
                head is noise on the document, not information. */}
            {gst.cgst > 0 || gst.sgst > 0 ? (
              <div className="flex justify-between">
                <dt className="text-text-muted">CGST + SGST</dt>
                <dd className="font-medium text-text tabular-nums">
                  {formatMoney(gst.cgst + gst.sgst, invoice.currency)}
                </dd>
              </div>
            ) : null}
            {gst.igst > 0 ? (
              <div className="flex justify-between">
                <dt className="text-text-muted">IGST</dt>
                <dd className="font-medium text-text tabular-nums">
                  {formatMoney(gst.igst, invoice.currency)}
                </dd>
              </div>
            ) : null}
            <div className="flex justify-between border-t border-border pt-2">
              <dt className="font-medium text-text">Total</dt>
              <dd className="font-semibold text-text tabular-nums">
                {formatMoney(preview.total, invoice.currency)}
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
          {unsaved ? (
            <p className="mt-3 text-xs text-text-muted">
              These are the edits on screen. Save items to store them - the issued
              invoice still totals {formatMoney(invoice.total, invoice.currency)}, and a payment link
              collects that amount until it is saved.
            </p>
          ) : null}
        </Card>

        <Card>
          <MonoLabel>Invoice for</MonoLabel>
          {/* These three were printed as raw uuids, which told the reader nothing
              and could not be changed from here at all. The API's PATCH has
              always accepted all three. */}
          <dl className="mt-3 space-y-3 text-xs">
            <div>
              <dt className="text-text-muted">Company</dt>
              <dd className="mt-1">
                <RecordPicker
                  objectType="account"
                  value={invoice.account_id}
                  disabled={linkPending}
                  onChange={(next) => saveLink({ accountId: next }, { account_id: next })}
                />
                {invoice.account_id ? (
                  <Link
                    href={`/owner/accounts/${invoice.account_id}`}
                    className="mt-1 inline-block text-xs text-accent-text hover:underline"
                  >
                    Open company
                  </Link>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Person</dt>
              <dd className="mt-1">
                <RecordPicker
                  objectType="contact"
                  value={invoice.contact_id}
                  disabled={linkPending}
                  onChange={(next) => saveLink({ contactId: next }, { contact_id: next })}
                />
                {invoice.contact_id ? (
                  <Link
                    href={`/owner/contacts/${invoice.contact_id}`}
                    className="mt-1 inline-block text-xs text-accent-text hover:underline"
                  >
                    Open person
                  </Link>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-text-muted">Deal</dt>
              <dd className="mt-1">
                <RecordPicker
                  objectType="deal"
                  value={invoice.deal_id}
                  disabled={linkPending}
                  onChange={(next) => saveLink({ dealId: next }, { deal_id: next })}
                />
                {/* No "Open deal" link: deals have no detail route - they live on
                    the board and the table at /owner/deals. */}
              </dd>
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
          {linkError ? (
            <p role="alert" className="mt-2 text-xs text-orange-text">
              {linkError}
            </p>
          ) : null}
        </Card>

        <Card>
          <MonoLabel>Collect payment</MonoLabel>
          <p className="mt-2 text-xs text-text-muted">
            Generates a payment link
            {offeredProviders.length === 1 ? ` through ${PROVIDER_LABEL[offeredProviders[0]]}` : ""}.
            Nothing is emailed or texted automatically - copy the link and share it yourself.
          </p>
          {!paymentUrl && offeredProviders.length > 1 ? (
            <div className="mt-3">
              <FormField label="Collect through" name="paymentProvider">
                <Select
                  value={provider}
                  disabled={paymentPending}
                  onChange={(e) => setProvider(e.target.value as PaymentProvider)}
                >
                  {offeredProviders.map((p) => (
                    <option key={p} value={p}>
                      {PROVIDER_LABEL[p]}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
          ) : null}
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
            <Button
              type="button"
              size="sm"
              className="mt-3"
              loading={paymentPending}
              disabled={invoice.status === "void" || savedBalanceDue <= 0}
              onClick={collectPayment}
            >
              Collect Payment
            </Button>
          )}
        </Card>
      </div>
    </div>
  );
}
