import { apiGetAdmin, apiGetAs, DEV_ORG_ID } from "@/lib/server-api";

export interface TenantOption {
  id: string;
  name: string;
}

export interface WorkspaceOption {
  id: string;
  name: string;
}

/**
 * Which tenant a switcher-backed page should read. Honours `?org=` only when it
 * names a real tenant, so a stale or hand-edited link cannot point the page at
 * an arbitrary uuid. Falls back to the environment's dev org — not simply the
 * first row, which is the newest tenant and would move the default view every
 * time a customer is onboarded.
 */
export function resolveOrgId(
  tenants: TenantOption[],
  requested: string | undefined,
  fallback: string,
): string {
  if (requested && tenants.some((t) => t.id === requested)) return requested;
  if (tenants.some((t) => t.id === fallback)) return fallback;
  return tenants[0]?.id ?? fallback;
}

export interface TenantScope {
  tenants: TenantOption[];
  orgId: string;
  activeTenant?: TenantOption;
}

/**
 * The tenant context for an org-scoped operator page.
 *
 * Every page under `(platform)` reads one tenant at a time because RLS is
 * per-org. Left implicit, that produced the console's worst class of bug: the
 * page silently rendered whichever org `DEV_ORG_ID` named and looked like it
 * was showing the whole platform. Resolving the scope explicitly — and
 * rendering a `<TenantSwitcher>` from it — makes the answer to "whose data is
 * this?" visible on the page and changeable from the URL.
 */
export async function resolveTenantScope(requested?: string): Promise<TenantScope> {
  const list = await apiGetAdmin<{ tenants: TenantOption[] }>("/v1/admin/tenants");
  const tenants = list?.tenants ?? [];
  const orgId = resolveOrgId(tenants, requested, DEV_ORG_ID);
  return { tenants, orgId, activeTenant: tenants.find((t) => t.id === orgId) };
}

/**
 * The tenant's workspaces, for the pages that must write into one (agents, CRM
 * connectors). These used to be created against the environment's
 * `DEV_WORKSPACE_ID`, which for any tenant but the first meant the row landed
 * in a workspace belonging to a different customer.
 */
export async function workspacesFor(orgId: string): Promise<WorkspaceOption[]> {
  const data = await apiGetAs<{ workspaces: WorkspaceOption[] }>("/v1/workspaces", orgId);
  return data?.workspaces ?? [];
}
