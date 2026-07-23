"use client";

import { useState, useTransition } from "react";
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
  device_label: string | null;
  remote_number_prefix?: string | null;
  remote_number_last3?: string | null;
  remote_name?: string | null;
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
  return "muted";
}

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

export function CallsExplorer({ calls }: { calls: CallRow[] }) {
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

  const openDrawer = (callId: string) => {
    setOpenId(callId);
    setDetail(null);
    setError(null);
    setAudioUrl(null);
    setReprocessMsg(null);
    setNotes(null);
    setNoteBody("");
    setNoteError(null);
    setLoading(true);
    startTransition(async () => {
      const [res, notesRes] = await Promise.all([
        getCallDetailAction(callId),
        getCallNotesAction(callId),
      ]);
      setLoading(false);
      if (res.error) setError(res.error);
      else setDetail(res.detail ?? null);
      setNotes(notesRes.error ? [] : notesRes.notes ?? []);
    });
  };

  const addNote = () => {
    if (!openId || !noteBody.trim()) return;
    setNoteError(null);
    startTransition(async () => {
      const res = await addCallNoteAction(openId, noteBody.trim());
      if (res.error) {
        setNoteError(res.error);
        return;
      }
      setNoteBody("");
      const refreshed = await getCallNotesAction(openId);
      setNotes(refreshed.error ? notes : refreshed.notes ?? []);
    });
  };

  const close = () => setOpenId(null);

  const reprocess = () => {
    if (!openId) return;
    setReprocessMsg(null);
    startTransition(async () => {
      const res = await reprocessCallAction(openId);
      setReprocessMsg(res.error ? res.error : `Reprocess ${res.status ?? "queued"}`);
    });
  };

  const getAudio = () => {
    if (!openId) return;
    setAudioUrl(null);
    startTransition(async () => {
      const res = await getCallAudioAction(openId);
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
        <table className="w-full min-w-[750px] text-left border-collapse">
          <thead>
            <tr className="bg-neutral-100 border-b-2 border-black font-mono text-[10px] text-black font-bold uppercase tracking-wider">
              <th className="py-3.5 px-5">Call</th>
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
                      </span>
                      <LocalTime
                        iso={c.started_at}
                        className="text-[10px] text-neutral-400 font-mono block"
                      />
                    </div>
                  </div>
                </td>
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
                      </div>
                      <p className="text-[10px] font-mono text-neutral-400 uppercase tracking-wider font-bold">
                        {call.device_label ?? "unknown device"} · src{" "}
                        {call.audio_source_used ?? "—"} · <LocalTime iso={call.started_at} />
                      </p>
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
