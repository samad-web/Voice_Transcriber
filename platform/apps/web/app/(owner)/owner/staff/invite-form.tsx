"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, UserPlus } from "lucide-react";
import {
  OWNER_ROLE_DESCRIPTIONS,
  OWNER_ROLE_LABELS,
  OwnerRole,
  ownerRoleSeesAllRecords,
} from "@aura/shared";
import {
  Button,
  Card,
  Checkbox,
  Input,
  MonoLabel,
  Radio,
  RadioGroup,
  Select,
  StatusChip,
  useAlert,
  useToast,
} from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { PhonePairFields, usePhoneErrors } from "@/components/phone-pair-fields";
import { inviteTeamMemberAction, issueInviteAction } from "./actions";
import type { IssuedInvite, TeamTelecaller } from "./types";

/** Invite link lifetimes offered. The API accepts 1-168 hours. */
const INVITE_EXPIRY = [
  { hours: 24, label: "24 hours" },
  { hours: 72, label: "3 days" },
  { hours: 168, label: "7 days" },
] as const;

/** What the invite-by-link mode can do on this platform - decided server-side in team-tab.tsx. */
export interface InviteByLink {
  /** GoTrue has the Google provider on, so an invite can actually be accepted. */
  googleEnabled: boolean;
  /** PLATFORM_SMTP_* is configured, so "Email it" would work. */
  mailConfigured: boolean;
}

/**
 * Add a colleague to this workspace - by invite link or by password.
 *
 * ── NOTHING IS SENT UNLESS THE OWNER SAYS SO ──────────────────────────────
 *
 * "Invite link" (0137) creates a single-use, expiring link the invitee opens
 * to join by continuing with Google. The link is shown here once; it is
 * emailed only if the owner ticks "Email it" for this one invite, the box is
 * never pre-ticked, and it only appears when the platform has SMTP set up.
 * Otherwise the owner passes the link on however they already talk to that
 * person.
 *
 * "Create login" is the original path for somebody with no Google account: a
 * generated password, displayed once, never emailed. Unrecoverable the moment
 * this panel is dismissed - so it is rendered to be hard to miss and easy to
 * copy, and "Reset password" exists on every row for when it is lost anyway.
 */
export function InviteForm({
  telecallers,
  inviteByLink,
}: {
  telecallers: TeamTelecaller[];
  inviteByLink?: InviteByLink;
}) {
  const router = useRouter();
  const alert = useAlert();
  const toast = useToast();
  const linkAvailable = Boolean(inviteByLink?.googleEnabled);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"link" | "password">(linkAvailable ? "link" : "password");
  const [sendEmail, setSendEmail] = useState(false);
  const [ttlHours, setTtlHours] = useState<number>(72);
  const [issued, setIssued] = useState<IssuedInvite | null>(null);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<OwnerRole>("telecaller");
  const [telecallerId, setTelecallerId] = useState("");
  // Mirrored by default: for most people the WhatsApp number IS their mobile.
  const [phones, setPhones] = useState({ mobile: "", whatsapp: "", same: true });
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ password: string | null; linked: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  // An own-scoped persona reads its records THROUGH a telecaller row, so
  // creating one without a binding produces a console that loads and shows
  // nothing. Said here, next to the control that fixes it.
  const needsIdentity = !ownerRoleSeesAllRecords(role) && !telecallerId;
  const free = telecallers.filter((t) => !t.userId);

  // Checked against the workspace's country, the rule the API applies too.
  const phoneErrors = usePhoneErrors();
  const { mobile: mobileError, whatsapp: whatsappError } = phoneErrors(phones);

  const resetFields = () => {
    setEmail("");
    setName("");
    setTelecallerId("");
    setPhones({ mobile: "", whatsapp: "", same: true });
    setSendEmail(false);
  };

  const submit = () => {
    setError(null);
    setResult(null);
    setIssued(null);
    if (mobileError || whatsappError) return;
    const common = {
      email,
      name: name || undefined,
      ownerRole: role,
      telecallerId: telecallerId || null,
      phone: phones.mobile.trim() || null,
      whatsapp: (phones.same ? phones.mobile : phones.whatsapp).trim() || null,
    };
    startTransition(async () => {
      if (mode === "link") {
        const res = await issueInviteAction({
          ...common,
          send: Boolean(inviteByLink?.mailConfigured) && sendEmail,
          ttlHours,
        });
        if (res.error || !res.issued) {
          setError(res.error ?? "The invite couldn't be created.");
          return;
        }
        setIssued(res.issued);
        resetFields();
        router.refresh();
        return;
      }

      const res = await inviteTeamMemberAction(common);
      if (res.error) {
        setError(res.error);
        return;
      }
      setResult({ password: res.password ?? null, linked: Boolean(res.linkedExisting) });
      resetFields();
      router.refresh();
    });
  };

  // Sync handler, promise voided - an async onClick turns a rejected clipboard
  // write into an unhandled rejection (see owner-accounts.tsx).
  const copyLink = (link: string) => {
    void navigator.clipboard
      .writeText(link)
      .then(() => toast("Invite link copied"))
      .catch(() =>
        alert({
          title: "Couldn't copy the link",
          body: "Select the link and copy it by hand.",
          tone: "danger",
        }),
      );
  };

  if (!open) {
    return (
      <div>
        <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
          <UserPlus className="h-4 w-4" />
          Add someone
        </Button>
      </div>
    );
  }

  return (
    <Card elevated className="max-w-2xl space-y-4">
      <MonoLabel>Add someone to this workspace</MonoLabel>

      {issued ? (
        <div className="space-y-2 rounded-lg border border-border-strong bg-bg-subtle p-4">
          <p className="text-sm font-medium text-text">
            Invite created for {issued.invite.email}. This link is shown once.
          </p>
          <div className="flex items-stretch gap-2">
            <code className="block min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 font-mono text-sm break-all text-text">
              {issued.link}
            </code>
            <Button type="button" variant="secondary" onClick={() => copyLink(issued.link)} aria-label="Copy invite link">
              <Copy className="h-4 w-4" />
              Copy
            </Button>
          </div>
          <p className="text-xs leading-relaxed text-text-muted">
            {issued.emailed
              ? "It was also emailed to them. "
              : issued.emailError
                ? `It was NOT emailed: ${issued.emailError} Pass the link on yourself. `
                : "Nothing was emailed - pass the link on yourself. "}
            It works once, for a Google account with that address, and expires{" "}
            <LocalTime iso={issued.invite.expiresAt} />
            . If it is lost, use Resend below for a new one.
          </p>
          <Button type="button" variant="secondary" onClick={() => setIssued(null)}>
            Invite another
          </Button>
        </div>
      ) : result ? (
        <div className="space-y-2 rounded-lg border border-border-strong bg-bg-subtle p-4">
          {result.password ? (
            <>
              <p className="text-sm font-medium text-text">
                Account created. This password is shown once.
              </p>
              <code className="block rounded-md border border-border bg-surface px-3 py-2 font-mono text-base tracking-wide text-text">
                {result.password}
              </code>
              <p className="text-xs leading-relaxed text-text-muted">
                Nothing was emailed - pass this on yourself, and ask them to change it after signing
                in. If it is lost, use Reset password on their row.
              </p>
            </>
          ) : (
            <p className="text-sm leading-relaxed text-text">
              They already had a login, so it was linked to this workspace rather than recreated.
              Their existing password still works.
            </p>
          )}
          <Button type="button" variant="secondary" onClick={() => setResult(null)}>
            Add another
          </Button>
        </div>
      ) : (
        <>
          <RadioGroup legend="How they sign in">
            <Radio
              name="invite-mode"
              value="link"
              checked={mode === "link"}
              onChange={() => setMode("link")}
              disabled={pending || !linkAvailable}
              label="Invite link - they join with Google"
              description={
                linkAvailable
                  ? "A single-use link that expires. They open it and continue with the Google account for this address."
                  : "Not available: Google sign-in isn't switched on for this platform yet."
              }
            />
            <Radio
              name="invite-mode"
              value="password"
              checked={mode === "password"}
              onChange={() => setMode("password")}
              disabled={pending}
              label="Create login - a password you pass on"
              description="For someone without a Google account. The password is shown once and never emailed."
            />
          </RadioGroup>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <MonoLabel>Email</MonoLabel>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="colleague@example.com"
                aria-label="Email address"
                disabled={pending}
              />
            </div>
            <div className="space-y-1.5">
              <MonoLabel>Name (optional)</MonoLabel>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Their name"
                aria-label="Name"
                disabled={pending}
              />
            </div>
          </div>

          <PhonePairFields
            idPrefix="invite"
            mobile={phones.mobile}
            whatsapp={phones.whatsapp}
            same={phones.same}
            onChange={setPhones}
            disabled={pending}
          />

          <div className="space-y-1.5">
            <MonoLabel>Role</MonoLabel>
            <Select
              aria-label="Role"
              value={role}
              disabled={pending}
              onChange={(e) => setRole(OwnerRole.parse(e.target.value))}
            >
              {OwnerRole.options.map((option) => (
                <option key={option} value={option}>
                  {OWNER_ROLE_LABELS[option]}
                </option>
              ))}
            </Select>
            <p className="text-xs leading-relaxed text-text-muted">
              {OWNER_ROLE_DESCRIPTIONS[role]}
            </p>
          </div>

          <div className="space-y-1.5">
            <MonoLabel>Telecaller identity</MonoLabel>
            <Select
              aria-label="Telecaller identity"
              value={telecallerId}
              disabled={pending}
              invalid={needsIdentity}
              onChange={(e) => setTelecallerId(e.target.value)}
            >
              <option value="">Not on the phones</option>
              {free.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.displayName}
                  {t.externalId ? ` (${t.externalId})` : ""}
                </option>
              ))}
            </Select>
            {needsIdentity ? (
              <p className="text-xs leading-relaxed text-danger-text">
                {OWNER_ROLE_LABELS[role]} only sees records assigned to them. Without a telecaller
                identity their console will be empty.
                {free.length === 0
                  ? " None are free - name a handset's holder on the dashboard first."
                  : ""}
              </p>
            ) : null}
          </div>

          {mode === "link" ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <MonoLabel>Link expires after</MonoLabel>
                <Select
                  aria-label="Link expires after"
                  value={String(ttlHours)}
                  disabled={pending}
                  onChange={(e) => setTtlHours(Number(e.target.value))}
                >
                  {INVITE_EXPIRY.map((option) => (
                    <option key={option.hours} value={option.hours}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </div>
              {inviteByLink?.mailConfigured ? (
                // Never pre-ticked: an email reaches a real person, so it is
                // the owner's explicit choice for this one invite.
                <Checkbox
                  className="self-end"
                  checked={sendEmail}
                  onChange={(e) => setSendEmail(e.target.checked)}
                  disabled={pending}
                  label="Email the link to them"
                  description="Sent once, from the platform's address. You'll see the link here either way."
                />
              ) : null}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <Button type="button" onClick={submit} disabled={!email.trim() || pending || Boolean(mobileError || whatsappError)}>
              {pending
                ? "Creating…"
                : mode === "link"
                  ? sendEmail && inviteByLink?.mailConfigured
                    ? "Create and email invite"
                    : "Create invite link"
                  : "Create login"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setOpen(false);
                setError(null);
              }}
              disabled={pending}
            >
              Cancel
            </Button>
            {!pending && error ? (
              <span className="text-xs leading-relaxed text-danger-text">{error}</span>
            ) : null}
          </div>
        </>
      )}
    </Card>
  );
}

/** Headcount by persona - the "how many users" question, answered in place. */
export function TeamCounts({
  counts,
  suspended = 0,
}: {
  counts: Array<[OwnerRole, number]>;
  suspended?: number;
}) {
  const total = counts.reduce((n, [, c]) => n + c, 0);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <MonoLabel className="mr-1">
        {total} {total === 1 ? "person" : "people"}
      </MonoLabel>
      {counts
        .filter(([, n]) => n > 0)
        .map(([role, n]) => (
          <StatusChip key={role} tone="muted">
            {n} {OWNER_ROLE_LABELS[role]}
          </StatusChip>
        ))}
      {/* Outside the persona counts and styled differently, because it answers
          a different question. A suspended colleague is not a smaller kind of
          telecaller - they are somebody who cannot sign in, and the number is
          here so that fact is visible without scrolling the table. */}
      {suspended > 0 ? <StatusChip tone="outline">{suspended} suspended</StatusChip> : null}
    </div>
  );
}
