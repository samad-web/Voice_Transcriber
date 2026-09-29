import { Card, MonoLabel, StatusChip } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { operatorGate } from "@/lib/operator-gate";
import { getPrincipal, isMax } from "@/lib/owner-context";
import { apiGetAdmin } from "@/lib/server-api";
import { googleSignInEnabled } from "@/lib/supabase/google";
import { OperatorInvites, type OperatorInviteRow } from "./operator-invites";
import { OperatorsManager, type OperatorRow } from "./operators-manager";

/**
 * Who administers this platform (migration 0089).
 *
 * Readable by every operator - knowing who else holds the keys is not a
 * privilege, and a list nobody can see is a list nobody audits. Only the root
 * can CHANGE it, and that is enforced in the actions rather than here: this
 * page decides what is rendered, and a page has never been a boundary for a
 * Server Action.
 */
export default async function OperatorsPage() {
  const blocked = await operatorGate();
  if (blocked) return blocked;

  const principal = await getPrincipal();
  const root = isMax(principal);

  // apiGetAdmin, not apiGetAs: this route spans every tenant, so it must not
  // carry an org header at all (see the helper's own note).
  const data = await apiGetAdmin<{ operators: OperatorRow[]; root: string | null }>(
    "/v1/admin/operators",
  );
  // Secondary (0145): a failure here hides the invite panel, never the list of
  // who already holds the keys.
  const inviteData = await apiGetAdmin<{
    invites: OperatorInviteRow[];
    mailConfigured: boolean;
  }>("/v1/admin/operator-invites");
  const googleEnabled = await googleSignInEnabled();
  const reachable = data !== null;
  const operators = data?.operators ?? [];
  const rootEmail = data?.root ?? null;

  return (
    <>
      <PageHeader title="Superadmins" context="Platform" />

      <Card>
        <MonoLabel>How access works</MonoLabel>
        <p className="mt-2 text-sm text-text-muted">
          Three things let an account into this console: the{" "}
          <span className="font-medium text-text">root operator</span> address, the
          deployment&rsquo;s{" "}
          <code className="rounded bg-bg-subtle px-1 py-0.5 font-mono text-xs">
            PLATFORM_OPERATOR_EMAILS
          </code>{" "}
          list, and the superadmins appointed below. Only the root can appoint or remove one -
          everything else in this console is open to all of them equally.
        </p>
        <p className="mt-2 text-sm text-text-muted">
          The root lives in the deployment&rsquo;s environment, not in this list, so it cannot be
          removed from here by anyone - including itself.
        </p>
        <p className="mt-2 text-sm text-text-muted">
          There are two ways to let a new superadmin in. Invite them and they accept with their own
          Google account, which is the one to prefer: no password is created and nothing has to be
          passed along. Or appoint them and mint a password, shown once - still the only recovery
          when Google is unavailable, and the only way in for the root itself, which has no
          self-service reset.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {rootEmail ? (
            <StatusChip tone="solid">root: {rootEmail}</StatusChip>
          ) : (
            <StatusChip tone="danger">no root configured</StatusChip>
          )}
          {root ? (
            <StatusChip tone="outline">you are the root</StatusChip>
          ) : (
            <StatusChip tone="muted">read-only for you</StatusChip>
          )}
        </div>
      </Card>

      {!reachable ? (
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer, so the appointed superadmins could not be listed.
            Anyone in the environment allowlist still has access.
          </p>
        </Card>
      ) : (
        <>
          <OperatorsManager operators={operators} canManage={root} rootEmail={rootEmail} />
          <OperatorInvites
            invites={inviteData?.invites ?? []}
            canManage={root}
            mailConfigured={Boolean(inviteData?.mailConfigured)}
            googleEnabled={googleEnabled}
          />
        </>
      )}
    </>
  );
}
