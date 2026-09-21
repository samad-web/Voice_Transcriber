import type { Metadata } from "next";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { operatorGate } from "@/lib/operator-gate";
import { apiGetAs, apiTry } from "@/lib/server-api";
import { resolveTenantScope } from "@/lib/tenant-scope";
import { TargetsManager, type AttainmentRow, type TeamMember } from "./targets-manager";
import type { SalesTarget } from "./actions";

export const metadata: Metadata = { title: "Targets - Aura" };

/**
 * Sales targets (PRD Layer 5, migration 0050).
 *
 * The reports page answers "what happened". This is where somebody says what
 * was supposed to happen - without it, every figure on that page is
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

  // `?all=1` - the management view is every target, not just the period that
  // happens to cover today. A quarter set last week for next quarter would
  // otherwise be invisible on the screen that created it.
  //
  // `apiTry` for the gating call, not `apiGetAs`: this page's failure is almost
  // never the API being down. See LoadError below.
  const [targets, members, attainment] = await Promise.all([
    apiTry<{ targets: SalesTarget[] }>("/v1/targets?all=1", orgId),
    apiGetAs<{ members: TeamMember[] }>("/v1/members", orgId),
    apiGetAs<{ attainment: AttainmentRow[] }>("/v1/targets/attainment", orgId),
  ]);

  return (
    <>
      <PageHeader title="Targets" context={activeTenant?.name ?? "Workspace"} />

      <TenantSwitcher tenants={tenants} activeOrgId={orgId} basePath="/targets" />

      {!targets.ok ? (
        <>
          <LoadFailure what="targets" failure={targets} />
          {/* LoadFailure's `forbidden` remedy is written for the customer
              console - "ask an owner of this workspace" - and on THIS page that
              is the wrong advice given to the wrong person: the operator IS the
              provider, and the 403 is structural rather than something anyone
              can grant. The diagnosis is the whole value of the fix, so it is
              said here rather than pushed into a shared component that has no
              business knowing which console it is rendering in. */}
          {targets.kind === "forbidden" ? (
            <p className="max-w-prose text-sm leading-relaxed text-text-muted">
              Nobody can grant this from here. Targets are gated on the CRM permission grid, which
              resolves the caller through a membership in the client&apos;s own org - and a platform
              operator deliberately holds none, which is what makes them an operator. Until this page
              gets an operator-only route of its own, set a client&apos;s targets from their console.
            </p>
          ) : null}
        </>
      ) : (
        <TargetsManager
          orgId={orgId}
          targets={targets.data.targets}
          members={members?.members ?? []}
          attainment={attainment?.attainment ?? []}
        />
      )}
    </>
  );
}
