"use client";

import { useMemo, useState, type ChangeEvent } from "react";
import Link from "next/link";
import { AlertTriangle, Quote } from "lucide-react";
import { Button, FormField, Input, StatusChip } from "@aura/ui";
import {
  TIER_LABELS,
  toolLabel,
  toolParams,
  type AgentParamSpec,
  type AgentTier,
  type AgentToolName,
} from "@aura/shared";
import { formatInZone, useOrgTimeZone } from "@/components/org-time";
import type { ReviewAgentAction } from "@/lib/review-queue";
import { TEXTAREA_CLASS } from "../agents/field-list";
import {
  approveAgentActionAction,
  editAgentActionAction,
  rejectAgentActionAction,
} from "./actions";
import { ReviewCardFrame, type ReviewCardProps } from "./review-card";

/**
 * §12's review card: one thing the call assistant proposes doing.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  NOTHING ON THIS CARD HAS HAPPENED YET
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Every other card in this queue decides something that already exists - a
 * thread that arrived, a message that was sent, two records that are already
 * duplicates. This one authorises something to happen. So the copy is in the
 * future tense throughout, and Approve says what it will do rather than
 * "Approve": a reviewer clicking the same green button on four kinds of card
 * stops reading, and this is the card where that matters.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  THE QUOTE IS NOT DECORATION
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §12 asks for "a transcript snippet with highlighted evidence and timestamp,
 * audio jump link". The reviewer's whole job is to check a reading of what
 * somebody said, and they cannot do that from a confidence score. The quote
 * comes from the API's own window around the evidence; the audio link goes to
 * the call page, which carries its own gates (0122's call-access rules), so
 * this is a LINK and not a player.
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHY THE SCORE IS SHOWN WITH ITS FACTORS AND ITS THRESHOLD
 * ══════════════════════════════════════════════════════════════════════════
 *
 * "0.61" means nothing on its own. Next to "review at 0.60, automatic at 0.85"
 * it means "this only just qualified to be asked about", which is exactly what
 * a reviewer needs to know before they trust it. The factors come from the
 * API's `confidenceBreakdown` (the signals the score was a product of), so the
 * card never recomputes a number the server decided.
 */

type Mode = "idle" | "rejecting" | "editing";

export function AgentActionReviewCard({
  item,
  waiting,
  onResolved,
  onFailed,
}: ReviewCardProps<ReviewAgentAction>) {
  const [mode, setMode] = useState<Mode>("idle");
  const [busy, setBusy] = useState<"approve" | "reject" | "edit" | null>(null);
  const [reason, setReason] = useState("");
  const specs = useMemo(() => toolParams(item.tool as AgentToolName), [item.tool]);
  // The workspace clock, not the reviewer's own (docs/30).
  const zone = useOrgTimeZone();
  const [draft, setDraft] = useState<Record<string, string>>(() => editableDraft(specs, item.params));

  const label = toolLabel(item.tool as AgentToolName);
  const overdue = item.review_due_at !== null && new Date(item.review_due_at) < new Date();

  const approve = async () => {
    setBusy("approve");
    const res = await approveAgentActionAction(item.id);
    setBusy(null);
    if (res.error) return onFailed("Couldn't approve that", res.error);
    onResolved(item.id, `${label} — approved`);
  };

  const reject = async () => {
    setBusy("reject");
    const res = await rejectAgentActionAction(item.id, reason);
    setBusy(null);
    if (res.error) return onFailed("Couldn't reject that", res.error);
    onResolved(item.id, "Rejected, and the assistant will learn from it");
  };

  const saveEdit = async () => {
    setBusy("edit");
    const res = await editAgentActionAction(item.id, mergedParams(specs, item.params, draft), reason);
    setBusy(null);
    if (res.error) return onFailed("Couldn't save that change", res.error);
    onResolved(item.id, `${label} — approved with your changes`);
  };

  return (
    <ReviewCardFrame
      sourceLabel="Call suggestion"
      waiting={waiting}
      title={label}
      meta={
        <>
          {item.telecaller_name ? <span>{item.telecaller_name}&rsquo;s call</span> : null}
          {item.lead_id && item.lead_name ? (
            <Link href={`/owner/leads/${item.lead_id}`} className="underline hover:text-text">
              {item.lead_name}
            </Link>
          ) : null}
          {item.language ? <span>{item.language}</span> : null}
          <StatusChip tone="outline">{TIER_LABELS[item.tier as AgentTier] ?? item.tier}</StatusChip>
          {item.final_score !== null ? (
            <span>
              score {item.final_score.toFixed(2)}
              {item.thresholds
                ? ` · asked about from ${item.thresholds.review.toFixed(2)}, automatic from ${item.thresholds.auto.toFixed(2)}`
                : null}
            </span>
          ) : null}
        </>
      }
    >
      {/* §12's SLA timer. Shown only once it has passed: a countdown on every
          card would make the queue feel like an alarm, and the escalation has
          already told somebody by then. */}
      {overdue ? (
        <p className="mb-3 flex items-start gap-1.5 text-sm text-text">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            This has been waiting past the review deadline
            {item.review_escalated_at ? ", and a manager has been told" : ""}.
          </span>
        </p>
      ) : null}

      {/* What it would actually do, parameter by parameter. Not a sentence:
          the values are the thing being approved, and a prose summary is where
          a wrong time hides. */}
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        {specs.map((spec) => {
          const raw = item.params?.[spec.key];
          if (raw === undefined || raw === null || raw === "") return null;
          return (
            <div key={spec.key} className="contents">
              <dt className="text-text-muted">{spec.label}</dt>
              <dd className="break-words text-text">{formatParam(spec, raw, zone)}</dd>
            </div>
          );
        })}
      </dl>

      {item.evidence && item.evidence.length > 0 ? (
        <div className="mt-3 space-y-2">
          {item.evidence.slice(0, 3).map((piece, index) => (
            <blockquote
              key={index}
              className="flex items-start gap-1.5 border-l-2 border-border-strong pl-3 text-sm break-words text-text"
            >
              <Quote className="mt-1 size-3 shrink-0 text-text-muted" aria-hidden />
              <span>
                {piece.quote ?? ""}
                {piece.speaker ? (
                  <span className="text-text-muted"> — {speakerLabel(piece.speaker)}</span>
                ) : null}
                {item.call_id ? (
                  <>
                    {" "}
                    <Link
                      href={jumpHref(item.call_id, piece.at_ms)}
                      className="underline underline-offset-2"
                    >
                      hear it
                    </Link>
                  </>
                ) : null}
              </span>
            </blockquote>
          ))}
        </div>
      ) : null}

      {/* §3A.2's `roles_inferred`: nobody told the transcript who was speaking,
          so "the customer said" is a guess. Worth one line, because it changes
          how much the quote above is worth. */}
      {item.roles_inferred ? (
        <p className="mt-2 text-xs text-text-muted">
          Who was speaking was worked out from the words, not from the recording, so check the quote
          belongs to the customer.
        </p>
      ) : null}

      {item.confidenceBreakdown && Object.keys(item.confidenceBreakdown).length > 0 ? (
        <details className="mt-3 text-xs text-text-muted">
          <summary className="cursor-pointer">Why it scored that</summary>
          <ul className="mt-1 space-y-0.5">
            {Object.entries(item.confidenceBreakdown).map(([key, value]) => (
              <li key={key}>
                {signalLabel(key)}: {formatSignal(value)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* §20: "every decision records prompt, model, schema and resolver
          versions". Collapsed, because it is the answer to "what changed" and
          not something anybody reads per item. */}
      <details className="mt-2 text-xs text-text-muted">
        <summary className="cursor-pointer">How this was produced</summary>
        <ul className="mt-1 space-y-0.5">
          <li>Model: {item.model ?? "unknown"}</li>
          <li>Prompt {item.prompt_version ?? "?"} · schema {item.schema_version ?? "?"}</li>
          <li>Times and amounts resolved by version {item.resolver_version ?? "?"}</li>
          <li>Mode at the time: {item.effective_mode ?? "unknown"}</li>
          {item.stt_confidence !== null ? (
            <li>Transcription confidence: {item.stt_confidence.toFixed(2)}</li>
          ) : null}
        </ul>
      </details>

      {mode === "editing" ? (
        <div className="mt-3 space-y-3 rounded-md border border-border p-3">
          <p className="text-xs text-text-muted">
            Change what it should do, then approve. Who it goes to and what the customer said are
            not editable here.
          </p>
          {specs
            .filter((spec) => spec.editable)
            .map((spec) => (
              <FormField key={spec.key} label={spec.label} name={`agent-${item.id}-${spec.key}`}>
                {spec.kind === "textarea" ? (
                  <textarea
                    rows={3}
                    className={TEXTAREA_CLASS}
                    value={draft[spec.key] ?? ""}
                    onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
                      setDraft({ ...draft, [spec.key]: event.currentTarget.value })
                    }
                  />
                ) : (
                  <Input
                    type={inputType(spec.kind)}
                    step={spec.kind === "amount_minor" ? "0.01" : undefined}
                    value={draft[spec.key] ?? ""}
                    onChange={(event: ChangeEvent<HTMLInputElement>) =>
                      setDraft({ ...draft, [spec.key]: event.currentTarget.value })
                    }
                  />
                )}
              </FormField>
            ))}
          <FormField
            label="What you changed, and why"
            name={`agent-${item.id}-edit-reason`}
            required
            hint="This becomes a labelled example, so the assistant stops getting it wrong."
          >
            <textarea
              rows={2}
              required
              className={TEXTAREA_CLASS}
              value={reason}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setReason(event.currentTarget.value)}
            />
          </FormField>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              loading={busy === "edit"}
              disabled={reason.trim().length === 0}
              onClick={() => void saveEdit()}
            >
              Approve with my changes
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </div>
        </div>
      ) : mode === "rejecting" ? (
        <div className="mt-3 space-y-3 rounded-md border border-border p-3">
          <FormField
            label="Why this is wrong"
            name={`agent-${item.id}-reject-reason`}
            required
            hint="Required. Rejections become labelled examples and are what moves the accuracy measurement."
          >
            <textarea
              rows={2}
              required
              className={TEXTAREA_CLASS}
              value={reason}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setReason(event.currentTarget.value)}
            />
          </FormField>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              loading={busy === "reject"}
              disabled={reason.trim().length === 0}
              onClick={() => void reject()}
            >
              Reject it
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setMode("idle")}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            loading={busy === "approve"}
            disabled={busy !== null}
            onClick={() => void approve()}
          >
            {approveLabel(label)}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={busy !== null}
            onClick={() => setMode("editing")}
          >
            Change it first
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy !== null}
            onClick={() => setMode("rejecting")}
          >
            It&rsquo;s wrong
          </Button>
          {item.call_id ? (
            <Link
              href={`/owner/calls/${item.call_id}`}
              className="ml-auto text-xs text-text-muted underline hover:text-text"
            >
              Open the call
            </Link>
          ) : null}
        </div>
      )}
    </ReviewCardFrame>
  );
}

/** "Schedule a call-back" -> "Schedule the call-back". */
function approveLabel(label: string): string {
  return label;
}

function inputType(kind: AgentParamSpec["kind"]): string {
  if (kind === "datetime") return "datetime-local";
  if (kind === "date") return "date";
  if (kind === "amount_minor") return "number";
  return "text";
}

/**
 * The editable parameters, as form strings.
 *
 * Money arrives in MINOR UNITS and is edited in major ones, because nobody
 * types paise. The conversion happens here and back in `mergedParams`, in one
 * place, so the two directions cannot disagree.
 *
 * A datetime arrives as an ISO instant and `datetime-local` wants
 * `YYYY-MM-DDTHH:mm` with no zone. Slicing the ISO string would silently show
 * UTC as if it were local, so it is converted through the browser's own
 * offset - which is the reviewer's own clock, which is what they are reading.
 */
function editableDraft(
  specs: readonly AgentParamSpec[],
  params: Record<string, unknown> | null,
): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const spec of specs) {
    if (!spec.editable) continue;
    const raw = params?.[spec.key];
    if (raw === undefined || raw === null) {
      draft[spec.key] = "";
      continue;
    }
    if (spec.kind === "amount_minor") {
      draft[spec.key] = (Number(raw) / 100).toFixed(2);
    } else if (spec.kind === "datetime") {
      draft[spec.key] = toLocalInput(String(raw));
    } else {
      draft[spec.key] = String(raw);
    }
  }
  return draft;
}

/** The original params with the reviewer's edits folded back in. */
function mergedParams(
  specs: readonly AgentParamSpec[],
  params: Record<string, unknown> | null,
  draft: Record<string, string>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(params ?? {}) };
  for (const spec of specs) {
    if (!spec.editable) continue;
    const value = draft[spec.key] ?? "";
    if (value === "") {
      merged[spec.key] = null;
    } else if (spec.kind === "amount_minor") {
      merged[spec.key] = Math.round(Number(value) * 100);
    } else if (spec.kind === "datetime") {
      merged[spec.key] = new Date(value).toISOString();
    } else {
      merged[spec.key] = value;
    }
  }
  return merged;
}

function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * One parameter as text, in the WORKSPACE's zone.
 *
 * The zone is passed in rather than read from the browser: a manager reviewing
 * a Pune floor's suggestions from Dubai must see the time the customer will
 * actually be rung at, which is the whole reason docs/30 made the console use
 * one clock (and `console-time.test.ts` the reason it stays that way).
 *
 * `toLocaleString("en-IN")` on the AMOUNT is a number, not a date, and is
 * left alone - grouping digits is locale-correct wherever it runs.
 */
function formatParam(spec: AgentParamSpec, raw: unknown, zone: string): string {
  if (spec.kind === "amount_minor") {
    const major = Number(raw) / 100;
    return Number.isFinite(major) ? `₹${major.toLocaleString("en-IN")}` : String(raw);
  }
  if (spec.kind === "datetime") return formatInZone(String(raw), "datetime", zone);
  if (spec.kind === "date") return formatInZone(String(raw), "date", zone);
  if (typeof raw === "object") return JSON.stringify(raw);
  return String(raw);
}

function speakerLabel(speaker: string): string {
  return speaker === "customer" ? "the customer" : speaker === "agent" ? "the agent" : speaker;
}

/**
 * The call page with a start offset, when the evidence carries one.
 *
 * `#t=` rather than a query parameter: the call page owns its own URL shape and
 * a fragment cannot disturb its server-side reads.
 */
function jumpHref(callId: string, atMs: number | undefined): string {
  if (atMs === undefined || !Number.isFinite(atMs)) return `/owner/calls/${callId}`;
  return `/owner/calls/${callId}#t=${Math.floor(atMs / 1000)}`;
}

function signalLabel(key: string): string {
  const labels: Record<string, string> = {
    modelConfidence: "How sure the reading was",
    evidenceMatch: "The quote was found in the transcript",
    sttConfidence: "How clear the audio was",
    slotCompleteness: "Everything it needed was said",
    policyFit: "It fits your rules",
    historyAgreement: "It matches the lead's history",
  };
  return labels[key] ?? key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function formatSignal(value: unknown): string {
  if (typeof value === "number") return value.toFixed(2);
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (value === null || value === undefined) return "not measured";
  return String(value);
}
