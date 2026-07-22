/**
 * Server-side API access only — the admin key must never reach the browser.
 * Dev defaults match the seed script; production swaps this for the OIDC
 * session (checklist §4.1).
 */
export const API_URL = process.env.API_URL ?? "http://localhost:4000";
export const ADMIN_KEY = process.env.ADMIN_API_KEY ?? "dev-admin-key";
export const DEV_ORG_ID = process.env.DEV_ORG_ID ?? "00000000-0000-4000-8000-000000000001";
export const DEV_WORKSPACE_ID =
  process.env.DEV_WORKSPACE_ID ?? "00000000-0000-4000-8000-000000000002";

export const adminHeaders = {
  "content-type": "application/json",
  "x-admin-key": ADMIN_KEY,
  "x-org-id": DEV_ORG_ID,
};

/**
 * Same admin credentials, pointed at a specific tenant. The platform operator
 * manages customers other than the dev org, so instance pages override the org
 * context per request — the admin key is not pinned to one tenant.
 */
export const orgHeaders = (orgId: string) => ({ ...adminHeaders, "x-org-id": orgId });

export async function apiGet<T>(path: string): Promise<T | null> {
  return apiGetAs<T>(path, DEV_ORG_ID);
}

/** apiGet against an explicit tenant org. */
export async function apiGetAs<T>(path: string, orgId: string): Promise<T | null> {
  try {
    const res = await fetch(`${API_URL}${path}`, {
      headers: orgHeaders(orgId),
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null; // API not running — pages render an offline notice
  }
}
