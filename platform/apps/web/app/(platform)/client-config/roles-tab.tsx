import { LoadFailure } from "@/components/load-failure";
import { apiTry } from "@/lib/server-api";
import { RolesManager } from "./roles-manager";
import type { Role } from "./roles-types";

/**
 * This client's roles, and what each one may do with a record.
 *
 * A role is per-client: `roles.org_id` is on every row, the system roles are
 * seeded per tenant when the CRM module is switched on, and a client may define
 * their own beside them. That is why this is a tab here and not a platform page
 * - there is no such thing as "the platform's roles" to edit.
 *
 * Both halves of the grid are live: the checkboxes are enforced by
 * `CrmPermissionsGuard` and the "Which records" column by a predicate on every
 * query (apps/api/src/common/crm-scope.ts). Much of the grid is nonetheless
 * inert because no route stands behind that cell yet - `ENFORCED_PERMISSIONS`
 * in packages/shared/src/permissions.ts is the machine-checked inventory of
 * which cells mean anything, and it is generated, never hand-maintained.
 */
export async function RolesTab({ orgId }: { orgId: string }) {
  const data = await apiTry<{ roles: Role[] }>("/v1/roles", orgId);

  if (!data.ok) return <LoadFailure what="this client's roles" failure={data} />;

  return (
    <>
      <p className="max-w-prose text-sm leading-relaxed text-text-muted">
        A role decides what somebody may do with a record they can already see.{" "}
        <strong className="font-medium text-text">Which</strong> records they see is their role on
        the Team tab - both have to allow it, and a narrower role never widens what the team role
        permits.
      </p>

      <RolesManager roles={data.data.roles} orgId={orgId} />
    </>
  );
}
