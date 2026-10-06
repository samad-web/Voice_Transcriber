"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  QUOTATION_MANUAL_MOVES,
  canReviseQuotation,
  computeDocumentTotals,
  quotationEditable,
} from "@aura/shared";
import { Button, Card, FormField, Input, MonoLabel, Select, useAlert } from "@aura/ui";
import { useDraftState, useServerState } from "@/lib/use-server-state";
import { createInvoiceFromQuotationAction } from "../../invoices/actions";
import { LineItemEditor } from "../../line-item-editor";
import type { Product } from "../../products/actions";
import { RecordPicker } from "../../record-picker";
import {
  reviseQuotationAction,
  updateQuotationAction,
  type Quotation,
  type QuotationItem,
  type QuotationPatch,
  type QuotationRevision,
  type QuotationStatus,
} from "../actions";
import { formatMoney } from "../../lib/format-money";
import { previewLineInputs, sourceToLineItemRows, useLineItemRows } from "../../use-line-item-rows";

/**
 * The statuses the select offers: where it is now, plus the moves the API will
 * actually accept from there.
 *
 * It used to list all five unconditionally, so the form offered moves the API
 * now refuses - and offered `expired`, which only the calendar may set. Derived
 * from the same table the API enforces, so the two cannot disagree. Mirrors what
 * `invoices/status-moves.ts` does for invoices.
 */
function selectableStatuses(current: QuotationStatus): QuotationStatus[] {
  return [current, ...QUOTATION_MANUAL_MOVES[current]];
}

/** A discount box mid-edit is any string at all; the totals preview treats nonsense as no discount. */
function safeDiscountValue(raw: string): number {
  const value = Number(raw.trim() || "0");
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

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
 *
 * ── THE TOTALS ON SCREEN ARE COMPUTED, NOT FETCHED ─────────────────────────
 *
 * Line totals used to read the literal word "unsaved" and the Totals card
 * showed the last SAVED figures, so pricing a quotation meant saving to find
 * out what it came to. Both now run through `@aura/shared`'s
 * `computeDocumentTotals` - the same function, in the same package, that the
 * API calls before it writes the columns. That is why a preview is safe here
 * and would not be if this file did the arithmetic itself: there is one engine,
 * so "what it will save" and "what you can see" cannot disagree. After a save
 * the rows rehydrate from the API's response, the same inputs go back through
 * the same function, and `unsaved` below settles to false on its own.
 */
export function QuotationDetail({
  quotation: initialQuotation,
  items: initialItems,
  revisions,
  products,
}: {
  quotation: Quotation;
  items: QuotationItem[];
  /** Every revision of this quotation, oldest first. Empty when it has never been revised. */
  revisions: QuotationRevision[];
  /** The active price list for the line picker, or `null` if this role may not read it. */
  products: Product[] | null;
}) {
  const router = useRouter();
  const alert = useAlert();

  const [quotation, setQuotation] = useServerState(initialQuotation);
  const [status, setStatus] = useDraftState<QuotationStatus>(initialQuotation.status);
  const [validUntil, setValidUntil] = useDraftState(
    initialQuotation.valid_until ? initialQuotation.valid_until.slice(0, 10) : "",
  );
  const [notes, setNotes] = useDraftState(initialQuotation.notes ?? "");
  const [headerPending, startHeader] = useTransition();

  // Held whole, because `LineItemEditor` takes it whole; `rows` and the two
  // helpers below are the parts this component still needs for itself.
  const lineItems = useLineItemRows(initialItems);
  const { rows, setRows, parse } = lineItems;
  const [discountType, setDiscountType] = useDraftState<"none" | "percent" | "amount">(
    initialQuotation.discount_type ?? "none",
  );
  const [discountValue, setDiscountValue] = useDraftState(
    initialQuotation.discount_value ? String(Number(initialQuotation.discount_value)) : "0",
  );
  const [itemsPending, startItems] = useTransition();

  const [invoicePending, startInvoice] = useTransition();
  const [revisePending, startRevise] = useTransition();

  /** Sent and beyond: the numbers are what a customer was told. Revise, don't rewrite. */
  const editable = quotationEditable(quotation.status);
  const revisable = canReviseQuotation(quotation.status);

  const revise = () => {
    startRevise(async () => {
      const result = await reviseQuotationAction(quotation.id);
      if (result.error || !result.quotation) {
        await alert({
          title: "Couldn't raise a revision",
          body: result.error ?? "Could not revise this quotation",
          tone: "danger",
        });
        return;
      }
      // Straight to the new draft - there is nothing left to do on a superseded
      // document, and staying here would show a locked page.
      router.push(`/owner/quotations/${result.quotation.id}`);
    });
  };

  const [linkPending, startLink] = useTransition();
  const [linkError, setLinkError] = useState<string | null>(null);

  /**
   * Attach or detach the company, person or deal this quotation is for.
   *
   * Saves on pick rather than behind a third Save button: a link is a discrete
   * choice, not text somebody is part-way through typing, and this is the same
   * behaviour `contact-details.tsx` has for a contact's company. The row is
   * updated optimistically and rolled back if the API refuses - a record from
   * another org is a 400 out of `assertInOrg`, and it must not look like it
   * stuck.
   */
  const saveLink = (patch: QuotationPatch, optimistic: Partial<Quotation>) => {
    const previous = quotation;
    setQuotation({ ...quotation, ...optimistic });
    setLinkError(null);
    startLink(async () => {
      const result = await updateQuotationAction(previous.id, patch);
      if (result.error || !result.quotation) {
        setQuotation(previous);
        setLinkError(result.error ?? "Could not save that link");
        return;
      }
      setQuotation(result.quotation);
    });
  };

  // Recomputed on every keystroke from the rows as they stand. No effect, no
  // state, no request - it is a pure function of what is on screen.
  const preview = computeDocumentTotals(previewLineInputs(rows), {
    type: discountType === "none" ? null : discountType,
    value: safeDiscountValue(discountValue),
  });
  // Exact comparison is right: both sides are this same function's round2
  // output, so they are equal to the cent or the document has been edited.
  const unsaved =
    preview.subtotal !== Number(quotation.subtotal) ||
    preview.taxTotal !== Number(quotation.tax_total) ||
    preview.total !== Number(quotation.total);

  const saveHeader = () => {
    startHeader(async () => {
      const result = await updateQuotationAction(quotation.id, {
        // Only a CHANGE is sent: the API refuses moves it does not allow, and an
        // unchanged status is not a move.
        ...(status !== quotation.status ? { status } : {}),
        // Only while the offer is still editable. `validUntil` is part of what
        // the customer was told, so the API counts sending it at all as changing
        // the offer - and marking a SENT quotation accepted, which is the main
        // thing this button does, must not be refused because the form posted a
        // validity it was not changing.
        ...(editable ? { validUntil: validUntil || null } : {}),
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
        <LineItemEditor
          caption="Quotation line items"
          currency={quotation.currency}
          products={products}
          items={lineItems}
          discountType={discountType}
          onDiscountTypeChange={setDiscountType}
          discountValue={discountValue}
          onDiscountValueChange={setDiscountValue}
          readOnly={!editable}
          readOnlyNote={
            quotation.status === "superseded"
              ? "A revision has replaced this quotation."
              : `This quotation is ${quotation.status} - its lines are what the customer was told. Use Revise to change them.`
          }
          saving={itemsPending}
          onSave={saveItems}
        />
      </div>

      <div className="space-y-4">
        <Card>
          <MonoLabel>Details</MonoLabel>
          <div className="mt-3 space-y-3">
            <FormField label="Status" name="status">
              {/* Only the moves the API allows from here. `expired` is never one:
                  it means the date has passed, and only the sweep sets it. */}
              <Select value={status} onChange={(e) => setStatus(e.target.value as QuotationStatus)}>
                {selectableStatuses(quotation.status).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Valid until" name="validUntil">
              {/* Part of the offer, so it locks with the lines - the API refuses
                  a validity change on anything past draft. */}
              <Input
                type="date"
                value={validUntil}
                disabled={!editable}
                onChange={(e) => setValidUntil(e.target.value)}
              />
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
                {formatMoney(preview.subtotal, quotation.currency)}
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
                    ? `${safeDiscountValue(discountValue)}% · ${formatMoney(preview.discountAmount, quotation.currency)}`
                    : formatMoney(preview.discountAmount, quotation.currency)}
              </dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-text-muted">Tax</dt>
              <dd className="font-medium text-text tabular-nums">
                {formatMoney(preview.taxTotal, quotation.currency)}
              </dd>
            </div>
            <div className="flex justify-between border-t border-border pt-2">
              <dt className="font-medium text-text">Total</dt>
              <dd className="font-semibold text-text tabular-nums">
                {formatMoney(preview.total, quotation.currency)}
              </dd>
            </div>
          </dl>
          {unsaved ? (
            <p className="mt-3 text-xs text-text-muted">
              These are the edits on screen. Save items to store them - the saved
              quotation still totals {formatMoney(quotation.total, quotation.currency)}.
            </p>
          ) : null}
        </Card>

        <Card>
          <MonoLabel>Quotation for</MonoLabel>
          {/* These three were printed as raw uuids, which told the reader
              nothing and could not be changed from here at all. The API's PATCH
              has always accepted all three. */}
          <dl className="mt-3 space-y-3 text-xs">
            <div>
              <dt className="text-text-muted">Company</dt>
              <dd className="mt-1">
                <RecordPicker
                  objectType="account"
                  value={quotation.account_id}
                  disabled={linkPending}
                  onChange={(next) => saveLink({ accountId: next }, { account_id: next })}
                />
                {quotation.account_id ? (
                  <Link
                    href={`/owner/accounts/${quotation.account_id}`}
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
                  value={quotation.contact_id}
                  disabled={linkPending}
                  onChange={(next) => saveLink({ contactId: next }, { contact_id: next })}
                />
                {quotation.contact_id ? (
                  <Link
                    href={`/owner/contacts/${quotation.contact_id}`}
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
                  value={quotation.deal_id}
                  disabled={linkPending}
                  onChange={(next) => saveLink({ dealId: next }, { deal_id: next })}
                />
                {/* No "Open deal" link: deals have no detail route - they live on
                    the board and the table at /owner/deals. The picker naming the
                    deal is the whole of what was missing here. */}
              </dd>
            </div>
          </dl>
          {linkError ? (
            <p role="alert" className="mt-2 text-xs text-orange-text">
              {linkError}
            </p>
          ) : null}
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

        <Card>
          <MonoLabel>Revisions</MonoLabel>
          <p className="mt-2 text-xs text-text-muted">
            An issued quotation cannot be edited - its numbers are what the customer was told.
            Revising it keeps this document and its number intact and starts a new draft at{" "}
            <span className="font-medium text-text">
              {quotation.quotation_number.replace(/-r\d+$/, "")}-r{quotation.revision + 1}
            </span>
            .
          </p>
          <Button
            type="button"
            size="sm"
            className="mt-3"
            loading={revisePending}
            onClick={revise}
            disabled={!revisable}
          >
            Revise
          </Button>
          {!revisable ? (
            <p className="mt-2 text-xs text-text-muted">
              {quotation.status === "draft"
                ? "This is still a draft - edit it directly."
                : "A newer revision has replaced this one. Revise that one instead."}
            </p>
          ) : null}

          {revisions.length > 1 ? (
            <ol className="mt-4 space-y-2 border-t border-border pt-3 text-xs">
              {revisions.map((rev) => (
                <li key={rev.id} className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0">
                    {rev.id === quotation.id ? (
                      <span className="font-medium text-text">{rev.quotation_number}</span>
                    ) : (
                      <Link
                        href={`/owner/quotations/${rev.id}`}
                        className="font-medium text-text hover:underline"
                      >
                        {rev.quotation_number}
                      </Link>
                    )}
                    <span className="ml-1.5 text-text-muted">{rev.status}</span>
                    {rev.id === quotation.id ? (
                      <span className="ml-1.5 text-text-subtle">(this one)</span>
                    ) : null}
                  </span>
                  <span className="shrink-0 text-text-muted tabular-nums">
                    {formatMoney(rev.total, rev.currency)}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
