"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Play, RefreshCw, Search, X } from "lucide-react";
import {
  Button,
  Input,
  MonoLabel,
  StatusChip,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  useConfirm,
} from "@aura/ui";
import { CallReadChips, TranscriptBody, humanize } from "../call-intel";
import {
  formatDuration,
  num,
  relativeTime,
  type CallNote,
  type OwnerCall,
  type OwnerCallDetail,
  type Telecaller,
} from "../types";
import {
  addOwnerCallNoteAction,
  fetchOwnerCallAction,
  fetchOwnerCallAudioAction,
  fetchOwnerCallNotesAction,
  reprocessOwnerCallAction,
} from "./actions";

const STATES = [
  { key: "complete", label: "Done" },
  { key: "in_pipeline", label: "Processing" },
  { key: "failed", label: "Failed" },
] as const;

const SENTIMENTS = [
  { key: "positive", label: "Positive" },
  { key: "neutral", label: "Neutral" },
  { key: "negative", label: "Negative" },
] as const;

/** Who was on the other end, in the order a person would recognise them. */
function contact(call: OwnerCall): string {
  if (call.remote_name) return call.remote_name;
  if (call.remote_number_prefix) return `${call.remote_number_prefix}…${call.remote_number_last3 ?? ""}`;
  if (call.remote_number_last3) return `…${call.remote_number_last3}`;
  return "Unknown caller";
}

/**
 * The client's call log.
 *
 * Filters live in the URL for the same reason the lead list's do: a filtered
 * log is a link, and the back button behaves. The row opens a drawer rather
 * than a page - reading one call and going back to the list is the whole loop
 * this screen exists for, and a route change would lose the reader's place in
 * it every time.
 */
export function CallsExplorer({
  calls,
  telecallers,
  total,
  limit,
  offset,
}: {
  calls: OwnerCall[];
  /** For the handset filter. Empty simply drops that chip row. */
  telecallers: Telecaller[];
  total: number;
  limit: number;
  offset: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [open, setOpen] = useState<OwnerCall | null>(null);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
    // Any filter change invalidates the current page.
    if (key !== "offset") next.delete("offset");
    router.push(`/owner/calls${next.toString() ? `?${next}` : ""}`);
  };

  const state = params.get("state");
  const direction = params.get("direction");
  const sentiment = params.get("sentiment");
  const deviceId = params.get("deviceId");
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));

  return (
    <>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:gap-5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setParam("q", query.trim() || null);
          }}
          className="min-w-0 flex-1"
        >
          <MonoLabel>Search</MonoLabel>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-muted"
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                // Says what it searches, because it deliberately does NOT
                // search the transcript - see the API's ListQuery.
                placeholder="Name, or what the call was about"
                aria-label="Search calls"
                className="pr-9 pl-9"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setParam("q", null);
                  }}
                  aria-label="Clear search"
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-1 text-text-muted transition-colors duration-150 ease-out hover:text-text"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              ) : null}
            </div>
          </div>
        </form>

        <div>
          <MonoLabel>Status</MonoLabel>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <FilterChip active={!state} onClick={() => setParam("state", null)}>
              All
            </FilterChip>
            {STATES.map((s) => (
              <FilterChip
                key={s.key}
                active={state === s.key}
                onClick={() => setParam("state", state === s.key ? null : s.key)}
              >
                {s.label}
              </FilterChip>
            ))}
          </div>
        </div>

        <div>
          <MonoLabel>Feeling</MonoLabel>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <FilterChip active={!sentiment} onClick={() => setParam("sentiment", null)}>
              Any
            </FilterChip>
            {SENTIMENTS.map((s) => (
              <FilterChip
                key={s.key}
                active={sentiment === s.key}
                onClick={() => setParam("sentiment", sentiment === s.key ? null : s.key)}
              >
                {s.label}
              </FilterChip>
            ))}
          </div>
        </div>

        <div>
          <MonoLabel>Direction</MonoLabel>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <FilterChip active={!direction} onClick={() => setParam("direction", null)}>
              Both
            </FilterChip>
            {["incoming", "outgoing"].map((d) => (
              <FilterChip
                key={d}
                active={direction === d}
                onClick={() => setParam("direction", direction === d ? null : d)}
              >
                {humanize(d)}
              </FilterChip>
            ))}
          </div>
        </div>
      </div>

      {telecallers.length > 0 ? (
        <div>
          <MonoLabel>Telecaller</MonoLabel>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <FilterChip active={!deviceId} onClick={() => setParam("deviceId", null)}>
              Everyone
            </FilterChip>
            {telecallers.map((t) => (
              <FilterChip
                key={t.id}
                active={deviceId === t.id}
                onClick={() => setParam("deviceId", deviceId === t.id ? null : t.id)}
              >
                {t.telecaller_name ?? t.label ?? "Unnamed handset"}
              </FilterChip>
            ))}
          </div>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-md border border-border bg-surface">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-subtle px-4 py-3">
          <span className="text-sm font-medium text-text tabular-nums">
            {total} call{total === 1 ? "" : "s"}
          </span>
          <span className="text-xs text-text-muted tabular-nums">
            page {page} of {pages}
          </span>
        </div>

        {calls.length === 0 ? (
          <p className="py-12 text-center text-sm text-text-muted">
            No calls match these filters.
          </p>
        ) : (
          <div tabIndex={0} role="region" aria-label="Calls" className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-left text-sm">
              <TableHead>
                <tr>
                  <TableHeaderCell>When</TableHeaderCell>
                  <TableHeaderCell>Contact</TableHeaderCell>
                  <TableHeaderCell className="text-right">Length</TableHeaderCell>
                  <TableHeaderCell>Telecaller</TableHeaderCell>
                  <TableHeaderCell>The AI read</TableHeaderCell>
                  <TableHeaderCell>Lead</TableHeaderCell>
                </tr>
              </TableHead>
              <TableBody>
                {calls.map((call) => (
                  <TableRow
                    key={call.id}
                    onClick={() => setOpen(call)}
                    // A <tr> has no interactive semantics of its own - the same
                    // role/tabIndex/onKeyDown the leads table supplies.
                    role="button"
                    tabIndex={0}
                    aria-label={`Open call with ${contact(call)}`}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpen(call);
                      }
                    }}
                    className="cursor-pointer"
                  >
                    <TableCell>
                      <span className="block text-text">{relativeTime(call.started_at)}</span>
                      <span className="text-xs text-text-muted">
                        {new Date(call.started_at).toLocaleString()}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="block font-medium text-text">{contact(call)}</span>
                      <span className="text-xs text-text-muted">{humanize(call.direction)}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDuration(call.duration_s)}
                    </TableCell>
                    <TableCell>{call.telecaller ?? <span className="text-text-subtle">-</span>}</TableCell>
                    <TableCell>
                      {call.sentiment || call.outcome || call.quality_score !== null ? (
                        <CallReadChips
                          sentiment={call.sentiment}
                          outcome={call.outcome}
                          qualityScore={call.quality_score}
                        />
                      ) : (
                        // Why there is nothing to show, in the row itself: a
                        // bare dash here reads as a fault, and the commonest
                        // reason by far is a call too short to be transcribed.
                        <span className="text-xs text-text-subtle">
                          {call.status === "COMPLETE" ? "Not analysed" : humanize(call.status)}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {call.lead_id ? (
                        <Link
                          href={`/owner/leads?focus=${call.lead_id}`}
                          // The row underneath opens the drawer; this cell is a
                          // different destination and must not do both.
                          onClick={(e) => e.stopPropagation()}
                          className="font-medium text-text underline underline-offset-2 hover:text-accent"
                        >
                          {call.lead_title ?? "View lead"}
                        </Link>
                      ) : (
                        <span className="text-xs text-text-subtle">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </table>
          </div>
        )}

        {pages > 1 ? (
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => setParam("offset", String(Math.max(0, offset - limit)))}
            >
              ← Previous
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={page >= pages}
              onClick={() => setParam("offset", String(offset + limit))}
            >
              Next →
            </Button>
          </div>
        ) : null}
      </div>

      <CallDrawer call={open} onClose={() => setOpen(null)} />
    </>
  );
}

/** Selected filter = the gradient fill, the same "you are here" the sidebar uses. */
function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={active ? { backgroundImage: "var(--brand-gradient)" } : undefined}
      className={`inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-out ${
        active
          ? "border-transparent text-white"
          : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * One call, opened from the log.
 *
 * The row it was opened from is already on screen, so the header renders from
 * that immediately and only the transcript, analytics and facts are fetched -
 * the parts no list can afford to carry for every row.
 */
function CallDrawer({ call, onClose }: { call: OwnerCall | null; onClose: () => void }) {
  const confirm = useConfirm();
  const [detail, setDetail] = useState<OwnerCallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState<CallNote[] | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setDetail(null);
    setError(null);
    setNotes(null);
    setNoteDraft("");
    // Audio and the last action's message are per-call: leaving either behind
    // would have the next call opened play the previous one's recording, or
    // claim a reprocess that was never asked for on it.
    setAudioUrl(null);
    setActionMsg(null);
    if (!call) return;
    let cancelled = false;
    void fetchOwnerCallAction(call.id).then((result) => {
      if (cancelled) return;
      if (result.error) setError(result.error);
      else if (result.detail) setDetail(result.detail);
    });
    // Notes ride alongside rather than inside the detail response - see
    // fetchOwnerCallNotesAction for why they are their own round trip. A
    // failure here degrades to "no notes" instead of blocking the drawer: the
    // AI read is the reason the panel was opened.
    void fetchOwnerCallNotesAction(call.id).then((result) => {
      if (cancelled) return;
      setNotes(result.notes ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [call]);

  async function submitNote() {
    if (!call || !noteDraft.trim()) return;
    setNoteBusy(true);
    const result = await addOwnerCallNoteAction(call.id, noteDraft);
    setNoteBusy(false);
    if (result.error) {
      setActionMsg(result.error);
      return;
    }
    if (result.note) {
      // Prepend rather than re-fetch: the list is newest-first and the server
      // just handed back the row it wrote.
      setNotes((current) => [result.note as CallNote, ...(current ?? [])]);
      setNoteDraft("");
    }
  }

  async function loadAudio() {
    if (!call) return;
    setPending(true);
    setActionMsg(null);
    const result = await fetchOwnerCallAudioAction(call.id);
    setPending(false);
    if (result.error) setActionMsg(result.error);
    else setAudioUrl(result.url ?? null);
  }

  async function reprocess() {
    if (!call) return;
    // Confirmed, not because the action is hard to undo - it is not - but
    // because it SPENDS: the call goes back through the ASR provider and the
    // analyzer, both billed, on a transcript already paid for once. The dialog
    // is the only place a reader is told that before it happens.
    const ok = await confirm({
      title: "Reprocess this call?",
      body: "The recording is transcribed and analysed again from scratch. This costs the same as a new call, and the current transcript and AI read are replaced.",
      confirmLabel: "Reprocess",
      tone: "danger",
    });
    if (!ok) return;

    setPending(true);
    setActionMsg(null);
    const result = await reprocessOwnerCallAction(call.id);
    setPending(false);
    setActionMsg(
      result.error ?? "Queued - this call will update as the pipeline works through it.",
    );
  }

  if (!call) return null;

  const analytics = detail?.analytics ?? null;
  const talkRatio = num(analytics?.talk_ratio ?? null);
  // The detail's score, falling back to the row's - the list already carries
  // one, and the drawer opening should not blank a chip that was on screen a
  // moment ago while the fetch is in flight.
  const qualityScore = num(analytics?.quality_score ?? call.quality_score ?? null);
  const isTerminal =
    call.status === "COMPLETE" ||
    call.status === "TRANSCRIPTION_OFF" ||
    call.status.startsWith("FAILED");
  const facts = (detail?.facts ?? []).filter(
    (f) => f.value_text !== null || f.value_num !== null || f.value_bool !== null,
  );

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-label={`Call with ${contact(call)}`}
        className="fixed right-0 top-0 z-50 flex h-dvh w-full flex-col overflow-y-auto border-l border-border bg-surface shadow-lg sm:w-[34rem]"
      >
        <div className="sticky top-0 flex items-start justify-between gap-3 border-b border-border bg-surface p-4 sm:p-5">
          <div className="min-w-0">
            <MonoLabel>
              {humanize(call.direction)} · {formatDuration(call.duration_s)}
            </MonoLabel>
            <h2 className="mt-1 text-xl leading-tight font-semibold break-words text-text">
              {contact(call)}
            </h2>
            <span className="mt-1 block text-xs text-text-muted">
              {new Date(call.started_at).toLocaleString()}
              {call.telecaller ? ` · ${call.telecaller}` : ""}
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClose}
            aria-label="Close"
            className="shrink-0 px-2"
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>

        <div className="space-y-5 p-4 sm:p-5">
          <CallReadChips
            intent={call.intent}
            sentiment={call.sentiment}
            outcome={call.outcome}
            qualityScore={call.quality_score}
          />

          {call.lead_id ? (
            <Link
              href={`/owner/leads?focus=${call.lead_id}`}
              className="block text-sm font-medium text-text underline underline-offset-2 hover:text-accent"
            >
              Lead: {call.lead_title ?? "open"}
            </Link>
          ) : null}

          {/*
            The coaching panel, in the same shape and the same words as the
            operator drawer (calls-explorer.tsx:559). The two consoles are read
            side by side during a support call, and a score that appeared bare
            here and itemised there made the same call look like two different
            verdicts. `quality_criteria` and `risk_flags` are what the owner
            API started returning alongside the score for exactly this.
          */}
          {analytics ? (
            <section className="space-y-3 border-t border-border pt-4">
              <div className="flex items-center justify-between">
                <MonoLabel>Call analytics</MonoLabel>
                {analytics.has_escalation_risk ? (
                  <StatusChip tone="danger">Needs review</StatusChip>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2">
                {qualityScore !== null ? (
                  <StatusChip
                    tone={qualityScore >= 70 ? "solid" : qualityScore >= 40 ? "muted" : "danger"}
                  >
                    Quality: {Math.round(qualityScore)}/100
                  </StatusChip>
                ) : null}
                {talkRatio !== null ? (
                  <StatusChip tone="outline">
                    Agent talk: {Math.round(talkRatio * 100)}%
                  </StatusChip>
                ) : null}
                {analytics.interruption_count !== null ? (
                  <StatusChip tone="outline">
                    {analytics.interruption_count} interruption
                    {analytics.interruption_count === 1 ? "" : "s"}
                  </StatusChip>
                ) : null}
              </div>

              {analytics.quality_criteria ? (
                <div className="space-y-1.5">
                  {(
                    [
                      [
                        "Consent disclosed",
                        analytics.quality_criteria.consentDisclosed ? "Yes" : "No",
                      ],
                      ["Script adherence", `${analytics.quality_criteria.scriptAdherence}/10`],
                      ["Professionalism", `${analytics.quality_criteria.professionalism}/10`],
                      ["Conversion signal", `${analytics.quality_criteria.conversionSignal}/10`],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label} className="flex gap-2 text-sm">
                      <span className="w-36 shrink-0 text-xs text-text-muted">{label}</span>
                      <span className="text-text">{value}</span>
                    </div>
                  ))}
                  {analytics.quality_criteria.rationale ? (
                    <p className="rounded-md border border-border bg-bg-subtle p-3 text-sm leading-relaxed text-text">
                      {analytics.quality_criteria.rationale}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {analytics.risk_flags && analytics.risk_flags.length > 0 ? (
                <div className="space-y-1.5">
                  <MonoLabel>Risk flags</MonoLabel>
                  {analytics.risk_flags.map((flag, i) => (
                    <div
                      key={i}
                      className="flex items-start gap-2 rounded-md border border-border bg-bg-subtle p-2.5 text-xs"
                    >
                      <AlertTriangle
                        aria-hidden="true"
                        className={
                          flag.severity === "high"
                            ? "mt-0.5 h-3.5 w-3.5 shrink-0 text-danger-text"
                            : "mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted"
                        }
                      />
                      <span className="min-w-0">
                        <span className="font-medium text-text">{humanize(flag.category)}</span>
                        <span className="text-text-muted"> · {flag.severity}</span>
                        {flag.snippet ? (
                          <span className="mt-0.5 block break-words text-text">
                            &ldquo;{flag.snippet}&rdquo;
                          </span>
                        ) : null}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </section>
          ) : null}

          {facts.length > 0 ? (
            <div className="space-y-1.5 border-t border-border pt-4">
              <MonoLabel>What the call told us</MonoLabel>
              {facts.map((f) => (
                <div key={f.field_key} className="flex justify-between gap-3 text-xs">
                  <span className="text-text-muted">{humanize(f.field_key)}</span>
                  <span className="text-right font-medium break-words text-text">
                    {f.value_text ?? f.value_num ?? (f.value_bool ? "Yes" : "No")}
                  </span>
                </div>
              ))}
            </div>
          ) : null}

          <div className="space-y-2 border-t border-border pt-4">
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

          {/* Notes - the same `call_notes` rows the operator console writes. */}
          <div className="space-y-2 border-t border-border pt-4">
            <MonoLabel>Notes</MonoLabel>
            {notes === null ? (
              <p className="text-xs text-text-muted">Loading…</p>
            ) : notes.length === 0 ? (
              <p className="text-xs text-text-muted">No notes yet</p>
            ) : (
              <ul className="space-y-2">
                {notes.map((note) => (
                  <li key={note.id} className="rounded-md border border-border bg-bg-subtle p-2.5">
                    <p className="text-xs leading-relaxed whitespace-pre-wrap text-text">
                      {note.body}
                    </p>
                    <p className="mt-1 text-[10px] text-text-subtle">
                      {new Date(note.created_at).toLocaleString()}
                    </p>
                  </li>
                ))}
              </ul>
            )}

            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              rows={3}
              placeholder="Add a note about this call…"
              aria-label="Add a note about this call"
              className="w-full rounded-md border border-border bg-surface p-2 text-xs text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => void submitNote()}
              disabled={noteBusy || !noteDraft.trim()}
            >
              {noteBusy ? "Saving…" : "Add note"}
            </Button>
          </div>

          {/* Playback and reprocess. */}
          <div className="space-y-2 border-t border-border pt-4">
            {/* A recording is streamed from a signed URL and has no caption
                track to point at - the transcript above is its accessible text
                alternative. Keyed on the URL so pressing Reload swaps the
                source instead of leaving the old one playing. */}
            {audioUrl ? (
              <audio
                key={audioUrl}
                controls
                preload="metadata"
                src={audioUrl}
                className="w-full"
              />
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => void loadAudio()}
                disabled={pending}
              >
                <Play aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                {audioUrl ? "Reload audio" : "Load audio"}
              </Button>

              {/*
                Hidden rather than disabled while the pipeline still holds the
                call: the API answers 409 for a non-terminal status, and a
                button whose only outcome is an error is worse than no button.
              */}
              {isTerminal ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void reprocess()}
                  disabled={pending}
                >
                  <RefreshCw aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                  {pending ? "Working…" : "Reprocess"}
                </Button>
              ) : null}
            </div>

            {actionMsg ? (
              <p role="status" className="text-xs text-text-muted">
                {actionMsg}
              </p>
            ) : null}
          </div>
        </div>
      </aside>
    </>
  );
}
