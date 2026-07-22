import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { apiGet } from "@/lib/server-api";
import { TeamManager, type Member, type Workspace } from "./team-manager";

export default async function TeamPage() {
  const [members, workspaces] = await Promise.all([
    apiGet<{ members: Member[] }>("/v1/members"),
    apiGet<{ workspaces: Workspace[] }>("/v1/workspaces"),
  ]);

  return (
    <>
      <PageHeader title="Team Management" />

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
        />
      )}
    </>
  );
}
