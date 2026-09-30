import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import { OWNER_UNSCOPED, type OwnerRecordScope } from "@aura/shared";
import type { PrincipalRequest } from "./auth-principal";

/**
 * Row-level scope for the OWNER CONSOLE's personas (migration 0079).
 *
 * ── THE PREDICATE MOVED; THE DECORATOR DID NOT ────────────────────────────
 *
 * Everything that BUILDS SQL now lives in `@aura/shared/owner-scope` and is
 * re-exported below, so every call site in this app is unchanged and
 * `owner-scope.spec.ts` still pins the column each object scopes on.
 *
 * It moved for the data export engine (doc 35, migration 0148). That worker
 * must apply EXACTLY this predicate and is a separate Nest application context
 * that cannot import this module graph - so the choice was one shared
 * implementation or a second copy in the worker. A duplicated scope predicate
 * is the worst kind this codebase has: the copy that drifts does not throw and
 * does not render wrong, it just returns more rows than the person may see,
 * in a file, silently.
 *
 * What stays here is `@OwnerScope()`, which needs Nest and therefore cannot
 * live in a package the worker loads. See the shared module's header for the
 * whole design, including why leads take the union of assignment and
 * attribution and deals do not.
 */

export {
  OWNER_UNSCOPED,
  ownerScopeAnd,
  ownerScopeClause,
  ownerScopeFilter,
  ownerScopeLiteral,
  scopeForRole,
  type OwnerRecordScope,
  type OwnerScopedObject,
} from "@aura/shared";

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
