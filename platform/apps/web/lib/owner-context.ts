import { cache } from "react";
import {
  ORG_FEATURES,
  type Branding,
  type OwnerRole,
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
   *  this org has. 'crm' gates the CRM-object nav items - see nav.ts. */
  enabledModules: string[];
  /**
   * organizations.enabled_features (migration 0093) - the per-feature
   * refinement of the modules above, set per client by an operator in /admin.
   *
   * A VISIBILITY control, not a security boundary: it decides which rail
   * entries exist and which pages render, and the API's own module gate plus
   * the role permission grid are what actually protect the data. See
   * @aura/shared's org-features.ts for why those are deliberately separate.
   */
  enabledFeatures: string[];
  /** organizations.whatsapp_provider (migration 0093) - which connect flow the
   *  WhatsApp Setup page offers. 'none' or 'wasi'. */
  whatsappProvider: string;
  /** organizations.branding (migration 0065), already parsed. Carried on the
   *  membership rather than fetched per page - see `getOwnerBranding`. */
  branding: Branding;
  /**
   * organizations.setup_completed_at (migration 0095), ISO or null.
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
      ownerRole: "owner",
      recordingsListen: true,
      recordingsExport: true,
      workspaceId: DEV_WORKSPACE_ID,
      // DEV_ORG_ID already has CRM (roles/pipeline) seeded locally - 0072's backfill.
      enabledModules: ["aura", "crm"],
      // Everything on locally, including the opt-in features: this branch
      // exists so the console is usable without a Supabase project, and a
      // developer checking a page they cannot reach because a flag they
      // never set is off would be debugging the wrong thing entirely.
      enabledFeatures: ORG_FEATURES.map((f) => f.id),
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
    // describes: a console deployed ahead of migration 0093 would otherwise
    // map `undefined` into a field every nav lookup treats as an array.
    enabledFeatures: m.enabledFeatures ?? [],
    whatsappProvider: m.whatsappProvider ?? "none",
    branding: parseBranding(m.branding),
    // Same fail-towards-asking default the API applies: a console deployed
    // ahead of migration 0095 sees `undefined` and must treat it as "not
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

  // An explicitly listed operator stays an operator even if they hold a
  // membership - otherwise provisioning yourself an owner login on a test
  // tenant would lock you out of the operator console. They keep access to
  // /owner too, since `membership` is what gates that.
  const listedOperator = OPERATOR_EMAILS.includes(user.email.toLowerCase());

  return {
    email: user.email,
    subject: user.id,
    userId,
    kind: membership && !listedOperator ? "owner" : "operator",
    membership,
    memberships,
  };
});

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
  if (OPERATOR_EMAILS.length === 0) return false;

  return OPERATOR_EMAILS.includes(principal.email.toLowerCase());
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
