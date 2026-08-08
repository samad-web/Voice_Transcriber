import { getPrincipal, isOperator, type Principal } from "@/lib/owner-context";

/**
 * The authorization check every Server Action in the `(platform)` group must run
 * for itself.
 *
 * READ THIS BEFORE ADDING THE NINTH ACTION TO THAT GROUP.
 *
 * A Server Action is not a function call. `"use server"` turns every exported
 * async function in the file into an independently-addressable POST endpoint
 * with a stable, guessable action id that ships in the client bundle. Anyone who
 * can reach the console can invoke one directly — with whatever arguments they
 * choose — without ever rendering the page it was written for.
 *
 * That is why `isOperator()` in `(platform)/layout.tsx` is NOT a boundary. A
 * layout runs during a *render*; it does not run when an action is invoked. The
 * layout decides what a browser is shown, and nothing more. Every one of these
 * actions also takes an `orgId` straight from its caller and sends the root
 * `ADMIN_API_KEY`, so an unguarded action is an unauthenticated cross-tenant
 * read — or, for `triggerErasureAction` / `wipeDeviceAction` / `mintKeyAction`,
 * an unauthenticated cross-tenant *write*.
 *
 * The rule, therefore: `await requireOperator()` is the FIRST statement of every
 * exported async function under `app/(platform)/` in a file named `actions.ts` —
 * first statement, not first statement inside the existing try, so that
 * reshaping that try cannot silently drop it. `(owner)/owner/actions.ts` does
 * the equivalent with
 * `getOwner()`; the difference is only which principal is acceptable.
 *
 * Note what this does NOT forbid: an operator naming any `orgId` they like. That
 * is precisely what a platform operator is for, and the instance console depends
 * on it. The defect was never that operators can cross tenants — it was that
 * *anyone* could.
 *
 * `getPrincipal()` is wrapped in React `cache()`, so calling this at the top of
 * every action costs one principal resolution per request, not one per action.
 * Do not add memoisation here.
 */

/**
 * Thrown when the caller is not an operator.
 *
 * Carries no detail on purpose. "Not signed in", "signed in but not on the
 * operator allowlist" and "that org does not exist" must be indistinguishable
 * from the outside: a refusal that explains itself is an oracle an attacker can
 * enumerate tenants with.
 */
export class NotAuthorizedError extends Error {
  constructor() {
    super("Not authorized");
    this.name = "NotAuthorizedError";
  }
}

/**
 * Assert the caller may act as a platform operator, and hand back who they are.
 *
 * Throws `NotAuthorizedError` otherwise — deliberately not `redirect()`. A
 * Server Action invoked outside a navigation has nowhere to redirect *to*, and
 * Next's redirect works by throwing a control-flow signal that a surrounding
 * `catch` in the action would swallow into a nonsense error. Actions instead
 * catch `NotAuthorizedError` and return their own error shape.
 */
export async function requireOperator(): Promise<Principal> {
  const principal = await getPrincipal();
  if (!isOperator(principal)) throw new NotAuthorizedError();
  // `isOperator` is a type-narrowing-free predicate over `Principal | null`, but
  // it returns false for null, so this is sound.
  return principal as Principal;
}
