import { PageHeader } from "@/components/page-header";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { operatorGate } from "@/lib/operator-gate";
import { resolveTenantScope } from "@/lib/tenant-scope";
import { SearchExplorer } from "./search-explorer";

/**
 * Gated like every other direct-fetching page in this group, which this one was
 * not. It looked exempt: the actual searching goes through a guarded Server
 * Action, so the page body has no `apiGetAs` call. But `resolveTenantScope`
 * reads `/v1/admin/tenants` - every customer on the platform, on the root admin
 * key - and it does so on the RENDER path, which is precisely the race
 * `platform-pages.guard.test.ts`'s header describes: Next renders a layout and
 * its page in one pass, so `(platform)/layout.tsx`'s `isOperator()` is not
 * guaranteed to have resolved before this fetch goes out. A signed-in
 * non-operator could therefore be served the tenant roster.
 *
 * Found by widening that suite's DIRECT_API_CALL to recognise
 * `resolveTenantScope`, which it had never matched.
 */
export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { org } = await searchParams;
  const { tenants, orgId, activeTenant } = await resolveTenantScope(org);

  return (
    <>
      <PageHeader title="Transcript Search" />
      <TenantSwitcher tenants={tenants} activeOrgId={orgId} basePath="/search" />
      <SearchExplorer orgId={orgId} tenantName={activeTenant?.name} />
    </>
  );
}
