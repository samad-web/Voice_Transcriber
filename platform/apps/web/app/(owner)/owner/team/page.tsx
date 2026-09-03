import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { OWNER_ROLE_DESCRIPTIONS, OWNER_ROLE_LABELS, OwnerRole } from "@aura/shared";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { getOwner, ownerGet } from "@/lib/owner-context";
import { InviteForm, TeamCounts } from "./invite-form";
import { TeamTable } from "./team-table";
import type { TeamResponse } from "./types";

export const metadata: Metadata = { title: "Team - Aura" };

/**
 * Who is in this workspace, and what each of them can see.
 *
 * ── WHY THIS PAGE IS THE POINT OF THE WHOLE CHANGE ────────────────────────
 *
 * The persona model has existed since migration 0018 and been enforced by
 * `OwnerRoleGuard` ever since. What it never had was a way to ASSIGN a
 * persona: `13_ROUTE_AND_GUARD_INVENTORY.md` finding 7 recorded that no route
 * on the platform wrote `owner_role` to anything but 'owner', so every console
 * login in every tenant was an owner no matter what that person actually did.
 * Guards over a column nobody can set are decoration. This is the page that
 * sets it.
 *
 * ── THE REDIRECT IS NOT THE SECURITY BOUNDARY ─────────────────────────────
 *
 * `GET /v1/owner/team` carries `@RequireOwnerRole("owner", "manager")` and
 * the PATCH behind the pickers carries `@RequireOwnerRole("owner")`, both
 * reading the persona from `memberships` rather than from anything this tier
 * sends. The redirect below only spares a telecaller who follows a stale link
 * a page of empty cards - remove it and they still cannot read a single row.
 */
export default async function TeamPage() {
  const owner = await getOwner();
  if (!owner) redirect("/dashboard");

  const role = owner.membership.ownerRole;
  // Sent to their own dashboard rather than shown a refusal: the nav never
  // offered this page to them, so arriving here means a stale bookmark or a
  // shared link, and a console that explains a permission they were never
  // told they lacked is worse than one that simply takes them home.
  if (role !== "owner" && role !== "manager") redirect("/owner");

  const data = await ownerGet<TeamResponse>("/v1/owner/team");

  // Headcount by persona - "how many users do we have" answered on the page
  // that manages them, in the enum's own order so the list does not reshuffle
  // as people are added.
  const counts: Array<[OwnerRole, number]> = OwnerRole.options.map((r) => [
    r,
    (data?.members ?? []).filter((m) => m.ownerRole === r).length,
  ]);

  return (
    <>
      <PageHeader title="Team" context="Settings" />

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

      {!data ? (
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      ) : (
        <>
          <TeamCounts counts={counts} />

          {role === "owner" ? <InviteForm telecallers={data.telecallers} /> : null}

          <TeamTable
            members={data.members}
            telecallers={data.telecallers}
            canEdit={role === "owner"}
            selfUserId={owner.userId}
          />

          {role === "manager" ? (
            <p className="text-sm text-text-muted">
              Only an Owner can change these. Ask one to adjust a role for you.
            </p>
          ) : (
            <p className="text-sm leading-relaxed text-text-muted">
              Changes take effect the next time that person loads a page. To add
              somebody new, ask your provider to create their login - roles are
              set here afterwards.
            </p>
          )}
        </>
      )}
    </>
  );
}
