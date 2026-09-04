"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import {
  Bot,
  Link2,
  MessageSquarePlus,
  PhoneIncoming,
  PhoneOutgoing,
  RefreshCw,
  User,
  X,
} from "lucide-react";
import {
  Button,
  ConsolePanel,
  MonoLabel,
  StatusChip,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  useAlert,
  useToast,
} from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import {
  addCallNoteAction,
  getCallAudioAction,
  getCallDetailAction,
  getCallNotesAction,
  reprocessCallAction,
  type CallDetailData,
  type CallFact,
  type CallNote,
  type TranscriptSegment,
} from "./actions";

export interface CallRow {
  id: string;
  direction: "incoming" | "outgoing";
  started_at: string;
  duration_s: number;
  audio_source_used: string | null;
  status: string;
  consent_status: string;
  device_id?: string | null;
  device_label: string | null;
  instance_id?: string | null;
  instance_name?: string | null;
  remote_number_prefix?: string | null;
  remote_number_last3?: string | null;
  remote_name?: string | null;
  /**
   * Contact history, computed per call by the API. All null when the number was
   * withheld - there is no history to count, and showing "1st call" for every
   * anonymous caller would be a lie repeated once per row.
   */
  calls_in?: number | null;
  calls_out?: number | null;
  sequence?: number | null;
  is_follow_up?: boolean | null;
}

/** "3 in / 2 out", or null when the number was withheld. */
function contactHistory(c: CallRow): string | null {
  if (c.calls_in == null && c.calls_out == null) return null;
  return `${c.calls_in ?? 0} in / ${c.calls_out ?? 0} out`;
}

/** "2nd call", "3rd call"… - the ordinal reads faster than "sequence: 3". */
function ordinalCall(n: number): string {
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix} call`;
}

function formatDuration(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Friendly call label: contact name, else the number's leading digits, else a fallback. */
function callLabel(c: CallRow): string {
  if (c.remote_name && c.remote_name.trim()) return c.remote_name.trim();
  if (c.remote_number_prefix) return `${c.remote_number_prefix}…`;
  if (c.remote_number_last3) return `…${c.remote_number_last3}`;
  return "Unknown caller";
}

/** snake_case / enum → plain words: "not_interested" → "Not interested". */
function humanize(s: string): string {
  const t = s.replace(/[_-]+/g, " ").trim().toLowerCase();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : s;
}

function statusTone(status: string): "solid" | "muted" | "outline" | "danger" {
  if (status === "COMPLETE") return "solid";
  if (status.startsWith("FAILED")) return "danger";
  // Deliberately not transcribed - not a success, not a fault.
  if (status === "TRANSCRIPTION_OFF") return "outline";
  return "muted";
}

/** Pipeline end states - anything else means the worker still has the call.
 *  TRANSCRIPTION_OFF counts: nothing is coming, so the drawer must stop
 *  polling for a transcript that was never going to be produced. */
function isTerminal(status: string): boolean {
  return (
    status === "COMPLETE" || status === "TRANSCRIPTION_OFF" || status.startsWith("FAILED")
  );
}

/** Poll interval while a call is mid-pipeline. Transcription of a several-minute
 *  call finishes in seconds, so this only ever runs a handful of times. */
const POLL_MS = 4000;
/** Give up after ~2 min. A call still moving after that is stuck (dead worker,
 *  drained queue), and polling an open tab forever helps nobody. */
const POLL_LIMIT = 30;

/**
 * Chrome for the note textarea. `@aura/ui` has no `Textarea` primitive yet
 * (doc 18 §2 defers it), so this mirrors the kit's `CONTROL_BASE` by hand -
 * notably `border-border-strong`, which is the token tuned to clear WCAG
 * 1.4.11's 3:1 for a control boundary. `--color-border` is a decorative
 * hairline and must never be the edge of something you can type into.
 *
 * `text-base sm:text-sm` is kept from the retired `inputClass`: iOS Safari
 * force-zooms the page when a control under 16px is focused, and the drawer is
 * used on a phone.
 */
const TEXTAREA_CLASS =
  "w-full min-w-0 rounded-sm border border-border-strong bg-surface px-3 py-2 " +
  "text-base leading-relaxed text-text transition-colors duration-150 ease-out sm:text-sm " +
  "placeholder:text-text-muted hover:border-text-subtle " +
  "disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-hover disabled:text-text-subtle";

function factValue(f: CallFact): string {
  if (f.value_text != null) return f.value_text;
  if (f.value_num != null) return String(f.value_num);
  if (f.value_bool != null) return f.value_bool ? "Yes" : "No";
  return "-";
}

/** Assigns each diarized speaker to a chat side; first distinct speaker = Agent. */
function speakerSideResolver(segments: TranscriptSegment[]) {
  const order = Array.from(new Set(segments.map((s) => s.speaker ?? "?")));
  return (speaker: string): { side: "agent" | "customer"; label: string } => {
    const low = speaker.toLowerCase();
    let side: "agent" | "customer";
    if (low.includes("agent") || low === "s1" || low === "a") side = "agent";
    else if (low.includes("customer") || low.includes("caller") || low === "s2" || low === "b")
      side = "customer";
    else side = order.indexOf(speaker) === 0 ? "agent" : "customer";
    const label = speaker === "?" ? (side === "agent" ? "Agent" : "Customer") : speaker;
    return { side, label };
  };
}

export function CallsExplorer({
  calls,
  /** Tenant these calls belong to. Omitted on the standalone /calls page, which
   *  still reads the environment's dev org; required everywhere the operator is
   *  looking at a specific customer, or the drawer reads the wrong tenant. */
  orgId,
  /** Show which instance each call came from - off when the table is already
   *  scoped to one instance and the column would repeat a single value. */
  showInstance = false,
  /** Open this call's drawer on arrival - how a search hit or any deep link
   *  lands on the conversation itself. The drawer fetches by id, so the call
   *  need not be on the current page of the table. */
  initialCallId,
}: {
  calls: CallRow[];
  orgId?: string;
  showInstance?: boolean;
  initialCallId?: string;
}) {
  const router = useRouter();
  const pollsRef = useRef(0);
  // Mirrors `openId` synchronously so an in-flight poll can tell, after its
  // await resolves, whether the drawer still shows the call it was polling
  // for - `openId` itself can't be read that way from inside the closure,
  // since state only updates on the next render.
  const openIdRef = useRef<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CallDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [notes, setNotes] = useState<CallNote[] | null>(null);
  const [noteBody, setNoteBody] = useState("");
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const openDrawer = useCallback(
    (callId: string) => {
      openIdRef.current = callId;
      setOpenId(callId);
      setDetail(null);
      setError(null);
      setAudioUrl(null);
      setNotes(null);
      setNoteBody("");
      pollsRef.current = 0;
      setLoading(true);
      startTransition(async () => {
        const [res, notesRes] = await Promise.all([
          getCallDetailAction(callId, orgId),
          getCallNotesAction(callId, orgId),
        ]);
        // Switched to (or away from) another call while this fetch was in
        // flight - its result belongs to a drawer that is no longer open.
        if (openIdRef.current !== callId) return;
        setLoading(false);
        if (res.error) setError(res.error);
        else setDetail(res.detail ?? null);
        setNotes(notesRes.error ? [] : notesRes.notes ?? []);
      });
    },
    [orgId],
  );

  // Deep link (e.g. a search hit). Guarded by a ref so closing the drawer does
  // not immediately reopen it while `?call=` is still in the URL.
  const deepLinked = useRef(false);
  useEffect(() => {
    if (!initialCallId || deepLinked.current) return;
    deepLinked.current = true;
    openDrawer(initialCallId);
  }, [initialCallId, openDrawer]);

  /**
   * A call opened mid-pipeline used to sit on "No transcript yet" forever: the
   * drawer fetched once and nothing ever re-read it, so a transcript that landed
   * seconds later stayed invisible until the drawer was closed and reopened.
   * Poll while the call is in a non-terminal state, and refresh the underlying
   * table once it settles so the row's status stops disagreeing with the drawer.
   */
  useEffect(() => {
    const status = detail?.call.status;
    // A failed call with a retry pending is not settled - the sweeper will move
    // it without anyone touching the page, so keep watching until it lands.
    const retryPending = Boolean(detail?.call.next_attempt_at);
    if (!openId || !status || (isTerminal(status) && !retryPending)) return;
    if (pollsRef.current >= POLL_LIMIT) return;
    const poll = async () => {
      pollsRef.current += 1;
      const target = openId;
      const res = await getCallDetailAction(target, orgId);
      // The drawer may have switched to a different call (or closed) while
      // this request was in flight - a stale response for the PREVIOUS call
      // must not land on top of whatever is open now.
      if (openIdRef.current !== target) return;
      if (res.detail) {
        setDetail(res.detail);
        // Refresh the table only once the call has actually settled. A failed
        // call still awaiting a retry is not settled, and refreshing on every
        // poll would re-render the whole page each tick for no new information.
        const settled =
          isTerminal(res.detail.call.status) && !res.detail.call.next_attempt_at;
        if (settled) router.refresh();
      }
    };
    // setTimeout wants a void callback. Handing it an `async` one gives it a
    // promise it drops on the floor, so a poll that rejects - the server action
    // throwing, a dropped connection - becomes an unhandled rejection and
    // nothing else. Swallow it deliberately instead: the drawer keeps showing
    // its last-known detail, `pollsRef` was already incremented so POLL_LIMIT
    // still bounds the loop, and the user can close and reopen to retry.
    const t = setTimeout(() => void poll().catch(() => undefined), POLL_MS);
    return () => clearTimeout(t);
    // detail identity changes on every poll, which is what re-arms the timer.
  }, [openId, detail, router, orgId]);

  const addNote = () => {
    if (!openId || !noteBody.trim()) return;
    startTransition(async () => {
      const res = await addCallNoteAction(openId, noteBody.trim(), orgId);
      if (res.error) {
        await alert({ title: "Couldn't add the note", body: res.error, tone: "danger" });
        return;
      }
      setNoteBody("");
      toast("Note added");
      const refreshed = await getCallNotesAction(openId, orgId);
      setNotes(refreshed.error ? notes : refreshed.notes ?? []);
    });
  };

  const close = () => {
    openIdRef.current = null;
    setOpenId(null);
  };

  const reprocess = () => {
    if (!openId) return;
    startTransition(async () => {
      const res = await reprocessCallAction(openId, orgId);
      if (res.error) {
        await alert({
          title: "Couldn't reprocess the call",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      toast(`Reprocess ${res.status ?? "queued"}`);
      pollsRef.current = 0;
      // Re-read immediately: the call leaves COMPLETE for a pipeline state, which
      // is what arms the poll above. Without this the drawer keeps showing the
      // old transcript and looks like the reprocess did nothing.
      const again = await getCallDetailAction(openId, orgId);
      if (again.detail) setDetail(again.detail);
    });
  };

  const getAudio = () => {
    if (!openId) return;
    setAudioUrl(null);
    startTransition(async () => {
      const res = await getCallAudioAction(openId, orgId);
      if (res.error) {
        await alert({
          title: "Couldn't load the recording",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      setAudioUrl(res.url ?? null);
    });
  };

  const call = detail?.call;
  const segments = detail?.transcript?.segments ?? null;
  const resolveSpeaker = segments ? speakerSideResolver(segments) : null;
  const intel = detail?.transcript?.intelligence ?? null;
  const analytics = detail?.analytics ?? null;

  return (
    <>
      {/* The kit's <Table> owns its own border and cannot carry a min-width on
          the <table> element, and both callers already wrap this in a Card. So
          the wrapper is hand-rolled - but it keeps the primitive's two
          accessibility affordances verbatim: tabIndex + role="region" so the
          horizontal scroll of a wide log is reachable without a mouse
          (WCAG 2.1.1), and a caption naming the table. Cells and rows are the
          real primitives. */}
      <div tabIndex={0} role="region" aria-label="Call log" className="overflow-x-auto">
        <table
          className={`w-full ${showInstance ? "min-w-[1000px]" : "min-w-[870px]"} border-collapse text-left text-sm`}
        >
          <caption className="sr-only">Call log</caption>
          <TableHead>
            {/* A plain <tr>, not TableRow: the header must not pick up the row
                hover tint, which would read as though it were clickable. */}
            <tr>
              <TableHeaderCell>Call</TableHeaderCell>
              <TableHeaderCell>Date and time</TableHeaderCell>
              {showInstance ? <TableHeaderCell>Instance</TableHeaderCell> : null}
              <TableHeaderCell>Device</TableHeaderCell>
              <TableHeaderCell>Duration</TableHeaderCell>
              <TableHeaderCell>Source</TableHeaderCell>
              <TableHeaderCell>Consent</TableHeaderCell>
              <TableHeaderCell>Pipeline</TableHeaderCell>
            </tr>
          </TableHead>
          <TableBody>
            {calls.map((c) => (
              <TableRow key={c.id} onClick={() => openDrawer(c.id)} className="cursor-pointer">
                <TableCell>
                  <div className="flex items-center gap-2.5">
                    <div
                      // Direction is carried by the icon's shape as well as the
                      // tint, so this still reads in greyscale and to a
                      // colour-blind operator (WCAG 1.4.1).
                      aria-hidden="true"
                      className={`shrink-0 rounded-sm border p-1.5 ${
                        c.direction === "incoming"
                          ? "border-accent-subtle bg-accent-subtle text-accent-text"
                          : "border-border bg-bg-subtle text-text-muted"
                      }`}
                    >
                      {c.direction === "incoming" ? (
                        <PhoneIncoming className="h-3.5 w-3.5" />
                      ) : (
                        <PhoneOutgoing className="h-3.5 w-3.5" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {/* The row's onClick is mouse-only. This button is what
                            makes the drawer reachable from the keyboard, and it
                            is also the row's accessible name. stopPropagation
                            keeps a mouse click from firing both handlers and
                            re-fetching the detail twice. */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openDrawer(c.id);
                          }}
                          className="cursor-pointer rounded-sm text-left text-sm font-medium text-text hover:underline"
                        >
                          {callLabel(c)}
                        </button>
                        {/* A repeat caller is the single most useful thing to
                            spot while scanning a log, so it sits on the name
                            rather than in a column you have to look for. */}
                        {c.is_follow_up ? <StatusChip tone="muted">Follow-up</StatusChip> : null}
                      </div>
                      <span className="mt-0.5 block text-xs text-text-muted tabular-nums">
                        #{c.id.slice(0, 8)}
                        {contactHistory(c) ? (
                          <span className="ml-2">
                            {c.sequence && c.sequence > 1 ? `${ordinalCall(c.sequence)} · ` : ""}
                            {contactHistory(c)}
                          </span>
                        ) : null}
                      </span>
                    </div>
                  </div>
                </TableCell>
                {/* Date over time, both tabular so the column scans down the
                    page. Previously this was a 10px caption under the caller
                    name - present, but not something you could read a log by. */}
                <TableCell className="whitespace-nowrap">
                  <LocalTime
                    iso={c.started_at}
                    mode="date"
                    className="block text-xs font-medium text-text tabular-nums"
                  />
                  <LocalTime
                    iso={c.started_at}
                    mode="time"
                    className="block text-xs text-text-muted tabular-nums"
                  />
                </TableCell>
                {showInstance ? (
                  <TableCell className="text-xs">{c.instance_name ?? "-"}</TableCell>
                ) : null}
                <TableCell className="text-xs">{c.device_label ?? "-"}</TableCell>
                <TableCell className="text-xs tabular-nums">
                  {formatDuration(c.duration_s)}
                </TableCell>
                <TableCell className="text-xs text-text-muted">
                  {c.audio_source_used ?? "-"}
                </TableCell>
                <TableCell className="text-xs text-text-muted">
                  {humanize(c.consent_status)}
                </TableCell>
                <TableCell>
                  <StatusChip tone={statusTone(c.status)}>{humanize(c.status)}</StatusChip>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </table>
      </div>

      <AnimatePresence>
        {openId ? (
          <>
            <motion.div
              className="fixed inset-0 z-40 bg-black/50"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={close}
            />
            <motion.aside
              // role + aria-label, but deliberately NOT aria-modal: this drawer
              // is not focus-trapped (the kit's Dialog is, but it is a centred
              // modal and this is a slide-over), and claiming modality a screen
              // reader then cannot rely on is worse than not claiming it.
              role="dialog"
              aria-label="Call detail"
              className="fixed top-0 right-0 z-50 h-full w-full max-w-xl overflow-y-auto border-l border-border bg-surface shadow-lg"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 32, stiffness: 320 }}
            >
              <div className="sticky top-0 z-10 flex items-center justify-between gap-4 border-b border-border bg-surface px-6 py-4">
                <div className="min-w-0">
                  <MonoLabel>Call detail</MonoLabel>
                  <h3 className="mt-1 text-xl font-semibold text-text tabular-nums">
                    #{openId.slice(0, 8)}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close call detail"
                  className="-mr-1 shrink-0 cursor-pointer rounded-sm p-1.5 text-text-muted transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-text"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-6 p-6">
                {loading ? (
                  <p className="py-8 text-center text-sm text-text-muted">Loading call detail…</p>
                ) : error ? (
                  <p className="rounded-md border border-danger bg-danger-subtle p-3 text-sm font-medium text-danger-text">
                    {error}
                  </p>
                ) : call ? (
                  <>
                    {/* Status */}
                    <section className="space-y-2.5">
                      <MonoLabel>Status</MonoLabel>
                      <div className="flex flex-wrap gap-2">
                        <StatusChip tone={statusTone(call.status)}>
                          {humanize(call.status)}
                        </StatusChip>
                        <StatusChip tone="outline">
                          {humanize(call.direction)} · {formatDuration(call.duration_s)}
                        </StatusChip>
                        <StatusChip tone="muted">Consent: {humanize(call.consent_status)}</StatusChip>
                        {call.crm_status ? (
                          <StatusChip tone="solid">CRM: {humanize(call.crm_status)}</StatusChip>
                        ) : null}
                        {call.pipeline_status ? (
                          <StatusChip tone="solid">Stage: {humanize(call.pipeline_status)}</StatusChip>
                        ) : null}
                        {/* How well we know this caller. Worth surfacing next to
                            the status chips: "we have spoken 4 times" changes how
                            you read everything below it. */}
                        {call.is_follow_up ? (
                          <StatusChip tone="solid">
                            Follow-up · {call.sequence ? ordinalCall(call.sequence) : "repeat"}
                          </StatusChip>
                        ) : contactHistory(call) ? (
                          <StatusChip tone="muted">First contact</StatusChip>
                        ) : null}
                        {contactHistory(call) ? (
                          <StatusChip tone="outline">{contactHistory(call)}</StatusChip>
                        ) : null}
                      </div>
                      <p className="text-xs text-text-muted">
                        {call.device_label ?? "Unknown device"} · Source{" "}
                        {call.audio_source_used ?? "-"} · <LocalTime iso={call.started_at} />
                      </p>
                      {/* Why it broke, next to the fact that it broke - otherwise
                          triage means SSH-ing to read worker logs. */}
                      {call.error_message ? (
                        <div className="space-y-1 rounded-md border border-danger bg-danger-subtle p-3">
                          <span className="block text-xs font-medium text-danger-text">
                            Failure reason
                          </span>
                          {/* The message itself stays monospaced: it is machine
                              output (stack frames, ids, exit codes) and the
                              alignment is part of reading it. */}
                          <p className="font-mono text-xs leading-relaxed break-words text-danger-text">
                            {call.error_message}
                          </p>
                          {/* Whether anyone needs to act. A pending retry means
                              this resolves itself; no retry means it will not. */}
                          <p className="pt-1 text-xs font-medium text-danger-text tabular-nums">
                            {call.next_attempt_at
                              ? `Retrying automatically · attempt ${(call.pipeline_attempts ?? 0) + 1} · next ${new Date(call.next_attempt_at).toLocaleTimeString()}`
                              : `Gave up after ${call.pipeline_attempts ?? 0} attempt${(call.pipeline_attempts ?? 0) === 1 ? "" : "s"} - reprocess to try again`}
                          </p>
                        </div>
                      ) : null}
                    </section>

                    {/* Call analytics: quality score, talk-ratio coaching metrics, risk flags */}
                    {analytics ? (
                      <section className="space-y-3">
                        <div className="flex items-center justify-between">
                          <MonoLabel>Call analytics</MonoLabel>
                          {analytics.has_escalation_risk ? (
                            <StatusChip tone="danger">Needs review</StatusChip>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {analytics.quality_score !== null ? (
                            <StatusChip
                              tone={
                                analytics.quality_score >= 70
                                  ? "solid"
                                  : analytics.quality_score >= 40
                                    ? "muted"
                                    : "danger"
                              }
                            >
                              Quality: {analytics.quality_score}/100
                            </StatusChip>
                          ) : null}
                          {analytics.talk_ratio !== null ? (
                            <StatusChip tone="outline">
                              Agent talk: {Math.round(analytics.talk_ratio * 100)}%
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
                              <div className="rounded-md border border-border bg-bg-subtle p-3 text-sm leading-relaxed text-text">
                                {analytics.quality_criteria.rationale}
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                        {analytics.risk_flags.length > 0 ? (
                          <div className="space-y-1.5">
                            <MonoLabel>Risk flags</MonoLabel>
                            {analytics.risk_flags.map((flag, i) => (
                              <div
                                key={i}
                                className="flex items-start gap-2 rounded-md border border-border bg-bg-subtle p-2.5 text-sm"
                              >
                                <StatusChip
                                  tone={
                                    flag.severity === "high"
                                      ? "danger"
                                      : flag.severity === "medium"
                                        ? "muted"
                                        : "outline"
                                  }
                                >
                                  {humanize(flag.severity)}
                                </StatusChip>
                                <span className="min-w-0">
                                  <span className="block text-xs text-text-muted">
                                    {humanize(flag.category)}
                                  </span>
                                  {flag.snippet}
                                </span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </section>
                    ) : null}

                    {/* Call intelligence: intent + sentiment + outcome */}
                    {intel &&
                    (intel.summary ||
                      intel.overall_intent ||
                      (intel.key_points?.length ?? 0) > 0 ||
                      (intel.action_items?.length ?? 0) > 0) ? (
                      <section className="space-y-3">
                        <MonoLabel>Call summary</MonoLabel>
                        <div className="flex flex-wrap gap-2">
                          {intel.sentiment ? (
                            <StatusChip
                              tone={
                                intel.sentiment === "positive"
                                  ? "solid"
                                  : intel.sentiment === "negative"
                                    ? "danger"
                                    : "muted"
                              }
                            >
                              Feeling: {humanize(intel.sentiment)}
                            </StatusChip>
                          ) : null}
                          {intel.outcome ? (
                            <StatusChip tone="outline">Result: {humanize(intel.outcome)}</StatusChip>
                          ) : null}
                        </div>
                        {intel.summary ? (
                          <div className="rounded-md border border-border bg-bg-subtle p-3 text-sm leading-relaxed text-text">
                            {intel.summary}
                          </div>
                        ) : null}
                        <div className="space-y-1.5">
                          {(
                            [
                              ["Call intent", intel.overall_intent],
                              ["Customer", intel.customer_intent],
                              ["Agent", intel.agent_intent],
                            ] as const
                          ).map(([label, value]) =>
                            value ? (
                              <div key={label} className="flex gap-2 text-sm">
                                <span className="w-24 shrink-0 text-xs text-text-muted">
                                  {label}
                                </span>
                                <span className="text-text">{value}</span>
                              </div>
                            ) : null,
                          )}
                        </div>
                        {intel.key_points?.length ? (
                          <div className="space-y-1">
                            <MonoLabel>Key points</MonoLabel>
                            <ul className="list-inside list-disc space-y-0.5 text-sm text-text">
                              {intel.key_points.map((k, i) => (
                                <li key={i}>{k}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {intel.action_items?.length ? (
                          <div className="space-y-1">
                            <MonoLabel>Action items</MonoLabel>
                            <ul className="list-inside list-disc space-y-0.5 text-sm text-text">
                              {intel.action_items.map((k, i) => (
                                <li key={i}>{k}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </section>
                    ) : null}

                    {/* Transcript bubbles */}
                    <section className="space-y-3">
                      <div className="flex items-center justify-between">
                        <MonoLabel>Transcript</MonoLabel>
                        {detail?.transcript?.engine ? (
                          <StatusChip tone="outline">
                            {detail.transcript.engine}
                            {detail.transcript.diarized ? " · diarized" : ""}
                          </StatusChip>
                        ) : null}
                      </div>
                      {segments && segments.length > 0 && resolveSpeaker ? (
                        <div className="space-y-2.5">
                          {segments.map((seg, i) => {
                            const { side, label } = resolveSpeaker(seg.speaker ?? "?");
                            const isAgent = side === "agent";
                            return (
                              <div
                                key={i}
                                className={`flex ${isAgent ? "justify-end" : "justify-start"}`}
                              >
                                <div className="max-w-[80%] space-y-1">
                                  <div
                                    className={`flex items-center gap-1.5 text-xs text-text-muted ${
                                      isAgent ? "justify-end" : "justify-start"
                                    }`}
                                  >
                                    {isAgent ? (
                                      <>
                                        {label} <Bot aria-hidden="true" className="h-3 w-3" />
                                      </>
                                    ) : (
                                      <>
                                        <User aria-hidden="true" className="h-3 w-3" /> {label}
                                      </>
                                    )}
                                  </div>
                                  {/* Side is carried by alignment and by the
                                      speaker label above, so the tint is a third
                                      redundant channel rather than the only one.
                                      accent-text on accent-subtle is 8:1 in both
                                      modes - a filled accent bubble would not be. */}
                                  <div
                                    className={`rounded-md border p-2.5 text-sm leading-relaxed ${
                                      isAgent
                                        ? "border-accent-subtle bg-accent-subtle text-accent-text"
                                        : "border-border bg-bg-subtle text-text"
                                    }`}
                                  >
                                    {seg.text}
                                  </div>
                                  {seg.intent ? (
                                    <div
                                      className={`text-xs text-text-muted ${
                                        isAgent ? "text-right" : "text-left"
                                      }`}
                                    >
                                      Intent: {seg.intent}
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : detail?.transcript?.text ? (
                        <div className="rounded-md border border-border bg-bg-subtle p-3 text-sm leading-relaxed whitespace-pre-wrap text-text">
                          {detail.transcript.text}
                        </div>
                      ) : call.status === "TRANSCRIPTION_OFF" ? (
                        // "No transcript yet" would imply one is coming.
                        <p className="rounded-md border border-border bg-bg-subtle p-3 text-sm leading-relaxed text-text-muted">
                          <span className="mb-1 block text-sm font-medium text-text">
                            Transcription is off for this instance
                          </span>
                          The call and its recording were stored, but ASR and analysis were
                          skipped. Turn transcription back on for this instance, then reprocess to
                          transcribe it.
                        </p>
                      ) : (
                        <p className="py-3 text-sm text-text-muted">No transcript yet</p>
                      )}
                    </section>

                    {/* AI output + facts */}
                    <section className="space-y-3">
                      <MonoLabel>AI analysis</MonoLabel>
                      {detail?.aiOutput ? (
                        <>
                          <div className="flex flex-wrap gap-2">
                            {detail.aiOutput.provider ? (
                              <StatusChip tone="outline">{humanize(detail.aiOutput.provider)}</StatusChip>
                            ) : null}
                            {detail.aiOutput.validation_status ? (
                              <StatusChip
                                tone={
                                  detail.aiOutput.validation_status === "valid"
                                    ? "solid"
                                    : "danger"
                                }
                              >
                                {detail.aiOutput.validation_status === "valid" ? "Checked" : "Needs review"}
                              </StatusChip>
                            ) : null}
                          </div>
                          {/* ConsolePanel, not a hand-rolled bg-black/text-green
                              block: it is the kit's terminal surface, stays dark
                              in both modes on purpose, and its whitespace-pre-wrap
                              keeps the JSON indentation without a sideways
                              scrollbar. It takes lines, so the pretty-printed
                              document is split on newlines. */}
                          <ConsolePanel
                            className="max-h-64"
                            lines={JSON.stringify(detail.aiOutput.output, null, 2).split("\n")}
                          />
                        </>
                      ) : (
                        <p className="py-3 text-sm text-text-muted">No AI output yet</p>
                      )}
                    </section>

                    {/* Extracted facts */}
                    <section className="space-y-3">
                      <MonoLabel>Details</MonoLabel>
                      {detail?.facts && detail.facts.length > 0 ? (
                        <div className="divide-y divide-border rounded-md border border-border">
                          {detail.facts.map((f) => (
                            <div
                              key={f.field_key}
                              className="flex items-center justify-between gap-3 px-3 py-2.5"
                            >
                              <span className="text-sm text-text-muted">
                                {humanize(f.field_key)}
                              </span>
                              <span className="text-right text-sm font-medium break-words text-text">
                                {factValue(f)}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="py-3 text-sm text-text-muted">No facts extracted</p>
                      )}
                    </section>

                    {/* Notes */}
                    <section className="space-y-3">
                      <MonoLabel>Notes</MonoLabel>
                      {notes && notes.length > 0 ? (
                        <div className="space-y-2">
                          {notes.map((n) => (
                            <div
                              key={n.id}
                              className="space-y-1 rounded-md border border-border bg-surface p-3"
                            >
                              <p className="text-sm leading-relaxed whitespace-pre-wrap text-text">
                                {n.body}
                              </p>
                              <span className="block text-xs text-text-muted">
                                {n.author ?? "Unknown"} · <LocalTime iso={n.created_at} />
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="py-2 text-sm text-text-muted">No notes yet</p>
                      )}

                      <div className="space-y-2">
                        {/* A placeholder is not a label (WCAG 3.3.2) - it
                            disappears the moment anything is typed. The visible
                            "Notes" MonoLabel above is a <p>, not a <label>, so
                            the control gets its own visually-hidden one. */}
                        <label htmlFor="call-note-body" className="sr-only">
                          Add a note about this call
                        </label>
                        <textarea
                          id="call-note-body"
                          className={`${TEXTAREA_CLASS} h-20`}
                          placeholder="Add a note about this call…"
                          value={noteBody}
                          onChange={(e) => setNoteBody(e.target.value)}
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={pending || !noteBody.trim()}
                          onClick={addNote}
                        >
                          <MessageSquarePlus aria-hidden="true" className="h-4 w-4" />
                          {pending ? "Saving…" : "Add note"}
                        </Button>
                      </div>
                    </section>

                    {/* Actions */}
                    <section className="space-y-3 border-t border-border pt-4">
                      <div className="flex flex-wrap gap-3">
                        <Button type="button" disabled={pending} onClick={reprocess}>
                          <RefreshCw aria-hidden="true" className="h-4 w-4" />
                          {pending ? "Working…" : "Reprocess"}
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={pending}
                          onClick={getAudio}
                        >
                          <Link2 aria-hidden="true" className="h-4 w-4" />
                          {audioUrl ? "Reload audio" : "Load audio"}
                        </Button>
                      </div>
                      {audioUrl ? (
                        <div className="space-y-2">
                          <MonoLabel>Recording playback</MonoLabel>
                          {/* No <track> caption: this is a raw call recording
                              streamed from a signed URL, and there is no
                              caption track to point at - the transcript above
                              is the accessible text alternative. */}
                          <audio
                            key={audioUrl}
                            controls
                            preload="metadata"
                            src={audioUrl}
                            className="w-full"
                          />
                          <a
                            href={audioUrl}
                            target="_blank"
                            rel="noreferrer"
                            download
                            className="inline-block rounded-sm text-sm font-medium text-accent-text underline underline-offset-2 hover:text-accent"
                          >
                            Download / open in new tab
                          </a>
                        </div>
                      ) : null}
                    </section>
                  </>
                ) : null}
              </div>
            </motion.aside>
          </>
        ) : null}
      </AnimatePresence>
    </>
  );
}
