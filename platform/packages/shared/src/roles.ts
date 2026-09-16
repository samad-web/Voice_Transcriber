import { z } from "zod";

/**
 * The owner console's persona model (design doc §9) - deliberately distinct
 * from `memberships.role`, which drives the operator-side team self-service
 * (members.controller.ts, design doc §3.4). Do not conflate the two: see
 * migration 0018's header for why.
 *
 * `sales` and `marketing` joined the original three in migration 0079. They
 * are personas, not permission grids: the fine-grained role -> object ->
 * action model lives in `permissions.ts` / `role_permissions` and is layered
 * ALONGSIDE this, never replaced by it. A persona answers "which console does
 * this person get, and whose records are in it"; a grant answers "may this
 * role edit a deal". Both must say yes.
 */
export const OwnerRole = z.enum(["owner", "manager", "telecaller", "sales", "marketing"]);
export type OwnerRole = z.infer<typeof OwnerRole>;

/**
 * Resolve a raw `owner_role` value to a persona. Absent/invalid defaults to
 * the MOST permissive persona, never the most restrictive - this only fires
 * for memberships that predate personas (backfilled to 'owner' in 0018) or
 * aren't owner-console logins at all. Adding a persona must only ever narrow
 * access, matching the console's existing "owners are strictly a narrowing"
 * invariant (see owner-context.ts).
 *
 * Normalised before matching, because that default is fail-OPEN and case is not
 * a reason to hand someone more access: "Telecaller" is unmistakably an attempt
 * to name the most RESTRICTED persona, and resolving it to 'owner' inverts the
 * author's intent silently. 0018's CHECK keeps case variants out of the column,
 * so this cannot fire from a stored membership today - it matters the moment a
 * value that never passed that CHECK reaches here, which is Stage 2.1's JWT
 * claim. Trimming likewise: a CSV import or a hand-written UPDATE is where the
 * stray whitespace comes from, and " manager " means manager.
 *
 * The `null`/absent default is deliberately untouched - see above.
 *
 * DEPLOY ORDER, now that the enum can grow. This function is fail-OPEN on a
 * string it does not recognise, so a build that predates a persona resolves
 * that persona to `owner` - full access. That is only reachable during a
 * rolling deploy where new DATA (an `owner_role` of 'sales') meets OLD CODE.
 * Ship the code first and assign the new personas second; 0079's header says
 * the same thing where an operator will actually read it.
 */
export function resolveOwnerRole(ownerRole: string | null | undefined): OwnerRole {
  const normalised = typeof ownerRole === "string" ? ownerRole.trim().toLowerCase() : ownerRole;
  const parsed = OwnerRole.safeParse(normalised);
  return parsed.success ? parsed.data : "owner";
}

/** Human-readable persona names - the console's dropdowns and the team table. */
export const OWNER_ROLE_LABELS: Record<OwnerRole, string> = {
  owner: "Owner",
  manager: "Manager",
  telecaller: "Telecaller",
  sales: "Sales",
  marketing: "Marketing",
};

/**
 * One line each, shown beside the persona wherever somebody is choosing one.
 * Phrased as what the person SEES, because that is the question being asked at
 * the moment of assignment - not as a list of the routes we happen to gate.
 */
export const OWNER_ROLE_DESCRIPTIONS: Record<OwnerRole, string> = {
  owner: "Full access to every record, report and setting in the workspace.",
  manager: "The whole team's pipeline, calls and reports. No billing or branding.",
  telecaller: "Only the leads, calls and tasks assigned to them.",
  sales: "Only the deals, quotations and leads assigned to them, plus their own targets.",
  marketing: "Lead sources, campaigns and attribution across the workspace. No deal values or invoices.",
};

/**
 * Whose records a persona may read.
 *
 * `all`  - every record in the org.
 * `own`  - only records assigned to this person.
 *
 * WHY THIS IS A TABLE AND NOT AN `if`. It is read by the API (to build a SQL
 * predicate) and by the web tier (to decide which dashboard to compose), and
 * those two answers drifting apart is precisely how a page renders a KPI the
 * API will not back. One exported table, imported by both.
 *
 * Marketing is `all` deliberately, and it is the one row worth pausing on: a
 * marketer's whole job is the shape of the funnel across every source, which
 * is meaningless narrowed to records assigned to them (none are). They are
 * restricted by OBJECT instead - no deal values, no invoices, no transcripts -
 * which nav.ts and the persona guards enforce. Scope and object are separate
 * questions and this table only answers the first.
 */
export const OWNER_ROLE_RECORD_SCOPE: Record<OwnerRole, "all" | "own"> = {
  owner: "all",
  manager: "all",
  telecaller: "own",
  sales: "own",
  marketing: "all",
};

/** The record scope for a persona. See OWNER_ROLE_RECORD_SCOPE. */
export function ownerRoleRecordScope(role: OwnerRole): "all" | "own" {
  return OWNER_ROLE_RECORD_SCOPE[role];
}

/**
 * True when this persona reads the whole org's records.
 *
 * Written as the positive question because that is how the call sites read
 * ("if they can see everything, skip the join"), and because the negative
 * form invites `!ownerRoleSeesAllRecords(role)` to be mistaken for "may see
 * nothing".
 */
export function ownerRoleSeesAllRecords(role: OwnerRole): boolean {
  return OWNER_ROLE_RECORD_SCOPE[role] === "all";
}

/**
 * The personas that manage other people: who may open the Team page, change
 * somebody's persona, and read org-wide settings.
 *
 * A single exported list rather than `role === "owner" || role === "manager"`
 * spelled out at each call site - the set has changed twice already and a
 * missed call site is an authorization hole, not a cosmetic bug.
 */
export const OWNER_ROLE_ADMINS: OwnerRole[] = ["owner", "manager"];

/**
 * May this person mint a handset pairing token? (migration 0096)
 *
 * The OWNER persona is always allowed, whatever the stored flag says. That is
 * not a convenience: storing the owner's own permission would create a state -
 * owner with the flag off - in which a tenant has nobody who can pair a handset
 * and no way to fix it from inside their own console. It matches the console's
 * standing invariant that owners are strictly a narrowing of nothing.
 *
 * Everybody else - manager, telecaller, sales, marketing - holds it only
 * because an owner handed it to them, one person at a time. There is
 * deliberately no persona that carries it implicitly: "all managers may pair"
 * was never the requirement, and widening a persona to fit would hand those
 * people everything else that persona carries too.
 *
 * Pairing only. Revoking a handset is owner/manager and is not delegable - see
 * 0096's header for why the reversible half travels and the destructive half
 * does not.
 */
export function canPairDevices(role: OwnerRole, granted: boolean): boolean {
  return role === "owner" || granted === true;
}

/**
 * May this person take a handset OFF the floor?
 *
 * Not delegable, and not the same question as `canPairDevices`. Pairing adds a
 * device the owner can see and remove; revoking pulls a working phone out of a
 * shift. An owner asking somebody to "set up the new handsets" is not asking
 * them to be able to unplug anyone.
 */
export function canRevokeDevices(role: OwnerRole): boolean {
  return OWNER_ROLE_ADMINS.includes(role);
}

/** True when this persona may administer the workspace's people and settings. */
export function isWorkspaceAdminRole(role: OwnerRole): boolean {
  return OWNER_ROLE_ADMINS.includes(role);
}
