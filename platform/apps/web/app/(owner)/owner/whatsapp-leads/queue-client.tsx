"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { StatusChip, useAlert, useToast } from "@aura/ui";
import { formatPhoneForDisplay } from "@aura/shared/dist/phone";
import { PhoneInput, usePhoneCheck } from "@/components/phone-input";
import {
  approveQualificationAction,
  listQualificationsAction,
  rejectQualificationAction,
  type Qualification,
} from "./actions";

/**
 * The review queue.
 *
 * ── WHY EVERY FIELD IS EDITABLE BEFORE APPROVING ──────────────────────────
 *
 * The model's extraction is a draft. What reaches the CRM is what the person
 * confirmed - that is the whole reason this screen exists rather than the sweep
 * writing leads directly. A reviewer who cannot fix a misread name would either
 * approve something wrong or reject something real, and both are worse than the
 * dead end this replaces.
 *
 * Only CHANGED fields are sent. An untouched blank must not become a deliberate
 * null that overwrites what the machine correctly read.
 */

/**
 * Bands onto the chip's four tones. StatusChip encodes each tone as a distinct
 * GLYPH as well as a colour, so these stay distinguishable in greyscale and to
 * a reviewer who cannot separate red from green - which matters here because
 * the band is the one thing being scanned down a list.
 */
const BAND_TONE = {
  hot: "solid",
  warm: "muted",
  cold: "outline",
  junk: "outline",
} as const satisfies Record<string, "solid" | "muted" | "outline" | "danger">;

interface Edits {
  name?: string;
  phone?: string;
  email?: string;
  company?: string;
  notes?: string;
  value?: string;
}

export function QualificationQueue() {
  const [items, setItems] = useState<Qualification[]>([]);
  const [includeJunk, setIncludeJunk] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, Edits>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();
  const phoneCheck = usePhoneCheck();

  const load = useCallback(() => {
    startTransition(async () => {
      const res = await listQualificationsAction({ includeJunk });
      if (res.error) {
        setError(res.error);
        return;
      }
      setError(null);
      setItems(res.items ?? []);
    });
  }, [includeJunk]);

  useEffect(() => load(), [load]);

  const setEdit = (id: string, field: keyof Edits, value: string) =>
    setEdits((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));

  const approve = async (q: Qualification) => {
    const e = edits[q.id] ?? {};
    // A callback number the reviewer typed must be a real one; blank keeps
    // the WhatsApp number the thread came from.
    const phone = phoneCheck(e.phone);
    if (!phone.ok) {
      await alert({ title: "Check the phone number", body: phone.message, tone: "danger" });
      return;
    }
    setBusyId(q.id);
    // Trim, then drop anything empty. `value` is parsed rather than cast: a
    // budget field a reviewer typed "lots" into must NOT become 0, which is the
    // exact bug the intake engine shipped - a zero-value deal reads as a real
    // figure in every revenue report.
    const parsedValue = e.value !== undefined ? Number(e.value.replace(/[^\d.]/gu, "")) : undefined;
    const res = await approveQualificationAction(q.id, {
      ...(e.name?.trim() ? { name: e.name.trim() } : {}),
      ...(phone.e164 ? { phone: phone.e164 } : {}),
      ...(e.email?.trim() ? { email: e.email.trim() } : {}),
      ...(e.company?.trim() ? { company: e.company.trim() } : {}),
      ...(e.notes?.trim() ? { notes: e.notes.trim() } : {}),
      ...(parsedValue !== undefined && Number.isFinite(parsedValue) && parsedValue > 0
        ? { value: parsedValue }
        : {}),
    });
    setBusyId(null);
    if (res.error) {
      await alert({ title: "Couldn't create the lead", body: res.error, tone: "danger" });
      return;
    }
    toast(`Lead created from ${q.peer_address}`);
    setItems((prev) => prev.filter((i) => i.id !== q.id));
  };

  const reject = async (q: Qualification) => {
    setBusyId(q.id);
    const res = await rejectQualificationAction(q.id);
    setBusyId(null);
    if (res.error) {
      await alert({
        title: "Couldn't reject this thread",
        body: res.error,
        tone: "danger",
      });
      return;
    }
    setItems((prev) => prev.filter((i) => i.id !== q.id));
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-text-muted">
          <input
            type="checkbox"
            checked={includeJunk}
            onChange={(ev) => setIncludeJunk(ev.target.checked)}
          />
          Show everything the qualifier read, including couriers, wrong numbers and spam
        </label>
        <button
          type="button"
          onClick={load}
          className="ml-auto rounded border border-border px-3 py-1 text-xs"
        >
          Refresh
        </button>
      </div>

      {error ? <p className="text-sm text-danger">{error}</p> : null}

      {items.length === 0 ? (
        <p className="text-sm text-text-muted">
          Nothing waiting. New WhatsApp threads are qualified within about fifteen minutes of the
          last message, and only threads from numbers that match no contact are read.
        </p>
      ) : null}

      <ul className="space-y-3">
        {items.map((q) => {
          const e = edits[q.id] ?? {};
          const busy = busyId === q.id;
          return (
            <li key={q.id} className="rounded border border-border p-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-lg font-semibold tabular-nums text-text">{q.score}</span>
                <StatusChip tone={BAND_TONE[q.band] ?? "outline"}>{q.band}</StatusChip>
                <span className="font-mono text-sm text-text">{q.peer_address}</span>
                {q.peer_label ? (
                  <span className="text-sm text-text-muted">{q.peer_label}</span>
                ) : null}
                <span className="ml-auto text-xs text-text-muted">
                  {q.message_count} message{q.message_count === 1 ? "" : "s"} &middot;{" "}
                  {q.disposition}
                </span>
              </div>

              {q.intent ? <p className="mt-2 text-sm text-text">{q.intent}</p> : null}
              {q.rationale ? (
                <p className="mt-1 text-xs text-text-muted">{q.rationale}</p>
              ) : null}
              {/* Provenance, shown rather than hidden: a reviewer trusting a
                  verdict deserves to know whether a model read the thread or a
                  keyword matcher did. */}
              <p className="mt-1 text-[11px] text-text-muted">
                read by {q.provider ?? "unknown"}
                {q.provider === "heuristic" ? " (no language model configured - keywords only)" : ""}
              </p>

              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <Field
                  label="Name"
                  placeholder={q.extracted_name ?? q.peer_label ?? "not stated"}
                  value={e.name ?? ""}
                  onChange={(v) => setEdit(q.id, "name", v)}
                />
                <div className="text-xs text-text-muted">
                  <span id={`${q.id}-phone-label`}>Phone</span>
                  <div className="mt-1">
                    <PhoneInput
                      size="sm"
                      aria-label="Phone"
                      aria-describedby={`${q.id}-phone-hint`}
                      value={e.phone ?? ""}
                      onChange={(v) => setEdit(q.id, "phone", v)}
                    />
                  </div>
                  <span id={`${q.id}-phone-hint`} className="mt-0.5 block">
                    Blank uses {formatPhoneForDisplay(q.peer_address)}
                  </span>
                </div>
                <Field
                  label="Email"
                  placeholder={q.extracted_email ?? "not stated"}
                  value={e.email ?? ""}
                  onChange={(v) => setEdit(q.id, "email", v)}
                />
                <Field
                  label="Company"
                  placeholder={q.extracted_company ?? "not stated"}
                  value={e.company ?? ""}
                  onChange={(v) => setEdit(q.id, "company", v)}
                />
                <Field
                  label="Value"
                  placeholder={
                    q.extracted_budget === null ? "not stated" : String(q.extracted_budget)
                  }
                  value={e.value ?? ""}
                  onChange={(v) => setEdit(q.id, "value", v)}
                />
                <Field
                  label="Notes"
                  placeholder={q.extracted_notes ?? "not stated"}
                  value={e.notes ?? ""}
                  onChange={(v) => setEdit(q.id, "notes", v)}
                />
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void approve(q)}
                  className="rounded bg-accent px-3 py-1 text-sm font-medium text-bg disabled:opacity-50"
                >
                  {busy ? "Working…" : "Approve, create lead"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void reject(q)}
                  className="rounded border border-border px-3 py-1 text-sm disabled:opacity-50"
                >
                  Not a lead
                </button>
                <a
                  href={`/owner/inbox?conversation=${q.conversation_id}`}
                  className="self-center text-xs text-text-muted underline"
                >
                  Read the conversation
                </a>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Field({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block text-xs text-text-muted">
      {label}
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(ev) => onChange(ev.target.value)}
        className="mt-1 w-full rounded border border-border bg-bg px-2 py-1 text-sm text-text"
      />
    </label>
  );
}
