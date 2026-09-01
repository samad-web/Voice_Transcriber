import type { OrgModule } from "@aura/shared";

/**
 * Whether the tenant on this connection is entitled to a product module
 * (migration 0072's `organizations.enabled_modules`, catalogue in
 * packages/shared/src/org-modules.ts).
 *
 * Takes the `withOrg` client rather than an org id on purpose: RLS has already
 * narrowed `organizations` to the one row this request may see, so there is no
 * org predicate here to get wrong, and no way to ask the question about a
 * tenant other than the one the request is scoped to.
 *
 * NOT A GUARD, and it could not be one. CrmPermissionsGuard reads the same
 * column, but it does so while deciding whether a request may proceed at all.
 * A module gate is often finer than that: `GET /leads` widens its SELECT when
 * `call_intel` is on and answers normally when it is off, and the call detail
 * route refuses outright. One helper, called where each route actually makes
 * its own decision, keeps the entitlement in one place without pretending
 * every route wants the same verdict.
 */
export async function orgHasModule(
  client: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  },
  module: OrgModule,
): Promise<boolean> {
  const {
    rows: [org],
  } = await client.query("SELECT $1 = ANY(enabled_modules) AS enabled FROM organizations LIMIT 1", [
    module,
  ]);
  return org?.enabled === true;
}
