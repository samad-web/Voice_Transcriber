"use client";

import { useState, useTransition } from "react";
import { Copy, Mail, UserPlus } from "lucide-react";
import {
  BrutalButton,
  Button,
  Card,
  MonoLabel,
  StatusChip,
  useAlert,
  useConfirm,
  useToast,
} from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { inputClass } from "@/lib/form";
import { operatorInviteMessage } from "@/lib/invite-text";
import {
  inviteOperatorAction,
  resendOperatorInviteAction,
  revokeOperatorInviteAction,
} from "./invite-actions";

export interface OperatorInviteRow {
  id: string;
  email: string;
  note: string | null;
  status: "pending" | "expired" | "accepted" | "revoked";
  expiresAt: string;
  createdAt: string;
  invitedBy: string;
  emailedAt: string | null;
}

const STATUS_TONE = {
  pending: "solid",
  expired: "muted",
  accepted: "outline",
  revoked: "muted",
} as const;

/**
 * Invite a superadmin, and the invites already out (migration 0145, doc 34 Part C).
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 *
 * Onboarding a superadmin was: appoint the address, press "create login", and
 * hand over a generated password shown once. That still works and is still the
 * recovery path when Google is unreachable - but it meant a credential travelled
 * by whatever channel the root happened to use, and the new colleague started
 * with a password somebody else had seen.
 *
 * An invite ends with them signing in as themselves, with Google, and nothing
 * shared in between.
 *
 * ── canManage IS A COURTESY, NOT A BOUNDARY ─────────────────────────────────
 *
 * It hides these controls from a non-root operator; `invite-actions.ts` re-checks
 * on the server with `requireMax()`, because a hidden button is a rendering
 * decision and a Server Action is a public POST endpoint.
 */
export function OperatorInvites({
  invites,
  canManage,
  mailConfigured,
  googleEnabled,
}: {
  invites: OperatorInviteRow[];
  canManage: boolean;
  mailConfigured: boolean;
  /** `googleSignInEnabled()`, resolved on the server. */
  googleEnabled: boolean;
}) {
  const live = invites.filter((i) => i.status === "pending");
  const past = invites.filter((i) => i.status !== "pending");

  return (
    <>
      {canManage ? <InviteForm mailConfigured={mailConfigured} googleEnabled={googleEnabled} /> : null}

      {live.length > 0 ? (
        <Card className="space-y-3">
          <MonoLabel>Outstanding invites</MonoLabel>
          <ul className="divide-y divide-border">
            {/* Keyed by address, not id: Resend issues a new token and a new id,
                and an id key would remount the row and drop the fresh link
                before it could be copied. One live invite per address is a
                unique index (platform_operator_invites_live), so this is
                unique. */}
            {live.map((invite) => (
              <InviteRow
                key={invite.email}
                invite={invite}
                canManage={canManage}
                mailConfigured={mailConfigured}
              />
            ))}
          </ul>
        </Card>
      ) : null}

      {past.length > 0 ? (
        <Card className="space-y-3">
          <MonoLabel>Invite history</MonoLabel>
          {/* Kept visible rather than pruned. This list is the record of who was
              offered platform-wide access and what became of the offer, which is
              exactly the thing worth being able to read back later. */}
          <ul className="divide-y divide-border">
            {past.map((invite) => (
              <li key={invite.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                <span className="text-sm font-medium text-text">{invite.email}</span>
                <StatusChip tone={STATUS_TONE[invite.status]}>{invite.status}</StatusChip>
                <span className="ml-auto text-xs text-text-muted">
                  invited by {invite.invitedBy} ·{" "}
                  <LocalTime iso={invite.createdAt} className="tabular-nums" />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </>
  );
}

function InviteForm({
  mailConfigured,
  googleEnabled,
}: {
  mailConfigured: boolean;
  googleEnabled: boolean;
}) {
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  // The link AND the address it is bound to. `email` is cleared from the form
  // the moment the invite is issued, so FreshLink cannot read it from state -
  // and without it the copied message could not name the account to use.
  const [issued, setIssued] = useState<IssuedLink | null>(null);
  const alert = useAlert();
  const toast = useToast();

  const submit = (sendEmail: boolean) => {
    startTransition(async () => {
      const result = await inviteOperatorAction({ email, note, sendEmail });
      if (result.error) {
        await alert({ title: "Could not invite", body: result.error, tone: "danger" });
        return;
      }
      const to = email.trim().toLowerCase();
      setIssued(
        result.link
          ? {
              link: result.link,
              email: to,
              emailed: Boolean(result.emailed),
              emailError: result.emailError ?? null,
              expiresAt: result.expiresAt ?? null,
            }
          : null,
      );
      setEmail("");
      setNote("");
      if (result.emailed) toast(`Invite emailed to ${to}`);
      else if (result.emailError) toast(`Invite created - not emailed: ${result.emailError}`);
    });
  };

  return (
    <Card className="space-y-3">
      <MonoLabel>Invite a superadmin</MonoLabel>
      <p className="max-w-prose text-sm text-text-muted">
        They accept with their own Google account, so no password is created and nothing has to be
        passed along. Accepting appoints them - the same standing privilege as adding them by hand.
      </p>

      {!googleEnabled ? (
        // Said before the button is pressed, not reported after. Without Google
        // sign-in configured the link cannot be completed by anybody, and the
        // password path below is the only way in.
        <p className="rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm text-text-muted">
          Google sign-in is not configured on this deployment, so an invite cannot be accepted yet.
          Appoint them and create a password instead.
        </p>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="colleague@example.com"
          aria-label="Email address to invite"
          className={inputClass}
        />
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Why (optional) - kept on the record"
          aria-label="Note"
          className={inputClass}
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <BrutalButton
          type="button"
          onClick={() => submit(mailConfigured)}
          disabled={pending || !email.trim() || !googleEnabled}
        >
          {mailConfigured ? (
            <>
              <Mail aria-hidden="true" className="h-4 w-4" /> Email the invite
            </>
          ) : (
            <>
              <UserPlus aria-hidden="true" className="h-4 w-4" /> Create invite link
            </>
          )}
        </BrutalButton>
        {mailConfigured ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => submit(false)}
            disabled={pending || !email.trim() || !googleEnabled}
          >
            Just give me the link
          </Button>
        ) : null}
      </div>

      {!mailConfigured ? (
        <p className="text-xs text-text-muted">
          Email is not configured on this deployment, so the link is shown here for you to pass on.
        </p>
      ) : null}

      {issued ? <FreshLink issued={issued} onDone={() => setIssued(null)} /> : null}
    </Card>
  );
}

export interface IssuedLink {
  link: string;
  /** The address the invite is bound to - see `operatorInviteMessage`. */
  email: string;
  emailed: boolean;
  emailError: string | null;
  /** ISO, when the issuing response gave one. */
  expiresAt: string | null;
}

/**
 * The link, shown ONCE, with the instructions that have to travel beside it.
 *
 * Only its hash is stored, so this is the only moment it exists in readable
 * form - the same contract the enrollment key and the owner-account password
 * already make on this console. Resend is how a lost link is replaced, and it
 * retires the old one in the same step.
 *
 * ── WHY COPY MORE THAN THE URL ──────────────────────────────────────────────
 *
 * This copied a bare URL at first, which is the same mistake `invite-text.ts`
 * was written to fix on the owner side. An invite is bound to ONE address. The
 * link gets pasted into WhatsApp or email, and by the time it reaches the person
 * the address it belongs to has been left behind on the screen it was copied
 * from - so they continue with whichever Google account their browser was
 * already holding, and the invite refuses them with nothing in the link to say
 * which account it wanted.
 *
 * So the address and the one-use rule go on the clipboard WITH the link, and are
 * on screen as well: the sender should not have to remember to type them, and
 * should be able to read what they have just handed over.
 */
function FreshLink({ issued, onDone }: { issued: IssuedLink; onDone: () => void }) {
  const toast = useToast();
  const alert = useAlert();

  const copy = (what: "message" | "link") => {
    const text =
      what === "message"
        ? operatorInviteMessage({
            email: issued.email,
            link: issued.link,
            expiresAt: issued.expiresAt,
          })
        : issued.link;
    navigator.clipboard
      ?.writeText(text)
      .then(() =>
        toast(what === "message" ? "Invite and sign-in address copied" : "Link only copied"),
      )
      .catch(() =>
        alert({
          title: "Couldn't copy",
          body: "Select the link and copy it by hand.",
          tone: "danger",
        }),
      );
  };

  return (
    <div className="space-y-2.5 rounded-md border border-border-strong bg-bg-subtle p-3">
      <MonoLabel>Invite link - shown once</MonoLabel>

      <div className="flex items-stretch gap-2">
        <code className="block min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-xs break-all text-text">
          {issued.link}
        </code>
        <Button type="button" variant="secondary" onClick={() => copy("message")}>
          <Copy aria-hidden="true" className="h-4 w-4" /> Copy
        </Button>
      </div>

      {/* The instructions, on screen and not only on the clipboard. Whoever
          sends this should be able to read what they are promising. */}
      <ul className="space-y-1 text-xs leading-relaxed text-text-muted">
        <li>
          They must continue with the Google account for{" "}
          <span className="font-medium text-text">{issued.email}</span>. Any other account is turned
          away.
        </li>
        <li>
          The link works once, and accepting makes them a superadmin immediately.
          {issued.expiresAt ? (
            <>
              {" "}
              It expires <LocalTime iso={issued.expiresAt} className="tabular-nums" />.
            </>
          ) : null}
        </li>
        <li>
          {issued.emailed
            ? "Already emailed to them - this copy is for passing on another way."
            : issued.emailError
              ? `NOT emailed: ${issued.emailError} Pass it on yourself.`
              : "Not emailed - pass it on yourself. It is not shown again."}
        </li>
      </ul>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="ghost" onClick={() => copy("link")}>
          Copy link only
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

function InviteRow({
  invite,
  canManage,
  mailConfigured,
}: {
  invite: OperatorInviteRow;
  canManage: boolean;
  mailConfigured: boolean;
}) {
  const alert = useAlert();
  const confirm = useConfirm();
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [fresh, setFresh] = useState<IssuedLink | null>(null);

  const resend = (send: boolean) => {
    startTransition(async () => {
      const result = await resendOperatorInviteAction(invite.id, send);
      if (result.error) {
        await alert({ title: "Could not resend", body: result.error, tone: "danger" });
        return;
      }
      setFresh(
        result.link
          ? {
              link: result.link,
              email: invite.email,
              emailed: Boolean(result.emailed),
              emailError: result.emailError ?? null,
              expiresAt: result.expiresAt ?? null,
            }
          : null,
      );
      if (result.emailed) toast(`Invite re-sent to ${invite.email}`);
    });
  };

  const revoke = () => {
    startTransition(async () => {
      // Not `tone: "danger"`: that makes the dialog demand a typed confirmation
      // word, which is right for erasing a customer's recordings and heavy for
      // this. Withdrawing an invite destroys nothing - the same person can be
      // invited again in one step.
      const ok = await confirm({
        title: `Withdraw the invite for ${invite.email}?`,
        body:
          "The link stops working immediately. If it was never accepted, the sign-in account it " +
          "created is removed too.",
        confirmLabel: "Withdraw",
      });
      if (!ok) return;
      const result = await revokeOperatorInviteAction(invite.id);
      if (result.error) await alert({ title: "Could not withdraw", body: result.error, tone: "danger" });
      else toast("Invite withdrawn");
    });
  };

  return (
    <li className="space-y-2 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-medium text-text">{invite.email}</span>
        <StatusChip tone={invite.emailedAt ? "solid" : "outline"}>
          {invite.emailedAt ? "emailed" : "link only"}
        </StatusChip>
        <span className="text-xs text-text-muted">
          expires <LocalTime iso={invite.expiresAt} className="tabular-nums" />
        </span>
        {canManage ? (
          <span className="ml-auto flex flex-wrap gap-2">
            <Button type="button" variant="secondary" disabled={pending} onClick={() => resend(mailConfigured)}>
              Resend
            </Button>
            <Button type="button" variant="ghost" disabled={pending} onClick={revoke}>
              Withdraw
            </Button>
          </span>
        ) : null}
      </div>
      {invite.note ? <p className="text-xs text-text-muted">{invite.note}</p> : null}
      {/* Resend issues a NEW token, so the replacement link appears here to be
          copied - there is no "show me the existing link", because only its hash
          was ever stored. */}
      {fresh ? <FreshLink issued={fresh} onDone={() => setFresh(null)} /> : null}
    </li>
  );
}
