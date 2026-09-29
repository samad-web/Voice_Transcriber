import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import type { CustomFieldDefinition } from "@/app/(owner)/owner/types";
import { operatorGate } from "@/lib/operator-gate";
import { apiGetAs } from "@/lib/server-api";
import { loadOrg } from "../instance-data";
import { CustomFieldsManager } from "./custom-fields-manager";

export const metadata: Metadata = { title: "Custom Fields - Aura" };

/**
 * Org-definable fields on Contact/Account/Deal - CRM Phase 1, E0.2. Same
 * tenant-scoping shape as (platform)/crm/page.tsx: one tenant at a time,
 * explicit and switchable via `?org=`, never the silent DEV_ORG_ID default.
 */
export default async function CustomFieldsPage({ params }: { params: Promise<{ id: string }> }) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { id: orgId } = await params;
  const org = await loadOrg(orgId);

  const data = await apiGetAs<{ fields: CustomFieldDefinition[] }>(
    "/v1/custom-field-definitions",
    orgId,
  );

  return (
    <>
      <PageHeader title="Custom Fields" context={org.name} />


      {data === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            Could not reach the API - start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : (
        <CustomFieldsManager fields={data.fields} orgId={orgId} />
      )}
    </>
  );
}
