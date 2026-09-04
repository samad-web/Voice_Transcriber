import { cache } from "react";
import { type OwnerRole, resolveOwnerRole } from "@aura/shared";
import {
  API_URL,
  DEV_ORG_ID,
  DEV_USER_ID,
  DEV_WORKSPACE_ID,
  apiGetAs,
  crossTenantHeaders,
} from "@/lib/server-api";
import { AUTH_ENABLED } from "@/lib/supabase/config";
import { getSessionUser } from "@/lib/supabase/server";

/**
 * Who is signed in, and which tenant they are.
 *
 * Supabase Auth proves the identity; it knows nothing about orgs. The platform
 * holds the binding (users.sso_subject → memberships), so resolving a session
 * to a tenant is one server-to-server call - and because the admin key never
 * reaches the browser, the org a page renders is decided on the server from a
 * verified session rather than from anything the client can set.
 *
 * Two kinds of principal come out of this:
 *
 *   owner    - has a membership. Locked to that org; sees /owner only.
 *   operator - signed in with no membership at all. A *candidate* for platform
 *              staff, nothing more: `kind` is a classification, not a grant.
 *              Reaching the operator console (org from DEV_ORG_ID, full
 *              operator nav) additionally requires passing `isOperator()`,
 *              which checks PLATFORM_OPERATOR_EMAILS and denies by default.
 *              Owners are strictly a narrowing: adding one can never widen
 *              anyone's access.
 */

export interface OwnerMembership {
  orgId: string;
  orgName: string;
  orgStatus: string;
  role: string;
  /** Owner-console persona (design doc §9) - Owner/Manager/Telecaller. */
  ownerRole: OwnerRole;
  recordingsListen: boolean;
  recordingsExport: boolean;
  workspaceId: string | null;
  /** organizations.enabled_modules (migration 0072) - which product modules
   *  this org has. 'crm' gates the CRM-object nav items - see nav.ts. */
  enabledModules: string[];
}

export interface Principal {
  email: string;
  subject: string;
  /** The platform `users.id` (distinct from `subject`, the Supabase sso_subject). */
  userId: string | null;
  kind: "owner" | "operator";
  /** The tenant an owner is pinned to. Null for the operator. */
  membership: OwnerMembership | null;
  /**
   * On the operator allowlist - by env var OR by a `platform_operators` row
   * (0089). Resolved once in `getPrincipal` rather than re-derived by each
   * caller, because the database half cannot be answered synchronously and
   * `isOperator()` has ~40 call sites that are not async.
   *
   * Optional so a hand-built Principal in a test still type-checks; absent is
   * read as false, which is the fail-closed direction.
   */
  operatorListed?: boolean;
  /** This account IS the root operator ("max") - see ROOT_OPERATOR_EMAIL. */
  isRoot?: boolean;
}

/**
 * The allowlist of platform-operator emails. REQUIRED in production.
 *
 * This used to be optional, and an empty list meant "everybody": any signed-in
 * account holding zero memberships was an operator. Supabase's anon key ships
 * in the browser bundle and /auth/v1/signup is on by default, so that chain ran
 * stranger → self-signup → sign in → no membership → operator → every tenant's
 * calls, transcripts and recording audio (road map §0.1).
 *
 * It now fails CLOSED: empty list means NOBODY is an operator. The one
 * exception is the documented local-dev mode where auth is unconfigured
 * entirely - see `isOperator` below.
 */
const OPERATOR_EMAILS = (process.env.PLATFORM_OPERATOR_EMAILS ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

/**
 * The ROOT operator - "max". The one account that may appoint and remove other
 * superadmins (migration 0089).
 *
 * In the environment rather than in `platform_operators`, and that is the
 * entire security argument for this feature: the root is what authorises
 * changes to the table, so a root that lived IN the table could be deleted by
 * anything that reached the table - a stray admin key, a future endpoint with a
 * missing check, a SQL injection - and replaced with an attacker's address.
 * Keeping it out of the database means the worst case is a table full of
 * unwanted operators that the real root can still delete, rather than a
 * platform with a new owner.
 *
 * Unset is not an error: it degrades to exactly the behaviour that existed
 * before this feature, where PLATFORM_OPERATOR_EMAILS is the whole allowlist
 * and nobody can appoint anybody. That is why the warning below is a warning.
 */
const ROOT_OPERATOR_EMAIL = (process.env.PLATFORM_ROOT_OPERATOR_EMAIL ?? "").trim().toLowerCase();

if (AUTH_ENABLED && !ROOT_OPERATOR_EMAIL) {
  console.warn(
    "[auth] PLATFORM_ROOT_OPERATOR_EMAIL is unset - no account can add or remove superadmins " +
      "from the console, and the Superadmins page will refuse everyone. The operator allowlist " +
      "falls back to PLATFORM_OPERATOR_EMAILS alone, which is the pre-0089 behaviour.",
  );
}

// Say it once, loudly, at server startup rather than only at the moment someone
// is refused: an empty list with auth configured means the operator console is
// closed to everyone, including us, and the symptom (a "No console access" card
// for a correct login) does not name its own cause.
if (AUTH_ENABLED && OPERATOR_EMAILS.length === 0) {
  console.error(
    "[auth] PLATFORM_OPERATOR_EMAILS is unset while Supabase auth is enabled - " +
      "the platform-operator console (/dashboard, /instances, /admin) is now closed to EVERY account. " +
      "Set PLATFORM_OPERATOR_EMAILS to a comma-separated list of operator emails in the web tier's " +
      "environment (platform/.env.production, consumed by the `web` service in docker-compose.prod.yml) " +
      "and redeploy.",
  );
}

interface RawMembership extends Omit<OwnerMembership, "ownerRole"> {
  ownerRole: string | null;
}

interface ContextResponse {
  memberships: RawMembership[];
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
  // treatment so it is usable without a Supabase project - as `operator`, so
  // the platform console stays reachable too.
  if (!user) {
    if (AUTH_ENABLED) return null;
    return {
      email: "",
      subject: "",
      // DEV_USER_ID, not null: CrmPermissionsGuard denies any principal
      // without a valid uuid userId, so leaving this null makes every
      // CRM-object page 403 and render "Data unavailable" in exactly the
      // local-dev mode this branch exists to support. Defaults to null, so
      // an unset DEV_USER_ID behaves as it always did. Unreachable when
      // AUTH_ENABLED - a real session takes the path below.
      userId: DEV_USER_ID,
      kind: "operator",
      membership: {
        orgId: DEV_ORG_ID,
        orgName: "",
        orgStatus: "active",
        role: "org_admin",
        ownerRole: "owner",
        recordingsListen: true,
        recordingsExport: true,
        workspaceId: DEV_WORKSPACE_ID,
        // DEV_ORG_ID already has CRM (roles/pipeline) seeded locally - 0072's backfill.
        enabledModules: ["aura", "crm"],
      },
    };
  }

  let rawMemberships: RawMembership[] = [];
  let userId: string | null = null;
  try {
    const params = new URLSearchParams({ subject: user.id });
    if (user.email) params.set("email", user.email);
    const res = await fetch(`${API_URL}/v1/auth/context?${params}`, {
      headers: crossTenantHeaders,
      cache: "no-store",
    });
    if (res.ok) {
      const body = (await res.json()) as ContextResponse;
      rawMemberships = body.memberships ?? [];
      userId = body.user?.id ?? null;
    }
  } catch {
    // API down. Fall through as an unbound session rather than a hard error -
    // the pages themselves already render an "API offline" state.
  }

  const memberships: OwnerMembership[] = rawMemberships.map((m) => ({
    ...m,
    ownerRole: resolveOwnerRole(m.ownerRole),
  }));

  // One owner, one instance. A user with several memberships (staff who own
  // more than one tenant) gets their first; an instance switcher is the
  // natural place to extend this.
  const membership = memberships.find((m) => m.orgStatus === "active") ?? memberships[0] ?? null;

  const email = user.email.toLowerCase();
  const isRoot = ROOT_OPERATOR_EMAIL !== "" && email === ROOT_OPERATOR_EMAIL;

  // An explicitly listed operator stays an operator even if they hold a
  // membership - otherwise provisioning yourself an owner login on a test
  // tenant would lock you out of the operator console. They keep access to
  // /owner too, since `membership` is what gates that.
  //
  // Three sources now, in cost order: the root address, the env allowlist, and
  // the `platform_operators` table (0089). The table is consulted only when the
  // first two have not already said yes - an appointed superadmin is the case
  // that needs the round trip, and the people who administer this platform
  // daily are usually in the env list anyway.
  const listedOperator =
    isRoot || OPERATOR_EMAILS.includes(email) || (await isAppointedOperator(email));

  return {
    email: user.email,
    subject: user.id,
    userId,
    kind: membership && !listedOperator ? "owner" : "operator",
    membership,
    operatorListed: listedOperator,
    isRoot,
  };
});

/**
 * Is this address in `platform_operators` (migration 0089)?
 *
 * Fails CLOSED, deliberately and in both directions: an API that is down or a
 * response that will not parse denies the appointment rather than granting it.
 * An env-listed operator is unaffected because they never reach this call - so
 * an API outage costs an appointed superadmin their console access and cannot
 * cost anyone the ability to fix the outage.
 */
async function isAppointedOperator(email: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/v1/admin/operators`, {
      headers: crossTenantHeaders,
      cache: "no-store",
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { operators?: Array<{ email?: string }> };
    return (body.operators ?? []).some((o) => (o.email ?? "").toLowerCase() === email);
  } catch {
    return false;
  }
}

/**
 * True when this session may use the platform-operator console - every tenant's
 * data, cross-tenant. Deny by default; this is the only gate in front of it.
 */
export function isOperator(principal: Principal | null): boolean {
  if (!principal || principal.kind !== "operator") return false;

  // Auth unconfigured is the documented local-dev mode (see supabase/config):
  // there is no session, so there is no email to check an allowlist against -
  // getPrincipal() above synthesised this principal itself with an empty email.
  // Deliberate and narrow: it requires NEXT_PUBLIC_SUPABASE_URL/ANON_KEY to be
  // absent, which is never true of a deployed console.
  if (!AUTH_ENABLED) return true;

  // Fail closed. An empty allowlist means nobody, not everybody - a missing env
  // var must lock us out, not let strangers in. The console-wide symptom is
  // announced at module load above so the cause is never a mystery.
  //
  // "Allowlist" now means three sources, and `operatorListed` is the resolved
  // answer across all of them, computed in getPrincipal where the database can
  // be reached. It is read rather than recomputed here so that this function
  // stays synchronous for its ~40 call sites.
  if (principal.operatorListed) return true;
  if (OPERATOR_EMAILS.length === 0) return false;

  return OPERATOR_EMAILS.includes(principal.email.toLowerCase());
}

/**
 * True only for the ROOT operator - "max".
 *
 * The one privilege this separates from every other operator: appointing and
 * removing superadmins. Everything else in the operator console stays open to
 * all of them, which is the scope that was asked for - a colleague who can run
 * the platform day to day, but cannot decide who else gets to.
 *
 * Not derived from the database, ever. See ROOT_OPERATOR_EMAIL.
 */
export function isMax(principal: Principal | null): boolean {
  if (!principal) return false;
  // Local dev with auth unconfigured has no email to compare, and synthesises a
  // principal that is already an operator. Granting root there too keeps the
  // superadmin page usable on a laptop; it requires the Supabase env vars to be
  // absent, which is never true of a deployment.
  if (!AUTH_ENABLED) return true;
  if (!ROOT_OPERATOR_EMAIL) return false;
  return principal.email.toLowerCase() === ROOT_OPERATOR_EMAIL;
}

/**
 * The owner principal, or null. Pages under /owner use this and redirect when
 * it comes back empty - never trusting an org id from the request.
 */
export async function getOwner(): Promise<(Principal & { membership: OwnerMembership }) | null> {
  const principal = await getPrincipal();
  if (!principal?.membership) return null;
  return principal as Principal & { membership: OwnerMembership };
}

/**
 * GET against the signed-in owner's own org. The counterpart to `apiGet`, which
 * is pinned to DEV_ORG_ID - pages under /owner must never use that one.
 */
export async function ownerGet<T>(path: string): Promise<T | null> {
  const owner = await getOwner();
  if (!owner) return null;
  return apiGetAs<T>(path, owner.membership.orgId, {
    ownerRole: owner.membership.ownerRole,
    userId: owner.userId,
  });
}
