"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ACTIVE_ORG_COOKIE, ACTIVE_ORG_MAX_AGE_S } from "@/lib/active-org";
import { getPrincipal } from "@/lib/owner-context";

/**
 * Switch the owner console to another of the signed-in person's tenants.
 *
 * A Server Action is a public endpoint, so the org id is treated as a claim to
 * check, not an instruction: it must name one of the memberships the verified
 * session already holds, and that tenant must be active. Anything else is
 * refused without touching the cookie. `getPrincipal` re-applies the same
 * rule on every render regardless (lib/active-org.ts), so even a cookie set by
 * other means cannot select a stranger's tenant - this check is what makes the
 * error message honest.
 *
 * Lands on Home rather than the current path: the page being viewed may be a
 * record id that does not exist in the other tenant, or a page that tenant or
 * persona does not have.
 */
export async function switchTenantAction(orgId: string): Promise<{ error?: string }> {
  const principal = await getPrincipal();
  const target = principal?.memberships.find((m) => m.orgId === orgId && m.orgStatus === "active");
  if (!principal || !target) return { error: "You don't have access to that workspace." };

  (await cookies()).set(ACTIVE_ORG_COOKIE, target.orgId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ACTIVE_ORG_MAX_AGE_S,
  });
  redirect("/owner");
}
