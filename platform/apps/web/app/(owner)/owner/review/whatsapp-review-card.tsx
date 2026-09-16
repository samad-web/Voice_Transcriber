"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, FormField, Input, StatusChip } from "@aura/ui";
import type { ReviewQualification } from "@/lib/review-queue";
import { approveQualificationAction, rejectQualificationAction } from "../whatsapp-leads/actions";
import { ReviewCardFrame, type ReviewCardProps } from "./review-card";

/**
 * A WhatsApp thread the qualifier scored (migration 0080).
 *
 * The model's extraction is a draft, so "Edit" opens every field before
 * approving - and only CHANGED fields are sent: an untouched blank must not
 * become a deliberate null over what the machine read correctly. Reject asks
 * for an optional reason inline rather than in a modal, so working down a long
 * queue is one card at a time with no dialog to dismiss.
 *
 * Bands map onto StatusChip's neutral tones, which each carry a distinct glyph -
 * a band is a category, not a state, so it gets no hue.
 */

const BAND_TONE = { hot: "solid", warm: "muted", cold: "outline", junk: "outline" } as const;

const FIELDS = [
  { key: "name", label: "Name" },
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "company", label: "Company" },
  { key: "value", label: "Value" },
  { key: "notes", label: "Notes" },
] as const;

type Edits = Partial<Record<(typeof FIELDS)[number]["key"], string>>;

function proposed(q: ReviewQualification, key: keyof Edits): string {
  switch (key) {
    case "name":
      return q.extracted_name ?? q.peer_label ?? "not stated";
    case "phone":
      return q.peer_address;
    case "email":
      return q.extracted_email ?? "not stated";
    case "company":
      return q.extracted_company ?? "not stated";
    case "value":
      return q.extracted_budget === null ? "not stated" : String(q.extracted_budget);
    case "notes":
      return q.extracted_notes ?? "not stated";
  }
}

export function WhatsAppReviewCard({ item, waiting, onResolved, onFailed }: ReviewCardProps<ReviewQualification>) {
  const q = item;
  const [mode, setMode] = useState<"view" | "edit" | "reject">("view");
  const [edits, setEdits] = useState<Edits>({});
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  const approve = async () => {
    setBusy(true);
    const trimmed = (key: keyof Edits) => edits[key]?.trim() || undefined;
    // Parsed, not cast: a budget typed as "lots" must not become 0, which reads
    // as a real figure in every revenue report.
    const rawValue = trimmed("value");
    const value = rawValue === undefined ? undefined : Number(rawValue.replace(/[^\d.]/gu, ""));
    const res = await approveQualificationAction(q.id, {
      name: trimmed("name"),
      phone: trimmed("phone"),
      email: trimmed("email"),
      company: trimmed("company"),
      notes: trimmed("notes"),
      ...(value !== undefined && Number.isFinite(value) && value > 0 ? { value } : {}),
    });
    setBusy(false);
    if (res.error) return onFailed("Couldn't create the lead", res.error);
    onResolved(q.id, `Lead created from ${q.extracted_name ?? q.peer_label ?? q.peer_address}`);
  };

  const reject = async () => {
    setBusy(true);
    const res = await rejectQualificationAction(q.id, reason.trim() || undefined);
    setBusy(false);
    if (res.error) return onFailed("Couldn't reject this thread", res.error);
    onResolved(q.id, "Marked as not a lead");
  };

  return (
    <ReviewCardFrame
      sourceLabel="WhatsApp lead"
      waiting={waiting}
      title={q.extracted_name ?? q.peer_label ?? q.peer_address}
      meta={
        <>
          <span className="font-semibold tabular-nums text-text">{q.score}</span>
          <StatusChip tone={BAND_TONE[q.band] ?? "outline"}>{q.band}</StatusChip>
          <span className="font-mono">{q.peer_address}</span>
          <span>
            {q.message_count} message{q.message_count === 1 ? "" : "s"}
          </span>
        </>
      }
    >
      {q.intent ? <p className="text-sm text-text">{q.intent}</p> : null}
      {q.rationale ? <p className="mt-1 text-xs text-text-muted">{q.rationale}</p> : null}
      {q.provider === "heuristic" ? (
        <p className="mt-1 text-xs text-text-muted">Read by keywords only - no language model is configured.</p>
      ) : null}

      {mode === "edit" ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <FormField key={field.key} label={field.label} name={field.key} id={`${q.id}-${field.key}`}>
              <Input
                id={`${q.id}-${field.key}`}
                value={edits[field.key] ?? ""}
                placeholder={proposed(q, field.key)}
                inputMode={field.key === "value" ? "decimal" : undefined}
                onChange={(event) => setEdits((prev) => ({ ...prev, [field.key]: event.target.value }))}
              />
            </FormField>
          ))}
          <p className="text-xs text-text-muted sm:col-span-2">
            Leave a field blank to keep what was read from the conversation.
          </p>
        </div>
      ) : null}

      {mode === "reject" ? (
        <div className="mt-3">
          <FormField label="Why isn't this a lead? (optional)" name="reason" id={`${q.id}-reason`}>
            <Input
              id={`${q.id}-reason`}
              value={reason}
              maxLength={400}
              placeholder="Courier, existing customer, wrong number…"
              onChange={(event) => setReason(event.target.value)}
            />
          </FormField>
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {mode === "reject" ? (
          <>
            <Button type="button" size="sm" variant="secondary" loading={busy} onClick={() => void reject()}>
              Reject
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setMode("view")}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button type="button" size="sm" loading={busy} onClick={() => void approve()}>
              {mode === "edit" ? "Approve with changes" : "Approve"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={busy}
              aria-expanded={mode === "edit"}
              onClick={() => setMode(mode === "edit" ? "view" : "edit")}
            >
              {mode === "edit" ? "Close edit" : "Edit"}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setMode("reject")}>
              Reject
            </Button>
          </>
        )}
        <Link
          href={`/owner/inbox?conversation=${q.conversation_id}`}
          className="ml-auto text-xs text-text-muted underline hover:text-text"
        >
          Read the conversation
        </Link>
      </div>
    </ReviewCardFrame>
  );
}
