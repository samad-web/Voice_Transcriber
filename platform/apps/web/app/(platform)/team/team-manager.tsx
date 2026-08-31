"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2, UserPlus, Users } from "lucide-react";
import { BrutalButton, Card, MonoLabel, StatusChip, useConfirm } from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import { inputClass, selectClass } from "@/lib/form";
import {
  addMemberAction,
  createWorkspaceAction,
  removeMemberAction,
  updateMemberAction,
} from "./actions";

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

/** A row from `GET /v1/roles` - system-seeded or operator-defined. */
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
  const [error, setError] = useState<string | null>(null);
  const [wsName, setWsName] = useState("");
  const [wsError, setWsError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const confirm = useConfirm();

  const addMember = () =>
    startTransition(async () => {
      setError(null);
      const res = await addMemberAction({
        email: email.trim(),
        name: name.trim(),
        role,
        recordingsListen: listen,
        recordingsExport: exportPerm,
      }, orgId);
      if (res.error) setError(res.error);
      else {
        setEmail("");
        setName("");
      }
    });

  const changeRole = (userId: string, nextRole: string) =>
    startTransition(async () => {
      setError(null);
      const res = await updateMemberAction({ userId, role: nextRole }, orgId);
      if (res.error) setError(res.error);
    });

  /** Assign a CRM role (0039). Sent alone, so the legacy `role` above is untouched. */
  const changeCrmRole = (userId: string, nextRoleId: string) =>
    startTransition(async () => {
      setError(null);
      const res = await updateMemberAction(
        { userId, roleId: nextRoleId === "" ? null : nextRoleId },
        orgId,
      );
      if (res.error) setError(res.error);
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
      setWsError(null);
      const res = await createWorkspaceAction(wsName.trim(), orgId);
      if (res.error) setWsError(res.error);
      else setWsName("");
    });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Members */}
      <div className="lg:col-span-2 space-y-6">
        <Card elevated className="overflow-hidden p-0">
          <div className="p-5 border-b-2 border-black flex items-center gap-2">
            <Users className="h-4 w-4" />
            <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
              Members
            </h4>
          </div>
          {members.length === 0 ? (
            <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-10 text-center">
              No members yet
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left border-collapse">
                <thead>
                  <tr className="bg-neutral-100 border-b-2 border-black font-mono text-[10px] text-black font-bold uppercase tracking-wider">
                    <th className="py-3.5 px-5">Member</th>
                    <th className="py-3.5 px-4">Role</th>
                    <th className="py-3.5 px-4">CRM Role</th>
                    <th className="py-3.5 px-4">Permissions</th>
                    <th className="py-3.5 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y-2 divide-neutral-100 text-sm">
                  {members.map((m) => (
                    <tr key={m.userId} className="hover:bg-neutral-50">
                      <td className="py-4 px-5">
                        <span className="font-display font-bold text-black block">
                          {m.name ?? "Unnamed"}
                        </span>
                        <span className="text-[10px] font-mono text-neutral-400">{m.email}</span>
                      </td>
                      <td className="py-4 px-4">
                        <div className="flex flex-col gap-1.5 items-start">
                          <StatusChip tone={roleTone(m.role)}>{m.role}</StatusChip>
                          <select
                            className="text-[10px] font-mono font-bold uppercase border border-black bg-white px-1 py-0.5 rounded-none focus:outline-none"
                            value={m.role}
                            disabled={pending}
                            onChange={(e) => changeRole(m.userId, e.target.value)}
                          >
                            {ROLES.map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        </div>
                      </td>
                      <td className="py-4 px-4">
                        {/* Which permission grid this member is enforced against
                            on the CRM routes. Separate from the column beside it:
                            that one is the legacy tenant role every other guard
                            still reads, and changing one must not change the
                            other. */}
                        <select
                          className="text-[10px] font-mono font-bold uppercase border border-black bg-white px-1 py-0.5 rounded-none focus:outline-none"
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
                        </select>
                      </td>
                      <td className="py-4 px-4">
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => togglePerm(m, "recordingsListen")}
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
                            title="Toggle export permission"
                          >
                            <StatusChip tone={m.recordingsExport ? "solid" : "outline"}>
                              export
                            </StatusChip>
                          </button>
                        </div>
                      </td>
                      <td className="py-4 px-4 text-right">
                        <button
                          onClick={() => void remove(m.userId)}
                          disabled={pending}
                          className="p-1.5 text-black hover:text-white hover:bg-black rounded-none border border-transparent hover:border-black disabled:opacity-40"
                          aria-label="Remove member"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Add member */}
        <Card elevated className="space-y-4">
          <div className="flex items-center gap-2">
            <UserPlus className="h-4 w-4" />
            <h4 className="text-lg font-display font-black text-black uppercase tracking-tight">
              Add Member
            </h4>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
                Email
              </label>
              <input
                className={inputClass}
                placeholder="person@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
                Name
              </label>
              <input
                className={inputClass}
                placeholder="Full name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
                Role
              </label>
              <select className={selectClass} value={role} onChange={(e) => setRole(e.target.value)}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-end gap-4 pb-1">
              <label className="flex items-center gap-2 text-xs font-mono font-bold uppercase cursor-pointer">
                <input
                  type="checkbox"
                  className="h-4 w-4 border-2 border-black rounded-none"
                  checked={listen}
                  onChange={(e) => setListen(e.target.checked)}
                />
                Listen
              </label>
              <label className="flex items-center gap-2 text-xs font-mono font-bold uppercase cursor-pointer">
                <input
                  type="checkbox"
                  className="h-4 w-4 border-2 border-black rounded-none"
                  checked={exportPerm}
                  onChange={(e) => setExportPerm(e.target.checked)}
                />
                Export
              </label>
            </div>
          </div>

          <div className="flex items-center justify-end">
            <BrutalButton
              shadow
              disabled={pending || !email.trim()}
              onClick={addMember}
            >
              <Plus className="h-4 w-4" />
              {pending ? "SAVING…" : "ADD MEMBER"}
            </BrutalButton>
          </div>

          {error ? (
            <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
              {error}
            </p>
          ) : null}
        </Card>
      </div>

      {/* Workspaces */}
      <div className="space-y-6">
        <Card elevated className="space-y-4">
          <MonoLabel>Workspaces</MonoLabel>
          <div className="space-y-3">
            {workspaces.length === 0 ? (
              <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-6 text-center">
                No workspaces yet
              </p>
            ) : (
              workspaces.map((w) => (
                <div
                  key={w.id}
                  className="p-3.5 rounded-none border-2 border-neutral-200 bg-white"
                >
                  <span className="font-display font-black text-black text-sm block uppercase tracking-tight">
                    {w.name}
                  </span>
                  <span className="text-[10px] font-mono text-neutral-400 font-bold">
                    {w.id.slice(0, 8)} · <LocalTime iso={w.created_at} mode="date" />
                  </span>
                </div>
              ))
            )}
          </div>

          <div className="space-y-2 border-t-2 border-neutral-200 pt-4">
            <label className="text-xs font-mono text-black uppercase tracking-wider font-bold block">
              New Workspace
            </label>
            <input
              className={inputClass}
              placeholder="e.g. West Coast Sales"
              value={wsName}
              onChange={(e) => setWsName(e.target.value)}
            />
            <BrutalButton
              variant="secondary"
              className="w-full"
              disabled={pending || !wsName.trim()}
              onClick={createWorkspace}
            >
              <Plus className="h-4 w-4" />
              {pending ? "CREATING…" : "CREATE WORKSPACE"}
            </BrutalButton>
            {wsError ? (
              <p className="text-xs text-red-700 font-sans font-bold border-2 border-red-600 bg-red-50 p-3">
                {wsError}
              </p>
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  );
}
