import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { PermissionObjectType, PermissionScope } from "@aura/shared";
import type { PrincipalRequest } from "./auth-principal";

/**
 * Row-level scope for the CRM objects - the `owned` half of migration 0039's
 * permission grid.
 *
 * ── WHY THIS IS NOT IN THE GUARD ──────────────────────────────────────────
 *
 * A guard answers yes or no to a whole request. "This role may view deals, but
 * only their own" is not a yes-or-no question about the request - it is a
 * predicate on every row the request touches, and the only place that can be
 * applied is the query. So `CrmPermissionsGuard` resolves the scope and hands
 * it to the controller through the request; each query adds the filter.
 *
 * That split is worth stating because it has a failure mode: a controller that
 * forgets to apply the filter is not a compile error, it is a silent leak. Two
 * things push against that - `scopeFilter()` is the only way to build the
 * predicate, so it is greppable, and `crm-scope.spec.ts` pins the column each
 * object scopes on.
 *
 * ── WHAT `owned` MEANS PER OBJECT ─────────────────────────────────────────
 *
 * Contact, account and deal all carry `owner_user_id`, so ownership is
 * literal. A task does not: it has an assignee and a creator, and a rep who
 * asked a colleague to do something still needs to see it. So a task is
 * "yours" if you are either end of it - which is what a person means when they
 * say "my tasks", and narrower than it sounds, since it is still only tasks
 * you are actually part of.
 */

export interface CrmRecordScope {
  scope: PermissionScope;
  /** The acting user, or null for the bare admin key (which is never scoped). */
  userId: string | null;
}

/** Nothing narrows: the bare admin key, and every role granted `all`. */
export const UNSCOPED: CrmRecordScope = { scope: "all", userId: null };

/**
 * The scope the guard resolved for this request.
 *
 * Defaults to UNSCOPED when absent, which is the correct default for exactly
 * one reason: absent means no `@RequireCrmPermission` ran, and a route with no
 * permission requirement has no grant to read a scope from. Any route that DOES
 * declare a requirement always gets a value written by the guard.
 */
export const RecordScope = createParamDecorator(
  (_data: unknown, context: ExecutionContext): CrmRecordScope => {
    const req = context.switchToHttp().getRequest<PrincipalRequest & { crmScope?: CrmRecordScope }>();
    return req.crmScope ?? UNSCOPED;
  },
);

/** Which column carries ownership, per object. Null = the object has no single owner column. */
const OWNER_COLUMN: Record<PermissionObjectType, string | null> = {
  contact: "owner_user_id",
  account: "owner_user_id",
  deal: "owner_user_id",
  // Tasks are handled by ownerPredicate's two-column branch below.
  task: null,
  // A conversation's owner is whoever it is assigned to. An UNASSIGNED thread
  // is therefore invisible to an `owned`-scoped role - which is the intended
  // reading: the shared queue belongs to whoever can see all of it, and a rep
  // scoped to their own work should not be answering correspondence nobody
  // has routed to them.
  conversation: "assigned_user_id",
  // A product is a shared catalogue entry, not a person's record - no owner
  // column exists and none of its routes use RecordScope/scopeClause.
  product: null,
  quotation: "owner_user_id",
  invoice: "owner_user_id",
};

/**
 * A SQL predicate restricting rows to the caller's own, or null when nothing
 * should be restricted.
 *
 * `alias` is the table alias in the caller's query (`d` for deals, `""` for an
 * unaliased one). The returned `sql` contains a single `$?` placeholder that
 * the caller substitutes, matching the `add()` helper every list endpoint in
 * this codebase already uses.
 */
export function scopeFilter(
  objectType: PermissionObjectType,
  scope: CrmRecordScope,
  alias = "",
): { sql: string; value: string } | null {
  if (scope.scope !== "owned") return null;
  // A scoped role with no resolvable user is a contradiction the guard should
  // already have refused. Returning a predicate that matches NOTHING is the
  // safe reading of it - an empty list beats everyone's list.
  const userId = scope.userId ?? "00000000-0000-0000-0000-000000000000";

  const prefix = alias ? `${alias}.` : "";
  const column = OWNER_COLUMN[objectType];

  if (column) return { sql: `${prefix}${column} = $?`, value: userId };

  // `task` is the one object with no single owner column - either end of it.
  // Both branches compare to the SAME parameter, so the caller still
  // substitutes exactly one value.
  if (objectType === "task") {
    return {
      sql: `(${prefix}assignee_user_id = $? OR ${prefix}created_by = $?)`,
      value: userId,
    };
  }

  // Any other null-column object (e.g. `product`, a shared catalogue entry
  // with no per-record owner) has nothing to restrict `owned` scope BY - that
  // scope should never actually be granted for it, but if it somehow is, the
  // safe reading is "no narrower than `all`", not a query against columns the
  // table doesn't have.
  return null;
}

/**
 * The same predicate for a query that builds its own parameter list, where
 * `$?` substitution is not available - `WHERE id = $1 AND <this>`.
 *
 * Takes the parameter INDEX rather than interpolating the id, because a uuid
 * from a header is still caller-influenced input and this file should contain
 * no path where one reaches a query as text.
 */
export function scopeClause(
  objectType: PermissionObjectType,
  scope: CrmRecordScope,
  paramIndex: number,
  alias = "",
): string | null {
  const filter = scopeFilter(objectType, scope, alias);
  if (!filter) return null;
  return filter.sql.replace(/\$\?/g, `$${paramIndex}`);
}
