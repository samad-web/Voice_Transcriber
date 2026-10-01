"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { CallEscalationSettingsView } from "@aura/shared";
import { Card, ErrorBanner, useConfirm, useToast } from "@aura/ui";
import { useServerState } from "@/lib/use-server-state";
import { Toggle } from "../attendance/toggle";
import { setEscalationSwitchAction } from "./actions";

/**
 * The workspace switch (0151, Build docs/38, "The switch").
 *
 * Owners only. A manager sees it in the state it is in, disabled, with the one
 * line that says why - the API returns `canEditSwitch` so this never guesses.
 * Both directions confirm: turning it on puts a new option in front of every
 * telecaller, and turning it off takes it away while some may be mid-call.
 */
export function EscalationSwitch({ initial }: { initial: CallEscalationSettingsView }) {
  const toast = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useServerState(initial);

  const flip = async (next: boolean) => {
    const live = settings.liveCount;
    const ok = await confirm(
      next
        ? {
            title: "Turn on escalations?",
            body: "Telecallers will see an Escalate option on their calls, in the phone app and here. Each one goes to the person chosen for them below.",
            confirmLabel: "Turn on",
          }
        : {
            title: "Turn off escalations?",
            body:
              "Telecallers will no longer see the Escalate option, in the app or here. " +
              (live > 0
                ? `The ${live === 1 ? "one escalation" : `${live} escalations`} still waiting stay open and can still be answered.`
                : "Nothing is waiting right now."),
            confirmLabel: "Turn off",
          },
    );
    if (!ok) return;
    setError(null);
    startTransition(async () => {
      const result = await setEscalationSwitchAction(next);
      if (result.error) {
        setError(result.error);
        return;
      }
      setSettings((s) => result.settings ?? { ...s, enabled: next });
      toast(next ? "Escalations are on" : "Escalations are off");
      // The rail's Escalations entry follows the switch.
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      <Card className="space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text">Let telecallers escalate calls</h3>
            <p className="mt-1 max-w-2xl text-sm text-text-muted">
              When this is on, a telecaller can hand a call up to a senior or a manager - from the phone
              app, or from the call in a lead&rsquo;s history here. When it is off, they don&rsquo;t see
              the option and handle the call themselves.
            </p>
            {settings.canEditSwitch ? null : (
              <p className="mt-1 text-sm text-text-muted">Only an owner of this workspace can turn this on or off.</p>
            )}
          </div>
          <Toggle
            on={settings.enabled}
            label="Let telecallers escalate calls"
            disabled={pending || !settings.canEditSwitch}
            onChange={(next) => void flip(next)}
          />
        </div>
        <p className="text-sm text-text-muted">
          {settings.liveCount === 0 ? (
            "Nothing is waiting for an answer."
          ) : (
            <>
              <span className="font-medium text-text tabular-nums">{settings.liveCount}</span>{" "}
              {settings.liveCount === 1 ? "escalation is" : "escalations are"} waiting for an answer.{" "}
              <Link
                href="/owner/escalations"
                className="font-medium text-accent-text underline-offset-2 hover:underline"
              >
                Open the queue
              </Link>
            </>
          )}
        </p>
      </Card>
    </div>
  );
}
