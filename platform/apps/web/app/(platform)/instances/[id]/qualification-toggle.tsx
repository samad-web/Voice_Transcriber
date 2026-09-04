"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { ScanSearch, ShieldOff } from "lucide-react";
import { BrutalButton, Card, MonoLabel, StatusChip, useAlert, useConfirm } from "@aura/ui";
import { setWhatsAppQualificationAction } from "./actions";

/**
 * WhatsApp lead qualification on/off for one instance (migrations 0080/0082).
 *
 * ── WHY THIS IS A DELIBERATE, CONFIRMED DECISION AND NOT A CHECKBOX ───────
 *
 * Turning this on means this tenant's inbound WhatsApp conversations - the
 * actual words their customers typed - are sent to an LLM provider to be read.
 * That is a materially different consent question from anything else on this
 * page, and it is one the tenant has to make knowingly. So the enable path
 * states plainly what leaves the building, the same way the transcription
 * toggle states plainly what will be spent.
 *
 * Off is the default in the schema, so an instance that never opens this dialog
 * never sends anything anywhere.
 */
export function QualificationToggle({
  orgId,
  enabled,
  retentionDays,
  instanceName,
}: {
  orgId: string;
  enabled: boolean;
  retentionDays: number;
  instanceName: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();
  const alert = useAlert();

  const set = (next: boolean) => {
    startTransition(async () => {
      const res = await setWhatsAppQualificationAction({ orgId, enabled: next });
      if (res.error) {
        await alert({
          title: "Couldn't change WhatsApp lead qualification",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      router.refresh();
    });
  };

  const enable = async () => {
    const ok = await confirm({
      title: `Read ${instanceName}'s WhatsApp threads to find leads?`,
      body:
        "Inbound WhatsApp conversations from numbers that match no contact will be sent to " +
        "an AI provider to be read and scored. Only threads from unknown numbers are read, " +
        "and nothing is added to the CRM until someone here approves it. " +
        "Messages the qualifier judges private are never shown in the review queue and " +
        "nothing from them is kept.",
      confirmLabel: "Turn on qualification",
    });
    if (ok) set(true);
  };

  const disable = async () => {
    const ok = await confirm({
      title: `Stop reading ${instanceName}'s WhatsApp threads?`,
      body:
        "No further conversations will be sent to the AI provider. Threads already waiting " +
        `for review stay in the queue, and decided ones are deleted after ${retentionDays} days.`,
      confirmLabel: "Stop qualifying",
      tone: "danger",
    });
    if (ok) set(false);
  };

  return (
    <Card elevated className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          {enabled ? <ScanSearch className="h-4 w-4" /> : <ShieldOff className="h-4 w-4" />}
          <MonoLabel>WhatsApp lead qualification</MonoLabel>
        </div>
        <StatusChip tone={enabled ? "solid" : "muted"}>{enabled ? "On" : "Off"}</StatusChip>
      </div>

      <p className="text-xs text-neutral-500 font-sans font-medium leading-relaxed">
        {enabled
          ? `Unclaimed WhatsApp threads are read and scored, and proposed leads wait for a person to approve them. Decided verdicts are deleted after ${retentionDays} days.`
          : "Inbound WhatsApp is stored and readable in the inbox as usual, but nothing is sent to an AI provider and no leads are proposed from it."}
      </p>

      <BrutalButton
        variant={enabled ? "secondary" : "primary"}
        disabled={pending}
        onClick={enabled ? () => void disable() : () => void enable()}
      >
        {enabled ? <ShieldOff className="h-4 w-4" /> : <ScanSearch className="h-4 w-4" />}
        {pending ? "SAVING…" : enabled ? "TURN OFF QUALIFICATION" : "TURN ON QUALIFICATION"}
      </BrutalButton>
    </Card>
  );
}
