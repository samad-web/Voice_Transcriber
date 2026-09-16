import "server-only";
import { getPrincipal, isOperator } from "@/lib/owner-context";
import { ALL_ORGS } from "@/lib/realtime/upstream";

/**
 * Which tenant's change signals the caller may listen to.
 *
 * The SAME question the rest of the console answers for every page, asked once
 * for the two live-update endpoints so they cannot drift apart:
 *
 *   an owner   → their own org, and only ever that one. It comes from the
 *                membership resolved server-side from a verified Supabase
 *                session, never from a query parameter, so there is no id a
 *                signed-in customer could change to watch a different tenant.
 *   an operator→ every org, because the platform console legitimately spans
 *                them - but only after `isOperator()`, which is the same
 *                allowlist gate `(platform)/layout.tsx` applies and which fails
 *                closed when PLATFORM_OPERATOR_EMAILS is unset.
 *   anyone else→ null. Not signed in, or signed in with neither a membership
 *                nor operator standing.
 *
 * Worth restating what a positive answer actually grants: a stream of
 * "org X had a Y change" with no row content in it (packages/shared/realtime.ts
 * sets out why). A caller who somehow got the wrong scope would learn that
 * something happened, not what - and every read they make afterwards still goes
 * through the normal authorised path with their own persona applied.
 */
export async function resolveListenScope(): Promise<string | null> {
  const principal = await getPrincipal();
  if (!principal) return null;
  if (principal.membership) return principal.membership.orgId;
  return isOperator(principal) ? ALL_ORGS : null;
}
