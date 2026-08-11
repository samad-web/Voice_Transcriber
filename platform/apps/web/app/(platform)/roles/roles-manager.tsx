"use client";

import { useState, useTransition } from "react";
import { Button, Card, FormField, Input, MonoLabel, StatusChip } from "@aura/ui";
import {
  createRoleAction,
  fetchRolePermissionsAction,
  saveRolePermissionsAction,
} from "./actions";
import {
  PERMISSION_ACTIONS,
  PERMISSION_OBJECT_TYPES,
  type PermissionAction,
  type PermissionObjectType,
  type Role,
} from "./types";

/** "objectType:action" — the grid's addressing scheme, and the shape of the Set below. */
type GrantKey = `${PermissionObjectType}:${PermissionAction}`;
const grantKey = (o: PermissionObjectType, a: PermissionAction): GrantKey => `${o}:${a}`;

/**
 * Define custom roles and edit ANY role's permission grid — including a
 * system role's, which is the point: an operator adjusting what "Viewer"
 * can see is normal, renaming or archiving the row itself is not (roles.
 * controller.ts rejects that). Nothing here is enforced yet (E0.4, schema-
 * only phase) — see roles.controller.ts's header.
 */
export function RolesManager({ roles, orgId }: { roles: Role[]; orgId: string }) {
  const [selected, setSelected] = useState<Role | null>(null);
  const [granted, setGranted] = useState<Set<GrantKey>>(new Set());
  const [loadingGrid, setLoadingGrid] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const selectRole = (role: Role) => {
    setSelected(role);
    setSaved(false);
    setError(null);
    setLoadingGrid(true);
    startTransition(async () => {
      const result = await fetchRolePermissionsAction(role.id, orgId);
      setLoadingGrid(false);
      if (result.error) {
        setError(result.error);
        return;
      }
      setGranted(new Set((result.grants ?? []).map((g) => grantKey(g.object_type, g.action))));
    });
  };

  const toggle = (o: PermissionObjectType, a: PermissionAction) => {
    setSaved(false);
    setGranted((prev) => {
      const next = new Set(prev);
      const key = grantKey(o, a);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const savePermissions = () => {
    if (!selected) return;
    setError(null);
    startTransition(async () => {
      const grants = Array.from(granted).map((key) => {
        const [objectType, action] = key.split(":") as [PermissionObjectType, PermissionAction];
        return { objectType, action, scope: "all" as const, fieldRestrictions: {} };
      });
      const result = await saveRolePermissionsAction(selected.id, grants, orgId);
      if (result.error) {
        setError(result.error);
        return;
      }
      setSaved(true);
    });
  };

  const createRole = () => {
    setError(null);
    if (!/^[a-z][a-z0-9_]*$/.test(newKey)) {
      setError('Key must be snake_case, starting with a letter (e.g. "sales_rep")');
      return;
    }
    if (!newName.trim()) {
      setError("Name is required");
      return;
    }
    startTransition(async () => {
      const result = await createRoleAction({ key: newKey, name: newName, orgId });
      if (result.error) {
        setError(result.error);
        return;
      }
      setNewKey("");
      setNewName("");
    });
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[20rem_1fr]">
      <div className="space-y-4">
        <Card>
          <MonoLabel>New custom role</MonoLabel>
          <div className="mt-3 space-y-3">
            <FormField label="Key" name="role-key" hint="snake_case, e.g. sales_rep">
              <Input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="sales_rep" />
            </FormField>
            <FormField label="Name" name="role-name">
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Sales Rep" />
            </FormField>
            <Button type="button" size="sm" onClick={createRole} loading={pending}>
              Add role
            </Button>
          </div>
        </Card>

        <Card>
          <MonoLabel>Roles</MonoLabel>
          <div className="mt-3 divide-y divide-border rounded-md border border-border">
            {roles.map((role) => (
              <button
                key={role.id}
                type="button"
                onClick={() => selectRole(role)}
                aria-pressed={selected?.id === role.id}
                className={`flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors duration-150 ease-out hover:bg-surface-hover ${
                  selected?.id === role.id ? "bg-accent-subtle" : ""
                }`}
              >
                <div className="min-w-0">
                  <span className="block truncate font-medium text-text">{role.name}</span>
                  <span className="text-xs text-text-muted">{role.key}</span>
                </div>
                {role.is_system ? <StatusChip tone="outline">system</StatusChip> : null}
              </button>
            ))}
          </div>
        </Card>
      </div>

      <Card>
        {!selected ? (
          <p className="text-sm text-text-muted">Pick a role to edit what it can do.</p>
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <div>
                <MonoLabel>{selected.name}</MonoLabel>
                {selected.is_system ? (
                  <p className="mt-1 text-xs text-text-muted">
                    A system role — its permissions can be edited, but not its name or key.
                  </p>
                ) : null}
              </div>
            </div>

            {loadingGrid ? (
              <p className="mt-4 text-sm text-text-muted">Loading…</p>
            ) : (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full min-w-[480px] border-collapse text-left text-sm">
                  <thead>
                    <tr>
                      <th className="border-b border-border px-3 py-2 text-xs font-medium text-text-muted">
                        Object
                      </th>
                      {PERMISSION_ACTIONS.map((action) => (
                        <th
                          key={action}
                          className="border-b border-border px-3 py-2 text-center text-xs font-medium text-text-muted"
                        >
                          {action}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {PERMISSION_OBJECT_TYPES.map((objectType) => (
                      <tr key={objectType}>
                        <td className="px-3 py-2 font-medium text-text capitalize">{objectType}</td>
                        {PERMISSION_ACTIONS.map((action) => (
                          <td key={action} className="px-3 py-2 text-center">
                            <input
                              type="checkbox"
                              aria-label={`${action} ${objectType}`}
                              checked={granted.has(grantKey(objectType, action))}
                              onChange={() => toggle(objectType, action)}
                              className="h-4 w-4 cursor-pointer rounded-sm accent-accent"
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {error ? (
              <p
                role="alert"
                className="mt-3 rounded-md border border-danger bg-danger-subtle p-2 text-xs font-medium text-danger-text"
              >
                {error}
              </p>
            ) : null}

            <div className="mt-4 flex items-center gap-3">
              <Button type="button" onClick={savePermissions} loading={pending} disabled={loadingGrid}>
                Save permissions
              </Button>
              {saved && !pending ? (
                <span role="status" className="text-xs text-text-muted">
                  Saved
                </span>
              ) : null}
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
