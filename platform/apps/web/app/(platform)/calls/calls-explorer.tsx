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
import { BrutalButton, MonoLabel, StatusChip } from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { inputClass } from "@/lib/form";
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
   * withheld — there is no history to count, and showing "1st call" for every
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

/** "2nd call", "3rd call"… — the ordinal reads faster than "sequence: 3". */
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
  // Deliberately not transcribed — not a success, not a fault.
  if (status === "TRANSCRIPTION_OFF") return "outline";
  return "muted";
}

/** Pipeline end states — anything else means the worker still has the call.
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

function factValue(f: CallFact): string {
  if (f.value_text != null) return f.value_text;
  if (f.value_num != null) return String(f.value_num);
  if (f.value_bool != null) return f.value_bool ? "Yes" : "No";
  return "—";
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
  /** Show which instance each call came from — off when the table is already
   *  scoped to one instance and the column would repeat a single value. */
  showInstance = false,
  /** Open this call's drawer on arrival — how a search hit or any deep link
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
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CallDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [reprocessMsg, setReprocessMsg] = useState<string | null>(null);
  const [notes, setNotes] = useState<CallNote[] | null>(null);
  const [noteBody, setNoteBody] = useState("");
  const [noteError, setNoteError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const openDrawer = useCallback(
    (callId: string) => {
      setOpenId(callId);
      setDetail(null);
      setError(null);
      setAudioUrl(null);
      setReprocessMsg(null);
      setNotes(null);
      setNoteBody("");
      setNoteError(null);
      pollsRef.current = 0;
      setLoading(true);
      startTransition(async () => {
        const [res, notesRes] = await Promise.all([
          getCallDetailAction(callId, orgId),
          getCallNotesAction(callId, orgId),
        ]);
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
    // A failed call with a retry pending is not settled — the sweeper will move
    // it without anyone touching the page, so keep watching until it lands.
    const retryPending = Boolean(detail?.call.next_attempt_at);
    if (!openId || !status || (isTerminal(status) && !retryPending)) return;
    if (pollsRef.current >= POLL_LIMIT) return;
    const t = setTimeout(async () => {
      pollsRef.current += 1;
      const res = await getCallDetailAction(openId, orgId);
      if (res.detail) {
        setDetail(res.detail);
        // Refresh the table only once the call has actually settled. A failed
        // call still awaiting a retry is not settled, and refreshing on every
        // poll would re-render the whole page each tick for no new information.
        const settled =
          isTerminal(res.detail.call.status) && !res.detail.call.next_attempt_at;
        if (settled) router.refresh();
      }
    }, POLL_MS);
    return () => clearTimeout(t);
    // detail identity changes on every poll, which is what re-arms the timer.
  }, [openId, detail, router, orgId]);

  const addNote = () => {
    if (!openId || !noteBody.trim()) return;
    setNoteError(null);
    startTransition(async () => {
      const res = await addCallNoteAction(openId, noteBody.trim(), orgId);
      if (res.error) {
        setNoteError(res.error);
        return;
      }
      setNoteBody("");
      const refreshed = await getCallNotesAction(openId, orgId);
      setNotes(refreshed.error ? notes : refreshed.notes ?? []);
    });
  };

  const close = () => setOpenId(null);

  const reprocess = () => {
    if (!openId) return;
    setReprocessMsg(null);
    startTransition(async () => {
      const res = await reprocessCallAction(openId, orgId);
      setReprocessMsg(res.error ? res.error : `Reprocess ${res.status ?? "queued"}`);
      if (res.error) return;
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
      if (res.error) setError(res.error);
      else setAudioUrl(res.url ?? null);
    });
  };

  const call = detail?.call;
  const segments = detail?.transcript?.segments ?? null;
  const resolveSpeaker = segments ? speakerSideResolver(segments) : null;
  const intel = detail?.transcript?.intelligence ?? null;

  return (
    <>
      <div className="overflow-x-auto">
        <table
          className={`w-full ${showInstance ? "min-w-[1000px]" : "min-w-[870px]"} text-left border-collapse`}
        >
          <thead>
            <tr className="bg-neutral-100 border-b-2 border-black font-mono text-[10px] text-black font-bold uppercase tracking-wider">
              <th className="py-3.5 px-5">Call</th>
              <th className="py-3.5 px-4">Date &amp; Time</th>
              {showInstance ? <th className="py-3.5 px-4">Instance</th> : null}
              <th className="py-3.5 px-4">Device</th>
              <th className="py-3.5 px-4">Duration</th>
              <th className="py-3.5 px-4">Source</th>
              <th className="py-3.5 px-4">Consent</th>
              <th className="py-3.5 px-4 text-right">Pipeline</th>
            </tr>
          </thead>
          <tbody className="divide-y-2 divide-neutral-100 text-sm">
            {calls.map((c) => (
              <tr
                key={c.id}
                onClick={() => openDrawer(c.id)}
                className="hover:bg-neutral-50 cursor-pointer"
              >
                <td className="py-4 px-5">
                  <div className="flex items-center gap-2.5">
                    <div
                      className={`p-1.5 rounded-none border border-black ${
                        c.direction === "incoming"
                          ? "bg-black text-white"
                          : "bg-neutral-100 text-black"
                      }`}
                    >
                      {c.direction === "incoming" ? (
                        <PhoneIncoming className="h-3.5 w-3.5" />
                      ) : (
                        <PhoneOutgoing className="h-3.5 w-3.5" />
                      )}
                    </div>
                    <div>
                      <span className="text-sm font-bold text-black block font-sans">
                        {callLabel(c)}
                        {/* A repeat caller is the single most useful thing to
                            spot while scanning a log, so it sits on the name
                            rather than in a column you have to look for. */}
                        {c.is_follow_up ? (
                          <span className="ml-2 align-middle inline-block border-2 border-black bg-black px-1.5 py-0.5 text-[9px] font-mono font-bold uppercase tracking-wider text-white">
                            Follow-up
                          </span>
                        ) : null}
                      </span>
                      <span className="text-[10px] text-neutral-400 font-mono block">
                        #{c.id.slice(0, 8)}
                        {contactHistory(c) ? (
                          <span className="ml-2 text-neutral-500">
                            {c.sequence && c.sequence > 1 ? `${ordinalCall(c.sequence)} · ` : ""}
                            {contactHistory(c)}
                          </span>
                        ) : null}
                      </span>
                    </div>
                  </div>
                </td>
                {/* Date over time, both monospaced so the column scans down the
                    page. Previously this was a 10px caption under the caller
                    name — present, but not something you could read a log by. */}
                <td className="py-4 px-4 whitespace-nowrap">
                  <LocalTime
                    iso={c.started_at}
                    mode="date"
                    className="block font-mono text-xs font-bold text-black"
                  />
                  <LocalTime
                    iso={c.started_at}
                    mode="time"
                    className="block font-mono text-[11px] text-neutral-500"
                  />
                </td>
                {showInstance ? (
                  <td className="py-4 px-4 text-xs font-sans font-bold">
                    {c.instance_name ?? "—"}
                  </td>
                ) : null}
                <td className="py-4 px-4 text-xs font-sans font-bold">{c.device_label ?? "—"}</td>
                <td className="py-4 px-4 font-mono text-xs font-bold">
                  {formatDuration(c.duration_s)}
                </td>
                <td className="py-4 px-4 font-mono text-xs">{c.audio_source_used ?? "—"}</td>
                <td className="py-4 px-4 font-mono text-xs uppercase">{c.consent_status}</td>
                <td className="py-4 px-4 text-right">
                  <StatusChip tone={statusTone(c.status)}>{c.status}</StatusChip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AnimatePresence>
        {openId ? (
          <>
            <motion.div
              className="fixed inset-0 bg-black/40 z-40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={close}
            />
            <motion.aside
              className="fixed right-0 top-0 h-full w-full max-w-xl bg-white border-l-4 border-black z-50 overflow-y-auto"
              initial={{ x: "100%" }}
              animate={{ x: 0 }}
              exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 32, stiffness: 320 }}
            >
              <div className="sticky top-0 bg-white border-b-2 border-black p-5 flex items-center justify-between z-10">
                <div>
                  <MonoLabel>Call Detail</MonoLabel>
                  <h3 className="text-xl font-display font-black text-black uppercase tracking-tight mt-1">
                    #{openId.slice(0, 8)}
                  </h3>
                </div>
                <button
                  onClick={close}
                  aria-label="Close"
                  className="p-1.5 text-black hover:text-white hover:bg-black rounded-none border-2 border-black"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="p-5 space-y-6">
                {loading ? (
                  <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-8 text-center">
                    Loading call detail…
                  </p>
                ) : error ? (
                  <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
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
                      <p className="text-[10px] font-mono text-neutral-400 uppercase tracking-wider font-bold">
                        {call.device_label ?? "unknown device"} · src{" "}
                        {call.audio_source_used ?? "—"} · <LocalTime iso={call.started_at} />
                      </p>
                      {/* Why it broke, next to the fact that it broke — otherwise
                          triage means SSH-ing to read worker logs. */}
                      {call.error_message ? (
                        <div className="border-2 border-red-600 bg-red-50 p-3 space-y-1">
                          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-red-700 block">
                            Failure reason
                          </span>
                          <p className="text-xs font-mono text-red-900 leading-relaxed break-words">
                            {call.error_message}
                          </p>
                          {/* Whether anyone needs to act. A pending retry means
                              this resolves itself; no retry means it will not. */}
                          <p className="text-[10px] font-mono font-bold uppercase tracking-wider text-red-700 pt-1">
                            {call.next_attempt_at
                              ? `Retrying automatically · attempt ${(call.pipeline_attempts ?? 0) + 1} · next ${new Date(call.next_attempt_at).toLocaleTimeString()}`
                              : `Gave up after ${call.pipeline_attempts ?? 0} attempt${(call.pipeline_attempts ?? 0) === 1 ? "" : "s"} — reprocess to try again`}
                          </p>
                        </div>
                      ) : null}
                    </section>

                    {/* Call intelligence: intent + sentiment + outcome */}
                    {intel &&
                    (intel.summary ||
                      intel.overall_intent ||
                      (intel.key_points?.length ?? 0) > 0 ||
                      (intel.action_items?.length ?? 0) > 0) ? (
                      <section className="space-y-3">
                        <MonoLabel>Call Summary</MonoLabel>
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
                          <div className="p-3 border-2 border-black bg-neutral-50 text-xs font-sans leading-relaxed">
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
                              <div key={label} className="flex gap-2 text-xs">
                                <span className="font-mono font-bold uppercase text-[10px] text-neutral-400 w-24 shrink-0 pt-0.5">
                                  {label}
                                </span>
                                <span className="font-sans text-black">{value}</span>
                              </div>
                            ) : null,
                          )}
                        </div>
                        {intel.key_points?.length ? (
                          <div className="space-y-1">
                            <MonoLabel>Key points</MonoLabel>
                            <ul className="list-disc list-inside text-xs font-sans space-y-0.5">
                              {intel.key_points.map((k, i) => (
                                <li key={i}>{k}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                        {intel.action_items?.length ? (
                          <div className="space-y-1">
                            <MonoLabel>Action items</MonoLabel>
                            <ul className="list-disc list-inside text-xs font-sans space-y-0.5">
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
                                    className={`flex items-center gap-1.5 text-[9px] font-mono font-bold uppercase tracking-wider text-neutral-400 ${
                                      isAgent ? "justify-end" : "justify-start"
                                    }`}
                                  >
                                    {isAgent ? (
                                      <>
                                        {label} <Bot className="h-3 w-3" />
                                      </>
                                    ) : (
                                      <>
                                        <User className="h-3 w-3" /> {label}
                                      </>
                                    )}
                                  </div>
                                  <div
                                    className={`p-2.5 border-2 border-black rounded-none text-xs font-sans leading-relaxed ${
                                      isAgent ? "bg-black text-white" : "bg-neutral-50 text-black"
                                    }`}
                                  >
                                    {seg.text}
                                  </div>
                                  {seg.intent ? (
                                    <div
                                      className={`text-[9px] font-mono uppercase tracking-wider text-neutral-400 ${
                                        isAgent ? "text-right" : "text-left"
                                      }`}
                                    >
                                      intent: {seg.intent}
                                    </div>
                                  ) : null}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : detail?.transcript?.text ? (
                        <div className="p-3 border-2 border-black bg-neutral-50 text-xs font-sans leading-relaxed whitespace-pre-wrap">
                          {detail.transcript.text}
                        </div>
                      ) : call.status === "TRANSCRIPTION_OFF" ? (
                        // "No transcript yet" would imply one is coming.
                        <p className="text-xs font-sans text-neutral-600 leading-relaxed border-2 border-neutral-300 bg-neutral-50 p-3">
                          <span className="font-mono font-bold uppercase text-[10px] tracking-wider text-black block mb-1">
                            Transcription is off for this instance
                          </span>
                          The call and its recording were stored, but ASR and analysis were
                          skipped. Turn transcription back on for this instance, then Reprocess to
                          transcribe it.
                        </p>
                      ) : (
                        <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-3">
                          No transcript yet
                        </p>
                      )}
                    </section>

                    {/* AI output + facts */}
                    <section className="space-y-3">
                      <MonoLabel>AI Analysis</MonoLabel>
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
                          <div className="bg-black rounded-none p-4 text-[10px] font-mono text-green-400 overflow-x-auto max-h-64 overflow-y-auto border-2 border-black">
                            <pre>{JSON.stringify(detail.aiOutput.output, null, 2)}</pre>
                          </div>
                        </>
                      ) : (
                        <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-3">
                          No AI output yet
                        </p>
                      )}
                    </section>

                    {/* Extracted facts */}
                    <section className="space-y-3">
                      <MonoLabel>Details</MonoLabel>
                      {detail?.facts && detail.facts.length > 0 ? (
                        <div className="border-2 border-black divide-y-2 divide-neutral-100">
                          {detail.facts.map((f) => (
                            <div
                              key={f.field_key}
                              className="flex items-center justify-between gap-3 p-2.5"
                            >
                              <span className="font-sans text-xs font-bold text-neutral-500">
                                {humanize(f.field_key)}
                              </span>
                              <span className="font-sans text-xs font-bold text-black text-right break-words">
                                {factValue(f)}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-3">
                          No facts extracted
                        </p>
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
                              className="p-3 border-2 border-neutral-200 bg-white space-y-1"
                            >
                              <p className="text-xs font-sans leading-relaxed text-black whitespace-pre-wrap">
                                {n.body}
                              </p>
                              <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-neutral-400">
                                {n.author ?? "unknown"} · <LocalTime iso={n.created_at} />
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-2">
                          No notes yet
                        </p>
                      )}

                      <div className="space-y-2">
                        <textarea
                          className={`${inputClass} h-20 leading-relaxed`}
                          placeholder="Add a note about this call…"
                          value={noteBody}
                          onChange={(e) => setNoteBody(e.target.value)}
                        />
                        <BrutalButton
                          variant="secondary"
                          disabled={pending || !noteBody.trim()}
                          onClick={addNote}
                        >
                          <MessageSquarePlus className="h-4 w-4" />
                          {pending ? "SAVING…" : "ADD NOTE"}
                        </BrutalButton>
                        {noteError ? (
                          <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
                            {noteError}
                          </p>
                        ) : null}
                      </div>
                    </section>

                    {/* Actions */}
                    <section className="space-y-3 border-t-2 border-neutral-200 pt-4">
                      <div className="flex flex-wrap gap-3">
                        <BrutalButton shadow disabled={pending} onClick={reprocess}>
                          <RefreshCw className="h-4 w-4" />
                          {pending ? "WORKING…" : "REPROCESS"}
                        </BrutalButton>
                        <BrutalButton variant="secondary" disabled={pending} onClick={getAudio}>
                          <Link2 className="h-4 w-4" />
                          {audioUrl ? "RELOAD AUDIO" : "LOAD AUDIO"}
                        </BrutalButton>
                      </div>
                      {reprocessMsg ? (
                        <p className="text-[11px] font-mono font-bold uppercase text-black">
                          {reprocessMsg}
                        </p>
                      ) : null}
                      {audioUrl ? (
                        <div className="space-y-2">
                          <MonoLabel>Recording playback</MonoLabel>
                          {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
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
                            className="inline-block text-[11px] font-mono font-bold uppercase text-black underline hover:text-neutral-600"
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
