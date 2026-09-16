import { cookies } from "next/headers";

/**
 * Which of a person's OWN tenants the owner console is showing.
 *
 * ── WHAT THIS COOKIE IS, AND WHAT IT IS NOT ─────────────────────────────────
 *
 * A preference, not a credential. `getPrincipal` reads it only to choose
 * BETWEEN the memberships `/v1/auth/context` already returned for the verified
 * session; a value naming any org outside that list is ignored as if absent.
 * So a forged or stale cookie can at worst select a tenant the person could
 * already switch to, and the org every page renders is still decided on the
 * server from the session - the property the owner layout's security comment
 * rests on.
 *
 * httpOnly because no client code needs to read it: the switcher posts a
 * server action, and the server is the only reader.
 */
export const ACTIVE_ORG_COOKIE = "aura_active_org";

/** 180 days - long enough that a person who works in one tenant is not bounced back to another. */
export const ACTIVE_ORG_MAX_AGE_S = 60 * 60 * 24 * 180;

/**
 * The stored preference, or null.
 *
 * Never throws: `cookies()` throws outside a request scope (a unit test, a
 * build-time render), and "no preference" is exactly the right answer there -
 * it falls through to the first active membership, which is what the console
 * did before this existed.
 */
export async function readActiveOrgPreference(): Promise<string | null> {
  try {
    return (await cookies()).get(ACTIVE_ORG_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}
