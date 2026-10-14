/**
 * WHICH CLIENTS THIS OPERATOR MAY SEE (doc 49 P13b).
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * The root sees every client. A superadmin sees the clients they onboarded. A
 * client onboarded by the root - or by nobody, which is every tenant that
 * predates migration 0206 - is visible to the root only.
 *
 * ── THE IMPORTANT PART IS NOT THIS FUNCTION ─────────────────────────────────
 *
 * It is that there must be exactly ONE of it, and that every cross-tenant read
 * goes through it. By doc 49's count the operator console has more than twenty
 * such reads: `/dashboard`'s fleet rollup, `/instances`, `/support`,
 * `/provisioning`, `/adoption`, `/slots`, `/leads`, `/team`, `/roles`,
 * `/api-keys`, the reprocess panel, the insights pages, and each of the ten
 * per-tenant screens under `/instances/[id]`.
 *
 * Miss one and it leaks the whole fleet. This is the same shape as the five
 * holes doc 39's partner RLS wall had, and it behaves the same way: the sites
 * you remember are fine and the twenty-first is the problem. So the predicate
 * is a SQL fragment rather than a post-filter in JavaScript - a query that
 * forgets it returns too many rows and is obvious, where a forgotten
 * `.filter()` returns too many rows and looks like a working endpoint.
 * `operator-scope.spec.ts` greps for the sites.
 *
 * ── THE HONEST LIMITATION, WHICH MUST BE READ BEFORE THIS IS TRUSTED ────────
 *
 * **This is a console-tier filter, not a containment of a hostile superadmin.**
 *
 * Every operator holds - or can reach - `ADMIN_API_KEY`, which is cross-tenant
 * by design and selects its tenant from a trusted `x-org-id` header. A filtered
 * superadmin can therefore still read a root-onboarded client by calling the
 * API directly with that key. What this buys is organisational hygiene: it
 * keeps account managers out of each other's books and keeps the console
 * legible.
 *
 * So the UI must say "your clients", never "only you can see this".
 *
 * Doc 49 names P5-A as the prerequisite for making it a real boundary, and
 * P5-A is now BUILT - the API verifies a Supabase JWT and pins the org from
 * `users.sso_subject` → `memberships`. That closes it for a caller presenting a
 * SESSION. It does not close it for a caller presenting the admin key, because
 * the admin key is still what the operator console uses for every cross-tenant
 * read, and moving the console onto per-user sessions is P5-B. Until then this
 * sentence stands, and this codebase already states the principle in
 * `owner-calls.controller.ts`: "a hidden page is not a closed door - the URL is
 * guessable and the session is real."
 */

export interface OperatorPrincipal {
  /** Lower-cased, from the verified `x-operator-email` header. */
  email: string | null;
  /** True only for `PLATFORM_ROOT_OPERATOR_EMAIL`. Never read from a table. */
  isRoot: boolean;
}

export type OperatorOrgScope =
  /** Every client. The root, and the no-auth local-dev mode. */
  | { kind: "all" }
  /** The clients this address onboarded, and nothing else. */
  | { kind: "onboarded_by"; email: string }
  /**
   * No client at all.
   *
   * Reached when an operator-scoped read arrives with no operator identity -
   * a script holding the admin key, a route that forgot to forward
   * `x-operator-email`, a header that failed to parse. Returning NOTHING rather
   * than EVERYTHING is the whole point: the failure mode of a missing identity
   * must be an empty screen somebody reports, not the fleet.
   */
  | { kind: "none" };

/**
 * The root, from the environment.
 *
 * Never from the database, and 0089's header has the argument: the root is what
 * authorises changes to `platform_operators`, so a root stored in that table
 * could be deleted by anything that reaches the table and replaced with an
 * attacker's address. Resolved per call rather than captured at module load, so
 * a test can exercise both branches.
 */
export function rootOperatorEmail(): string {
  return (process.env.PLATFORM_ROOT_OPERATOR_EMAIL ?? "").trim().toLowerCase();
}

/** Is this address the root? */
export function isRootOperator(email: string | null | undefined): boolean {
  const root = rootOperatorEmail();
  if (!root) return false;
  return (email ?? "").trim().toLowerCase() === root;
}

/**
 * What this operator may see.
 *
 * `OPERATOR_SCOPE_ENABLED` defaults to OFF, and that is deliberate for a
 * reason doc 49 states and this code must respect: the backfill leaves every
 * existing tenant unattributed, so switching the filter on before anybody has
 * attributed them makes four live clients vanish from every superadmin's
 * console at once. An operator console that suddenly shows nothing is
 * indistinguishable from an outage.
 *
 * So: ship the mechanism, attribute the clients, then throw the switch. The
 * sequence is in DEPLOYMENT.md §13.
 */
export function operatorOrgScope(principal: OperatorPrincipal): OperatorOrgScope {
  if (process.env.OPERATOR_SCOPE_ENABLED !== "1") return { kind: "all" };
  if (principal.isRoot) return { kind: "all" };
  if (!principal.email) return { kind: "none" };
  return { kind: "onboarded_by", email: principal.email.trim().toLowerCase() };
}

/**
 * The scope as SQL, to be ANDed into a cross-tenant read.
 *
 * @param scope      from `operatorOrgScope`
 * @param orgColumn  the column naming the tenant in the caller's query, e.g.
 *                   `o.id` or `c.org_id`. A COLUMN REFERENCE, never anything
 *                   derived from a request - it is interpolated, and
 *                   `operator-scope.spec.ts` asserts every call site passes a
 *                   literal.
 * @param nextParam  the next free `$n` index in the caller's parameter list
 *
 * Returns a fragment and the parameters to append. The fragment is always a
 * complete boolean expression, so a caller can AND it in unconditionally
 * without having to think about the "all" case - which is exactly the kind of
 * thinking that produces the twenty-first unfiltered read.
 */
export function operatorScopeSql(
  scope: OperatorOrgScope,
  orgColumn: string,
  nextParam: number,
): { sql: string; params: string[] } {
  if (scope.kind === "all") return { sql: "TRUE", params: [] };
  if (scope.kind === "none") return { sql: "FALSE", params: [] };
  return {
    // The subquery rather than a join, so the caller's own FROM clause does not
    // have to change shape - a filter that requires restructuring a query is a
    // filter somebody leaves out.
    sql: `EXISTS (
            SELECT 1 FROM organizations scope_o
             WHERE scope_o.id = ${orgColumn}
               AND scope_o.onboarded_by_operator = $${nextParam}
          )`,
    params: [scope.email],
  };
}

/**
 * Build the principal from a request.
 *
 * `x-operator-email` is set by the web tier from a verified `getClaims()`, and
 * `AdminKeyGuard` parses and lower-cases it onto `principal.operatorEmail`. It
 * names WHICH operator is asking and authorises nothing by itself, which is why
 * an absent or unrecognised address resolves to `{ kind: "none" }` rather than
 * to the fleet.
 */
export function operatorPrincipalFrom(req: {
  principal?: { operatorEmail?: string | null } | null;
}): OperatorPrincipal {
  const email = req.principal?.operatorEmail?.trim().toLowerCase() || null;
  return { email, isRoot: isRootOperator(email) };
}

/** The scope for this request, in one call. The form every route should use. */
export function scopeForRequest(req: {
  principal?: { operatorEmail?: string | null } | null;
}): OperatorOrgScope {
  return operatorOrgScope(operatorPrincipalFrom(req));
}

/** One line for the console, so a filtered screen says so. */
export function describeScope(scope: OperatorOrgScope): string | null {
  if (scope.kind === "all") return null;
  if (scope.kind === "none") return "No clients are attributed to this account.";
  return "Showing your clients only.";
}
