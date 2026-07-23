import type { CrmProviderSpec } from "@aura/shared";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { apiGet, DEV_WORKSPACE_ID } from "@/lib/server-api";
import { CrmManager } from "./crm-manager";
import type { Integration } from "./integration-card";

export default async function CrmPage() {
  // The catalogue comes from the API rather than being imported directly, so
  // the console can only offer providers the running API will actually accept.
  const [data, catalogue] = await Promise.all([
    apiGet<{ integrations: Integration[] }>("/v1/crm/integrations"),
    apiGet<{ providers: CrmProviderSpec[]; sourcePaths: Array<{ path: string; label: string }> }>(
      "/v1/crm/providers",
    ),
  ]);

  return (
    <>
      <PageHeader title="CRM Integrations" />

      {data === null || catalogue === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="text-sm text-neutral-600 mt-2 font-sans">
            Could not reach the API — start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : (
        <CrmManager
          integrations={data.integrations}
          providers={catalogue.providers}
          sourcePaths={catalogue.sourcePaths}
          defaultWorkspaceId={DEV_WORKSPACE_ID}
        />
      )}
    </>
  );
}
