import { LoadFailure } from "@/components/load-failure";
import { apiGetAs, apiTry } from "@/lib/server-api";
import { TeamManager, type CrmRole, type Member, type Workspace } from "./team-manager";

/**
 * Who works for this client, and what each of them may do.
 *
 * Three reads because the table needs three things: the people, the roles they
 * can be assigned, and the workspaces they can be filed under. They are fetched
 * together rather than in the page so this tab pays for them only when it is
 * the tab being looked at.
 *
 * ── ONE READ IS LOAD-BEARING, TWO DEGRADE ─────────────────────────────────
 *
 * Only `members` goes through `apiTry`, because it is the only one whose failure
 * means this tab cannot be drawn. A client with no workspaces and no roles yet is
 * an ordinary new tenant, and an empty picker is the truthful rendering of that -
 * so those two stay on `apiGetAs`, whose `null` collapses "none yet" and "read
 * failed" into the same empty list on purpose.
 *
 * This replaced a `members === null && workspaces === null` condition, which
 * needed BOTH to fail before it would admit anything was wrong: a members read
 * that 403'd while workspaces succeeded rendered a confident, empty team.
 *
 * ── THE TWO ROLE COLUMNS ARE NOT THE SAME COLUMN ──────────────────────────
 *
 * `memberships.role` (the tenant tier - org_admin and friends) and
 * `memberships.role_id` (a row in `roles`, the permission grid) are independent
 * axes and the table renders both. Conflating them is the mistake this console
 * has made before; see the note on the CRM Role cell in team-manager.tsx and
 * the grid's own header in apps/api/src/common/crm-permissions.guard.ts.
 */
export async function TeamTab({ orgId }: { orgId: string }) {
  const [members, workspaces, roles] = await Promise.all([
    apiTry<{ members: Member[] }>("/v1/members", orgId),
    apiGetAs<{ workspaces: Workspace[] }>("/v1/workspaces", orgId),
    apiGetAs<{ roles: CrmRole[] }>("/v1/roles", orgId),
  ]);

  if (!members.ok) return <LoadFailure what="this client's team" failure={members} />;

  return (
    <TeamManager
      members={members.data.members}
      workspaces={workspaces?.workspaces ?? []}
      roles={roles?.roles ?? []}
      orgId={orgId}
    />
  );
}
