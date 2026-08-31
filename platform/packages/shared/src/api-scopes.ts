import { z } from "zod";

/**
 * What an external integration key is allowed to do.
 *
 * ── WHY A NEW VOCABULARY AND NOT `PermissionObjectType` × action ──────────
 *
 * The CRM permission grid (0039, packages/shared/src/permissions.ts) describes
 * what a PERSON may do, and is resolved through their memberships and roles. An
 * API key is not a person: it has no membership, no role, and no `owned` vs
 * `all` record scope to resolve against, because there is nobody for a record
 * to be owned BY. Modelling it as a synthetic user with a synthetic role would
 * put a credential with no human behind it into the same grid the console uses
 * to answer "may Priya edit this deal", and every future permission question
 * would have to remember that some principals are not people.
 *
 * So: a small, closed, flat list. Easy to read on a key-creation screen, easy
 * to reason about in a security review, and impossible to accidentally widen -
 * adding a scope means editing this array, the CHECK in migration 0076, and
 * the route that requires it.
 *
 * ── WHAT IS DELIBERATELY ABSENT ───────────────────────────────────────────
 *
 * There is no `recordings:*`, no `transcripts:*`, and no `messages:send`.
 *
 * The first two because call audio and transcripts are the most sensitive data
 * in the product and are gated on a person's own `recordings_listen` /
 * `recordings_export` flags - a headless credential should not be able to reach
 * them at all, and the safest way to guarantee that is for the scope not to
 * exist.
 *
 * The third because of the standing rule that nothing automated can send. An
 * integration may create a lead, read a pipeline, and label a project; it may
 * not put a message in front of a human being. That rule is enforced by there
 * being no scope, no route, and no MCP tool that sends - not by a runtime check
 * somebody could later relax.
 *
 * There is also no `:delete` on anything. An integration that can create data
 * is useful; one that can destroy it is a liability with no matching upside,
 * and deletion stays a decision a person makes in the console.
 */
export const API_SCOPES = [
  "leads:read",
  "leads:write",
  "contacts:read",
  "contacts:write",
  "deals:read",
  "deals:write",
  "projects:read",
  /**
   * Permission to speak MCP at all, independent of what the key may then do.
   *
   * Held separately so an ordinary backend integration key cannot be pointed at
   * the MCP endpoint and driven by a model. A key reaching the MCP transport
   * needs BOTH this and the data scope for each tool it calls, so "this key may
   * be used by an AI agent" is an explicit, separately-auditable decision
   * rather than something implied by already having `leads:write`.
   */
  "mcp",
] as const;

export const ApiScope = z.enum(API_SCOPES);
export type ApiScope = z.infer<typeof ApiScope>;

/** Keeps the DB CHECK in 0076 and this list honest about being the same set. */
export const ApiScopeList = z.array(ApiScope).max(API_SCOPES.length);

/**
 * A `:read` scope is implied by its `:write` counterpart.
 *
 * Creating a record returns it, and every create path here find-or-creates -
 * so a write already discloses whether a record existed and what it holds. A
 * key with `leads:write` but not `leads:read` would therefore be a distinction
 * the implementation cannot actually honour, and pretending otherwise on the
 * key-creation screen would be security theatre. Better to state the implication
 * in one place and have the guard apply it.
 */
export function effectiveScopes(granted: readonly string[]): Set<string> {
  const out = new Set<string>(granted);
  for (const scope of granted) {
    const [object, action] = scope.split(":");
    if (action === "write") out.add(`${object}:read`);
  }
  return out;
}

export function hasScope(granted: readonly string[], required: ApiScope): boolean {
  return effectiveScopes(granted).has(required);
}
