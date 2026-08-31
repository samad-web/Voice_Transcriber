"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Mic, MicOff } from "lucide-react";
import { BrutalButton, Card, MonoLabel, StatusChip, useConfirm } from "@aura/ui";
import { reprocessBacklogAction, setTranscriptionEnabledAction } from "./actions";

/**
 * How much of the untranscribed backlog to pick up when switching transcription
 * back on. Deliberately an explicit question rather than a default: the calls
 * that arrived while it was off still have their audio, so "everything" can mean
 * months of paid ASR on a dormant instance. Nobody should discover that from an
 * invoice.
 */
const BACKLOG_CHOICES: Array<{ days: number | null; label: string; blurb: string }> = [
  { days: 0, label: "Nothing", blurb: "New calls only. The backlog stays untranscribed - you can come back to it later." },
  { days: 7, label: "Last 7 days", blurb: "Transcribe calls from the past week." },
  { days: 30, label: "Last 30 days", blurb: "Transcribe calls from the past month." },
  { days: null, label: "Everything", blurb: "Transcribe every stored call that was skipped, however old. Costs the most." },
];

/**
 * Transcription on/off for one instance.
 *
 * Deliberately separate from suspending the org: suspending refuses the upload,
 * so the customer's handsets stop recording and the calls are gone. This keeps
 * the call log filling up - numbers, durations, recordings, all still playable -
 * and only stops the paid ASR + analysis stages.
 */
export function TranscriptionToggle({
  orgId,
  enabled,
  instanceName,
}: {
  orgId: string;
  enabled: boolean;
  instanceName: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();

  const disable = async () => {
    const ok = await confirm({
      title: `Stop transcribing calls for ${instanceName}?`,
      body:
        "Calls keep arriving and stay listed with their recordings - they just won't be " +
        "transcribed or analysed until you switch this back on.",
      confirmLabel: "Stop transcribing",
      tone: "danger",
    });
    if (!ok) return;
    setError(null);
    setNote(null);
    startTransition(async () => {
      const res = await setTranscriptionEnabledAction({ orgId, enabled: false });
      if (res.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  };

  /**
   * Enabling is two steps, in this order: turn it on, then pick up the backlog.
   * If the reprocess half fails the instance is still transcribing new calls,
   * which is the more important half - and the backlog can be retried.
   */
  const enable = (days: number | null) => {
    setError(null);
    setNote(null);
    setAsking(false);
    startTransition(async () => {
      const on = await setTranscriptionEnabledAction({ orgId, enabled: true });
      if (on.error) {
        setError(on.error);
        return;
      }
      if (days === 0) {
        setNote("Transcription on. Backlog left as it was.");
        router.refresh();
        return;
      }
      const res = await reprocessBacklogAction({
        orgId,
        statuses: ["TRANSCRIPTION_OFF"],
        sinceDays: days,
      });
      if (res.error) {
        setError(`Transcription is on, but the backlog could not be queued: ${res.error}`);
        return;
      }
      setNote(
        res.requeued === 0
          ? "Transcription on. No untranscribed calls in that window."
          : `Transcription on. ${res.requeued} call${res.requeued === 1 ? "" : "s"} queued - they'll appear as they finish.`,
      );
      router.refresh();
    });
  };

  return (
    <Card elevated className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          {enabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
          <MonoLabel>Transcription</MonoLabel>
        </div>
        <StatusChip tone={enabled ? "solid" : "muted"}>{enabled ? "On" : "Off"}</StatusChip>
      </div>

      <p className="text-xs text-neutral-500 font-sans font-medium leading-relaxed">
        {enabled
          ? "Calls from this instance are transcribed and analysed as they arrive."
          : "Calls are still collected and listed with their recordings, but ASR and analysis are skipped. Nothing is being spent on this instance."}
      </p>

      {asking ? (
        <div className="space-y-2 border-2 border-black bg-neutral-50 p-3">
          <MonoLabel>How much of the backlog should be transcribed?</MonoLabel>
          <p className="text-[11px] text-neutral-600 font-sans leading-relaxed">
            Calls that arrived while transcription was off still have their audio.
            Transcribing them costs the same as a new call, so pick a window.
          </p>
          <div className="space-y-1.5 pt-1">
            {BACKLOG_CHOICES.map((c) => (
              <button
                key={c.label}
                type="button"
                disabled={pending}
                onClick={() => enable(c.days)}
                className="w-full border-2 border-black bg-white p-2 text-left hover:bg-neutral-100 disabled:opacity-50"
              >
                <span className="block text-xs font-sans font-bold">{c.label}</span>
                <span className="block text-[11px] text-neutral-500 font-sans">{c.blurb}</span>
              </button>
            ))}
          </div>
          <BrutalButton variant="secondary" disabled={pending} onClick={() => setAsking(false)}>
            CANCEL
          </BrutalButton>
        </div>
      ) : (
        <BrutalButton
          variant={enabled ? "secondary" : "primary"}
          disabled={pending}
          onClick={enabled ? () => void disable() : () => setAsking(true)}
        >
          {enabled ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
          {pending ? "SAVING…" : enabled ? "DISABLE TRANSCRIPTION" : "ENABLE TRANSCRIPTION"}
        </BrutalButton>
      )}

      {note ? (
        <p className="text-xs text-neutral-700 font-sans font-bold border-2 border-black bg-neutral-50 p-3">
          {note}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
