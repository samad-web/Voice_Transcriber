"use client";

import { useState, useTransition } from "react";
import { useDraftState } from "@/lib/use-server-state";
import { useRouter } from "next/navigation";
import {
  OWNER_ROLE_DESCRIPTIONS,
  OWNER_ROLE_LABELS,
  OwnerRole,
  ownerRoleSeesAllRecords,
} from "@aura/shared";
import {
  Button,
  Card,
  Input,
  MonoLabel,
  Select,
  StatusChip,
  useAlert,
  useConfirm,
  useToast,
} from "@aura/ui";
import { PhonePairFields, usePhoneErrors } from "@/components/phone-pair-fields";
import { removeTeamMemberAction, resetTeamPasswordAction, setTeamMemberAction } from "./actions";
import {
  assignStaffRoleAction,
  setStaffProfileAction,
  setStaffStatusAction,
} from "./staff-actions";
import type { TeamMember, TeamRole, TeamTelecaller } from "./types";

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
  roles,
  canEdit,
  selfUserId,
}: {
  members: TeamMember[];
  telecallers: TeamTelecaller[];
  roles: TeamRole[];
  canEdit: boolean;
  selfUserId: string | null;
}) {
  return (
    <Card className="overflow-hidden p-0">
      <div tabIndex={0} role="region" aria-label="Team" className="overflow-x-auto">
        <table className="w-full min-w-[720px] border-collapse text-left text-sm">
          <thead className="bg-bg-subtle">
            <tr>
              {["Person", "Role", "Telecaller identity", "Permissions", "", ""].map(
                (heading, i) => (
                  <th
                    // Two trailing unlabelled columns (status, actions), so the
                    // key cannot be the heading text - both are "".
                    key={heading || `blank-${i}`}
                    scope="col"
                    className="border-b border-border px-4 py-2.5 text-xs font-medium whitespace-nowrap text-text-muted"
                  >
                    {heading}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {members.map((member) => (
              <Row
                key={member.userId}
                member={member}
                telecallers={telecallers}
                roles={roles}
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
  roles,
  canEdit,
  isSelf,
}: {
  member: TeamMember;
  telecallers: TeamTelecaller[];
  roles: TeamRole[];
  canEdit: boolean;
  isSelf: boolean;
}) {
  const [role, setRole] = useDraftState<OwnerRole>(member.ownerRole);
  const [telecallerId, setTelecallerId] = useDraftState(member.telecallerId ?? "");
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const save = (update: { ownerRole?: OwnerRole; telecallerId?: string | null }) => {
    startTransition(async () => {
      const result = await setTeamMemberAction(member.userId, update);
      if (result.error) {
        // Put the control back where it was. A picker that keeps showing the
        // value the server refused is how somebody walks away believing a
        // change landed - the row would read "Telecaller" while the person
        // still has the whole console.
        setRole(member.ownerRole);
        setTelecallerId(member.telecallerId ?? "");
        await alert({
          title: `Couldn't update ${member.email}`,
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
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {isSelf ? <StatusChip tone="muted">you</StatusChip> : null}
          {/* Suspension is announced on the row, not signalled by the row being
              absent - see TeamTab for why a suspended colleague stays listed. */}
          {member.status === "suspended" ? <StatusChip tone="danger">suspended</StatusChip> : null}
          {member.staffCode ? <StatusChip tone="outline">{member.staffCode}</StatusChip> : null}
        </div>
        {member.jobTitle || member.phone || member.whatsapp ? (
          <p className="mt-1 text-xs text-text-muted">
            {[
              member.jobTitle,
              member.phone,
              // Said once when it is the same number; spelled out when not.
              member.whatsapp && member.whatsapp !== member.phone ? `WhatsApp ${member.whatsapp}` : null,
            ]
              .filter(Boolean)
              .join(" - ")}
          </p>
        ) : null}
        {canEdit ? <StaffDetails member={member} /> : null}
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
            {OWNER_ROLE_LABELS[role]} only sees records assigned to them. Link a telecaller
            identity, or their console will be empty.
          </p>
        ) : null}
      </td>

      <td className="px-4 py-3">
        {canEdit ? (
          <PermissionRole member={member} roles={roles} />
        ) : (
          <span className="text-text-muted">{member.roleName ?? "Default for their tier"}</span>
        )}
      </td>

      <td className="px-4 py-3 whitespace-nowrap">
        {pending ? <MonoLabel>Saving…</MonoLabel> : null}
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
 * membership and, if it was their last one, the login itself.
 *
 * These used `window.confirm`, justified here by "this table is not inside a
 * ConfirmProvider". That was simply untrue: the provider is mounted at
 * app/layout.tsx, above every route group, and the `useAlert()` two lines into
 * RowActions below was already proving the tree was reachable. On top of the
 * reasons confirm.tsx gives for not using the native dialog at all, browsers
 * let a user tick "prevent this page from creating more dialogues", which
 * silently turns every later confirm into `false` - a guard the guarded party
 * can switch off.
 *
 * Neither button is the security boundary: `POST /v1/owner/team/:id/password`
 * and `DELETE /v1/owner/team/:id` both carry `@RequireOwnerRole("owner")`, and
 * the API refuses the last owner and self-removal on its own.
 */
function RowActions({ member, isSelf }: { member: TeamMember; isSelf: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [password, setPassword] = useState<string | null>(null);
  const alert = useAlert();
  const confirm = useConfirm();

  const reset = () => {
    setPassword(null);
    startTransition(async () => {
      const res = await resetTeamPasswordAction(member.userId);
      if (res.error) {
        await alert({
          title: `Couldn't reset ${member.email}'s password`,
          body: res.error,
          tone: "danger",
        });
        return;
      }
      setPassword(res.password ?? null);
    });
  };

  /**
   * Suspend, or put back.
   *
   * Only the suspension asks first, and the asymmetry is the point: suspending
   * takes something away and reinstating gives it back, so a mis-click one way
   * costs somebody their morning and a mis-click the other way costs one more
   * click. The confirmation says what suspension does NOT do, because the
   * button next to it does exactly that and cannot be undone.
   */
  const toggleStatus = () => {
    const suspending = member.status !== "suspended";
    startTransition(async () => {
      if (
        suspending &&
        // `requireTyped: false`: suspension is reversible by the button right
        // next to it, and confirm.tsx reserves the type-DELETE gate for
        // actions whose data is gone afterwards. Asking someone to type DELETE
        // to suspend is how they learn to type it without reading.
        !(await confirm({
          title: `Suspend ${member.email}?`,
          body:
            "They stop being able to sign in. Every lead, call and follow-up stays assigned " +
            "to them, and you can reinstate them at any time.",
          confirmLabel: "Suspend",
          tone: "danger",
          requireTyped: false,
        }))
      ) {
        return;
      }
      const res = await setStaffStatusAction(member.userId, suspending ? "suspended" : "active");
      if (res.error) {
        await alert({
          title: `Couldn't ${suspending ? "suspend" : "reinstate"} ${member.email}`,
          body: res.error,
          tone: "danger",
        });
        return;
      }
      router.refresh();
    });
  };

  const remove = () => {
    startTransition(async () => {
      // No `requireTyped` override, so this keeps the default DELETE gate:
      // the login is destroyed and cannot be restored.
      if (
        !(await confirm({
          title: `Remove ${member.email} from this workspace?`,
          body:
            "Their login is deleted and cannot be restored - suspend them instead if this " +
            "might be temporary.",
          confirmLabel: "Remove",
          tone: "danger",
        }))
      ) {
        return;
      }
      const res = await removeTeamMemberAction(member.userId);
      if (res.error) {
        await alert({
          title: `Couldn't remove ${member.email}`,
          body: res.error,
          tone: "danger",
        });
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="ghost" onClick={reset} disabled={pending}>
          Reset password
        </Button>
        {/* Self-suspension and self-removal are both refused by the API; not
            offering either button is the kinder half of the same rule. */}
        {isSelf ? null : (
          <Button type="button" variant="secondary" onClick={toggleStatus} disabled={pending}>
            {member.status === "suspended" ? "Reinstate" : "Suspend"}
          </Button>
        )}
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
          <span className="block text-xs text-text-muted">Shown once. Nothing was emailed.</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The employment fields: staff code, job title, phone (migration 0102).
 *
 * Collapsed behind a disclosure rather than given three columns. They are read
 * far more often than they are written - the code and title already render on
 * the row above - and three more inputs per row would push the persona and
 * identity pickers, which are the reason anybody opens this page, off the side
 * of the table.
 *
 * Saved together on an explicit Save, unlike the pickers above, which save on
 * change. Text fields have no "changed" moment: saving on blur would write a
 * half-typed phone number every time somebody tabbed away to check something.
 */
function StaffDetails({ member }: { member: TeamMember }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [staffCode, setStaffCode] = useDraftState(member.staffCode ?? "");
  const [jobTitle, setJobTitle] = useDraftState(member.jobTitle ?? "");
  // Starts ticked only when the two numbers already agree (or neither is
  // set) - a person whose WhatsApp differs must not have it overwritten by
  // opening and saving this panel.
  const [phones, setPhones] = useState({
    mobile: member.phone ?? "",
    whatsapp: member.whatsapp ?? "",
    same: (member.whatsapp ?? "") === (member.phone ?? "") || !member.whatsapp,
  });
  // Checked against the workspace's country, the rule the API applies too.
  const phoneErrors = usePhoneErrors();
  const { mobile: mobileError, whatsapp: whatsappError } = phoneErrors(phones);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const save = () => {
    startTransition(async () => {
      const res = await setStaffProfileAction(member.userId, {
        staffCode,
        jobTitle,
        phone: phones.mobile,
        whatsapp: phones.same ? phones.mobile : phones.whatsapp,
      });
      if (res.error) {
        await alert({
          title: `Couldn't save ${member.email}'s details`,
          body: res.error,
          tone: "danger",
        });
        return;
      }
      toast("Saved");
      setOpen(false);
      router.refresh();
    });
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1.5 text-xs text-text-muted underline underline-offset-2 hover:text-text"
      >
        Staff details
      </button>
    );
  }

  return (
    <div className="mt-2 max-w-[15rem] space-y-1.5">
      <Input
        aria-label={`Employee code for ${member.email}`}
        placeholder="Employee code"
        value={staffCode}
        onChange={(e) => setStaffCode(e.target.value)}
      />
      <Input
        aria-label={`Job title for ${member.email}`}
        placeholder="Job title"
        value={jobTitle}
        onChange={(e) => setJobTitle(e.target.value)}
      />
      <PhonePairFields
        idPrefix={`staff-${member.userId}`}
        mobile={phones.mobile}
        whatsapp={phones.whatsapp}
        same={phones.same}
        onChange={setPhones}
        disabled={pending}
        stacked
      />
      <div className="flex gap-2">
        <Button type="button" onClick={save} disabled={pending || Boolean(mobileError || whatsappError)}>
          {pending ? "Saving..." : "Save"}
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/**
 * Which permission role's grid applies to this person (0039's
 * `memberships.role_id`, which nothing has ever written until now).
 *
 * -- WHY THIS IS A SEPARATE PICKER FROM THE PERSONA ------------------------
 *
 * They answer different questions and both must say yes. The persona decides
 * WHICH CONSOLE somebody gets and whose records are in it; the role decides
 * what they may do with a record once they can see it. Merging them into one
 * dropdown would mean either five personas times every role, or pretending a
 * business's own roles map onto a fixed list of five.
 *
 * "Default for their tier" is not "no permissions": clearing the role returns
 * them to the seeded grants for their tenant tier, which is what every
 * membership used before this control existed.
 */
function PermissionRole({ member, roles }: { member: TeamMember; roles: TeamRole[] }) {
  const [roleId, setRoleId] = useDraftState(member.roleId ?? "");
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  return (
    <>
      <Select
        aria-label={`Permission role for ${member.email}`}
        value={roleId}
        disabled={pending}
        onChange={(e) => {
          const next = e.target.value;
          setRoleId(next);
          startTransition(async () => {
            const res = await assignStaffRoleAction(member.userId, next || null);
            if (res.error) {
              setRoleId(member.roleId ?? "");
              await alert({
                title: `Couldn't change ${member.email}'s permissions`,
                body: res.error,
                tone: "danger",
              });
              return;
            }
            toast("Saved");
          });
        }}
      >
        <option value="">Default for their tier</option>
        {roles.map((r) => (
          <option key={r.id} value={r.id}>
            {r.name}
            {r.isSystem ? "" : " (custom)"}
          </option>
        ))}
      </Select>
      <p className="mt-1.5 max-w-[13rem] text-xs leading-relaxed text-text-muted">
        What they may do with a record. Their role above decides which records they see at all.
      </p>
    </>
  );
}
