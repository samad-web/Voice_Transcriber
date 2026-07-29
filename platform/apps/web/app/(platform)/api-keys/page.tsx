import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { apiGetAs } from "@/lib/server-api";
import { resolveTenantScope } from "@/lib/tenant-scope";
import { ApiKeysManager, type ApiKey } from "./api-keys-manager";

export default async function ApiKeysPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const { org } = await searchParams;
  const { tenants, orgId } = await resolveTenantScope(org);

  const data = await apiGetAs<{ keys: ApiKey[] }>("/v1/apikeys", orgId);

  return (
    <>
      <PageHeader title="API Keys" />

      <TenantSwitcher tenants={tenants} activeOrgId={orgId} basePath="/api-keys" />

      {data === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="text-sm text-neutral-600 mt-2 font-sans">
            Could not reach the API — start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : (
        <ApiKeysManager keys={data.keys} orgId={orgId} />
      )}
    </>
  );
}
