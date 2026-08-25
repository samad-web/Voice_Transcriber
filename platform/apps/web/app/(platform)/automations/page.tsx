import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { operatorGate } from "@/lib/operator-gate";
import { apiGetAs } from "@/lib/server-api";
import { resolveTenantScope } from "@/lib/tenant-scope";
import { AutomationsManager } from "./automations-manager";
import type { AutomationRule, AutomationRun } from "./actions";

export const metadata: Metadata = { title: "Automations — Aura" };

/**
 * Workflow automation (PRD Layer 2). Same tenant-scoping shape as
 * /custom-fields and /roles: one tenant at a time, explicit and switchable,
 * never the silent DEV_ORG_ID default.
 *
 * The run log is loaded alongside the rules rather than behind a tab. "Why
 * didn't my rule fire?" is the first question anybody asks of an automation
 * system, and putting the answer one click away is how it goes unread.
 */
export default async function AutomationsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { org } = await searchParams;
  const { tenants, orgId, activeTenant } = await resolveTenantScope(org);

  const [rules, runs] = await Promise.all([
    apiGetAs<{ rules: AutomationRule[]; triggers: string[]; sweepTriggers: string[] }>(
      "/v1/automations",
      orgId,
    ),
    apiGetAs<{ runs: AutomationRun[] }>("/v1/automations/runs?limit=30", orgId),
  ]);

  return (
    <>
      <PageHeader title="Automations" context={activeTenant?.name ?? "Workspace"} />

      <TenantSwitcher tenants={tenants} activeOrgId={orgId} basePath="/automations" />

      {rules === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            Could not reach the API — start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : (
        <AutomationsManager
          orgId={orgId}
          rules={rules.rules}
          triggers={rules.triggers}
          sweepTriggers={rules.sweepTriggers}
          runs={runs?.runs ?? []}
        />
      )}
    </>
  );
}
