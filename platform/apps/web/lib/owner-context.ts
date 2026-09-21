import { cache } from "react";
import { redirect } from "next/navigation";
import {
  type Branding,
  type FeatureKey,
  type FeatureOverrides,
  type OwnerRole,
  OrgModule,
  enabledFeatures,
  featureForPath,
  parseBranding,
  resolveOwnerRole,
} from "@aura/shared";
import {
  API_URL,
  DEV_ORG_ID,
  DEV_USER_ID,
  DEV_WORKSPACE_ID,
  apiGetAs,
  crossTenantHeaders,
} from "@/lib/server-api";
import { readActiveOrgPreference } from "@/lib/active-org";
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
   *  this org has. The PROVIDER's entitlement, and the ceiling for everything
   *  below. */
  enabledModules: string[];
  /**
   * The org's own feature switches (migration 0101), sparse and raw.
   *
   * Raw rather than resolved, because `resolveFeatures` has to run in exactly
   * one place for the API and the web tier to agree - and that place is
   * @aura/shared, not here. `requireFeature` and the sidebar both call it with
   * these two fields.
   */
  featureOverrides: FeatureOverrides;
  /** organizations.whatsapp_provider (migration 0104) - which connect flow the
   *  WhatsApp Setup page offers. 'none' or 'wasi'. */
  whatsappProvider: string;
  /** organizations.branding (migration 0065), already parsed. Carried on the
   *  membership rather than fetched per page - see `getOwnerBranding`. */
  branding: Branding;
  /**
   * organizations.setup_completed_at (migration 0106), ISO or null.
   *
   * Non-null is the owner layout's licence to render no setup checklist and
   * make no extra call - which is the whole reason the column exists. Null
   * means onboarding is unfinished OR unknown, and the layout pays one round
   * trip to find out.
   */
  setupCompletedAt: string | null;
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
  /**
   * Every tenant this account belongs to, `membership` included - what the
   * header's tenant switcher offers. Read-only context: nothing may treat an
   * entry here as the active org except through `membership`.
   */
  memberships: OwnerMembership[];
}

/**
 * The membership the console acts as.
 *
 * `preferredOrgId` (the switcher's cookie) wins only when it names one of
 * THESE memberships and that tenant is active - so the choice can never reach
 * outside what the verified session already holds. Otherwise the long-standing
 * rule: first active membership, else the first one.
 */
export function pickActiveMembership<M extends { orgId: string; orgStatus: string }>(
  memberships: M[],
  preferredOrgId: string | null,
): M | null {
  const preferred = preferredOrgId
    ? memberships.find((m) => m.orgId === preferredOrgId && m.orgStatus === "active")
    : undefined;
  return preferred ?? memberships.find((m) => m.orgStatus === "active") ?? memberships[0] ?? null;
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

interface RawMembership extends Omit<OwnerMembership, "ownerRole" | "branding"> {
  ownerRole: string | null;
  /** Straight off the API as jsonb - `parseBranding` gives it a shape below. */
  branding: unknown;
}

interface ContextResponse {
  memberships: RawMembership[];
  user: { id: string; email: string; name: string | null } | null;
}

/**
 * `cache` dedupes this across a single render pass: the layout, the page and
 * every server action in one request resolve the principal once.
 */
/**
 * The persona the local-dev console acts as (CRM dashboard Phase 8).
 *
 * This branch used to hard-code `owner`, which made the other four personas
 * unreachable without a Supabase project: every persona-dependent screen - the
 * dashboards, the review queue's sources, the response-time card - rendered as
 * an owner no matter what, so a change to them could only be reasoned about,
 * never seen. `DEV_OWNER_ROLE=telecaller` now renders the console as that
 * persona.
 *
 * It ONLY applies where there is no session at all (auth unconfigured), which
 * is the mode whose own boot log says every page is reachable without one. A
 * real session takes the path below and reads the persona from `memberships`,
 * where it belongs; nothing here can widen a signed-in user's access.
 *
 * The API is NOT fooled by it: OwnerRoleGuard reads the persona from the
 * caller's membership row, so to see a persona end to end the membership has
 * to say the same thing. That is deliberate - a console that could claim a
 * persona the API did not agree with would be a worse lie than the hard-coded
 * owner it replaces.
 */
function devOwnerRole(): OwnerRole {
  return resolveOwnerRole(process.env.DEV_OWNER_ROLE);
}

/**
 * The modules the local-dev console acts as holding - `DEV_ENABLED_MODULES`,
 * comma-separated, defaulting to the `aura,crm` this branch always hard-coded.
 *
 * Same reasoning, and the same boundary, as devOwnerRole above: without it
 * every `call_intel` page (the call log, call insights) is a 404 on a laptop,
 * because the synthetic membership never held that module - a page that can
 * only be reasoned about, never seen. Unknown names are dropped rather than
 * trusted, and it only applies where there is no session at all; a real
 * session reads its modules from the org, and the API checks them again
 * regardless.
 */
function devEnabledModules(): string[] {
  const requested = (process.env.DEV_ENABLED_MODULES ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => OrgModule.safeParse(m).success);
  return requested.length ? [...new Set(requested)] : ["aura", "crm"];
}

export const getPrincipal = cache(async (): Promise<Principal | null> => {
  const user = await getSessionUser();

  // Unconfigured auth is the documented local-dev mode (see supabase/config):
  // no gate, everything scoped to DEV_ORG_ID. Give the owner console the same
  // treatment so it is usable without a Supabase project - as `operator`, so
  // the platform console stays reachable too.
  if (!user) {
    if (AUTH_ENABLED) return null;
    const devMembership: OwnerMembership = {
      orgId: DEV_ORG_ID,
      orgName: "",
      orgStatus: "active",
      role: "org_admin",
      ownerRole: devOwnerRole(),
      recordingsListen: true,
      recordingsExport: true,
      workspaceId: DEV_WORKSPACE_ID,
      // DEV_ORG_ID already has CRM (roles/pipeline) seeded locally - 0072's
      // backfill. DEV_ENABLED_MODULES widens it; see devEnabledModules.
      enabledModules: devEnabledModules(),
      // No overrides locally: the catalogue's defaults are every feature on,
      // so a laptop with no database rows renders the whole console. This
      // branch exists so the console is usable without a Supabase project, and
      // a developer checking a page they cannot reach because a flag they
      // never set is off would be debugging the wrong thing entirely.
      featureOverrides: {},
      whatsappProvider: "wasi",
      // Local dev runs unbranded: the console renders in the stock palette,
      // which is what you want when checking a change against the design system.
      branding: {},
      // Set, so the setup checklist stays out of the way locally. A developer
      // opening any page to check an unrelated change should not be met by an
      // onboarding modal about a tenant that does not exist. Clear this to
      // work on the checklist itself.
      setupCompletedAt: new Date(0).toISOString(),
    };
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
      membership: devMembership,
      memberships: [devMembership],
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
    // Defaulted here as well as in the API, for the case the API's own note
    // describes: a console deployed ahead of migration 0101 would otherwise
    // map `undefined` into a field `resolveFeatures` expects to be a record.
    // `{}` is the honest empty value - it means "no override", so the
    // catalogue's own defaults answer, which is exactly right for an API that
    // cannot yet tell us otherwise.
    featureOverrides: m.featureOverrides ?? {},
    whatsappProvider: m.whatsappProvider ?? "none",
    branding: parseBranding(m.branding),
    // Same fail-towards-asking default the API applies: a console deployed
    // ahead of migration 0106 sees `undefined` and must treat it as "not
    // finished", so onboarding is merely delayed by a round trip rather than
    // hidden from every new client for the length of a rolling deploy.
    setupCompletedAt: m.setupCompletedAt ?? null,
  }));

  // A user with several memberships (staff who own more than one tenant) sees
  // the one they last picked in the header's tenant switcher, else their first
  // active one. The preference is only honoured inside this list - see
  // lib/active-org.ts. Not read at all for a single membership: there is
  // nothing to choose between, and it saves a cookie parse on every render.
  const membership = pickActiveMembership(
    memberships,
    memberships.length > 1 ? await readActiveOrgPreference() : null,
  );

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
    memberships,
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

/**
 * The features this owner's workspace actually has, resolved.
 *
 * Entitlement intersected with the client's own switches and with every
 * feature's dependencies - see `resolveFeatures`, which is shared with the API
 * and the worker so all three answer the same question the same way.
 */
export function ownerFeatures(owner: Principal & { membership: OwnerMembership }): Set<FeatureKey> {
  return enabledFeatures(owner.membership.enabledModules, owner.membership.featureOverrides);
}

/**
 * Refuse a page whose feature this workspace has switched off.
 *
 * ── WHY A PAGE GUARD AND NOT ONLY A HIDDEN NAV ENTRY ──────────────────────
 *
 * Hiding a sidebar row leaves the page reachable by bookmark, by a link in an
 * older notification, and by a colleague pasting a URL into chat. A switch
 * that only tidies the rail is a switch that does not mean anything, and the
 * first person to discover that will be looking at a page their business
 * decided it was not using.
 *
 * ── AND WHY IT REDIRECTS RATHER THAN EXPLAINS ─────────────────────────────
 *
 * Same reasoning the persona redirects already use: arriving here means a
 * stale link, and a console that explains a feature the reader was never told
 * about is worse than one that takes them home. The Features page names every
 * switch and why it is in the state it is in - that is where the explanation
 * belongs.
 *
 * ── NOT A SECURITY BOUNDARY, AND SAYING SO MATTERS ────────────────────────
 *
 * The same people who can reach the page can switch the feature back on. What
 * protects a record is the persona and the permission grid, both enforced by
 * the API; this only makes "off" mean off. Do not move an authorization check
 * behind it.
 */
export async function requireFeature(pathname: string): Promise<void> {
  const feature = featureForPath(pathname);
  if (!feature) return;
  const owner = await getOwner();
  if (!owner) return redirect("/dashboard");
  if (!ownerFeatures(owner).has(feature)) redirect("/owner");
}

/**
 * This org's white-label branding (migration 0065).
 *
 * ── WHY THIS IS NOT A FETCH ─────────────────────────────────────────────────
 *
 * The owner console applies branding in its LAYOUT, so this is read on every
 * single page, twice per render (once in `generateMetadata` for the tab title
 * and favicon, once in the layout body for the colours and the mark). Fetching
 * `/v1/org` for it would put a fresh HTTP call plus a database query in front
 * of every navigation in the product.
 *
 * That is the exact cost `AuthService.contextFor` was rewritten to remove - its
 * own comment records that a second lookup was "~125ms of pure flight time on
 * every page", the API running in Mumbai and the database in AWS Seoul. Undoing
 * that to fetch a hex code would be a poor trade.
 *
 * So `branding` rides along on the org row `contextFor` already reads to
 * resolve the session, and this is a pure accessor over a `cache`d principal:
 * no request, no query. It is a function rather than a field so that a future
 * change of source stays invisible to the ~40 call sites in the layout tree.
 *
 * Never throws. `parseBranding` has already turned anything malformed into `{}`
 * at the point the membership was built, so a bad colour costs a tenant their
 * branding for that render, not their console.
 */
export async function getOwnerBranding(): Promise<Branding> {
  const owner = await getOwner();
  return owner?.membership.branding ?? {};
}
