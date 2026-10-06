import "server-only";
import { cache } from "react";
import { API_URL, ADMIN_KEY } from "@/lib/server-api";
import { getSessionUser } from "@/lib/supabase/server";

/**
 * Who is signed into the portal, resolved on the SERVER from a verified
 * Supabase session (Build docs/39 §19).
 *
 * The owner console's counterpart is `lib/owner-context.ts`, and this is
 * deliberately NOT a branch inside it. Two reasons, and the first is the one
 * that matters:
 *
 *  1. `getPrincipal()` resolves memberships. A partner has none - that is the
 *    definition - so every field on `OwnerMembership` (ownerRole, role,
 *    recordingsListen, enabledModules, featureOverrides, setupCompletedAt…)
 *    would be a lie with a plausible default, and the ~40 call sites in the
 *    owner layout tree read those defaults without knowing a partner exists.
 *    A `kind: "partner"` third case on that type would put a broker one
 *    missing `if` away from the owner console.
 *
 *  2. `/v1/auth/context` is the console's resolver and knows nothing about
 *    partners. `/v1/portal/context` is the portal's, behind
 *    `PartnerScopeGuard`, and it is the API - not the web tier - that decides
 *    whether this Supabase subject is a partner at all.
 *
 * ── THE HEADERS, AND THE ONE THAT IS ABSENT ───────────────────────────────
 *
 * `x-admin-key` plus `x-caller-auth-id`, and NO `x-org-id`. The org is a
 * property of the partner's `partner_users` row and is read from the database
 * by the guard; sending it would mean the portal naming its own tenant, which
 * is the first thing a hostile partner would try. `orgHeaders()` in
 * server-api.ts always sends one, which is why this builds its own.
 */

/** The shape `GET /v1/portal/context` answers with. */
export interface PortalContext {
  partner: {
    id: string;
    name: string;
    code: string;
    status: string;
    role: "owner" | "member";
  };
  workspace: {
    name: string;
    /** `organizations.branding` (0065), unparsed - `parseBranding` gives it shape. */
    branding: unknown;
    /** `org_business_profile.country` (0126) - where the phone field starts. */
    country: string;
    currency: string;
  };
  me: { email: string; name: string | null };
}

const portalHeaders = (authUserId: string) => ({
  "content-type": "application/json",
  "x-admin-key": ADMIN_KEY,
  "x-caller-auth-id": authUserId,
});

/**
 * `cache`d for the render, exactly as `getPrincipal` is: the layout reads it
 * for the nav and the branding, `generateMetadata` reads it for the tab title,
 * and each page reads it again. One call per request, not four.
 */
export const getPortal = cache(async (): Promise<PortalContext | null> => {
  const user = await getSessionUser();
  if (!user) return null;
  try {
    const res = await fetch(`${API_URL}/v1/portal/context`, {
      headers: portalHeaders(user.id),
      cache: "no-store",
    });
    // 403 is the ordinary answer for "signed in, but not a partner" - a
    // member of the tenant who typed /portal into the address bar, or
    // somebody whose access was suspended. Null, and the layout redirects.
    if (!res.ok) return null;
    return (await res.json()) as PortalContext;
  } catch {
    // API unreachable. Same answer as "not a partner", because the portal has
    // nothing it can usefully render either way and a half-drawn shell around
    // an error is worse than the sign-in page.
    return null;
  }
});

/** GET against the signed-in partner's own portal. Returns null on any failure. */
export async function portalGet<T>(path: string): Promise<T | null> {
  const user = await getSessionUser();
  if (!user) return null;
  try {
    const res = await fetch(`${API_URL}${path}`, {
      headers: portalHeaders(user.id),
      cache: "no-store",
    });
    if (!res.ok) {
      console.warn(`[portal] ${res.status} ${path}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[portal] unreachable ${path} - ${(err as Error).message}`);
    return null;
  }
}

/**
 * POST/PATCH from a server action. Returns the API's message on failure rather
 * than swallowing it: these are forms a person just pressed, and "something
 * went wrong" is not an answer anybody can act on.
 */
export async function portalSend<T>(
  path: string,
  method: "POST" | "PATCH",
  body: unknown,
): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  const user = await getSessionUser();
  if (!user) return { ok: false, message: "Your session has expired. Sign in again." };
  try {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: portalHeaders(user.id),
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) {
      const parsed = (() => {
        try {
          return JSON.parse(text) as { message?: unknown };
        } catch {
          return null;
        }
      })();
      const message =
        typeof parsed?.message === "string"
          ? parsed.message
          : Array.isArray(parsed?.message)
            ? parsed.message.map((m) => JSON.stringify(m)).join("; ")
            : `The portal couldn't save that (${res.status}).`;
      console.warn(`[portal] ${res.status} ${method} ${path} - ${message}`);
      return { ok: false, message };
    }
    return { ok: true, data: (text ? JSON.parse(text) : {}) as T };
  } catch (err) {
    return { ok: false, message: `The portal is unreachable: ${(err as Error).message}` };
  }
}
