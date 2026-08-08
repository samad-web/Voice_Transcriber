import { redirect } from "next/navigation";
import { NoConsoleAccess } from "@/components/no-console-access";
import { getPrincipal, isOperator } from "@/lib/owner-context";

/**
 * Gate for the platform-admin group.
 *
 * This group had no layout at all, so its only gate was the middleware — which
 * proves *a* session exists, not that it belongs to us. Any signed-in account
 * could open /admin and read the tenant list (every customer's name, region,
 * call and device counts) and global pipeline health. The page's own TODO
 * ("gate behind platform_admin") is this file.
 *
 * Same three decisions as (platform)/layout, in the same order and with the
 * same card, because /admin is strictly more sensitive than /dashboard — it may
 * never be the laxer of the two. No chrome is added: the admin page renders its
 * own full-page shell.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const principal = await getPrincipal();

  // A customer owner belongs in their own instance console, never here.
  if (principal?.kind === "owner") redirect("/owner");

  if (principal && !isOperator(principal)) {
    return <NoConsoleAccess email={principal.email} />;
  }

  return <>{children}</>;
}
