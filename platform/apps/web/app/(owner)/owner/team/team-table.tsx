"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  OWNER_ROLE_DESCRIPTIONS,
  OWNER_ROLE_LABELS,
  OwnerRole,
  ownerRoleSeesAllRecords,
} from "@aura/shared";
import { Button, Card, MonoLabel, Select, StatusChip } from "@aura/ui";
import { removeTeamMemberAction, resetTeamPasswordAction, setTeamMemberAction } from "./actions";
import type { TeamMember, TeamTelecaller } from "./types";

/**
 * The roster, with the persona picker that makes the whole role model usable.
 *
 * Client-side because each row saves on change and reports its own result -
 * a single form with one Save button would mean a mis-set persona on row four
 * is only discovered after submitting rows one through eight.
 *
 * `canEdit` comes from the server (the signed-in persona). A manager gets the
 * same table read-only, which is deliberate: knowing who sits where is part of
 * running a floor even when changing it is not yours to do. It is presentation
 * only - the API refuses a manager's PATCH regardless of what this renders.
 */
export function TeamTable({
  members,
  telecallers,
  canEdit,
  selfUserId,
}: {
  members: TeamMember[];
  telecallers: TeamTelecaller[];
  canEdit: boolean;
  selfUserId: string | null;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <div tabIndex={0} role="region" aria-label="Team" className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead className="bg-bg-subtle">
            <tr>
              {["Person", "Role", "Telecaller identity", "", ""].map((heading, i) => (
                <th
                  // Two trailing unlabelled columns (status, actions), so the
                  // key cannot be the heading text - both are "".
                  key={heading || `blank-${i}`}
                  scope="col"
                  className="border-b border-border px-4 py-2.5 text-xs font-medium whitespace-nowrap text-text-muted"
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {members.map((member) => (
              <Row
                key={member.userId}
                member={member}
                telecallers={telecallers}
                canEdit={canEdit}
                isSelf={member.userId === selfUserId}
              />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Row({
  member,
  telecallers,
  canEdit,
  isSelf,
}: {
  member: TeamMember;
  telecallers: TeamTelecaller[];
  canEdit: boolean;
  isSelf: boolean;
}) {
  const [role, setRole] = useState<OwnerRole>(member.ownerRole);
  const [telecallerId, setTelecallerId] = useState(member.telecallerId ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const save = (update: { ownerRole?: OwnerRole; telecallerId?: string | null }) => {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await setTeamMemberAction(member.userId, update);
      if (result.error) {
        setError(result.error);
        // Put the control back where it was. A picker that keeps showing the
        // value the server refused is how somebody walks away believing a
        // change landed - the row would read "Telecaller" while the person
        // still has the whole console.
        setRole(member.ownerRole);
        setTelecallerId(member.telecallerId ?? "");
        return;
      }
      setSaved(true);
    });
  };

  // A persona scoped to its own records resolves them through a `telecallers`
  // row. Without one the console loads and shows nothing, which reads as a
  // broken deploy rather than an unfinished setup - so say so on the row where
  // it can be fixed, next to the control that fixes it.
  const needsIdentity = !ownerRoleSeesAllRecords(role) && !telecallerId;

  return (
    <tr className="align-top transition-colors duration-150 ease-out hover:bg-surface-hover">
      <td className="px-4 py-3">
        <span className="block font-medium text-text">{member.name || member.email}</span>
        <span className="text-xs text-text-muted">{member.email}</span>
        {isSelf ? (
          <StatusChip tone="muted" className="mt-1.5">
            you
          </StatusChip>
        ) : null}
      </td>

      <td className="px-4 py-3">
        {canEdit ? (
          <>
            <Select
              aria-label={`Role for ${member.email}`}
              value={role}
              disabled={pending}
              onChange={(e) => {
                const next = OwnerRole.parse(e.target.value);
                setRole(next);
                save({ ownerRole: next });
              }}
            >
              {OwnerRole.options.map((option) => (
                <option key={option} value={option}>
                  {OWNER_ROLE_LABELS[option]}
                </option>
              ))}
            </Select>
            <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-text-muted">
              {OWNER_ROLE_DESCRIPTIONS[role]}
            </p>
          </>
        ) : (
          <>
            <span className="font-medium text-text">{OWNER_ROLE_LABELS[member.ownerRole]}</span>
            <p className="mt-1 max-w-xs text-xs leading-relaxed text-text-muted">
              {OWNER_ROLE_DESCRIPTIONS[member.ownerRole]}
            </p>
          </>
        )}
      </td>

      <td className="px-4 py-3">
        {canEdit ? (
          <Select
            aria-label={`Telecaller identity for ${member.email}`}
            value={telecallerId}
            disabled={pending}
            invalid={needsIdentity}
            onChange={(e) => {
              const next = e.target.value;
              setTelecallerId(next);
              save({ telecallerId: next || null });
            }}
          >
            <option value="">Not on the phones</option>
            {telecallers.map((t) => (
              <option
                key={t.id}
                value={t.id}
                // An identity already bound to somebody else is shown but not
                // selectable: hiding it entirely would leave an owner hunting
                // for a name that is right there on the floor, with no clue
                // why it is missing.
                disabled={Boolean(t.userId) && t.userId !== member.userId}
              >
                {t.displayName}
                {t.externalId ? ` (${t.externalId})` : ""}
                {t.userId && t.userId !== member.userId ? " - already linked" : ""}
              </option>
            ))}
          </Select>
        ) : (
          <span className="text-text-muted">{member.telecallerName ?? "-"}</span>
        )}

        {needsIdentity ? (
          <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-danger-text">
            {OWNER_ROLE_LABELS[role]} only sees records assigned to them. Link a
            telecaller identity, or their console will be empty.
          </p>
        ) : null}
      </td>

      <td className="px-4 py-3 whitespace-nowrap">
        {pending ? <MonoLabel>Saving…</MonoLabel> : null}
        {!pending && saved ? <StatusChip tone="solid">Saved</StatusChip> : null}
        {!pending && error ? (
          <span className="block max-w-xs text-xs leading-relaxed text-danger-text">{error}</span>
        ) : null}
      </td>

      <td className="px-4 py-3 align-top whitespace-nowrap">
        {canEdit ? <RowActions member={member} isSelf={isSelf} /> : null}
      </td>
    </tr>
  );
}

/**
 * The two destructive-ish actions, kept off the main row controls.
 *
 * Removal asks first. Everything else on this page is a reversible edit - set
 * the persona back and the change is undone - but revoking access deletes the
 * membership and, if it was their last one, the login itself. `window.confirm`
 * rather than the kit's ConfirmProvider only because this table is not inside
 * one; the point is that the click is not the last word.
 *
 * Neither button is the security boundary: `POST /v1/owner/team/:id/password`
 * and `DELETE /v1/owner/team/:id` both carry `@RequireOwnerRole("owner")`, and
 * the API refuses the last owner and self-removal on its own.
 */
function RowActions({ member, isSelf }: { member: TeamMember; isSelf: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [password, setPassword] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setError(null);
    setPassword(null);
    startTransition(async () => {
      const res = await resetTeamPasswordAction(member.userId);
      if (res.error) setError(res.error);
      else setPassword(res.password ?? null);
    });
  };

  const remove = () => {
    if (
      !window.confirm(
        `Remove ${member.email} from this workspace? They lose access immediately.`,
      )
    ) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await removeTeamMemberAction(member.userId);
      if (res.error) setError(res.error);
      else router.refresh();
    });
  };

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2">
        <Button type="button" variant="ghost" onClick={reset} disabled={pending}>
          Reset password
        </Button>
        {/* Self-removal is refused by the API; not offering the button is the
            kinder half of the same rule. */}
        {isSelf ? null : (
          <Button type="button" variant="danger" onClick={remove} disabled={pending}>
            Remove
          </Button>
        )}
      </div>
      {password ? (
        <div className="max-w-xs space-y-1">
          <code className="block rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-text">
            {password}
          </code>
          <span className="block text-xs text-text-muted">
            Shown once. Nothing was emailed.
          </span>
        </div>
      ) : null}
      {error ? (
        <span className="block max-w-xs text-xs leading-relaxed text-danger-text">{error}</span>
      ) : null}
    </div>
  );
}
