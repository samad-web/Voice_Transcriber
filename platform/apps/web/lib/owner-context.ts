import { cache } from "react";
import { API_URL, DEV_ORG_ID, DEV_WORKSPACE_ID, apiGetAs, crossTenantHeaders } from "@/lib/server-api";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import { getSessionUser } from "@/lib/supabase/server";

/**
 * Who is signed in, and which tenant they are.
 *
 * Supabase Auth proves the identity; it knows nothing about orgs. The platform
 * holds the binding (users.sso_subject → memberships), so resolving a session
 * to a tenant is one server-to-server call — and because the admin key never
 * reaches the browser, the org a page renders is decided on the server from a
 * verified session rather than from anything the client can set.
 *
 * Two kinds of principal come out of this:
 *
 *   owner    — has a membership. Locked to that org; sees /owner only.
 *   operator — signed in with no membership at all. This is the platform staff
 *              account, and it keeps the behaviour the console has always had
 *              (org from DEV_ORG_ID, full operator nav). Owners are strictly a
 *              narrowing: adding one can never widen anyone's access.
 */

export interface OwnerMembership {
  orgId: string;
  orgName: string;
  orgStatus: string;
  role: string;
  recordingsListen: boolean;
  recordingsExport: boolean;
  workspaceId: string | null;
}

export interface Principal {
  email: string;
  subject: string;
  kind: "owner" | "operator";
  /** The tenant an owner is pinned to. Null for the operator. */
  membership: OwnerMembership | null;
}

/**
 * Optional allowlist of operator emails. When set, a signed-in user who is not
 * an owner AND not on the list gets nothing — useful once real customers have
 * logins and a stray Supabase signup should not land in the operator console.
 * Unset (the default) keeps local dev and the existing deployment working.
 */
const OPERATOR_EMAILS = (process.env.PLATFORM_OPERATOR_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

interface ContextResponse {
  memberships: OwnerMembership[];
  user: { id: string; email: string; name: string | null } | null;
}

/**
 * `cache` dedupes this across a single render pass: the layout, the page and
 * every server action in one request resolve the principal once.
 */
export const getPrincipal = cache(async (): Promise<Principal | null> => {
  const user = await getSessionUser();

  // Unconfigured auth is the documented local-dev mode (see supabase/config):
  // no gate, everything scoped to DEV_ORG_ID. Give the owner console the same
  // treatment so it is usable without a Supabase project — as `operator`, so
  // the platform console stays reachable too.
  if (!user) {
    if (AUTH_ENABLED) return null;
    return {
      email: "",
      subject: "",
      kind: "operator",
      membership: {
        orgId: DEV_ORG_ID,
        orgName: "",
        orgStatus: "active",
        role: "org_admin",
        recordingsListen: true,
        recordingsExport: true,
        workspaceId: DEV_WORKSPACE_ID,
      },
    };
  }

  let memberships: OwnerMembership[] = [];
  try {
    const params = new URLSearchParams({ subject: user.id });
    if (user.email) params.set("email", user.email);
    const res = await fetch(`${API_URL}/v1/auth/context?${params}`, {
      headers: crossTenantHeaders,
      cache: "no-store",
    });
    if (res.ok) memberships = ((await res.json()) as ContextResponse).memberships ?? [];
  } catch {
    // API down. Fall through as an unbound session rather than a hard error —
    // the pages themselves already render an "API offline" state.
  }

  // One owner, one instance. A user with several memberships (staff who own
  // more than one tenant) gets their first; an instance switcher is the
  // natural place to extend this.
  const membership = memberships.find((m) => m.orgStatus === "active") ?? memberships[0] ?? null;

  // An explicitly listed operator stays an operator even if they hold a
  // membership — otherwise provisioning yourself an owner login on a test
  // tenant would lock you out of the operator console. They keep access to
  // /owner too, since `membership` is what gates that.
  const listedOperator = OPERATOR_EMAILS.includes(user.email.toLowerCase());

  return {
    email: user.email,
    subject: user.id,
    kind: membership && !listedOperator ? "owner" : "operator",
    membership,
  };
});

/** True when this session may use the platform-operator console. */
export function isOperator(principal: Principal | null): boolean {
  if (!principal || principal.kind !== "operator") return false;
  if (OPERATOR_EMAILS.length === 0) return true;
  return OPERATOR_EMAILS.includes(principal.email.toLowerCase());
}

/**
 * The owner principal, or null. Pages under /owner use this and redirect when
 * it comes back empty — never trusting an org id from the request.
 */
export async function getOwner(): Promise<(Principal & { membership: OwnerMembership }) | null> {
  const principal = await getPrincipal();
  if (!principal?.membership) return null;
  return principal as Principal & { membership: OwnerMembership };
}

/**
 * GET against the signed-in owner's own org. The counterpart to `apiGet`, which
 * is pinned to DEV_ORG_ID — pages under /owner must never use that one.
 */
export async function ownerGet<T>(path: string): Promise<T | null> {
  const owner = await getOwner();
  if (!owner) return null;
  return apiGetAs<T>(path, owner.membership.orgId);
}
