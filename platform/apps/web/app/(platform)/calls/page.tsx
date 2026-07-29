import { Phone } from "lucide-react";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { Pager, PAGE_SIZE } from "@/components/pager";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { apiGetAs } from "@/lib/server-api";
import { resolveTenantScope } from "@/lib/tenant-scope";
import { CallsExplorer, type CallRow } from "./calls-explorer";

/**
 * Cross-tenant call log. Calls are readable only under one org context at a
 * time (RLS), so the page reads the tenant named in `?org=` and falls back to
 * the environment's dev org — with a switcher, so the operator can tell which
 * customer these calls belong to instead of assuming they are all of them.
 */
export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string; page?: string }>;
}) {
  const { org, page } = await searchParams;
  const { tenants, orgId, activeTenant } = await resolveTenantScope(org);

  const pageNo = Math.max(1, Number(page) || 1);
  const offset = (pageNo - 1) * PAGE_SIZE;

  const data = await apiGetAs<{ calls: CallRow[]; total: number }>(
    `/v1/calls?limit=${PAGE_SIZE}&offset=${offset}`,
    orgId,
  );

  return (
    <>
      <PageHeader title="Call Log Explorer" />

      <TenantSwitcher tenants={tenants} activeOrgId={orgId} basePath="/calls" />

      {data === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="text-sm text-neutral-600 mt-2 font-sans">
            Could not reach the API — start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : data.calls.length === 0 ? (
        <Card className="flex flex-col items-center py-12 gap-3">
          <Phone className="h-8 w-8 text-neutral-300" />
          <p className="text-xs font-mono font-bold uppercase text-neutral-400">
            {activeTenant
              ? `No calls ingested for ${activeTenant.name} yet`
              : "No calls ingested yet — enroll a device and record the first call"}
          </p>
        </Card>
      ) : (
        <>
          <Pager
            total={data.total}
            page={pageNo}
            hrefFor={(p) => `/calls?org=${orgId}${p > 1 ? `&page=${p}` : ""}`}
          />
          <Card className="overflow-hidden p-0">
            <CallsExplorer calls={data.calls} orgId={orgId} showInstance />
          </Card>
        </>
      )}
    </>
  );
}
