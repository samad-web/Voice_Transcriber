"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AppConnection, ConnectionState } from "@aura/shared";
import { StatusChip, useAlert, useConfirm, useToast, type ConfirmOptions } from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { disconnectAction } from "../connections/actions";
import { updateLeadSourceAction } from "../lead-sources/actions";
import { disconnectMcpAction } from "../meta-ads/actions";
import { setChannelStatusAction, verifyChannelAction } from "../messaging-setup/actions";
import { linkedinDisconnectAction, metaDisconnectPageAction } from "./actions";
import { connectHref } from "./app-links";

/**
 * An app's connections, each with the few things a person can do to it
 * (doc 28 §10.2, §12).
 *
 * ── EVERY ACTION IS AN EXISTING ONE ─────────────────────────────────────────
 *
 * Pausing a sheet is the Lead sources page's own action; switching a number
 * off is Messaging setup's. The store calls them, it does not re-implement
 * them - so the two pages cannot disagree about what "paused" does.
 *
 * ── WHAT DISCONNECT MEANS DIFFERS, AND THE DIALOG SAYS SO ───────────────────
 *
 * A lead source is never deleted (0078 has no DELETE): it pauses, keeping its
 * address so it can resume. A number is switched off, never deleted, because
 * every conversation points at it. A mailbox really is removed. Each confirm
 * spells out what stops and what stays, and the ones that stop a whole team's
 * inflow ask for the typed word.
 */

const STATE_CHIP: Record<ConnectionState, { text: string; tone: "solid" | "outline" | "muted" | "danger" }> = {
  connected: { text: "Connected", tone: "solid" },
  connecting: { text: "Finish setup", tone: "outline" },
  attention: { text: "Needs attention", tone: "danger" },
  paused: { text: "Paused", tone: "muted" },
};

type RunAction = {
  kind: "run";
  label: string;
  run: () => Promise<{ error?: string }>;
  done: string;
  confirm?: ConfirmOptions;
  /** A destructive control reads orange, never red (red is a missed call). */
  destructive?: boolean;
};
type RowAction = { kind: "link"; label: string; href: string } | RunAction;

/**
 * The kit's ghost button, drawn here rather than overridden: a `className`
 * cannot reliably recolour a kit component (cx is a plain join, and Tailwind
 * settles the tie by stylesheet order), and a destructive control here must be
 * orange - this console's error colour - never the kit's red, which means a
 * missed call.
 */
const rowButton = (destructive: boolean) =>
  `inline-flex h-10 items-center rounded-full px-3 text-sm font-medium transition-colors duration-150 ease-out hover:bg-surface-hover disabled:cursor-not-allowed disabled:text-text-subtle sm:h-8 sm:text-xs ${
    destructive ? "text-orange-text" : "text-text"
  }`;

/**
 * What a person may do to one row. Decided by which table the row came from
 * (`rowKind`), not by the app: Meta leads alone arrive three ways - a Page
 * grant, an MCP server, a webhook relay - and pausing, revoking and
 * disconnecting are different acts on each.
 */
function actionsFor(appId: string, c: AppConnection, canManage: boolean): RowAction[] {
  switch (c.rowKind) {
    case "lead_source":
      return canManage ? leadSourceActions(c) : [];
    case "channel":
      return canManage ? channelActions(c) : [];
    case "mailbox":
      return c.mine ? mailboxActions(appId, c) : [];
    case "pending_choice":
      return canManage && c.mine
        ? [{ kind: "link", label: "Choose Pages", href: `${connectHref(appId)}?step=choose&pending=${c.id}` }]
        : [];
    case "mcp_server":
      return canManage ? [mcpDisconnect(c)] : [];
    case "meta_page":
      return canManage ? [metaPageDisconnect(c)] : [];
    case "linkedin_account":
      return canManage ? linkedinActions(appId, c) : [];
    default:
      // A gateway is managed in the page's own settings card; provider-managed
      // connectors and API keys are the operator's.
      return [];
  }
}

function leadSourceActions(c: AppConnection): RowAction[] {
  if (c.state === "paused") {
    return [
      {
        kind: "run",
        label: "Resume",
        done: `${c.label} resumed`,
        run: () => updateLeadSourceAction(c.id, { status: "active" }),
      },
    ];
  }
  return [
    {
      kind: "run",
      label: "Pause",
      done: `${c.label} paused`,
      destructive: true,
      confirm: {
        title: `Pause "${c.label}"?`,
        body: "New leads from it stop until you resume it. Its address, its settings and every lead it already created stay.",
        confirmLabel: "Pause",
      },
      run: () => updateLeadSourceAction(c.id, { status: "paused" }),
    },
  ];
}

function channelActions(c: AppConnection): RowAction[] {
  if (c.state === "paused") {
    return [
      {
        kind: "run",
        label: "Switch on",
        done: `${c.label} switched on`,
        run: () => setChannelStatusAction(c.id, "active"),
      },
    ];
  }
  return [
    {
      kind: "run",
      label: "Check",
      done: "Checked - the result is on the row",
      run: () => verifyChannelAction(c.id),
    },
    {
      kind: "run",
      label: "Switch off",
      done: `${c.label} switched off`,
      destructive: true,
      confirm: {
        title: `Switch off ${c.label}?`,
        body: "Messages in and out on this number stop for the whole team. Every conversation and message already in Aura stays, and you can switch it back on.",
        confirmLabel: "Switch off",
        tone: "danger",
      },
      run: () => setChannelStatusAction(c.id, "disabled"),
    },
  ];
}

function mailboxActions(appId: string, c: AppConnection): RowAction[] {
  const disconnect: RunAction = {
    kind: "run",
    label: "Disconnect",
    done: `${c.label} disconnected`,
    destructive: true,
    confirm: {
      title: `Disconnect ${c.label}?`,
      body: "Mail and calendar sync stop, and Aura can no longer send email as you. Emails and meetings already on customer timelines stay.",
      confirmLabel: "Disconnect",
    },
    run: () => disconnectAction(c.id),
  };
  return c.state === "attention"
    ? [{ kind: "link", label: "Reconnect", href: connectHref(appId) }, disconnect]
    : [disconnect];
}

function mcpDisconnect(c: AppConnection): RunAction {
  return {
    kind: "run",
    label: "Disconnect",
    done: "MCP server disconnected",
    destructive: true,
    confirm: {
      title: "Disconnect the MCP server?",
      body: "Aura stops pulling leads through it. Every lead it already created stays.",
      confirmLabel: "Disconnect",
    },
    run: () => disconnectMcpAction(c.id),
  };
}

function metaPageDisconnect(c: AppConnection): RunAction {
  return {
    kind: "run",
    label: "Disconnect",
    done: `${c.label} disconnected`,
    destructive: true,
    confirm: {
      title: `Disconnect ${c.label}?`,
      body: "New leads from this Page's forms stop arriving for the whole team. Every lead already created stays. You can connect the Page again later.",
      confirmLabel: "Disconnect",
      tone: "danger",
    },
    run: () => metaDisconnectPageAction(c.id),
  };
}

function linkedinActions(appId: string, c: AppConnection): RowAction[] {
  if (c.state === "connecting") {
    return [{ kind: "link", label: "Choose ad account", href: `${connectHref(appId)}?step=choose&pending=${c.id}` }];
  }
  return [
    {
      kind: "run",
      label: "Disconnect",
      done: "LinkedIn disconnected",
      destructive: true,
      confirm: {
        title: `Disconnect ${c.label}?`,
        body: "Aura stops reading new Lead Gen Form responses from it. Every lead already created stays.",
        confirmLabel: "Disconnect",
      },
      run: () => linkedinDisconnectAction(c.id),
    },
  ];
}

export function ConnectionList({
  appId,
  connections,
  canManage,
}: {
  appId: string;
  connections: AppConnection[];
  canManage: boolean;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const toast = useToast();
  const alert = useAlert();
  // One control in flight at a time: a double click must not switch a number
  // off and back on (§11.5).
  const [busy, setBusy] = useState<string | null>(null);

  const perform = async (c: AppConnection, action: RunAction) => {
    if (action.confirm && !(await confirm(action.confirm))) return;
    setBusy(c.id);
    try {
      const result = await action.run();
      if (result.error) {
        await alert({ title: `Could not ${action.label.toLowerCase()} ${c.label}`, body: result.error, tone: "danger" });
        return;
      }
      toast(action.done);
      router.refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
      {connections.map((c) => {
        const chip = STATE_CHIP[c.state];
        const actions = actionsFor(appId, c, canManage);
        return (
          <li key={c.id} className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-3">
            <div className="min-w-0 flex-1 basis-60">
              <p className="truncate text-sm font-medium text-text">{c.label}</p>
              {c.detail ? <p className="mt-0.5 truncate text-xs text-text-muted">{c.detail}</p> : null}
              {c.lastError ? (
                // The provider's own words, orange: this console's error colour.
                <p className="mt-1.5 text-xs leading-relaxed text-orange-text">{c.lastError}</p>
              ) : null}
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs sm:flex sm:gap-x-5">
              <div>
                <dt className="text-text-subtle">Last activity</dt>
                <dd className="text-text-muted">
                  {c.lastActivityAt ? <LocalTime iso={c.lastActivityAt} /> : "None yet"}
                </dd>
              </div>
              {c.connectedBy ? (
                <div>
                  <dt className="text-text-subtle">Connected by</dt>
                  <dd className="text-text-muted">{c.connectedBy}</dd>
                </div>
              ) : null}
            </dl>
            <div className="flex flex-wrap items-center gap-2">
              <StatusChip tone={chip.tone}>{chip.text}</StatusChip>
              {actions.map((a) =>
                a.kind === "link" ? (
                  <Link
                    key={a.label}
                    href={a.href}
                    className="inline-flex h-10 items-center rounded-full px-3 text-sm font-medium text-text underline-offset-2 hover:underline sm:h-8 sm:text-xs"
                  >
                    {a.label}
                  </Link>
                ) : (
                  <button
                    key={a.label}
                    type="button"
                    disabled={busy !== null}
                    aria-busy={busy === c.id || undefined}
                    onClick={() => void perform(c, a)}
                    className={rowButton(a.destructive === true)}
                  >
                    {a.label}
                  </button>
                ),
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
