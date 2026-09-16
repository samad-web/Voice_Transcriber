"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Mic, MicOff } from "lucide-react";
import {
  Button,
  Card,
  MonoLabel,
  RowHint,
  StatusChip,
  useAlert,
  useConfirm,
  useToast,
} from "@aura/ui";
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
  const [asking, setAsking] = useState(false);
  const [pending, startTransition] = useTransition();
  const hintId = useId();
  const confirm = useConfirm();
  const alert = useAlert();
  const toast = useToast();

  const disable = async () => {
    const ok = await confirm({
      title: `Stop transcribing calls for ${instanceName}?`,
      body:
        "Calls keep arriving and stay listed with their recordings - they just won't be " +
        "transcribed or analysed until you switch this back on.",
      confirmLabel: "Stop transcribing",
      tone: "danger",
      // Reversible switch: calls keep arriving and keep their recordings.
      requireTyped: false,
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await setTranscriptionEnabledAction({ orgId, enabled: false });
      if (res.error) {
        await alert({
          title: "Couldn't stop transcription",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      toast("Transcription is off for this instance.");
      router.refresh();
    });
  };

  /**
   * Enabling is two steps, in this order: turn it on, then pick up the backlog.
   * If the reprocess half fails the instance is still transcribing new calls,
   * which is the more important half - and the backlog can be retried.
   */
  const enable = (days: number | null) => {
    setAsking(false);
    startTransition(async () => {
      const on = await setTranscriptionEnabledAction({ orgId, enabled: true });
      if (on.error) {
        await alert({
          title: "Couldn't turn transcription on",
          body: on.error,
          tone: "danger",
        });
        return;
      }
      if (days === 0) {
        toast("Transcription on. Backlog left as it was.");
        router.refresh();
        return;
      }
      const res = await reprocessBacklogAction({
        orgId,
        statuses: ["TRANSCRIPTION_OFF"],
        sinceDays: days,
      });
      if (res.error) {
        await alert({
          title: "Couldn't queue the backlog",
          body: `Transcription is on and new calls are being transcribed, but the backlog could not be queued: ${res.error}`,
          tone: "danger",
        });
        return;
      }
      toast(
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

      {/* Wired to the button below with aria-describedby, not just placed near
          it. A screen-reader user who tabs straight onto "Enable transcription"
          would otherwise hear a verb and nothing about what it costs or what it
          leaves alone - which is the entire content of the decision. */}
      <RowHint kind="toggle" id={`${hintId}-state`}>
        {enabled
          ? "On: calls from this instance are transcribed and analysed as they arrive, and each one is billed."
          : "Off: calls are still collected and listed with their recordings, but ASR and analysis are skipped. Nothing is being spent on this instance."}
      </RowHint>

      {asking ? (
        <div className="space-y-2 rounded-md border border-border-strong bg-bg-subtle p-3">
          <MonoLabel>How much of the backlog should be transcribed?</MonoLabel>
          <RowHint kind="action">
            Calls that arrived while transcription was off still have their audio. Transcribing
            them costs the same as a new call, so pick a window.
          </RowHint>
          <div className="space-y-1.5 pt-1">
            {BACKLOG_CHOICES.map((c) => (
              <button
                key={c.label}
                type="button"
                disabled={pending}
                onClick={() => enable(c.days)}
                className="w-full rounded-md border border-border-strong bg-surface p-2 text-left transition-colors duration-150 ease-out hover:bg-surface-hover disabled:cursor-not-allowed disabled:text-text-subtle"
              >
                <span className="block text-xs font-medium text-text">{c.label}</span>
                <span className="block text-xs text-text-muted">{c.blurb}</span>
              </button>
            ))}
          </div>
          <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => setAsking(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          variant={enabled ? "secondary" : "primary"}
          disabled={pending}
          loading={pending}
          aria-describedby={`${hintId}-state`}
          onClick={enabled ? () => void disable() : () => setAsking(true)}
        >
          {enabled ? (
            <MicOff className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Mic className="h-4 w-4" aria-hidden="true" />
          )}
          {enabled ? "Disable transcription" : "Enable transcription"}
        </Button>
      )}
    </Card>
  );
}
