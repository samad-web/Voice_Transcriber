import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import { type OwnerRole, ownerRoleRecordScope } from "@aura/shared";
import type { PrincipalRequest } from "./auth-principal";

/**
 * Row-level scope for the OWNER CONSOLE's personas (migration 0079).
 *
 * ── HOW THIS DIFFERS FROM crm-scope.ts ────────────────────────────────────
 *
 * Two scope systems now exist and they are not redundant:
 *
 *   crm-scope.ts   the `owned` half of the role_permissions GRID (0039).
 *                  Keyed on `owner_user_id` - a CRM record belongs to a USER.
 *                  Answers "what did an org_admin grant this role".
 *
 *   this file      the PERSONA's scope (0018/0079). Keyed on the caller's
 *                  `telecallers` row - a lead or a call belongs to whoever
 *                  worked the phone, which is an identity the CRM grid has no
 *                  concept of. Answers "which desk is this person sitting at".
 *
 * They compose by INTERSECTION, never union: a persona can only ever narrow
 * what the grid allowed (see crm-permissions.guard.ts, which applies this).
 * That direction is the console's standing invariant - "adding a persona must
 * only ever narrow access" (roles.ts) - and reversing it anywhere would let a
 * persona hand out access no administrator granted.
 *
 * ── WHY THE PREDICATE LIVES IN THE QUERY ──────────────────────────────────
 *
 * Same reasoning crm-scope.ts sets out at length: "may read leads, but only
 * their own" is not a yes/no verdict on a request, it is a predicate on every
 * row the request returns, and the only place to apply it is the SQL. The
 * failure mode is the same too - a controller that forgets the filter leaks
 * silently rather than failing to compile - so the predicate is built ONLY
 * here, making every call site greppable, and owner-scope.spec.ts pins the
 * column each object scopes on.
 */

/** What an own-scoped persona's identity resolves to. */
export interface OwnerRecordScope {
  role: OwnerRole;
  scope: "all" | "own";
  /** The acting platform user, or null for a caller with no resolvable user. */
  userId: string | null;
  /**
   * This person's `telecallers` row in this org, or null if they have none.
   *
   * Null with `scope: "own"` is the load-bearing case: a restricted persona
   * that is not bound to a telecaller identity has no phone-side records to
   * be shown, and `ownerScopeFilter` therefore returns a predicate that
   * matches NOTHING rather than one that matches everything. See the sentinel
   * below.
   */
  telecallerId: string | null;
}

/** Nothing narrows - an owner or manager, and the default for unguarded routes. */
export const OWNER_UNSCOPED: OwnerRecordScope = {
  role: "owner",
  scope: "all",
  userId: null,
  telecallerId: null,
};

/**
 * The scope `OwnerScopeGuard` resolved for this request.
 *
 * Defaults to OWNER_UNSCOPED when absent, and that default is only correct
 * because absence means the guard is not mounted - i.e. the route is not an
 * owner-console route at all. Any route that mounts `OwnerScopeGuard` always
 * gets a value written by it. A route that reads records per-persona and
 * FORGETS the guard would silently read unscoped, which is why the guard is
 * mounted on the controller class rather than per-handler.
 */
export const OwnerScope = createParamDecorator(
  (_data: unknown, context: ExecutionContext): OwnerRecordScope => {
    const req = context
      .switchToHttp()
      .getRequest<PrincipalRequest & { ownerScope?: OwnerRecordScope }>();
    return req.ownerScope ?? OWNER_UNSCOPED;
  },
);

/**
 * A uuid that matches no row, for an own-scoped persona whose identity could
 * not be resolved. Borrowed verbatim from crm-scope.ts and for the same
 * reason: an empty list beats everyone's list. Deliberately NOT a `WHERE
 * false` - a real parameter keeps the predicate shape identical in both
 * branches, so the query plan and the bind-parameter count do not change
 * based on who is asking.
 */
const MATCHES_NOTHING = "00000000-0000-0000-0000-000000000000";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The owner-console objects a persona scope can narrow.
 *
 * `telecaller_stats` (migration 0090) is the daily productivity rollup. It
 * scopes exactly like `call` - on the telecaller identity - and is named
 * separately rather than reusing "call" because the two will not always agree:
 * a rollup row is about a PERSON on a DAY, and if a future assignment concept
 * ever attaches to it, the divergence has to be expressible here rather than
 * silently inherited from calls.
 *
 * Getting this one wrong is how a telecaller reads the whole floor's
 * productivity numbers - the exact defect 13_ROUTE_AND_GUARD_INVENTORY.md
 * finding 3 recorded against /v1/owner/overview.
 */
export type OwnerScopedObject = "lead" | "call" | "deal" | "task" | "telecaller_stats";

/**
 * A SQL predicate restricting rows to the caller's own, or null when nothing
 * should be restricted.
 *
 * `alias` is the table alias in the caller's query (`l` for leads, `""` for an
 * unaliased one). The returned `sql` contains `$?` placeholders that the
 * caller substitutes - matching the `add()` helper every list endpoint in this
 * codebase already uses. EVERY placeholder in a returned predicate binds the
 * SAME value, so the caller always substitutes exactly one parameter no matter
 * which branch it took.
 *
 * ── WHY LEADS TAKE THE UNION, AND DEALS DO NOT ────────────────────────────
 *
 * `leads` carries two telecaller columns and they mean different things:
 *
 *   telecaller_id           WRITE-ONCE attribution (0017). Who actually made
 *                           the call that created this lead.
 *   assigned_telecaller_id  Re-assignable ownership (0075). Who is meant to
 *                           work it.
 *
 * Scoping on assignment alone looks obviously right and is wrong in practice:
 * the worker's lead-creation path (apps/worker/src/pipeline/leads.ts) writes
 * `telecaller_id` and NEVER `assigned_telecaller_id`, so every lead generated
 * from a phone call is unassigned. A telecaller scoped strictly to assignment
 * would open their dashboard and see nothing at all - not a subtle
 * under-count, an empty console - for exactly the leads they created
 * themselves. 0075's own backfill set assignment from attribution for history,
 * which hides the gap on old rows and makes this look correct in any seeded
 * database.
 *
 * So: assignment wins where it exists, and attribution fills in where nobody
 * has assigned the lead to anyone. Re-assigning a lead away therefore removes
 * it from the previous holder's view, which is the point of assignment; an
 * unassigned lead stays with whoever sourced it, which is the point of
 * attribution. A lead assigned to someone ELSE is never visible through the
 * attribution branch, which is what keeps this a narrowing rather than a way
 * of seeing more.
 *
 * `deals` needs no such union: nothing creates a deal from a call, so an
 * unassigned deal is one nobody has been given, and the shared queue belongs
 * to whoever can see all of it - the same reading crm-scope.ts applies to an
 * unassigned conversation.
 */
export function ownerScopeFilter(
  object: OwnerScopedObject,
  scope: OwnerRecordScope,
  alias = "",
): { sql: string; value: string } | null {
  if (scope.scope !== "own") return null;

  const prefix = alias ? `${alias}.` : "";

  // A task belongs to a USER, not a telecaller identity - it is the one object
  // here the CRM grid also owns, and both must agree on the column or the same
  // row appears and disappears depending on which endpoint served it.
  if (object === "task") {
    const userId = scope.userId ?? MATCHES_NOTHING;
    return {
      sql: `(${prefix}assignee_user_id = $? OR ${prefix}created_by = $?)`,
      value: userId,
    };
  }

  const telecallerId = scope.telecallerId ?? MATCHES_NOTHING;

  if (object === "lead") {
    return {
      sql:
        `(${prefix}assigned_telecaller_id = $? OR ` +
        `(${prefix}assigned_telecaller_id IS NULL AND ${prefix}telecaller_id = $?))`,
      value: telecallerId,
    };
  }

  if (object === "deal") {
    return { sql: `${prefix}assigned_telecaller_id = $?`, value: telecallerId };
  }

  // Falls through for "call" and "telecaller_stats", which scope identically.
  //
  // `calls` has only the write-once snapshot (0068) - there is no assignment
  // concept for a recording, and there should not be: who spoke on a call is a
  // fact, not an allocation somebody can change afterwards. A
  // `telecaller_daily_stats` row (0090) is an aggregate of those same facts
  // and inherits the reasoning unchanged.
  //
  // This is a fall-through rather than two explicit branches because the
  // exhaustiveness test in owner-scope.spec.ts iterates every member of
  // OwnerScopedObject: a new object added to that union with no branch here
  // lands on the telecaller predicate, and the spec is what forces someone to
  // decide whether that is right for it.
  return { sql: `${prefix}telecaller_id = $?`, value: telecallerId };
}

/**
 * The same predicate for a query that builds its own parameter list, where
 * `$?` substitution is not available - `WHERE org_id = $1 AND <this>`.
 *
 * Takes the parameter INDEX rather than interpolating the id, because the
 * caller's identity is still resolved from caller-influenced input and this
 * file must contain no path where a uuid reaches a query as text.
 */
export function ownerScopeClause(
  object: OwnerScopedObject,
  scope: OwnerRecordScope,
  paramIndex: number,
  alias = "",
): string | null {
  const filter = ownerScopeFilter(object, scope, alias);
  if (!filter) return null;
  return filter.sql.replace(/\$\?/g, `$${paramIndex}`);
}

/**
 * The predicate as a bare SQL fragment, safe to inline into a statement that
 * takes NO bind parameters at all.
 *
 * This exists for one caller and the constraint is the database's, not a
 * shortcut: `/v1/owner/overview` issues its aggregates as a single
 * multi-statement round trip (owner.controller.ts explains why - Mumbai→Seoul
 * latency costs ~125ms per flight), and the multi-statement protocol accepts
 * no parameters. The uuid is therefore validated and rendered as a literal.
 *
 * SAFE BECAUSE THE VALUE IS NOT CALLER TEXT. `telecallerId` and `userId` are
 * read from the database by `OwnerScopeGuard`, never from a header or query
 * string, and the regex re-checks each is a bare uuid before it is
 * interpolated. Anything else collapses to the never-matching sentinel - a
 * lockout, not a leak. Do not widen this to take a value from the request; use
 * `ownerScopeClause` with a bind parameter.
 */
export function ownerScopeLiteral(
  object: OwnerScopedObject,
  scope: OwnerRecordScope,
  alias = "",
): string | null {
  const filter = ownerScopeFilter(object, scope, alias);
  if (!filter) return null;
  const uuid = UUID_RE.test(filter.value) ? filter.value : MATCHES_NOTHING;
  return filter.sql.replace(/\$\?/g, `'${uuid}'::uuid`);
}

/**
 * `AND <predicate>`, or an empty string - the form the multi-statement
 * overview query actually wants, so a caller never has to decide whether to
 * write the conjunction itself. Getting that wrong in one of seven statements
 * is exactly the silent leak this module exists to prevent.
 */
export function ownerScopeAnd(
  object: OwnerScopedObject,
  scope: OwnerRecordScope,
  alias = "",
): string {
  const sql = ownerScopeLiteral(object, scope, alias);
  return sql ? ` AND ${sql}` : "";
}

/** The scope a persona implies, before its identity is resolved. */
export function scopeForRole(role: OwnerRole): "all" | "own" {
  return ownerRoleRecordScope(role);
}
