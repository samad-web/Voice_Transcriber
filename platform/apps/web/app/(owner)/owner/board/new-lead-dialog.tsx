"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button, Dialog, ErrorBanner, FormField, Input, Select, useToast } from "@aura/ui";
import { PhoneInput, usePhoneCheck } from "@/components/phone-input";
import { TEXTAREA_CLASS } from "../lead-drawer";
import { boardRef, type LeadBoardRef } from "../types";
import { createLeadAction } from "./actions";

/** "Follow routing" in the Board picker - the API decides from the "Added manually" route. */
const ROUTED = "__routed__";

/**
 * "New lead" - putting a card on a board by hand (0136).
 *
 * Until now every lead arrived from a call, a form or an integration; a
 * walk-in or a referral waited for a phone call that might never be recorded.
 *
 * Name is the only required field. A phone number or email is what lets the
 * API recognise someone the business already knows - typing an existing
 * number opens THAT lead instead of making a duplicate, and the dialog says so
 * rather than pretending it created something.
 *
 * The board defaults to wherever "Added manually" is routed (Manage boards ->
 * Routing), so a team that sends hand-made leads to one board never has to
 * pick it; the picker is there for the exception, and hidden when there is
 * only one board.
 */
export function NewLeadDialog({ boards }: { boards: LeadBoardRef[] }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", email: "", company: "", value: "", notes: "" });
  const [board, setBoard] = useState(ROUTED);
  const phoneCheck = usePhoneCheck();

  const set = (field: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  const reset = () => {
    setForm({ name: "", phone: "", email: "", company: "", value: "", notes: "" });
    setBoard(ROUTED);
    setError(null);
  };

  const submit = () => {
    setError(null);
    const name = form.name.trim();
    if (!name) return setError("Give the lead a name.");
    // Valid for its country or not sent at all - a mistyped number would
    // never recognise the person it was meant to.
    const phone = phoneCheck(form.phone);
    if (!phone.ok) return setError(phone.message);
    const email = form.email.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return setError("That email address doesn't look right.");
    const value = form.value.trim() ? Number(form.value.replace(/[,\s]/g, "")) : null;
    if (value !== null && (!Number.isFinite(value) || value < 0)) return setError("Value must be a positive number.");

    startTransition(async () => {
      const result = await createLeadAction({
        name,
        phone: phone.e164,
        email: email || null,
        company: form.company.trim() || null,
        notes: form.notes.trim() || null,
        value,
        ...(board !== ROUTED ? { boardId: board } : {}),
      });
      if (result.error || !result.leadId) {
        setError(result.error ?? "The lead wasn't created.");
        return;
      }
      setOpen(false);
      reset();
      const where = boards.find((b) => b.id === (result.boardId ?? null))?.name;
      toast(
        result.created
          ? where
            ? `Lead added to ${where}`
            : "Lead added"
          : "That number or email is already a lead - opened it instead of adding a duplicate",
        result.created ? undefined : { duration: 7000 },
      );
      // Open it on the board it landed on - for an existing lead, the one it
      // was already on.
      router.push(`/owner/board?boardId=${boardRef(result.boardId ?? null)}&focus=${result.leadId}`);
      router.refresh();
    });
  };

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" className="h-4 w-4" />
        New lead
      </Button>

      <Dialog
        open={open}
        onClose={() => {
          if (!pending) setOpen(false);
        }}
        title="New lead"
        description="Add someone who reached you outside a recorded call - a walk-in, a referral, a message."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} loading={pending}>
              Add lead
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <FormField label="Name" name="new-lead-name" required>
            <Input value={form.name} onChange={set("name")} placeholder="e.g. Priya Sharma" maxLength={200} autoFocus />
          </FormField>

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Phone" name="new-lead-phone" hint="Recognises someone you already know">
              <PhoneInput value={form.phone} onChange={(value) => setForm((f) => ({ ...f, phone: value }))} />
            </FormField>
            <FormField label="Email" name="new-lead-email" hint="Optional">
              <Input type="email" value={form.email} onChange={set("email")} placeholder="priya@example.com" />
            </FormField>
            <FormField label="Company" name="new-lead-company" hint="Optional">
              <Input value={form.company} onChange={set("company")} maxLength={200} />
            </FormField>
            <FormField label="Value (₹)" name="new-lead-value" hint="Optional">
              <Input inputMode="decimal" value={form.value} onChange={set("value")} placeholder="150000" />
            </FormField>
          </div>

          <FormField label="Notes" name="new-lead-notes" hint="What they asked about">
            <textarea
              id="new-lead-notes"
              value={form.notes}
              onChange={set("notes")}
              rows={3}
              maxLength={5000}
              className={TEXTAREA_CLASS}
            />
          </FormField>

          {boards.length > 1 ? (
            <FormField label="Board" name="new-lead-board">
              <Select value={board} onChange={(e) => setBoard(e.target.value)}>
                <option value={ROUTED}>Automatic - where manual leads are routed</option>
                {boards.map((b) => (
                  <option key={boardRef(b.id)} value={boardRef(b.id)}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </FormField>
          ) : null}

          {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        </div>
      </Dialog>
    </>
  );
}
