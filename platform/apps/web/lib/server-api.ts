import "server-only";
import type { OwnerRole } from "@aura/shared";
import { type ApiResult, NO_HTTP_STATUS, classifyStatus, unwrap } from "@/lib/api-result";

/**
 * Server-side API access only — the admin key must never reach the browser.
 * Dev defaults match the seed script; production swaps this for the OIDC
 * session (checklist §4.1).
 *
 * `import "server-only"` is the belt-and-suspenders half of that sentence: it
 * throws a build error if any Client Component ever imports this module,
 * instead of relying on nobody doing so by discipline alone. No `"use client"`
 * file imports it today — this just makes that invariant load-bearing.
 */
export const API_URL = process.env.API_URL ?? "http://localhost:4000";

/**
 * The admin key this console will present. Mirrors the API's own
 * `resolveAdminKey()` (apps/api/src/common/admin-key.guard.ts) deliberately:
 * both sides of the same credential should fail the same way.
 *
 * `ADMIN_API_KEY` is the platform's root credential — AdminKeyGuard mints a
 * synthetic platform_admin from it and trusts the `x-org-id` that comes with
 * it — and `"dev-admin-key"` is a string published in this repository. Under
 * `NODE_ENV=production` an unset variable therefore yields the empty string,
 * which no configured key can ever equal, so the API answers 401 rather than
 * the console quietly operating every tenant behind a public literal. Outside
 * production the dev literal stays, because `pnpm dev` must keep working with
 * no setup: `apps/web/.env.development.local` supplies exactly this value and
 * Next loads it ahead of `.env.local` for `next dev` only.
 *
 * `instrumentation.ts` already throws at boot on the same condition, and that
 * is the control an operator will actually meet. This is the second line, for
 * the same reason the API side has one: a single chokepoint is one skipped code
 * path away from being no chokepoint. Empty counts as unset — a variable set to
 * whitespace must not become the key.
 *
 * Deliberately NOT a throw at module load. `next build` runs with
 * `NODE_ENV=production` and `ADMIN_API_KEY` is not a build ARG in
 * docker/web.Dockerfile, so throwing here would break the image build itself.
 */
export function resolveAdminKey(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ADMIN_API_KEY?.trim();
  if (configured) return configured;
  if (env.NODE_ENV === "production") return "";
  return "dev-admin-key";
}

export const ADMIN_KEY = resolveAdminKey();
export const DEV_ORG_ID = process.env.DEV_ORG_ID ?? "00000000-0000-4000-8000-000000000001";
export const DEV_WORKSPACE_ID =
  process.env.DEV_WORKSPACE_ID ?? "00000000-0000-4000-8000-000000000002";

/**
 * The platform `users.id` the unconfigured-auth dev principal acts as.
 *
 * Defaults to null, which is exactly the behaviour before this existed. It is
 * read ONLY by getPrincipal's `!user && !AUTH_ENABLED` branch — the documented
 * local-dev mode — and cannot be reached with Supabase auth configured.
 *
 * WHY IT IS NEEDED: without a user id, `orgHeaders` omits `x-caller-user-id`,
 * and `CrmPermissionsGuard` refuses any request whose principal has no valid
 * uuid userId. So with auth unconfigured, EVERY CRM-object page (contacts,
 * deals, tasks, products, quotations, invoices, reports) 403s and renders
 * "Data unavailable" — while the non-CRM pages beside them work, which makes
 * it read like an outage rather than a missing local credential.
 *
 * Set it to a user who actually holds a membership in DEV_ORG_ID. A value that
 * names no member changes nothing: the guard still denies, exactly as it does
 * today with no value at all.
 */
export const DEV_USER_ID = process.env.DEV_USER_ID?.trim() || null;

export const adminHeaders = {
  "content-type": "application/json",
  "x-admin-key": ADMIN_KEY,
  "x-org-id": DEV_ORG_ID,
};

/**
 * Credentials WITHOUT an org, for the endpoints that legitimately span every
 * tenant: provisioning a new customer, resolving a login's memberships, the
 * fleet rollup. Sending `x-org-id` on those would tie them to whether
 * DEV_ORG_ID still names a live org — which is exactly backwards, since
 * creating the very first tenant happens when no such org exists yet.
 */
export const crossTenantHeaders = {
  "content-type": "application/json",
  "x-admin-key": ADMIN_KEY,
};

/** Who is actually asking, threaded through the admin-key call so an API-side
 *  guard can enforce owner-console personas server-side (design doc §9) —
 *  without this the API would only ever see the omnipotent admin key. */
export interface Caller {
  ownerRole?: OwnerRole | null;
  userId?: string | null;
}

/**
 * Same admin credentials, pointed at a specific tenant. The platform operator
 * manages customers other than the dev org, so instance pages override the org
 * context per request — the admin key is not pinned to one tenant.
 */
export const orgHeaders = (orgId: string, caller?: Caller) => ({
  ...adminHeaders,
  "x-org-id": orgId,
  ...(caller?.ownerRole ? { "x-caller-owner-role": caller.ownerRole } : {}),
  ...(caller?.userId ? { "x-caller-user-id": caller.userId } : {}),
});

/**
 * The single fetch in the web tier. Everything below is a wrapper over this.
 *
 * It never throws — every page in the console is written on the assumption that
 * a failed panel renders a card rather than blowing up the whole route — but it
 * does say *why* it failed, and it says so in the server log. Until now a 403
 * from a persona guard and a 500 from the API were both a silent `null`, which
 * is why an empty page in production was undiagnosable without a repro.
 */
async function request<T>(
  path: string,
  headers: Record<string, string>,
  orgId: string | null,
): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { headers, cache: "no-store" });
  } catch (err) {
    // No HTTP response at all — API not running, DNS, TLS, abort.
    const message = err instanceof Error ? err.message : String(err);
    logFailure(path, orgId, NO_HTTP_STATUS, message);
    return { ok: false, kind: "network", status: NO_HTTP_STATUS, message };
  }

  if (!res.ok) {
    // Read the body for the log only: our API answers errors as
    // `{ statusCode, message }`, and that message is usually the whole
    // diagnosis. Capped so a stray HTML error page cannot flood the log.
    const message = (await res.text().catch(() => "")).slice(0, 300) || res.statusText;
    logFailure(path, orgId, res.status, message);
    return { ok: false, kind: classifyStatus(res.status), status: res.status, message };
  }

  try {
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    // 2xx with a body we cannot parse. The transport worked, so this is a
    // server-side defect, not a network one.
    const message = err instanceof Error ? err.message : String(err);
    logFailure(path, orgId, res.status, `unparseable body: ${message}`);
    return { ok: false, kind: "server", status: res.status, message };
  }
}

/** One line per failure, with the three facts needed to find it: which route,
 *  which tenant, which status. Server-side only — this module never reaches the
 *  browser. */
function logFailure(path: string, orgId: string | null, status: number, message: string) {
  console.warn(
    `[api] ${status === NO_HTTP_STATUS ? "unreachable" : status} ${path}` +
      ` org=${orgId ?? "cross-tenant"} — ${message}`,
  );
}

/**
 * GET against an explicit tenant org, returning the reason on failure.
 *
 * Prefer this in new code. `apiGetAs` is the same call with the reason thrown
 * away; both share the fetch above, so the two can never diverge.
 */
export async function apiTry<T>(
  path: string,
  orgId: string,
  caller?: Caller,
): Promise<ApiResult<T>> {
  return request<T>(path, orgHeaders(orgId, caller), orgId);
}

export async function apiGet<T>(path: string): Promise<T | null> {
  return apiGetAs<T>(path, DEV_ORG_ID);
}

/**
 * GET a cross-tenant operator endpoint (`/v1/admin/*`), sending NO org header.
 * Those routes span every tenant, and attaching `x-org-id` would tie them to
 * whether DEV_ORG_ID happens to name a live org — so a stale env var would
 * take out the tenant list itself, and with it the switcher that is the only
 * way to reach a working tenant.
 */
export async function apiGetAdmin<T>(path: string): Promise<T | null> {
  return unwrap(await request<T>(path, crossTenantHeaders, null));
}

/**
 * apiGet against an explicit tenant org.
 *
 * Kept exactly as it was — `T | null`, never throws — because ~35 call sites
 * depend on that shape. It is now a collapse of `apiTry`, so the failure is
 * logged even though the caller cannot see it. Migrating a page means switching
 * it to `apiTry` and rendering the four states; that is Stage 2, not this.
 */
export async function apiGetAs<T>(path: string, orgId: string, caller?: Caller): Promise<T | null> {
  return unwrap(await apiTry<T>(path, orgId, caller));
}
