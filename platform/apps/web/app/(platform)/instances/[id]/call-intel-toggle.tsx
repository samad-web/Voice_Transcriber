"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText } from "lucide-react";
import { BrutalButton, Card, MonoLabel, StatusChip, useConfirm } from "@aura/ui";
import { setModuleEnabledAction } from "./actions";
import type { OwnerRow } from "./owner-accounts";

/**
 * Call Intelligence on/off for one tenant (`enabled_modules`, org-modules.ts).
 *
 * WHAT IT ACTUALLY HANDS OVER. With this on, the client's own console shows the
 * AI read of their calls - intent, sentiment, outcome, quality - on the lead
 * list and against every call in a lead's history, and lets them open the
 * transcript itself. With it off they see what they saw before: the lead the
 * call produced, and a call history with times and durations. Nothing about
 * the recording pipeline changes either way; this decides who may READ the
 * result, not what gets produced.
 *
 * CONFIRMED ON THE WAY ON, not on the way off - the opposite of the CRM toggle
 * next to it, and deliberately so. Turning CRM off takes a working tool away
 * from a team, so that is the risky direction there. Here the risky direction
 * is ON: a transcript is a word-for-word account of a customer's phone call,
 * and switching it on is a disclosure that cannot be taken back once somebody
 * has read it. Turning it off needs no ceremony.
 *
 * SECOND GATE, NOT A SUBSTITUTE FOR THE FIRST. Even with the module on, the
 * verbatim text is served only to accounts whose `recordings_listen` is set -
 * the same flag Owner accounts above controls - so this card reports how many
 * of this tenant's people that currently is. The AI read reaches everyone.
 */
export function CallIntelToggle({
  orgId,
  enabled,
  instanceName,
  owners,
  modules,
}: {
  orgId: string;
  enabled: boolean;
  instanceName: string;
  /** Owner accounts, to report who could actually open a transcript. */
  owners: OwnerRow[];
  /** The tenant's whole entitlement, so this toggle leaves the rest alone. */
  modules: string[];
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();

  // Only accounts that can sign in are counted: a revoked member with the flag
  // still set is not somebody who can read anything.
  const active = owners.filter((o) => o.hasLogin && o.status === "active");
  const canRead = active.filter((o) => o.recordingsListen);

  const toggle = async (next: boolean) => {
    if (next) {
      const ok = await confirm({
        title: `Show call transcripts to ${instanceName}?`,
        body:
          "Their team will be able to read the AI read of every call - intent, sentiment and " +
          "outcome - on their leads, and open the transcript of any call with one. This is the " +
          "word-for-word record of a customer conversation; once it has been read it cannot be " +
          "un-disclosed. Accounts without recordings access still see the AI read but not the text.",
        confirmLabel: "Turn on Call Intelligence",
      });
      if (!ok) return;
    }
    setError(null);
    startTransition(async () => {
      const res = await setModuleEnabledAction({
        orgId,
        module: "call_intel",
        enabled: next,
        current: modules,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <Card elevated className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4" />
          <MonoLabel>Call Intelligence</MonoLabel>
        </div>
        <StatusChip tone={enabled ? "solid" : "muted"}>{enabled ? "On" : "Off"}</StatusChip>
      </div>

      <p className="text-xs text-neutral-500 font-sans font-medium leading-relaxed">
        {enabled
          ? "This client sees each call's intent, sentiment and outcome on their leads, and can open the transcript."
          : "This client sees only the lead a call produced - no transcript, no intent or sentiment labels."}
      </p>

      {enabled ? (
        <div className="border-2 border-black bg-white p-3 space-y-1.5">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <MonoLabel>Who can open a transcript</MonoLabel>
            <StatusChip tone={canRead.length > 0 ? "solid" : "muted"}>
              {canRead.length} of {active.length}
            </StatusChip>
          </div>
          <p className="text-[10px] font-mono text-neutral-500 leading-relaxed">
            {canRead.length === 0
              ? "Nobody. Their team sees the intent and sentiment labels, but every transcript stays withheld until an account is given recordings access in Owner accounts above."
              : "The rest of their team still sees the intent and sentiment labels - only the verbatim text is withheld. Recordings access is per account, in Owner accounts above."}
          </p>
        </div>
      ) : null}

      <BrutalButton
        variant={enabled ? "secondary" : "primary"}
        disabled={pending}
        onClick={() => void toggle(!enabled)}
      >
        {pending ? "SAVING…" : enabled ? "TURN OFF" : "TURN ON"}
      </BrutalButton>

      {error ? (
        <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
          {error}
        </p>
      ) : null}
    </Card>
  );
}
