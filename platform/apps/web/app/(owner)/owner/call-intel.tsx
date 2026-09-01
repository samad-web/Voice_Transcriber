"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Lock } from "lucide-react";
import { MonoLabel, StatusChip } from "@aura/ui";
import { fetchLeadCallAction } from "./actions";
import { num, type LeadCall, type LeadCallDetail } from "./types";

/**
 * The AI read of a call, in the CLIENT's console.
 *
 * Everything here is behind the `call_intel` module (org-modules.ts): the API
 * omits the fields entirely for a tenant without it, so these components are
 * rendered off the presence of the data rather than off a flag threaded down
 * from the layout. One decision, made server-side, where the entitlement
 * actually lives - a second copy in the client bundle could only ever drift
 * from it, and would drift in the direction of showing something the client is
 * not entitled to.
 *
 * The vocabulary deliberately matches the operator console's call drawer
 * ("Feeling", "Result", the same sentiment tones - calls-explorer.tsx:651): the
 * two consoles are read side by side during a support call, and the same
 * conversation must not appear to say two different things.
 */

/** snake_case / enum → plain words: "not_interested" → "Not interested". */
export function humanize(s: string): string {
  const t = s.replace(/[_-]+/g, " ").trim().toLowerCase();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : s;
}

/** Positive reads solid, negative reads danger, everything else stays quiet. */
function sentimentTone(sentiment: string): "solid" | "danger" | "muted" {
  if (sentiment === "positive") return "solid";
  if (sentiment === "negative") return "danger";
  return "muted";
}

/**
 * One call's read, as chips. Renders nothing at all when the call has no
 * read - a call that failed ASR, or one that arrived before this was switched
 * on, should look like a call with nothing to say rather than a row of empty
 * placeholders.
 */
export function CallReadChips({
  intent,
  sentiment,
  outcome,
  qualityScore,
}: {
  intent?: string | null;
  sentiment?: string | null;
  outcome?: string | null;
  qualityScore?: string | number | null;
}) {
  const quality = num(qualityScore ?? null);
  if (!intent && !sentiment && !outcome && quality === null) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {sentiment ? (
        <StatusChip tone={sentimentTone(sentiment)}>Feeling: {humanize(sentiment)}</StatusChip>
      ) : null}
      {outcome ? <StatusChip tone="outline">Result: {humanize(outcome)}</StatusChip> : null}
      {quality !== null ? (
        // Same thresholds as the operator drawer, so a call called "strong"
        // there is not called "weak" here.
        <StatusChip tone={quality >= 70 ? "solid" : quality >= 40 ? "muted" : "danger"}>
          Quality: {Math.round(quality)}/100
        </StatusChip>
      ) : null}
      {intent ? (
        <span className="text-xs text-text-muted">
          <span className="text-text-subtle">Intent:</span> {intent}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The transcript panel, opened per call from the lead drawer.
 *
 * Fetched on expand, never with the lead: the drawer lists up to 50 calls and a
 * transcript is unbounded text, so loading them together would make opening any
 * lead pay for every conversation it ever had.
 */
export function CallTranscript({ leadId, call }: { leadId: string; call: LeadCall }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<LeadCallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || detail || error) return;
    let cancelled = false;
    void fetchLeadCallAction(leadId, call.id).then((result) => {
      if (cancelled) return;
      if (result.error) setError(result.error);
      else if (result.detail) setDetail(result.detail);
    });
    return () => {
      cancelled = true;
    };
  }, [open, detail, error, leadId, call.id]);

  const Chevron = open ? ChevronDown : ChevronRight;

  return (
    <div className="mt-1.5">
      <button
        type="button"
        // stopPropagation: this sits inside the drawer, but the same call rows
        // are rendered from list rows that open on click - expanding a
        // transcript must never also be a click on whatever is underneath.
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs font-medium text-text-muted transition-colors duration-150 ease-out hover:text-text"
      >
        <Chevron aria-hidden="true" className="h-3.5 w-3.5" />
        {open ? "Hide transcript" : "Read transcript"}
      </button>

      {open ? (
        <div className="mt-2 space-y-2 rounded-md border border-border bg-bg-subtle p-3">
          {error ? (
            <p role="alert" className="text-xs font-medium text-danger-text">
              {error}
            </p>
          ) : detail === null ? (
            <p className="text-xs text-text-muted">Loading…</p>
          ) : (
            <TranscriptBody detail={detail} />
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Shared by the lead drawer and the call log's own drawer, which fetch from
 * different endpoints. The prop is the STRUCTURE it reads rather than either
 * response type: both carry a transcript and a redaction flag, and typing it
 * to one of them would have meant either an import cycle between two features
 * or a second copy of this panel drifting away from the first.
 */
export function TranscriptBody({
  detail,
}: {
  detail: Pick<LeadCallDetail, "transcript" | "transcriptRedacted">;
}) {
  const intel = detail.transcript?.intelligence ?? null;
  const segments = detail.transcript?.segments ?? null;
  const text = detail.transcript?.text ?? null;

  return (
    <>
      {intel?.summary ? (
        <div className="space-y-1">
          <MonoLabel>What the call was about</MonoLabel>
          <p className="text-sm leading-relaxed text-text">{intel.summary}</p>
        </div>
      ) : null}

      {intel && (intel.customer_intent || intel.agent_intent) ? (
        <div className="space-y-1 border-t border-border pt-2">
          {(
            [
              ["Customer", intel.customer_intent],
              ["Agent", intel.agent_intent],
            ] as const
          ).map(([label, value]) =>
            value ? (
              <div key={label} className="flex gap-2 text-xs">
                <span className="w-16 shrink-0 text-text-muted">{label}</span>
                <span className="text-text">{value}</span>
              </div>
            ) : null,
          )}
        </div>
      ) : null}

      <div className="space-y-1 border-t border-border pt-2">
        <div className="flex items-center justify-between gap-2">
          <MonoLabel>Transcript</MonoLabel>
          {detail.transcript?.engine ? (
            <span className="text-[10px] text-text-subtle">
              {detail.transcript.engine}
              {detail.transcript.diarized ? " · diarized" : ""}
            </span>
          ) : null}
        </div>

        {detail.transcriptRedacted ? (
          // The AI read above still rendered: this is the same split the API
          // makes - a member who may not read a word-for-word account of a
          // customer's call can still see what the call was about.
          <p className="flex items-start gap-2 text-xs leading-relaxed text-text-muted">
            <Lock aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Your account cannot read call transcripts. Ask whoever manages your Aura account to
              enable recordings access.
            </span>
          </p>
        ) : segments && segments.length > 0 ? (
          <div className="max-h-72 space-y-1.5 overflow-y-auto">
            {segments.map((seg, i) => (
              <p key={i} className="text-xs leading-relaxed text-text">
                {seg.speaker ? (
                  <span className="mr-1.5 font-medium text-text-muted">{seg.speaker}:</span>
                ) : null}
                {seg.text}
              </p>
            ))}
          </div>
        ) : text ? (
          <p className="max-h-72 overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap text-text">
            {text}
          </p>
        ) : (
          // Not "no transcript yet" - that would imply one is still coming.
          <p className="text-xs text-text-muted">
            No transcript was produced for this call.
          </p>
        )}
      </div>
    </>
  );
}
