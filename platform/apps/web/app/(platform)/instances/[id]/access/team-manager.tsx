"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2, UserPlus, Users } from "lucide-react";
import {
  Button,
  Card,
  Checkbox,
  FormField,
  Input,
  MonoLabel,
  Select,
  StatusChip,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  useAlert,
  useConfirm,
} from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import {
  addMemberAction,
  createWorkspaceAction,
  removeMemberAction,
  updateMemberAction,
} from "./team-actions";

export interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: string;
  /** The assigned `roles` row (migration 0039), or null if none. */
  roleId?: string | null;
  roleName?: string | null;
  recordingsListen: boolean;
  recordingsExport: boolean;
  scopeType?: string | null;
  scopeId?: string | null;
}

export interface Workspace {
  id: string;
  name: string;
  created_at: string;
}

/** A row from `GET /v1/roles` - system-seeded or client-defined. */
export interface CrmRole {
  id: string;
  key: string;
  name: string;
  is_system: boolean;
  status: string;
}

/**
 * The tenant-assignable half of `memberships.role`'s CHECK enum, matching
 * members.controller.ts's `Role` exactly (platform_admin is reserved for
 * internal staff and deliberately absent).
 *
 * This list used to read ["owner","admin","manager","analyst","viewer"], which
 * matched nothing the API accepts - so every add/change to anything but
 * "viewer" was rejected with a 400 the UI showed as a bare status code.
 */
const ROLES = ["org_admin", "workspace_admin", "workspace_member", "viewer"] as const;

function roleTone(role: string): "solid" | "muted" | "outline" {
  if (role === "org_admin" || role === "workspace_admin") return "solid";
  if (role === "viewer") return "outline";
  return "muted";
}

/** Head strip shared by the two panels - matches the instance page's TablePanel. */
const PANEL_HEAD =
  "flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border bg-bg-subtle px-5 py-3";

/**
 * One client's people: who they are, what tier they hold, which permission role
 * they are enforced against, and what they may do with a recording.
 *
 * ── THEMED, AS OF THE client-config CONSOLIDATION ──────────────────────────
 *
 * This component was one of the operator console's pre-v2 holdouts and was
 * written entirely in stock Tailwind - `border-black`, `bg-white`,
 * `bg-neutral-100`, `text-neutral-400`. Those are fixed values, so in dark mode
 * it rendered black rules and a near-white table on a #0a0a0a page: the member
 * names were legible only because `text-black` happened to sit on a `bg-white`
 * the component also hard-coded, and every border around them disappeared into
 * the surface. It now spends only semantic tokens, which are redefined under
 * `prefers-color-scheme: dark` and by `[data-theme]`, so it follows the toggle
 * like the rest of the console. It is off `console-palette.test.ts`'s backlog.
 *
 * The form controls moved to the kit's `Input`/`Select`/`Checkbox` rather than
 * `lib/form.ts`'s `inputClass`: that helper is itself hard-coded
 * (`border-black bg-neutral-50 text-black`), which is invisible to the palette
 * ratchet because the ratchet scans `.tsx` only. Ten other pages still use it -
 * they are a separate migration, not this one.
 */
export function TeamManager({
  members,
  workspaces,
  roles,
  orgId,
}: {
  members: Member[];
  workspaces: Workspace[];
  roles: CrmRole[];
  /** Tenant these members belong to; omitted falls back to the dev org. */
  orgId?: string;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<string>("workspace_member");
  const [listen, setListen] = useState(true);
  const [exportPerm, setExportPerm] = useState(false);
  const [wsName, setWsName] = useState("");
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();
  const alert = useAlert();

  const addMember = () =>
    startTransition(async () => {
      const res = await addMemberAction({
        email: email.trim(),
        name: name.trim(),
        role,
        recordingsListen: listen,
        recordingsExport: exportPerm,
      }, orgId);
      if (res.error) {
        await alert({
          title: "Couldn't add the member",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      setEmail("");
      setName("");
    });

  const changeRole = (userId: string, nextRole: string) =>
    startTransition(async () => {
      const res = await updateMemberAction({ userId, role: nextRole }, orgId);
      if (res.error) {
        await alert({
          title: "Couldn't change the role",
          body: res.error,
          tone: "danger",
        });
      }
    });

  /** Assign a CRM role (0039). Sent alone, so the legacy `role` above is untouched. */
  const changeCrmRole = (userId: string, nextRoleId: string) =>
    startTransition(async () => {
      const res = await updateMemberAction(
        { userId, roleId: nextRoleId === "" ? null : nextRoleId },
        orgId,
      );
      if (res.error) {
        await alert({
          title: "Couldn't change the CRM role",
          body: res.error,
          tone: "danger",
        });
      }
    });

  const togglePerm = (m: Member, key: "recordingsListen" | "recordingsExport") =>
    startTransition(() =>
      updateMemberAction({ userId: m.userId, [key]: !m[key] }, orgId).then(() => undefined),
    );

  const remove = async (userId: string) => {
    const ok = await confirm({
      title: "Remove this member?",
      body: "They lose access to this workspace immediately. Their account itself is not deleted.",
      confirmLabel: "Remove member",
      tone: "danger",
    });
    if (!ok) return;
    startTransition(async () => {
      await removeMemberAction(userId, orgId);
    });
  };

  const createWorkspace = () =>
    startTransition(async () => {
      const res = await createWorkspaceAction(wsName.trim(), orgId);
      if (res.error) {
        await alert({
          title: "Couldn't create the workspace",
          body: res.error,
          tone: "danger",
        });
        return;
      }
      setWsName("");
    });

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      {/* Members */}
      <div className="space-y-6 lg:col-span-2">
        <Card className="overflow-hidden p-0">
          <div className={PANEL_HEAD}>
            <div className="flex items-center gap-2">
              <span aria-hidden="true" className="text-text-muted">
                <Users className="h-4 w-4" />
              </span>
              <span className="text-sm font-medium text-text">Members</span>
            </div>
            <span className="text-xs text-text-muted tabular-nums">
              {members.length} {members.length === 1 ? "person" : "people"}
            </span>
          </div>
          {members.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-text-muted">No members yet</p>
          ) : (
            <div
              tabIndex={0}
              role="region"
              aria-label="Members"
              className="overflow-x-auto"
            >
              <table className="w-full min-w-[640px] border-collapse text-left text-sm">
                <caption className="sr-only">Members of this client</caption>
                <TableHead>
                  <tr>
                    <TableHeaderCell>Member</TableHeaderCell>
                    <TableHeaderCell>Role</TableHeaderCell>
                    <TableHeaderCell>CRM Role</TableHeaderCell>
                    <TableHeaderCell>Permissions</TableHeaderCell>
                    <TableHeaderCell className="text-right">Actions</TableHeaderCell>
                  </tr>
                </TableHead>
                <TableBody>
                  {members.map((m) => (
                    <TableRow key={m.userId}>
                      <TableCell>
                        <span className="block font-medium text-text">{m.name ?? "Unnamed"}</span>
                        <span className="font-mono text-xs text-text-muted">{m.email}</span>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col items-start gap-1.5">
                          <StatusChip tone={roleTone(m.role)}>{m.role}</StatusChip>
                          <Select
                            aria-label={`Tenant role for ${m.name ?? m.email}`}
                            size="sm"
                            className="min-w-[10rem]"
                            value={m.role}
                            disabled={pending}
                            onChange={(e) => changeRole(m.userId, e.target.value)}
                          >
                            {ROLES.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </Select>
                        </div>
                      </TableCell>
                      <TableCell>
                        {/* Which permission grid this member is enforced against
                            on the CRM routes. Separate from the column beside it:
                            that one is the legacy tenant role every other guard
                            still reads, and changing one must not change the
                            other. */}
                        <Select
                          aria-label={`CRM role for ${m.name ?? m.email}`}
                          size="sm"
                          className="min-w-[10rem]"
                          value={m.roleId ?? ""}
                          disabled={pending}
                          onChange={(e) => changeCrmRole(m.userId, e.target.value)}
                        >
                          <option value="">- none -</option>
                          {roles.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                              {r.is_system ? "" : " (custom)"}
                            </option>
                          ))}
                        </Select>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => togglePerm(m, "recordingsListen")}
                            className="rounded-sm disabled:opacity-40"
                            aria-pressed={m.recordingsListen}
                            title="Toggle listen permission"
                          >
                            <StatusChip tone={m.recordingsListen ? "solid" : "outline"}>
                              listen
                            </StatusChip>
                          </button>
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => togglePerm(m, "recordingsExport")}
                            className="rounded-sm disabled:opacity-40"
                            aria-pressed={m.recordingsExport}
                            title="Toggle export permission"
                          >
                            <StatusChip tone={m.recordingsExport ? "solid" : "outline"}>
                              export
                            </StatusChip>
                          </button>
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <button
                          onClick={() => void remove(m.userId)}
                          disabled={pending}
                          className="rounded-md border border-transparent p-1.5 text-text-muted transition-colors duration-150 ease-out hover:border-border hover:bg-surface-hover hover:text-text disabled:opacity-40"
                          aria-label={`Remove ${m.name ?? m.email}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </table>
            </div>
          )}
        </Card>

        {/* Add member */}
        <Card className="space-y-4">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="text-text-muted">
              <UserPlus className="h-4 w-4" />
            </span>
            <span className="text-sm font-medium text-text">Add member</span>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <FormField label="Email" name="member-email">
              <Input
                type="email"
                placeholder="person@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </FormField>
            <FormField label="Name" name="member-name">
              <Input
                placeholder="Full name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </FormField>
            <FormField label="Role" name="member-role">
              <Select value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
            </FormField>
            <div className="flex flex-wrap items-end gap-4 pb-1">
              <Checkbox
                label="Listen"
                checked={listen}
                onChange={(e) => setListen(e.target.checked)}
              />
              <Checkbox
                label="Export"
                checked={exportPerm}
                onChange={(e) => setExportPerm(e.target.checked)}
              />
            </div>
          </div>

          <div className="flex items-center justify-end">
            <Button type="button" onClick={addMember} loading={pending} disabled={!email.trim()}>
              <Plus className="h-4 w-4" />
              Add member
            </Button>
          </div>
        </Card>
      </div>

      {/* Workspaces */}
      <div className="space-y-6">
        <Card className="space-y-4">
          <MonoLabel>Workspaces</MonoLabel>
          <div className="space-y-3">
            {workspaces.length === 0 ? (
              <p className="py-6 text-center text-sm text-text-muted">No workspaces yet</p>
            ) : (
              workspaces.map((w) => (
                <div key={w.id} className="rounded-md border border-border bg-surface p-3.5">
                  <span className="block font-medium text-text">{w.name}</span>
                  <span className="font-mono text-xs text-text-muted">
                    {w.id.slice(0, 8)} · <LocalTime iso={w.created_at} mode="date" />
                  </span>
                </div>
              ))
            )}
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <FormField label="New workspace" name="workspace-name">
              <Input
                placeholder="e.g. West Coast Sales"
                value={wsName}
                onChange={(e) => setWsName(e.target.value)}
              />
            </FormField>
            <Button
              type="button"
              variant="secondary"
              className="w-full"
              onClick={createWorkspace}
              loading={pending}
              disabled={!wsName.trim()}
            >
              <Plus className="h-4 w-4" />
              Create workspace
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
