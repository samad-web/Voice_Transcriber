"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserPlus } from "lucide-react";
import {
  OWNER_ROLE_DESCRIPTIONS,
  OWNER_ROLE_LABELS,
  OwnerRole,
  ownerRoleSeesAllRecords,
} from "@aura/shared";
import { Button, Card, Input, MonoLabel, Select, StatusChip } from "@aura/ui";
import { inviteTeamMemberAction } from "./actions";
import type { TeamTelecaller } from "./types";

/**
 * Add a colleague to this workspace.
 *
 * ── THE PASSWORD IS SHOWN, NOT SENT ───────────────────────────────────────
 *
 * No email leaves the platform when somebody is added. The generated password
 * comes back in the response and is displayed once, for the owner to pass on
 * however they already talk to that person. An invite email would mean this
 * product putting a message in a stranger's inbox because a form was
 * submitted, which is not a thing it does.
 *
 * The consequence is that the password is unrecoverable the moment this panel
 * is dismissed - so it is rendered in a way that is hard to miss and easy to
 * copy, and "Reset password" exists on every row for when it is lost anyway.
 */
export function InviteForm({ telecallers }: { telecallers: TeamTelecaller[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<OwnerRole>("telecaller");
  const [telecallerId, setTelecallerId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ password: string | null; linked: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  // An own-scoped persona reads its records THROUGH a telecaller row, so
  // creating one without a binding produces a console that loads and shows
  // nothing. Said here, next to the control that fixes it.
  const needsIdentity = !ownerRoleSeesAllRecords(role) && !telecallerId;
  const free = telecallers.filter((t) => !t.userId);

  const submit = () => {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const res = await inviteTeamMemberAction({
        email,
        name: name || undefined,
        ownerRole: role,
        telecallerId: telecallerId || null,
      });
      if (res.error) {
        setError(res.error);
        return;
      }
      setResult({ password: res.password ?? null, linked: Boolean(res.linkedExisting) });
      setEmail("");
      setName("");
      setTelecallerId("");
      router.refresh();
    });
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

      {result ? (
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

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <Button type="button" onClick={submit} disabled={!email.trim() || pending}>
              {pending ? "Creating…" : "Create login"}
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
