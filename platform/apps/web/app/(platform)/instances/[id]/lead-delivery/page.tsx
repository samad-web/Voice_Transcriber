import { Card, EmptyState, MonoLabel } from "@aura/ui";
import { Plug } from "lucide-react";
import { operatorGate } from "@/lib/operator-gate";
import { CrmManager } from "../crm-manager";
import { loadCrm, loadInstances, loadOrg } from "../instance-data";

/**
 * Where this customer's calls are pushed - their outbound CRM and automation
 * connectors.
 *
 * ── THIS REPLACES A TOP-LEVEL PAGE ──────────────────────────────────────────
 *
 * There used to be TWO of this screen. `(platform)/crm/page.tsx` was a
 * `resolveTenantScope` + `<TenantSwitcher>` wrapper around the same
 * `<CrmManager>`, and the instance page's "Lead delivery" tab was the other -
 * importing that manager across folders from `../../crm/crm-manager`. Doc 34
 * Part B deleted the top-level page and moved the component here, because the
 * duplicate was the accident: a connector row carries an `org_id`, so there was
 * never a platform-wide version of this page to be had.
 *
 * The top-level one also had a real failure mode. Its sibling `actions.ts` wrote
 * against whichever org `DEV_ORG_ID` named rather than the one on screen, so for
 * every customer but the first it could configure the wrong tenant.
 */
export default async function InstanceLeadDeliveryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { id: orgId } = await params;
  const [org, instances, crm] = await Promise.all([
    loadOrg(orgId),
    loadInstances(orgId),
    loadCrm(orgId),
  ]);

  // The catalogue comes from the API rather than being imported directly, so a
  // provider added server-side needs no web deploy to appear here.
  if (!crm.catalogue) {
    return (
      <Card>
        <MonoLabel>Catalogue unavailable</MonoLabel>
        <p className="mt-2 text-sm text-text-muted">
          The platform API did not answer with the connector catalogue, so nothing can be configured
          here right now. Existing connectors are unaffected.
        </p>
      </Card>
    );
  }

  if (instances.length === 0) {
    return (
      <EmptyState
        icon={<Plug className="h-8 w-8" />}
        title="No instance to deliver from"
        description="Lead delivery is configured per instance, and this tenant has none. Reprovision the customer to create one."
      />
    );
  }

  return (
    <>
      <p className="text-sm text-text-muted">
        Where this customer&apos;s calls are pushed. Scoped to {org.name} - nothing here affects
        another tenant.
      </p>
      <CrmManager
        integrations={crm.integrations}
        providers={crm.catalogue.providers}
        sourcePaths={crm.catalogue.sourcePaths}
        workspaces={crm.workspaces}
        orgId={orgId}
      />
    </>
  );
}
