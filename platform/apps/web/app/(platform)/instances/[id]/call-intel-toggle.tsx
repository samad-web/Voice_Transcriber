"use client";

import { useId, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FileText } from "lucide-react";
import { Button, Card, MonoLabel, RowHint, StatusChip, useAlert, useConfirm } from "@aura/ui";
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
  const [pending, startTransition] = useTransition();
  const hintId = useId();
  const confirm = useConfirm();
  const alert = useAlert();

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
    startTransition(async () => {
      const res = await setModuleEnabledAction({
        orgId,
        module: "call_intel",
        enabled: next,
        current: modules,
      });
      if (res.error) {
        await alert({
          title: next
            ? "Couldn't turn on Call Intelligence"
            : "Couldn't turn off Call Intelligence",
          body: res.error,
          tone: "danger",
        });
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

      <RowHint kind="toggle" id={`${hintId}-state`}>
        {enabled
          ? "On: this client sees each call's intent, sentiment and outcome on their leads, and can open the transcript."
          : "Off: this client sees only the lead a call produced - no transcript, no intent or sentiment labels."}
      </RowHint>

      {enabled ? (
        <div className="space-y-1.5 rounded-md border border-border-strong bg-bg-subtle p-3">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <MonoLabel>Who can open a transcript</MonoLabel>
            <StatusChip tone={canRead.length > 0 ? "solid" : "muted"}>
              {canRead.length} of {active.length}
            </StatusChip>
          </div>
          <RowHint kind="blocked">
            {canRead.length === 0
              ? "Nobody. Their team sees the intent and sentiment labels, but every transcript stays withheld until an account is given recordings access in Owner accounts above."
              : "The rest of their team still sees the intent and sentiment labels - only the verbatim text is withheld. Recordings access is per account, in Owner accounts above."}
          </RowHint>
        </div>
      ) : null}

      <Button
        type="button"
        variant={enabled ? "secondary" : "primary"}
        disabled={pending}
        loading={pending}
        aria-describedby={`${hintId}-state`}
        onClick={() => void toggle(!enabled)}
      >
        {enabled ? "Turn off" : "Turn on"}
      </Button>
    </Card>
  );
}
