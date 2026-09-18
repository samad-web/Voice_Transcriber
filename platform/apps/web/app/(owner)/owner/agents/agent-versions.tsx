"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, MonoLabel, StatusChip, useAlert, useConfirm, useToast } from "@aura/ui";
import { activateAgentAction, archiveAgentAction, deactivateAgentAction } from "./actions";

export interface VersionHeader {
  version: number;
  name: string;
  isActive: boolean;
  createdAt: string;
  fieldCount: number;
}

const dateFormat = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * Every saved version, with the one running marked - and the two ways out:
 * switching the agent off, and archiving it.
 *
 * Switching an older version on IS the rollback. There is no separate
 * "restore" that copies it forward, because a copy would be a new version
 * number describing old text, and "which version read this call" would stop
 * lining up with what the owner remembers switching on.
 */
export function AgentVersions({
  agentId,
  versions,
  activeVersion,
  viewing,
  noun,
}: {
  agentId: string;
  versions: VersionHeader[];
  activeVersion: number | null;
  viewing: number;
  /** What it stops doing when switched off: "reading calls", … */
  noun: string;
}) {
  const router = useRouter();
  const alert = useAlert();
  const confirm = useConfirm();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  const act = async (fn: () => Promise<{ error?: string }>, done: string, failure: string) => {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (res.error) {
      await alert({ title: failure, body: res.error, tone: "danger" });
      return false;
    }
    toast(done);
    return true;
  };

  const switchOn = async (version: number) => {
    const ok = await confirm({
      title: `Switch on version ${version}?`,
      body:
        activeVersion === null
          ? `It starts ${noun} straight away. Any other agent of this kind that is running is switched off.`
          : `It replaces version ${activeVersion} from now on. Anything already processed keeps the version it was read with.`,
      confirmLabel: "Switch on",
    });
    if (!ok) return;
    await act(
      () => activateAgentAction({ agentId, version }),
      `Version ${version} is running`,
      "Couldn't switch it on",
    );
  };

  const switchOff = async () => {
    const ok = await confirm({
      title: "Switch this agent off?",
      body: `It stops ${noun}. Nothing it already did is undone, and you can switch it back on at any time.`,
      confirmLabel: "Switch off",
    });
    if (!ok) return;
    await act(
      () => deactivateAgentAction({ agentId }),
      "Agent switched off",
      "Couldn't switch it off",
    );
  };

  const archive = async () => {
    const ok = await confirm({
      title: "Archive this agent?",
      body: "It is switched off and removed from the studio. Calls and leads it already produced keep their record of it.",
      confirmLabel: "Archive",
      tone: "danger",
      // Recoverable in the data (the rows stay), and typing DELETE for
      // something that deletes nothing would teach people to type it unread.
      requireTyped: false,
    });
    if (!ok) return;
    if (await act(() => archiveAgentAction({ agentId }), "Agent archived", "Couldn't archive it")) {
      router.push("/owner/agents");
    }
  };

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <MonoLabel>Versions</MonoLabel>
        {activeVersion !== null ? (
          <StatusChip tone="solid">Running · v{activeVersion}</StatusChip>
        ) : (
          <StatusChip tone="outline">Off</StatusChip>
        )}
      </div>

      <ul className="divide-y divide-border rounded-md border border-border">
        {versions.map((v) => (
          <li
            key={v.version}
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
          >
            <div className="min-w-0">
              <p className="text-sm text-text">
                Version {v.version}
                {v.version === viewing ? (
                  <span className="text-text-muted"> · shown below</span>
                ) : null}
              </p>
              <p className="text-xs text-text-subtle">{dateFormat.format(new Date(v.createdAt))}</p>
            </div>
            <div className="flex items-center gap-2">
              {v.version !== viewing ? (
                <Link
                  href={`/owner/agents/${agentId}?version=${v.version}`}
                  className="text-sm text-text underline underline-offset-2"
                >
                  View
                </Link>
              ) : null}
              {v.isActive ? (
                <StatusChip tone="solid">Running</StatusChip>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void switchOn(v.version)}
                >
                  Switch on
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        {activeVersion !== null ? (
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => void switchOff()}
          >
            Switch off
          </Button>
        ) : null}
        <Button type="button" variant="ghost" disabled={busy} onClick={() => void archive()}>
          Archive
        </Button>
      </div>
    </Card>
  );
}
