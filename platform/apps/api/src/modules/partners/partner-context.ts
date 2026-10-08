import {
  InternalServerErrorException,
  NotFoundException,
  createParamDecorator,
  type ExecutionContext,
} from "@nestjs/common";
import { ORG_TIME_ZONE_SQL, getPool, type PoolClient } from "@aura/db";
import type { PrincipalRequest } from "../../common/auth-principal";

/**
 * The portal's own transaction helper - the ONLY thing in this platform that
 * sets `app.partner_id` (Build docs/39 §17, rule 1).
 *
 * ── WHY THIS IS A SECOND HELPER AND NOT A PARAMETER ON THE FIRST ───────────
 *
 * The obvious change is an optional third argument on `withOrgContext`:
 * `withOrgContext(orgId, fn, partnerId?)`. It would be fewer lines and it would
 * be wrong, for a reason that has nothing to do with taste.
 *
 * `withOrgContext` is called from roughly four hundred places. Every one of
 * them would then be a place where a partner id could be passed, and - far more
 * dangerously - every one of them would be a place where a partner id could be
 * FORGOTTEN. An omitted optional argument is not a compile error; it is the
 * whole tenant, returned successfully, to a broker. The failure would look like
 * a working page.
 *
 * Two helpers with disjoint call sites make that specific mistake unavailable.
 * `withOrgContext` does not know this setting exists; nothing in
 * `packages/db/src/index.ts` mentions it. A partner-context transaction can
 * only be opened by calling this function, which cannot be called without a
 * `PartnerContext`, which can only be produced by `PartnerScopeGuard`.
 *
 * ── AND WHY IT TAKES THE WHOLE CONTEXT OBJECT ──────────────────────────────
 *
 * Not `(orgId, partnerId, fn)`. A handler holding two loose uuids is a handler
 * that can hand the first of them to `db.withOrg(...)` - at which point the
 * partner reads the entire tenant, the query is correct, the types are correct
 * and nothing anywhere goes red. Taking the opaque object means the only org id
 * a portal handler ever has is inside something it cannot unpack usefully,
 * and `@PartnerCtx()` is the only decorator that yields it: there is no
 * `@OrgId()` on these routes, because `TenantGuard` never ran and `@OrgId()`
 * throws without it.
 *
 * That is the structural half of §17 rule 1. `partner-scope.guard.spec.ts`
 * carries the grep half: no file in this module may call `withOrg`.
 *
 * ── WHY `app.org_id` IS SET AT ALL ─────────────────────────────────────────
 *
 * Because `partners`, `partner_users` and `partner_submissions` are ordinary
 * org-scoped tables whose `org_isolation` policy is what makes them readable.
 * Setting only the partner id would leave all three empty.
 *
 * The consequence is the thing migration 0163 exists for: inside this
 * transaction every OTHER org-scoped table is also addressable by org. The
 * database closes that rather than this file - `partner_wall`, a RESTRICTIVE
 * policy on every tenant table bar four, empties each of them the instant
 * `app.partner_id` is set. Read 0163's header before adding a query here.
 */

/** The canonical UUID shape, anchored - the same test `withOrgContext` applies. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who is asking, resolved from the database by `PartnerScopeGuard` and never
 * from a header. Deliberately NOT a `Principal`: a partner is not a user of the
 * tenant, holds no tenant role, no persona and no permission grid, and giving
 * them a shape that fits `req.principal` would mean every guard and helper that
 * reads that field silently starts applying to them. Kept in its own field for
 * exactly the reason `req.apiKey` is (auth-principal.ts).
 */
export interface PartnerContext {
  /** The tenant whose portal this is. Resolved from `partner_users`, never sent. */
  orgId: string;
  orgName: string;
  /** `organizations.branding` (0065), opaque here - @aura/shared's `Branding` gives it shape. */
  branding: unknown;
  /**
   * `org_business_profile.country` (0126) and its currency.
   *
   * Carried on the context rather than read per request for the reason
   * `contextFor` carries branding: the portal's phone field must start on the
   * tenant's own country (otherwise a Delhi broker types a ten-digit number
   * into a +1 field and the vault stores an American number), and the guard's
   * single resolution query can join it for nothing. A second lookup would be
   * ~125ms of Seoul flight time on every portal page for two short strings.
   */
  defaultCountry: string;
  baseCurrency: string;
  partnerId: string;
  partnerName: string;
  partnerCode: string;
  partnerStatus: string;
  /** `partner_users.id` - what a submission is stamped with. */
  partnerUserId: string;
  partnerRole: "owner" | "member";
  /** `users.id`. The person exists in the platform; they are simply not a member. */
  userId: string;
  email: string;
  name: string | null;
  /** `users.sso_subject` - the Supabase subject the guard matched on. */
  authUserId: string;
  /**
   * Whether this tenant's `partner_portal` feature is on (Build docs/40 §A2).
   *
   * Resolved by the guard from `organizations.enabled_modules` and
   * `feature_overrides` - columns the guard's single resolution query already
   * had to join `organizations` for, so this costs no extra round trip, which
   * is the same argument `branding` and `defaultCountry` are carried on.
   *
   * ── WHY THIS LIVES HERE AND NOT IN A ROUTE GUARD ───────────────────────────
   *
   * Migration 0163 shipped the portal with no reachability gate at all: any org
   * with a `partner_users` row had a live portal, which is the opposite of what
   * was decided. The fix has to hold for routes nobody has written yet, so it is
   * enforced in `withPartnerContext` - the single chokepoint every portal read
   * and write already passes through by construction - rather than as a
   * decorator somebody can forget on route seven.
   *
   * It is NOT a security boundary. 0163's RESTRICTIVE `partner_wall` policies
   * are, and they are untouched by this. This decides whether the portal is
   * REACHABLE; the wall decides what a reachable portal may see.
   */
  portalEnabled: boolean;
}

/**
 * Run `fn` inside a transaction scoped to one tenant AND one partner.
 *
 * The preamble is one message for the reason `withOrgContext`'s is: the API is
 * in Mumbai and the database in AWS Seoul, so each round trip is ~125ms and
 * node-postgres does not pipeline. The simple query protocol takes no bind
 * parameters, so both ids are interpolated - which is safe only because they
 * are checked against `UUID_RE` first, and this one THROWS rather than falling
 * back to a slow parameterised path. `withOrgContext` can afford that fallback;
 * here a value that is not a uuid means the guard produced something it should
 * not have, and the right answer to that is to stop.
 *
 * `true` as set_config's third argument is transaction-local: both settings
 * revert on COMMIT or ROLLBACK, so a pooled connection cannot carry a partner
 * id into somebody else's request. Note that reverting a custom GUC restores
 * the EMPTY STRING rather than NULL, which is why every policy in 0162/0163
 * reads it through `NULLIF(..., '')` instead of `IS NULL`.
 */
export async function withPartnerContext<T>(
  ctx: PartnerContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(ctx.orgId) || !UUID_RE.test(ctx.partnerId)) {
    throw new InternalServerErrorException("partner context carries a malformed id");
  }
  // THE PORTAL GATE (Build docs/40 §A2). Checked here, before a connection is
  // taken, because this function is the one path every portal read and write
  // goes through - partner-scope.guard.spec.ts greps this directory to keep
  // `withOrg` out of it, which is what makes "every path" true rather than
  // hopeful.
  //
  // 404, not 403. A workspace that has not switched the portal on does not have
  // a portal, and saying "forbidden" would confirm the surface exists to
  // somebody who should see no trace of it. The web tier renders Next's
  // not-found page on the same reasoning.
  if (!ctx.portalEnabled) {
    throw new NotFoundException("This workspace does not have a partner portal.");
  }
  const client = await getPool().connect();
  try {
    await client.query(
      `BEGIN;` +
        ` SELECT set_config('app.org_id', '${ctx.orgId}', true);` +
        ` SELECT set_config('app.partner_id', '${ctx.partnerId}', true);` +
        ` ${ORG_TIME_ZONE_SQL.replace("$1", `'${ctx.orgId}'`)}`,
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export interface PartnerRequest extends PrincipalRequest {
  /**
   * Written by `PartnerScopeGuard`, absent on every other route in the API.
   * `principal` stays UNSET on a portal request - see `PartnerContext` above.
   */
  partner?: PartnerContext;
}

/**
 * The partner this request belongs to. The portal's `@OrgId()`.
 *
 * Throws rather than returning undefined when it is unset, because the only way
 * that happens is a programming error: the route is missing
 * `PartnerScopeGuard`, or the guard ran and refused and somehow did not throw.
 * The same shape - and the same reasoning - as `@OrgId()` in tenant.guard.ts.
 */
export const PartnerCtx = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): PartnerContext => {
    const req = ctx.switchToHttp().getRequest<PartnerRequest>();
    const partner = req.partner;
    if (!partner) {
      throw new InternalServerErrorException("@PartnerCtx() on a route without PartnerScopeGuard");
    }
    return partner;
  },
);
