"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button, Dialog, ErrorBanner, FormField, Input, Select, useAlert } from "@aura/ui";
import { fetchAssigneeOptionsAction, type AssigneeOption } from "../bulk/actions";
import { searchRecordsAction, type RecordOption } from "../crm-actions";
import type { Stage } from "../types";
import { addDealAction } from "./board-actions";

type ContactMode = "existing" | "new";

/**
 * "Add deal" on the board.
 *
 * The board only ever FILLED from calls and imports - there was no way to put a
 * deal on it by hand, so a walk-in or a referral had to wait for a phone call
 * that might never be recorded. This is the missing front door.
 *
 * ── THE SHAPE ────────────────────────────────────────────────────────────────
 *
 * Contact first, as a two-way switch (someone we know / someone new), because
 * that is the first thing a person adding a deal knows and the one choice that
 * changes the rest of the form. Then stage and value side by side, name and
 * owner side by side. Deal name defaults to the contact's name, which is what
 * nine deals in ten are called anyway.
 *
 * Stage defaults to the column the plus was clicked from when there is one
 * (`initialStage`), else the board's first column.
 *
 * A new contact is name + email only. Phone numbers in Aura are stored as a
 * match key from the handset, not as typed text, so a phone field here would
 * collect a number the contact record cannot hold.
 */
export function AddDealDialog({
  pipelineId,
  stages,
  initialStage,
}: {
  pipelineId: string;
  stages: Stage[];
  initialStage?: string;
}) {
  const router = useRouter();
  const alert = useAlert();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const firstOpen = stages.find((s) => !s.terminal)?.key ?? stages[0]?.key ?? "";
  const [mode, setMode] = useState<ContactMode>("existing");
  const [query, setQuery] = useState("");
  const [contacts, setContacts] = useState<RecordOption[] | null>(null);
  const [contactId, setContactId] = useState("");
  const [newName, setNewName] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [stage, setStage] = useState(initialStage ?? firstOpen);
  const [amount, setAmount] = useState("");
  const [name, setName] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [owners, setOwners] = useState<AssigneeOption[] | null>(null);

  const reset = () => {
    setMode("existing");
    setQuery("");
    setContactId("");
    setNewName("");
    setNewEmail("");
    setStage(initialStage ?? firstOpen);
    setAmount("");
    setName("");
    setOwnerUserId("");
    setError(null);
  };

  // The team, once per open.
  useEffect(() => {
    if (!open || owners !== null) return;
    void fetchAssigneeOptionsAction("people").then((r) => setOwners(r.options ?? []));
  }, [open, owners]);

  // Contact search, debounced. An empty box lists the most recent contacts,
  // so the common case - the person you spoke to today - needs no typing.
  useEffect(() => {
    if (!open || mode !== "existing") return;
    let cancelled = false;
    const t = setTimeout(() => {
      void searchRecordsAction("contact", query).then((r) => {
        if (cancelled) return;
        setContacts(r.records ?? []);
        if (r.error) setError(r.error);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [open, mode, query]);

  const pickedContact = contacts?.find((c) => c.id === contactId) ?? null;
  const contactName = mode === "existing" ? (pickedContact?.label ?? "") : newName.trim();
  const dealName = name.trim() || contactName;

  const submit = () => {
    setError(null);
    if (mode === "existing" && !contactId) return setError("Pick a contact, or switch to New contact.");
    if (mode === "new" && !newName.trim()) return setError("Give the new contact a name.");
    if (!dealName) return setError("Give the deal a name.");
    const value = amount.trim() ? Number(amount.replace(/[,\s]/g, "")) : null;
    if (value !== null && (!Number.isFinite(value) || value < 0)) return setError("Value must be a positive number.");

    startTransition(async () => {
      const result = await addDealAction({
        pipelineId,
        stage,
        name: dealName,
        amount: value,
        ownerUserId: ownerUserId || null,
        contact:
          mode === "existing"
            ? { kind: "existing", id: contactId }
            : { kind: "new", displayName: newName.trim(), email: newEmail.trim() || null },
      });
      if (result.error && !result.dealId) {
        setError(result.error);
        return;
      }
      setOpen(false);
      reset();
      router.refresh();
      // Added, but a later step failed (the owner): said once, after closing,
      // because the deal itself is on the board now.
      if (result.error) await alert({ title: "Deal added", body: result.error, tone: "danger" });
    });
  };

  const segment = (value: ContactMode, label: string) => (
    <button
      type="button"
      aria-pressed={mode === value}
      onClick={() => {
        setMode(value);
        setError(null);
      }}
      className={`h-10 flex-1 rounded-md border text-sm font-medium transition-colors duration-150 ease-out ${
        mode === value
          ? "border-accent bg-accent-subtle text-accent-text"
          : "border-border bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
      }`}
    >
      {label}
    </button>
  );

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" className="h-4 w-4" />
        Add deal
      </Button>

      <Dialog
        open={open}
        onClose={() => {
          if (!pending) setOpen(false);
        }}
        title="Add deal"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={submit} loading={pending}>
              Add deal
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div role="group" aria-label="Who is this deal with?" className="flex gap-2">
            {segment("existing", "Existing contact")}
            {segment("new", "New contact")}
          </div>

          {mode === "existing" ? (
            <div className="space-y-2">
              <FormField label="Contact" name="contact-search">
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name or email"
                  autoComplete="off"
                />
              </FormField>
              <Select
                aria-label="Contact"
                value={contactId}
                onChange={(e) => setContactId(e.target.value)}
                disabled={contacts === null}
              >
                <option value="">
                  {contacts === null
                    ? "Loading contacts…"
                    : contacts.length === 0
                      ? "No contacts match - try New contact"
                      : "- pick a contact -"}
                </option>
                {(contacts ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.detail ? `${c.label} · ${c.detail}` : c.label}
                  </option>
                ))}
              </Select>
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Contact name" name="new-contact-name" required>
                <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. Priya Sharma" />
              </FormField>
              <FormField label="Email" name="new-contact-email" hint="Optional">
                <Input
                  type="email"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="priya@example.com"
                />
              </FormField>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Stage" name="deal-stage">
              <Select value={stage} onChange={(e) => setStage(e.target.value)}>
                {stages.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Value (₹)" name="deal-value" hint="Optional">
              <Input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="150000"
              />
            </FormField>
            <FormField label="Deal name" name="deal-name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={contactName ? `Defaults to "${contactName}"` : "Defaults to the contact's name"}
                maxLength={200}
              />
            </FormField>
            <FormField label="Owner" name="deal-owner">
              <Select value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)} disabled={owners === null}>
                <option value="">{owners === null ? "Loading…" : "- unassigned -"}</option>
                {(owners ?? []).map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </FormField>
          </div>

          {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        </div>
      </Dialog>
    </>
  );
}
