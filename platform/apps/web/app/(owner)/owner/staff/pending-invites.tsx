"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy } from "lucide-react";
import { OWNER_ROLE_LABELS } from "@aura/shared";
import { Button, Card, MonoLabel, StatusChip, useAlert, useConfirm, useToast } from "@aura/ui";
import { resendInviteAction, revokeInviteAction } from "./actions";
import type { TeamInvite } from "./types";

/** A row plus the expiry wording, worked out on the server (no hydration drift over time zones). */
export type PendingInviteRow = TeamInvite & { expiresLabel: string };

/**
 * Invites that have been issued and not yet accepted or withdrawn (0137).
 *
 * Owners get Resend and Withdraw; a manager sees the list and nothing to press,
 * the same split as the roster. Both writes are `@RequireOwnerRole("owner")`
 * in the API regardless of what renders here.
 *
 * There is no "copy the existing link": only its hash is stored, so the link
 * is gone once the panel that created it is closed. Resend is how a lost link
 * is replaced - and it withdraws the old one in the same step.
 */
export function PendingInvites({
  invites,
  canEdit,
  mailConfigured,
}: {
  invites: PendingInviteRow[];
  canEdit: boolean;
  mailConfigured: boolean;
}) {
  if (invites.length === 0) return null;
  return (
    <Card className="space-y-3">
      <MonoLabel>Pending invites</MonoLabel>
      <ul className="divide-y divide-border">
        {/* Keyed by address, not id: Resend replaces the row with a new id,
            and an id key would remount it on refresh and drop the new link
            before the owner could copy it. One live invite per address is a
            unique index (org_invites_one_live), so the key stays unique. */}
        {invites.map((invite) => (
          <InviteRow key={invite.email} invite={invite} canEdit={canEdit} mailConfigured={mailConfigured} />
        ))}
      </ul>
    </Card>
  );
}

function InviteRow({
  invite,
  canEdit,
  mailConfigured,
}: {
  invite: PendingInviteRow;
  canEdit: boolean;
  mailConfigured: boolean;
}) {
  const router = useRouter();
  const alert = useAlert();
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [fresh, setFresh] = useState<{ link: string; note: string } | null>(null);

  const resend = (send: boolean) => {
    startTransition(async () => {
      if (
        send &&
        !(await confirm({
          title: `Email a new invite to ${invite.email}?`,
          body: "The current link stops working, and a new one is emailed to them once.",
          confirmLabel: "Send",
          requireTyped: false,
        }))
      ) {
        return;
      }
      const res = await resendInviteAction(invite.id, send);
      if (res.error || !res.issued) {
        await alert({
          title: `Couldn't make a new link for ${invite.email}`,
          body: res.error ?? "The platform didn't return a link.",
          tone: "danger",
        });
        return;
      }
      const { issued } = res;
      setFresh({
        link: issued.link,
        note: issued.emailed
          ? "Emailed to them, and shown here once."
          : issued.emailError
            ? `NOT emailed: ${issued.emailError} Pass it on yourself - shown here once.`
            : "Shown here once - pass it on yourself. The old link no longer works.",
      });
      router.refresh();
    });
  };

  const revoke = () => {
    startTransition(async () => {
      if (
        !(await confirm({
          title: `Withdraw the invite for ${invite.email}?`,
          body: "The link stops working at once. You can invite them again later.",
          confirmLabel: "Withdraw",
          tone: "danger",
          // Reversible by inviting again - the type-DELETE gate is for data
          // that is gone afterwards (confirm.tsx).
          requireTyped: false,
        }))
      ) {
        return;
      }
      const res = await revokeInviteAction(invite.id);
      if (res.error) {
        await alert({ title: `Couldn't withdraw the invite for ${invite.email}`, body: res.error, tone: "danger" });
        return;
      }
      router.refresh();
    });
  };

  const copy = (link: string) => {
    void navigator.clipboard
      .writeText(link)
      .then(() => toast("Invite link copied"))
      .catch(() =>
        alert({ title: "Couldn't copy the link", body: "Select the link and copy it by hand.", tone: "danger" }),
      );
  };

  const expired = invite.status === "expired";

  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium break-all text-text">
            {invite.email}
            {invite.name ? <span className="font-normal text-text-muted"> · {invite.name}</span> : null}
          </p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
            <StatusChip tone="muted">{OWNER_ROLE_LABELS[invite.ownerRole]}</StatusChip>
            <StatusChip tone={expired ? "outline" : "muted"}>{expired ? "Expired" : "Pending"}</StatusChip>
            <span>{invite.expiresLabel}</span>
            {invite.emailedAt ? <span>· emailed</span> : null}
            {invite.invitedByName ? <span>· by {invite.invitedByName}</span> : null}
          </div>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => resend(false)} disabled={pending}>
              New link
            </Button>
            {mailConfigured ? (
              <Button type="button" size="sm" variant="secondary" onClick={() => resend(true)} disabled={pending}>
                Email new link
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="ghost" onClick={revoke} disabled={pending}>
              Withdraw
            </Button>
          </div>
        ) : null}
      </div>

      {fresh ? (
        <div className="space-y-1.5 rounded-md border border-border-strong bg-bg-subtle p-3">
          <div className="flex items-stretch gap-2">
            <code className="block min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-xs break-all text-text">
              {fresh.link}
            </code>
            <Button type="button" size="sm" variant="secondary" onClick={() => copy(fresh.link)} aria-label="Copy invite link">
              <Copy className="h-4 w-4" />
              Copy
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-text-muted">{fresh.note}</p>
        </div>
      ) : null}
    </li>
  );
}
