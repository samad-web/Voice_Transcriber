import { OWNER_ROLE_DESCRIPTIONS, OWNER_ROLE_LABELS, OwnerRole } from "@aura/shared";
import { Card, MonoLabel } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { ownerTry } from "@/lib/owner-context";
import { googleSignInEnabled } from "@/lib/supabase/google";
import { InviteForm, TeamCounts } from "./invite-form";
import { PendingInvites, type PendingInviteRow } from "./pending-invites";
import { TeamTable } from "./team-table";
import type { InvitesResponse, TeamInvite, TeamResponse } from "./types";

/** "expires in 2 days" / "expired 3 hours ago" - relative, so no time zone is involved. */
function expiryLabel(invite: TeamInvite, now: number): string {
  const ms = new Date(invite.expiresAt).getTime() - now;
  const abs = Math.abs(ms);
  const hours = Math.max(1, Math.round(abs / 3_600_000));
  const span = hours < 48 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${Math.round(hours / 24)} days`;
  return ms > 0 ? `expires in ${span}` : `expired ${span} ago`;
}

/**
 * Who is in this workspace, and what each of them can see.
 *
 * ── WHY THIS TAB IS THE POINT OF THE WHOLE PERSONA MODEL ──────────────────
 *
 * The persona model has existed since migration 0018 and been enforced by
 * `OwnerRoleGuard` ever since. What it never had was a way to ASSIGN a
 * persona: `13_ROUTE_AND_GUARD_INVENTORY.md` finding 7 recorded that no route
 * on the platform wrote `owner_role` to anything but 'owner', so every console
 * login in every tenant was an owner no matter what that person actually did.
 * Guards over a column nobody can set are decoration. This is the tab that
 * sets it.
 *
 * ── THE REDIRECT IS NOT THE SECURITY BOUNDARY ─────────────────────────────
 *
 * `GET /v1/owner/team` carries `@RequireOwnerRole("owner", "manager")` and
 * every write behind these controls carries `@RequireOwnerRole("owner")`, both
 * reading the persona from `memberships` rather than from anything this tier
 * sends. The redirect in `page.tsx` only spares a telecaller who follows a
 * stale link a page of empty cards - remove it and they still cannot read a
 * single row.
 */
export async function TeamTab({
  role,
  selfUserId,
}: {
  role: OwnerRole;
  selfUserId: string | null;
}) {
  const [result, invitesResult, googleEnabled] = await Promise.all([
    ownerTry<TeamResponse>("/v1/owner/team"),
    // Secondary: if this fails the roster still renders, just without the
    // pending list - an invite problem must not hide who is already here.
    ownerTry<InvitesResponse>("/v1/owner/invites"),
    googleSignInEnabled(),
  ]);

  if (!result.ok) {
    return <LoadFailure what="your team" failure={result} />;
  }
  const data = result.data;
  const invites = invitesResult.ok ? invitesResult.data : null;
  const now = Date.now();
  const pendingInvites: PendingInviteRow[] = (invites?.invites ?? []).map((invite) => ({
    ...invite,
    expiresLabel: expiryLabel(invite, now),
  }));

  // Headcount by persona - "how many users do we have" answered on the page
  // that manages them, in the enum's own order so the list does not reshuffle
  // as people are added.
  //
  // Suspended people are excluded from the persona counts and reported
  // separately, rather than dropped. A headcount that included somebody who
  // cannot sign in would answer the wrong question ("how many logins exist"
  // rather than "how many people are working"), and one that omitted them
  // entirely would make a suspended colleague invisible on the only page that
  // can reinstate them.
  const active = data.members.filter((m) => m.status !== "suspended");
  const counts: Array<[OwnerRole, number]> = OwnerRole.options.map((r) => [
    r,
    active.filter((m) => m.ownerRole === r).length,
  ]);
  const suspended = data.members.length - active.length;

  return (
    <>
      <Card className="space-y-3">
        <MonoLabel>What each role sees</MonoLabel>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 sm:grid-cols-2">
          {OwnerRole.options.map((option) => (
            <div key={option} className="flex gap-2 text-sm">
              <dt className="w-24 shrink-0 font-medium text-text">{OWNER_ROLE_LABELS[option]}</dt>
              <dd className="min-w-0 leading-relaxed text-text-muted">
                {OWNER_ROLE_DESCRIPTIONS[option]}
              </dd>
            </div>
          ))}
        </dl>
      </Card>

      <TeamCounts counts={counts} suspended={suspended} />

      {role === "owner" ? (
        <InviteForm
          telecallers={data.telecallers}
          inviteByLink={{
            // Both halves must work for a link to be acceptable: Google on in
            // GoTrue, and the API able to reach GoTrue's admin endpoints.
            googleEnabled: googleEnabled && Boolean(invites?.authConfigured),
            mailConfigured: Boolean(invites?.mailConfigured),
          }}
        />
      ) : null}

      <PendingInvites
        invites={pendingInvites}
        canEdit={role === "owner"}
        mailConfigured={Boolean(invites?.mailConfigured)}
      />

      <TeamTable
        members={data.members}
        telecallers={data.telecallers}
        roles={data.roles}
        canEdit={role === "owner"}
        selfUserId={selfUserId}
      />

      {role === "manager" ? (
        <p className="text-sm text-text-muted">
          Only an Owner can change these. Ask one to adjust a role for you.
        </p>
      ) : (
        <p className="text-sm leading-relaxed text-text-muted">
          Changes take effect the next time that person loads a page. Suspending somebody stops them
          signing in and leaves every lead, call and follow-up still assigned to them; removing them
          deletes the login for good.
        </p>
      )}
    </>
  );
}
