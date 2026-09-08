"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { isPermissionEnforced } from "@aura/shared";
import { Button, Card, Input, MonoLabel, Select, StatusChip, useAlert, useToast } from "@aura/ui";
import { createRoleAction, deleteRoleAction, saveRolePermissionsAction } from "./roles-actions";
import type { RoleRow } from "./types";

/** Object keys are API vocabulary; these are what a person calls them, and
 *  they are the sidebar's own words so a reader can find the page each row is
 *  about. */
const OBJECT_LABELS: Record<string, string> = {
  lead: "Leads",
  contact: "Contacts",
  account: "Accounts",
  deal: "Deals",
  task: "Follow-ups",
  conversation: "Conversations",
  product: "Products",
  quotation: "Quotations",
  invoice: "Invoices",
};

const ACTION_LABELS: Record<string, string> = {
  view: "View",
  create: "Create",
  edit: "Edit",
  delete: "Delete",
  export: "Export",
};

type Grid = Record<string, Record<string, "none" | "all" | "owned">>;

function gridFor(role: RoleRow, objectTypes: string[], actions: string[]): Grid {
  const grid: Grid = {};
  for (const object of objectTypes) {
    grid[object] = {};
    for (const action of actions) grid[object][action] = "none";
  }
  for (const grant of role.grants) {
    if (!grid[grant.objectType]) continue;
    grid[grant.objectType][grant.action] = grant.scope === "owned" ? "owned" : "all";
  }
  return grid;
}

/**
 * The permission matrix, one role at a time.
 *
 * ── WHY ONE ROLE AT A TIME AND NOT A WALL OF CHECKBOXES ───────────────────
 *
 * Eight objects x five actions is forty controls; times six roles is two
 * hundred and forty, which is not a table anybody reads, it is a wall somebody
 * clicks at. A role is also how permissions are actually reasoned about
 * ("what can a Viewer do") - so the role is the unit of both editing and
 * saving, which is also what the API takes (`PUT :id/permissions` replaces the
 * whole grid, because a grid is edited as a whole).
 *
 * ── SCOPE IS A THIRD STATE, NOT A SECOND CHECKBOX ─────────────────────────
 *
 * A grant is off, on for every record, or on for the person's own records.
 * Two checkboxes would allow "own records only, but not granted", which is not
 * a thing, and a reader would have to work out which of the four combinations
 * are real. One control with three positions cannot express a state that does
 * not exist.
 *
 * ── AND "OWN" MEANS SOMETHING DIFFERENT HERE THAN ON THE TEAM TAB ──────────
 *
 * Two scoping systems exist and they key on different columns:
 *
 *   here          `owner_user_id` - the record is assigned to your LOGIN.
 *   the Team tab  `telecallers.user_id` - the record is attributed to your
 *                 HANDSET IDENTITY.
 *
 * They compose by intersection and the persona can only narrow, never widen -
 * so a telecaller given "All records" here still reads only their own. The
 * page says so out loud rather than leaving two identical words meaning two
 * things one tab apart.
 *
 * ── INERT CELLS ARE SHOWN AS INERT ────────────────────────────────────────
 *
 * The grid is a full cross product; the API mounts a guard on rather less than
 * all of it. A screen that silently ignored half of what somebody set would be
 * worse than one offering less - remove Delete from a role, tell the team the
 * records are safe, and they are not. `isPermissionEnforced` comes from the
 * inventory that `permissions-inventory.spec.ts` pins against the controllers'
 * real metadata, so this cannot drift into over-promising.
 */
export function RolesGrid({
  roles,
  objectTypes,
  actions,
  canEdit,
}: {
  roles: RoleRow[];
  objectTypes: string[];
  actions: string[];
  canEdit: boolean;
}) {
  const [selectedId, setSelectedId] = useState(roles[0]?.id ?? "");
  const selected = roles.find((r) => r.id === selectedId) ?? roles[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {roles.map((role) => {
          const active = role.id === selected?.id;
          return (
            <button
              key={role.id}
              type="button"
              onClick={() => setSelectedId(role.id)}
              aria-current={active ? "true" : undefined}
              className={`rounded-md border px-3 py-1.5 text-left text-sm ${
                active
                  ? "border-border-strong bg-surface-hover font-medium text-text"
                  : "border-border text-text-muted hover:text-text"
              }`}
            >
              {role.name}
              <span className="ml-2 tabular-nums text-text-muted">{role.member_count}</span>
            </button>
          );
        })}
        {canEdit ? <NewRoleButton /> : null}
      </div>

      {selected ? (
        <RoleEditor
          key={selected.id}
          role={selected}
          objectTypes={objectTypes}
          actions={actions}
          canEdit={canEdit}
        />
      ) : null}
    </div>
  );
}

function RoleEditor({
  role,
  objectTypes,
  actions,
  canEdit,
}: {
  role: RoleRow;
  objectTypes: string[];
  actions: string[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [grid, setGrid] = useState<Grid>(() => gridFor(role, objectTypes, actions));
  const [dirty, setDirty] = useState(false);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
  const toast = useToast();

  const set = (object: string, action: string, value: "none" | "all" | "owned") => {
    setGrid((prev) => ({ ...prev, [object]: { ...prev[object], [action]: value } }));
    setDirty(true);
  };

  const save = () => {
    // Inert cells are never written. The API would happily store the row and
    // no route would ever read it, which is the state this screen exists to
    // stop pretending is a permission.
    const grants = objectTypes.flatMap((object) =>
      actions
        .filter((action) => isPermissionEnforced(object, action))
        .filter((action) => grid[object][action] !== "none")
        .map((action) => ({
          objectType: object,
          action,
          scope: grid[object][action] === "owned" ? "owned" : "all",
          fieldRestrictions: {},
        })),
    );

    startTransition(async () => {
      const res = await saveRolePermissionsAction(role.id, grants);
      if (res.error) {
        await alert({ title: `Couldn't save ${role.name}`, body: res.error, tone: "danger" });
        return;
      }
      setDirty(false);
      toast("Saved");
      router.refresh();
    });
  };

  const remove = () => {
    if (!window.confirm(`Delete the role "${role.name}"?`)) return;
    startTransition(async () => {
      const res = await deleteRoleAction(role.id);
      if (res.error) {
        await alert({ title: `Couldn't delete ${role.name}`, body: res.error, tone: "danger" });
        return;
      }
      router.refresh();
    });
  };

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <MonoLabel>{role.name}</MonoLabel>
          <p className="mt-1 text-xs text-text-muted">
            {role.member_count === 1 ? "1 person holds" : `${role.member_count} people hold`} this
            role.
            {role.is_system ? " Built in - its name cannot be changed, its grants can." : null}
          </p>
        </div>
        {canEdit ? (
          <div className="flex gap-2">
            {/* Deleting a role somebody holds is refused by the API - it would
                silently drop them to their tier's default grants, which is a
                permission change dressed up as a tidy-up. Not offering the
                button is the readable half of that rule. */}
            {!role.is_system && role.member_count === 0 ? (
              <Button type="button" variant="danger" onClick={remove} disabled={pending}>
                Delete role
              </Button>
            ) : null}
            <Button type="button" onClick={save} disabled={pending || !dirty}>
              {pending ? "Saving…" : "Save permissions"}
            </Button>
          </div>
        ) : null}
      </div>

      <div
        tabIndex={0}
        role="region"
        aria-label={`${role.name} permissions`}
        className="overflow-x-auto"
      >
        <table className="w-full min-w-[640px] border-collapse text-left text-sm">
          <thead className="bg-bg-subtle">
            <tr>
              <th
                scope="col"
                className="border-b border-border px-3 py-2 text-xs font-medium text-text-muted"
              >
                Object
              </th>
              {actions.map((action) => (
                <th
                  key={action}
                  scope="col"
                  className="border-b border-border px-3 py-2 text-xs font-medium whitespace-nowrap text-text-muted"
                >
                  {ACTION_LABELS[action] ?? action}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {objectTypes.map((object) => (
              <tr key={object}>
                <th scope="row" className="px-3 py-2 text-left font-medium text-text">
                  {OBJECT_LABELS[object] ?? object}
                </th>
                {actions.map((action) => {
                  const enforced = isPermissionEnforced(object, action);
                  if (!enforced) {
                    // Not a disabled control - no control. A greyed-out picker
                    // still reads as "a setting I could have", and the honest
                    // statement is that this combination is not something the
                    // product checks at all.
                    return (
                      <td key={action} className="px-3 py-2">
                        <span
                          className="text-xs text-text-muted"
                          title={`Aura does not check ${
                            ACTION_LABELS[action] ?? action
                          } on ${OBJECT_LABELS[object] ?? object}, so this cannot be restricted.`}
                        >
                          not checked
                        </span>
                      </td>
                    );
                  }
                  return (
                    <td key={action} className="px-3 py-2">
                      {canEdit ? (
                        <Select
                          aria-label={`${ACTION_LABELS[action] ?? action} ${
                            OBJECT_LABELS[object] ?? object
                          } for ${role.name}`}
                          value={grid[object][action]}
                          disabled={pending}
                          onChange={(e) =>
                            set(object, action, e.target.value as "none" | "all" | "owned")
                          }
                        >
                          <option value="none">No</option>
                          <option value="all">All records</option>
                          <option value="owned">Own records</option>
                        </Select>
                      ) : (
                        <StatusChip tone={grid[object][action] === "none" ? "outline" : "muted"}>
                          {grid[object][action] === "none"
                            ? "No"
                            : grid[object][action] === "owned"
                              ? "Own"
                              : "All"}
                        </StatusChip>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="max-w-prose text-xs leading-relaxed text-text-muted">
        <strong className="font-medium text-text">Own records</strong> here means assigned to that
        person&rsquo;s login. On the Team tab, a Telecaller or Sales role is narrowed to records
        attributed to their handset identity instead &mdash; both apply, and the narrower one wins.
        Cells marked <em>not checked</em> are combinations Aura does not enforce anywhere, so
        setting them would change nothing.
      </p>

      {dirty ? (
        <p className="text-xs text-text-muted">
          Unsaved. Nothing changes for anybody until you save.
        </p>
      ) : null}
    </Card>
  );
}

/**
 * A role of the business's own.
 *
 * The key is derived from the name rather than asked for. It is a slug the API
 * needs and nobody outside this file will ever type or read, and asking a
 * person to invent a snake_case identifier for "Branch Manager" produces
 * either a rejection or "Branch Manager" with a space in it.
 */
function NewRoleButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const alert = useAlert();

  if (!open) {
    return (
      <Button type="button" variant="secondary" onClick={() => setOpen(true)}>
        New role
      </Button>
    );
  }

  const create = () => {
    startTransition(async () => {
      const res = await createRoleAction(name);
      if (res.error) {
        await alert({ title: "Couldn't create the role", body: res.error, tone: "danger" });
        return;
      }
      setName("");
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <div className="flex items-center gap-2">
      <Input
        aria-label="New role name"
        placeholder="Branch Manager"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <Button type="button" onClick={create} disabled={pending || name.trim().length === 0}>
        {pending ? "Creating…" : "Create"}
      </Button>
      <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
        Cancel
      </Button>
    </div>
  );
}
