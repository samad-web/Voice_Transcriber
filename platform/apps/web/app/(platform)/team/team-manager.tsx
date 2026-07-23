"use client";

import { useState, useTransition } from "react";
import { Plus, Trash2, UserPlus, Users } from "lucide-react";
import { BrutalButton, Card, MonoLabel, StatusChip } from "@aura/ui";
import { LocalTime } from "@/components/local-time";
import {
  addMemberAction,
  createWorkspaceAction,
  removeMemberAction,
  updateMemberAction,
} from "./actions";
import { inputClass, selectClass } from "@/lib/form";

export interface Member {
  userId: string;
  email: string;
  name: string | null;
  role: string;
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

const ROLES = ["owner", "admin", "manager", "analyst", "viewer"] as const;

function roleTone(role: string): "solid" | "muted" | "outline" {
  if (role === "owner" || role === "admin") return "solid";
  if (role === "viewer") return "outline";
  return "muted";
}

export function TeamManager({
  members,
  workspaces,
}: {
  members: Member[];
  workspaces: Workspace[];
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<string>("analyst");
  const [listen, setListen] = useState(true);
  const [exportPerm, setExportPerm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wsName, setWsName] = useState("");
  const [wsError, setWsError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const addMember = () =>
    startTransition(async () => {
      setError(null);
      const res = await addMemberAction({
        email: email.trim(),
        name: name.trim(),
        role,
        recordingsListen: listen,
        recordingsExport: exportPerm,
      });
      if (res.error) setError(res.error);
      else {
        setEmail("");
        setName("");
      }
    });

  const changeRole = (userId: string, nextRole: string) =>
    startTransition(() => updateMemberAction({ userId, role: nextRole }).then(() => undefined));

  const togglePerm = (m: Member, key: "recordingsListen" | "recordingsExport") =>
    startTransition(() =>
      updateMemberAction({ userId: m.userId, [key]: !m[key] }).then(() => undefined),
    );

  const remove = (userId: string) =>
    startTransition(async () => {
      if (!window.confirm("Remove this member from the workspace?")) return;
      await removeMemberAction(userId);
    });

  const createWorkspace = () =>
    startTransition(async () => {
      setWsError(null);
      const res = await createWorkspaceAction(wsName.trim());
      if (res.error) setWsError(res.error);
      else setWsName("");
    });

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      {/* Members */}
      <div className="lg:col-span-2 space-y-6">
        <Card shadow className="overflow-hidden p-0">
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
                          onClick={() => remove(m.userId)}
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
        <Card shadow className="space-y-4">
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
        <Card shadow className="space-y-4">
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
