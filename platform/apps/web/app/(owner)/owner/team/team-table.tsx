"use client";

import { useState, useTransition } from "react";
import {
  canPairDevices,
  OWNER_ROLE_DESCRIPTIONS,
  OWNER_ROLE_LABELS,
  OwnerRole,
  ownerRoleSeesAllRecords,
} from "@aura/shared";
import { Card, MonoLabel, Select, StatusChip, useAlert, useToast } from "@aura/ui";
import { setTeamMemberAction } from "./actions";
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
              {["Person", "Role", "Telecaller identity", "Can pair handsets", ""].map((heading) => (
                <th
                  key={heading}
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
  const [canPair, setCanPair] = useState(member.canPairDevices);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const save = (update: {
    ownerRole?: OwnerRole;
    telecallerId?: string | null;
    canPairDevices?: boolean;
  }) => {
    startTransition(async () => {
      const result = await setTeamMemberAction(member.userId, update);
      if (result.error) {
        // Put the control back where it was. A picker that keeps showing the
        // value the server refused is how somebody walks away believing a
        // change landed - the row would read "Telecaller" while the person
        // still has the whole console.
        setRole(member.ownerRole);
        setTelecallerId(member.telecallerId ?? "");
        setCanPair(member.canPairDevices);
        await alert({
          title: `Couldn't update ${member.name || member.email}`,
          body: result.error,
          tone: "danger",
        });
        return;
      }
      toast("Saved");
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

      {/* ── Handset pairing (migration 0096) ─────────────────────────── */}
      <td className="px-4 py-3">
        {/* An owner always can, whatever the stored flag says - so the control
            is a fixed "Always" rather than a checkbox that would imply an
            owner could be switched off. `canPairDevices` is the single place
            that rule lives; reproducing it as `role === "owner"` here would be
            a second copy. */}
        {canPairDevices(role, false) ? (
          <span className="text-xs text-text-muted">Always</span>
        ) : canEdit ? (
          <label className="flex items-center gap-2 text-xs text-text">
            <input
              type="checkbox"
              checked={canPair}
              disabled={pending}
              aria-label={`Allow ${member.email} to pair handsets`}
              onChange={(e) => {
                const next = e.target.checked;
                setCanPair(next);
                save({ canPairDevices: next });
              }}
            />
            {canPair ? "Allowed" : "Not allowed"}
          </label>
        ) : (
          <span className="text-text-muted">{member.canPairDevices ? "Allowed" : "-"}</span>
        )}
      </td>

      <td className="px-4 py-3 whitespace-nowrap">
        {pending ? <MonoLabel>Saving…</MonoLabel> : null}
      </td>
    </tr>
  );
}
