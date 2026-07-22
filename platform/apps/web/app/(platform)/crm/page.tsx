import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { apiGet, DEV_WORKSPACE_ID } from "@/lib/server-api";
import { CrmManager, type Integration } from "./crm-manager";

export default async function CrmPage() {
  const data = await apiGet<{ integrations: Integration[] }>("/v1/crm/integrations");

  return (
    <>
      <PageHeader title="CRM Integrations" />

      {data === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="text-sm text-neutral-600 mt-2 font-sans">
            Could not reach the API — start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : (
        <CrmManager integrations={data.integrations} defaultWorkspaceId={DEV_WORKSPACE_ID} />
      )}
    </>
  );
}
