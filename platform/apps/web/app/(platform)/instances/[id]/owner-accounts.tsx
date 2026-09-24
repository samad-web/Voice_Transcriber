"use client";

import { useState, useTransition } from "react";
import { AlertTriangle, Copy, Link2, Trash2, UserPlus } from "lucide-react";
import { BrutalButton, Card, ConsolePanel, MonoLabel, StatusChip, useAlert, useConfirm, useToast } from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { inputClass } from "@/lib/form";
import {
  createOwnerAction,
  inviteOwnerAction,
  resendOwnerInviteAction,
  resetOwnerPasswordAction,
  revokeOwnerAction,
  revokeOwnerInviteAction,
  type InstanceInvite,
  type InviteOutcome,
  type OwnerResult,
} from "./actions";

/** Invite link lifetimes offered. The API accepts 1-168 hours. */
const INVITE_EXPIRY = [
  { hours: 24, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
] as const;

export interface OwnerRow {
  userId: string;
  email: string;
  name: string | null;
  status: string;
  hasLogin: boolean;
  recordingsListen: boolean;
  recordingsExport: boolean;
  createdAt: string;
}

/**
 * Owner logins for this customer.
 *
 * An owner signs in to /owner and sees only this instance: their own pipeline,
 * their own telecallers. They never reach the operator console - that is the
 * point of provisioning them here rather than handing over a shared login.
 *
 * Two ways in (0137): an INVITE LINK the owner opens and finishes by
 * continuing with Google, or a generated PASSWORD read out to them. The link
 * is shown once and emailed only when "Email it" is ticked for that invite.
 */
export function OwnerAccounts({
  orgId,
  owners,
  authConfigured,
  invites = [],
  inviteByLink,
}: {
  orgId: string;
  owners: OwnerRow[];
  authConfigured: boolean;
  invites?: InstanceInvite[];
  inviteByLink?: { googleEnabled: boolean; mailConfigured: boolean };
}) {
  const linkAvailable = Boolean(inviteByLink?.googleEnabled);
  const mailConfigured = Boolean(inviteByLink?.mailConfigured);
  const [mode, setMode] = useState<"link" | "password">(linkAvailable ? "link" : "password");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [canListen, setCanListen] = useState(true);
  const [sendEmail, setSendEmail] = useState(false);
  const [ttlHours, setTtlHours] = useState<number>(72);
  const [result, setResult] = useState<(OwnerResult & { forEmail?: string }) | null>(null);
  const [invited, setInvited] = useState<InviteOutcome | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const confirm = useConfirm();
  const toast = useToast();

  const invite = () =>
    startTransition(async () => {
      setResult(null);
      const res = await inviteOwnerAction({
        orgId,
        email,
        name,
        recordingsListen: canListen,
        send: mailConfigured && sendEmail,
        ttlHours,
      });
      if (res.error) {
        await alert({ title: "Couldn't create the invite", body: res.error, tone: "danger" });
        return;
      }
      setInvited(res);
      setEmail("");
      setName("");
      setSendEmail(false);
    });

  const resendInvite = (row: InstanceInvite, send: boolean) =>
    startTransition(async () => {
      if (
        send &&
        !(await confirm({
          title: `Email a new invite to ${row.email}?`,
          body: "The current link stops working, and a new one is emailed to them once.",
          confirmLabel: "Send",
          requireTyped: false,
        }))
      ) {
        return;
      }
      const res = await resendOwnerInviteAction(orgId, row.id, send);
      if (res.error) {
        await alert({ title: `Couldn't make a new link for ${row.email}`, body: res.error, tone: "danger" });
        return;
      }
      setResult(null);
      setInvited(res);
    });

  const withdrawInvite = (row: InstanceInvite) =>
    startTransition(async () => {
      if (
        !(await confirm({
          title: `Withdraw the invite for ${row.email}?`,
          body: "The link stops working at once. You can invite them again later.",
          confirmLabel: "Withdraw",
          tone: "danger",
          // Reversible by inviting again - the typed gate is for lost data.
          requireTyped: false,
        }))
      ) {
        return;
      }
      const res = await revokeOwnerInviteAction(orgId, row.id);
      if (res.error) {
        await alert({ title: `Couldn't withdraw the invite for ${row.email}`, body: res.error, tone: "danger" });
        return;
      }
      toast("Invite withdrawn");
    });

  const create = () =>
    startTransition(async () => {
      setInvited(null);
      const created = await createOwnerAction({
        orgId,
        email,
        name,
        recordingsListen: canListen,
      });
      if (created.error) {
        await alert({
          title: "Couldn't create the owner login",
          body: created.error,
          tone: "danger",
        });
        return;
      }
      setResult({ ...created, forEmail: email.trim() });
      setEmail("");
      setName("");
    });

  const reset = (userId: string, forEmail: string) =>
    startTransition(async () => {
      const outcome = await resetOwnerPasswordAction(orgId, userId);
      if (outcome.error) {
        await alert({
          title: "Couldn't reset the password",
          body: outcome.error,
          tone: "danger",
        });
        return;
      }
      setResult({ ...outcome, forEmail });
    });

  const revoke = (userId: string) =>
    startTransition(async () => {
      const outcome = await revokeOwnerAction(orgId, userId);
      if (outcome.error) {
        await alert({
          title: "Couldn't revoke the owner",
          body: outcome.error,
          tone: "danger",
        });
        return;
      }
      setConfirming(null);
      setResult(null);
      toast("Owner revoked");
    });

  return (
    <Card elevated className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <MonoLabel>Owner Logins</MonoLabel>
          <p className="text-xs text-text-muted font-sans mt-1.5 leading-relaxed max-w-md">
            A sign-in scoped to this instance only. Owners land on their own
            dashboard, lead board and lead list - never the operator console.
          </p>
        </div>
        <StatusChip tone={owners.length > 0 ? "solid" : "muted"}>
          {owners.length} owner{owners.length === 1 ? "" : "s"}
        </StatusChip>
      </div>

      {!authConfigured ? (
        process.env.NODE_ENV === "production" ? (
          <div className="flex items-start gap-2.5 rounded-md border border-warning bg-warning-subtle p-3">
            <AlertTriangle aria-hidden="true" className="h-4 w-4 shrink-0 mt-0.5 text-warning" />
            <p className="text-sm leading-relaxed text-warning-text">
              Supabase Auth is not configured on the API - set SUPABASE_URL and
              SUPABASE_SERVICE_ROLE_KEY, then restart it. Logins cannot be created
              until then.
            </p>
          </div>
        ) : (
          // Local dev has no Supabase Auth backend by design (auth is opt-in -
          // see lib/supabase/config.ts) - this is expected, not a misconfiguration
          // to flag with a warning banner.
          <p className="text-xs font-mono text-text-muted border-2 border-border p-3">
            Owner logins are disabled in local dev (no Supabase Auth configured).
          </p>
        )
      ) : null}

      {owners.length > 0 ? (
        <div className="divide-y-2 divide-border border-2 border-border">
          {owners.map((owner) => (
            <div
              key={owner.userId}
              className="px-3 py-2.5 flex items-center justify-between gap-3 flex-wrap"
            >
              <div className="min-w-0">
                <span className="font-display font-bold text-text block truncate">
                  {owner.name || owner.email}
                </span>
                <span className="text-[10px] font-mono text-text-muted break-all">
                  {owner.name ? `${owner.email} · ` : ""}
                  added <LocalTime iso={owner.createdAt} mode="date" />
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {owner.hasLogin ? null : <StatusChip tone="muted">no login</StatusChip>}
                {owner.recordingsListen ? <StatusChip tone="outline">audio</StatusChip> : null}
                <button
                  type="button"
                  disabled={pending || !owner.hasLogin}
                  onClick={() => reset(owner.userId, owner.email)}
                  className="text-[10px] font-mono font-bold uppercase tracking-wider px-2 py-1 border-2 border-border-strong hover:bg-surface-hover hover:text-text disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-muted"
                >
                  Reset password
                </button>
                {confirming === owner.userId ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => revoke(owner.userId)}
                    className="text-[10px] font-mono font-bold uppercase tracking-wider px-2 py-1 border-2 border-danger bg-danger text-danger-fg"
                  >
                    Confirm revoke
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => setConfirming(owner.userId)}
                    aria-label={`Revoke ${owner.email}`}
                    className="p-1.5 border-2 border-border-strong text-text hover:bg-danger hover:text-danger-fg hover:border-danger"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs font-mono font-bold uppercase text-text-muted py-6 text-center border-2 border-border">
          No owner has access yet
        </p>
      )}

      {invites.length > 0 ? (
        <div className="space-y-2">
          <MonoLabel>Pending invites</MonoLabel>
          <div className="divide-y-2 divide-border border-2 border-border">
            {invites.map((row) => (
              <div key={row.id} className="px-3 py-2.5 flex items-center justify-between gap-3 flex-wrap">
                <div className="min-w-0">
                  <span className="font-display font-bold text-text block break-all">{row.name || row.email}</span>
                  <span className="text-[10px] font-mono text-text-muted break-all">
                    {row.name ? `${row.email} · ` : ""}
                    {row.status === "expired" ? "expired " : "expires "}
                    <LocalTime iso={row.expiresAt} />
                    {row.emailedAt ? " · emailed" : ""}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <StatusChip tone={row.status === "expired" ? "outline" : "muted"}>
                    {row.status === "expired" ? "expired" : "pending"}
                  </StatusChip>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => resendInvite(row, false)}
                    className="text-[10px] font-mono font-bold uppercase tracking-wider px-2 py-1 border-2 border-border-strong hover:bg-surface-hover disabled:opacity-30"
                  >
                    New link
                  </button>
                  {mailConfigured ? (
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => resendInvite(row, true)}
                      className="text-[10px] font-mono font-bold uppercase tracking-wider px-2 py-1 border-2 border-border-strong hover:bg-surface-hover disabled:opacity-30"
                    >
                      Email new link
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => withdrawInvite(row)}
                    aria-label={`Withdraw the invite for ${row.email}`}
                    className="p-1.5 border-2 border-border-strong text-text hover:bg-danger hover:text-danger-fg hover:border-danger disabled:opacity-30"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <div className="space-y-3 pt-2 border-t-2 border-border">
        <div role="radiogroup" aria-label="How the owner signs in" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {(
            [
              {
                value: "link",
                title: "Invite link",
                hint: linkAvailable
                  ? "They open it and continue with Google."
                  : "Needs Google sign-in switched on.",
                disabled: !linkAvailable,
              },
              {
                value: "password",
                title: "Create login",
                hint: "A password you pass on - shown once.",
                disabled: false,
              },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={mode === option.value}
              disabled={pending || option.disabled}
              onClick={() => setMode(option.value)}
              className={`text-left px-3 py-2 border-2 disabled:opacity-40 ${
                mode === option.value ? "border-text bg-surface-hover" : "border-border hover:border-border-strong"
              }`}
            >
              <span className="text-xs font-mono font-bold uppercase tracking-wider text-text block">
                {option.title}
              </span>
              <span className="text-[11px] font-sans text-text-muted">{option.hint}</span>
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-mono text-text uppercase tracking-wider font-bold block">
              Owner Email
            </label>
            <input
              className={inputClass}
              type="email"
              placeholder="owner@customer.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-mono text-text uppercase tracking-wider font-bold block">
              Name <span className="text-text-muted">(optional)</span>
            </label>
            <input
              className={inputClass}
              placeholder="Ravi Kumar"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-xs font-sans text-text-muted">
          <input
            type="checkbox"
            checked={canListen}
            onChange={(e) => setCanListen(e.target.checked)}
            className="w-4 h-4 border-2 border-border-strong accent-black"
          />
          May listen to call recordings
        </label>

        {mode === "link" ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-end">
            <div className="space-y-1.5">
              <label
                htmlFor={`invite-ttl-${orgId}`}
                className="text-xs font-mono text-text uppercase tracking-wider font-bold block"
              >
                Link expires after
              </label>
              <select
                id={`invite-ttl-${orgId}`}
                className={inputClass}
                value={String(ttlHours)}
                disabled={pending}
                onChange={(e) => setTtlHours(Number(e.target.value))}
              >
                {INVITE_EXPIRY.map((option) => (
                  <option key={option.hours} value={option.hours}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            {mailConfigured ? (
              // Never pre-ticked: an email reaches a real person, so it is the
              // operator's explicit choice for this one invite.
              <label className="flex items-center gap-2 text-xs font-sans text-text-muted pb-2">
                <input
                  type="checkbox"
                  checked={sendEmail}
                  onChange={(e) => setSendEmail(e.target.checked)}
                  className="w-4 h-4 border-2 border-border-strong accent-black"
                />
                Email the link to them
              </label>
            ) : null}
          </div>
        ) : null}

        {mode === "link" ? (
          <BrutalButton className="w-full" shadow disabled={pending || !email.trim() || !linkAvailable} onClick={invite}>
            <Link2 className="h-4 w-4" />
            {pending ? "WORKING…" : sendEmail && mailConfigured ? "CREATE AND EMAIL INVITE" : "CREATE INVITE LINK"}
          </BrutalButton>
        ) : (
          <BrutalButton
            className="w-full"
            shadow
            disabled={pending || !email.trim() || !authConfigured}
            onClick={create}
          >
            <UserPlus className="h-4 w-4" />
            {pending ? "WORKING…" : "CREATE OWNER LOGIN"}
          </BrutalButton>
        )}
      </div>

      {invited?.link ? <InviteReveal outcome={invited} /> : null}

      {result?.password ? (
        <PasswordReveal email={result.forEmail ?? result.email ?? ""} password={result.password} />
      ) : null}

      {result?.linkedExisting ? (
        <p className="text-xs font-mono font-bold uppercase text-text-muted border-2 border-border p-3">
          {result.forEmail} already had an Aura login - it was linked to this
          instance and keeps its existing password.
        </p>
      ) : null}
    </Card>
  );
}

/** The invite link, shown once - only its hash is stored. Resend replaces a lost one. */
function InviteReveal({ outcome }: { outcome: InviteOutcome }) {
  const alert = useAlert();
  const toast = useToast();
  const link = outcome.link ?? "";

  return (
    <div className="border-2 border-border-strong bg-surface p-3.5 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <MonoLabel>Invite link - shown once</MonoLabel>
        <StatusChip tone="danger">Copy now</StatusChip>
      </div>
      <p className="text-xs font-sans text-text break-all">{outcome.email}</p>
      <ConsolePanel lines={[link]} tone="log" />
      <BrutalButton
        variant="secondary"
        className="w-full"
        // Sync onClick, promise voided - see PasswordReveal below.
        onClick={() => {
          void navigator.clipboard
            .writeText(link)
            .then(() => toast("Copied"))
            .catch(() =>
              alert({
                title: "Couldn't copy the link",
                body: "Select it above and copy it by hand - it is not shown again.",
                tone: "danger",
              }),
            );
        }}
      >
        <Copy className="h-4 w-4" />
        COPY LINK
      </BrutalButton>
      <p className="text-[10px] font-mono text-text-muted leading-relaxed">
        {outcome.emailed
          ? "Also emailed to them. "
          : outcome.emailError
            ? `NOT emailed: ${outcome.emailError} Send it yourself. `
            : "Nothing was emailed - send it over a channel the customer trusts. "}
        It works once, for a Google account with that address
        {outcome.expiresAt ? (
          <>
            , until <LocalTime iso={outcome.expiresAt} />
          </>
        ) : null}
        . Lost it? Use New link on the pending invite.
      </p>
    </div>
  );
}

/** Same one-time contract as the enrollment key: copy it now or reset it later. */
function PasswordReveal({ email, password }: { email: string; password: string }) {
  const alert = useAlert();
  const toast = useToast();

  return (
    <div className="border-2 border-border-strong bg-surface p-3.5 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <MonoLabel>Temporary password - shown once</MonoLabel>
        <StatusChip tone="danger">Copy now</StatusChip>
      </div>
      <p className="text-xs font-sans text-text break-all">{email}</p>
      <ConsolePanel lines={[password]} tone="log" />
      <BrutalButton
        variant="secondary"
        className="w-full"
        // Sync, not `async` - see client-config/keys-manager.tsx: React discards an event
        // handler's return value, so an async onClick turns a rejected
        // clipboard write (insecure origin, denied permission) into an
        // unhandled rejection. This password is shown once and never
        // recovered, so a failed copy must SAY so rather than pass silently.
        onClick={() => {
          void navigator.clipboard
            .writeText(password)
            .then(() => toast("Copied"))
            .catch(() =>
              alert({
                title: "Couldn't copy the password",
                body: "Select it above and copy it by hand - it is not shown again.",
                tone: "danger",
              }),
            );
        }}
      >
        <Copy className="h-4 w-4" />
        COPY PASSWORD
      </BrutalButton>
      <p className="text-[10px] font-mono text-text-muted leading-relaxed">
        Send it over a channel the customer trusts and have them change it after
        the first sign-in. A lost password is reset here, never recovered.
      </p>
    </div>
  );
}
