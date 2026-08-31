import { NoConsoleAccess } from "@/components/no-console-access";
import { getPrincipal, isOperator } from "@/lib/owner-context";

/**
 * Page-level twin of `operator-guard.ts`'s `requireOperator()`.
 *
 * `(platform)/layout.tsx` and `(admin)/layout.tsx` already call `isOperator()`
 * and substitute `<NoConsoleAccess>` for a non-operator's whole subtree. That
 * is correct for what a BROWSER ends up seeing, but it says nothing about the
 * ORDER work happens in: Next renders a layout and the page inside it as part
 * of the same pass, and a page that fetches with the root admin key on an
 * `orgId` taken from `?org=`/`[id]` does that fetching on its own schedule,
 * not after the layout's decision. The same reasoning that put
 * `requireOperator()` at the top of every Server Action - the guard has to be
 * the first thing that runs, not a wrapper hoping to run first - applies here.
 *
 * A Server Action has no render to fall back to, so it throws. A page IS a
 * render, so it can express "you may not see this" as its own return value.
 *
 * Usage, as the first two statements of the page component:
 *
 *   const blocked = await operatorGate();
 *   if (blocked) return blocked;
 *
 * Note what this does NOT forbid: an operator naming any `orgId` they like.
 * That is what a platform operator is for. The defect this closes is that the
 * fetch could run before anyone had checked the caller was an operator at
 * all - not that operators can cross tenants.
 */
export async function operatorGate() {
  const principal = await getPrincipal();
  if (isOperator(principal)) return null;
  return <NoConsoleAccess email={principal?.email ?? ""} />;
}
