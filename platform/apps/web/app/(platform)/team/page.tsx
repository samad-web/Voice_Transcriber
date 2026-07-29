import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { TenantSwitcher } from "@/components/tenant-switcher";
import { apiGetAs } from "@/lib/server-api";
import { resolveTenantScope } from "@/lib/tenant-scope";
import { TeamManager, type Member, type Workspace } from "./team-manager";

export default async function TeamPage({
  searchParams,
}: {
  searchParams: Promise<{ org?: string }>;
}) {
  const { org } = await searchParams;
  const { tenants, orgId } = await resolveTenantScope(org);

  const [members, workspaces] = await Promise.all([
    apiGetAs<{ members: Member[] }>("/v1/members", orgId),
    apiGetAs<{ workspaces: Workspace[] }>("/v1/workspaces", orgId),
  ]);

  return (
    <>
      <PageHeader title="Team Management" />

      <TenantSwitcher tenants={tenants} activeOrgId={orgId} basePath="/team" />

      {members === null && workspaces === null ? (
        <Card>
          <MonoLabel>API offline</MonoLabel>
          <p className="text-sm text-neutral-600 mt-2 font-sans">
            Could not reach the API — start it with <code>pnpm --filter @aura/api dev</code>.
          </p>
        </Card>
      ) : (
        <TeamManager
          members={members?.members ?? []}
          workspaces={workspaces?.workspaces ?? []}
          orgId={orgId}
        />
      )}
    </>
  );
}
