"use client";

import { useState } from "react";
import Link from "next/link";
import { Button, FormField, Input, StatusChip } from "@aura/ui";
import { formatPhoneForDisplay } from "@aura/shared/dist/phone";
import { PhoneInput, usePhoneCheck } from "@/components/phone-input";
import { formatTestValue, humanizeKey } from "@/lib/agent-studio";
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
      return formatPhoneForDisplay(q.peer_address);
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
  const phoneCheck = usePhoneCheck();
  const details = Object.entries(q.facts ?? {}).flatMap(([key, value]) => {
    const text = formatTestValue(value);
    return text === null ? [] : [[key, text] as const];
  });

  const approve = async () => {
    // A number the reviewer typed must be a real one; blank keeps the
    // WhatsApp number the thread came from.
    const phone = phoneCheck(edits.phone);
    if (!phone.ok) return onFailed("Check the phone number", phone.message);
    setBusy(true);
    const trimmed = (key: keyof Edits) => edits[key]?.trim() || undefined;
    // Parsed, not cast: a budget typed as "lots" must not become 0, which reads
    // as a real figure in every revenue report.
    const rawValue = trimmed("value");
    const value = rawValue === undefined ? undefined : Number(rawValue.replace(/[^\d.]/gu, ""));
    const res = await approveQualificationAction(q.id, {
      name: trimmed("name"),
      phone: phone.e164 ?? undefined,
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

      {/* The tenant's own chat qualifier's extra details (0121). Shown read-only:
          they travel onto the lead as facts when it is approved, and the
          conversation link below is where to check them. */}
      {details.length > 0 ? (
        <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 rounded-md bg-bg-subtle px-3 py-2 text-sm sm:grid-cols-2">
          {details.map(([key, value]) => (
            <div key={key} className="flex min-w-0 gap-2">
              <dt className="shrink-0 text-text-muted">{humanizeKey(key)}:</dt>
              <dd className="min-w-0 truncate text-text">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {q.agent_name ? <p className="mt-1 text-xs text-text-subtle">Judged by your agent “{q.agent_name}”.</p> : null}

      {mode === "edit" ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <FormField key={field.key} label={field.label} name={field.key} id={`${q.id}-${field.key}`}>
              {field.key === "phone" ? (
                <PhoneInput
                  id={`${q.id}-phone`}
                  value={edits.phone ?? ""}
                  onChange={(value) => setEdits((prev) => ({ ...prev, phone: value }))}
                />
              ) : (
              <Input
                id={`${q.id}-${field.key}`}
                value={edits[field.key] ?? ""}
                placeholder={proposed(q, field.key)}
                inputMode={field.key === "value" ? "decimal" : undefined}
                onChange={(event) => setEdits((prev) => ({ ...prev, [field.key]: event.target.value }))}
              />
              )}
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
