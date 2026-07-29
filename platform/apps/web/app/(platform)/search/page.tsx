import { PageHeader } from "@/components/page-header";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { resolveTenantScope } from "@/lib/tenant-scope";
import { SearchExplorer } from "./search-explorer";

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
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
