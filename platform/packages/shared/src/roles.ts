import { z } from "zod";

/**
 * The owner console's persona model (design doc §9) — deliberately distinct
 * from `memberships.role`, which drives the operator-side team self-service
 * (members.controller.ts, design doc §3.4). Do not conflate the two: see
 * migration 0018's header for why.
 */
export const OwnerRole = z.enum(["owner", "manager", "telecaller"]);
export type OwnerRole = z.infer<typeof OwnerRole>;

/**
 * Resolve a raw `owner_role` value to a persona. Absent/invalid defaults to
 * the MOST permissive persona, never the most restrictive — this only fires
 * for memberships that predate personas (backfilled to 'owner' in 0018) or
 * aren't owner-console logins at all. Adding a persona must only ever narrow
 * access, matching the console's existing "owners are strictly a narrowing"
 * invariant (see owner-context.ts).
 *
 * Normalised before matching, because that default is fail-OPEN and case is not
 * a reason to hand someone more access: "Telecaller" is unmistakably an attempt
 * to name the most RESTRICTED persona, and resolving it to 'owner' inverts the
 * author's intent silently. 0018's CHECK keeps case variants out of the column,
 * so this cannot fire from a stored membership today — it matters the moment a
 * value that never passed that CHECK reaches here, which is Stage 2.1's JWT
 * claim. Trimming likewise: a CSV import or a hand-written UPDATE is where the
 * stray whitespace comes from, and " manager " means manager.
 *
 * The `null`/absent default is deliberately untouched — see above.
 */
export function resolveOwnerRole(ownerRole: string | null | undefined): OwnerRole {
  const normalised = typeof ownerRole === "string" ? ownerRole.trim().toLowerCase() : ownerRole;
  const parsed = OwnerRole.safeParse(normalised);
  return parsed.success ? parsed.data : "owner";
}
