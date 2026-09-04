import Link from "next/link";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { operatorGate } from "@/lib/operator-gate";
import { apiGetAs } from "@/lib/server-api";
import { resolveTenantScope } from "@/lib/tenant-scope";
import { ApiKeysManager, type ApiKey } from "./api-keys-manager";

export default async function ApiKeysPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { org } = await searchParams;
  const { tenants, orgId } = await resolveTenantScope(org);

  const data = await apiGetAs<{ keys: ApiKey[] }>("/v1/apikeys", orgId);

  return (
    <>
      <PageHeader title="API Keys" />

      {/* Public reference for whoever this key is handed to - it needs no
          console login, so it's linked out rather than embedded. */}
      <Link
        href="/docs/api"
        target="_blank"
        rel="noopener noreferrer"
        className="-mt-3 inline-block text-xs font-medium text-accent-text hover:underline"
      >
        View developer docs ↗
      </Link>

      <TenantSwitcher tenants={tenants} activeOrgId={orgId} basePath="/api-keys" />

      {data === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            Could not reach the API - start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : (
        <ApiKeysManager keys={data.keys} orgId={orgId} />
      )}
    </>
  );
}
