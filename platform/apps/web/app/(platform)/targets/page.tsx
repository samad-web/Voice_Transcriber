import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { operatorGate } from "@/lib/operator-gate";
import { apiGetAs } from "@/lib/server-api";
import { resolveTenantScope } from "@/lib/tenant-scope";
import { TargetsManager, type AttainmentRow, type TeamMember } from "./targets-manager";
import type { SalesTarget } from "./actions";

export const metadata: Metadata = { title: "Targets — Aura" };

/**
 * Sales targets (PRD Layer 5, migration 0050).
 *
 * The reports page answers "what happened". This is where somebody says what
 * was supposed to happen — without it, every figure on that page is
 * uncalibrated: 400,000 closed is excellent or alarming depending entirely on
 * what the quarter was for.
 *
 * Same tenant-scoping shape as /custom-fields, /roles and /automations.
 */
export default async function TargetsPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const { org } = await searchParams;
  const { tenants, orgId, activeTenant } = await resolveTenantScope(org);

  // `?all=1` — the management view is every target, not just the period that
  // happens to cover today. A quarter set last week for next quarter would
  // otherwise be invisible on the screen that created it.
  const [targets, members, attainment] = await Promise.all([
    apiGetAs<{ targets: SalesTarget[] }>("/v1/targets?all=1", orgId),
    apiGetAs<{ members: TeamMember[] }>("/v1/members", orgId),
    apiGetAs<{ attainment: AttainmentRow[] }>("/v1/targets/attainment", orgId),
  ]);

  return (
    <>
      <PageHeader title="Targets" context={activeTenant?.name ?? "Workspace"} />

      <TenantSwitcher tenants={tenants} activeOrgId={orgId} basePath="/targets" />

      {targets === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            Could not reach the API — start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : (
        <TargetsManager
          orgId={orgId}
          targets={targets.targets}
          members={members?.members ?? []}
          attainment={attainment?.attainment ?? []}
        />
      )}
    </>
  );
}
