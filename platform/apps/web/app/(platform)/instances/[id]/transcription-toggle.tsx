"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Mic, MicOff } from "lucide-react";
import { BrutalButton, Card, MonoLabel, StatusChip } from "@aura/ui";
import { setTranscriptionEnabledAction } from "./actions";

/**
 * Transcription on/off for one instance.
 *
 * Deliberately separate from suspending the org: suspending refuses the upload,
 * so the customer's handsets stop recording and the calls are gone. This keeps
 * the call log filling up — numbers, durations, recordings, all still playable —
 * and only stops the paid ASR + analysis stages. Turning it back on plus a
 * Reprocess is what picks the backlog up.
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
  const [pending, startTransition] = useTransition();

  const toggle = () => {
    const next = !enabled;
    if (
      !next &&
      !window.confirm(
        `Stop transcribing calls for ${instanceName}?\n\n` +
          "Calls keep arriving and stay listed with their recordings — they just " +
          "won't be transcribed or analysed until you switch this back on.",
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await setTranscriptionEnabledAction({ orgId, enabled: next });
      if (res.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <Card shadow className="space-y-3">
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

      <BrutalButton
        variant={enabled ? "secondary" : "primary"}
        disabled={pending}
        onClick={toggle}
      >
        {enabled ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        {pending ? "SAVING…" : enabled ? "DISABLE TRANSCRIPTION" : "ENABLE TRANSCRIPTION"}
      </BrutalButton>

      {error ? (
        <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
