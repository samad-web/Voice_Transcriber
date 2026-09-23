import { redirect } from "next/navigation";
import { BackButton } from "@/components/back-button";
import { BreadcrumbProvider } from "@/components/breadcrumbs";
import { MobileNav } from "@/components/mobile-nav";
import { NavHistoryProvider } from "@/components/nav-history-provider";
import { NoConsoleAccess } from "@/components/no-console-access";
import { RealtimeIndicator } from "@/components/realtime-indicator";
import { RealtimeProvider } from "@/components/realtime-provider";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { getPrincipal, isOperator } from "@/lib/owner-context";
import { getSessionUser } from "@/lib/supabase/server";

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  // Every page in this group resolves its org from DEV_ORG_ID, so a customer
  // owner must never land here - they would be looking at another tenant's
  // calls. Send them to the console that is scoped to their own instance.
  const principal = await getPrincipal();
  if (principal?.kind === "owner") redirect("/owner");

  // Signed in, not an owner, and not on PLATFORM_OPERATOR_EMAILS - which is
  // now the default answer, not the exceptional one (see isOperator).
  if (principal && !isOperator(principal)) {
    return <NoConsoleAccess email={principal.email} />;
  }

  const realtimeEnabled = process.env.REALTIME_DISABLED !== "1";

  return (
    <RealtimeProvider enabled={realtimeEnabled}>
    {/* The operator console has no breadcrumbs, so Back (doc 28 §3) is its
        only way up from a page like /instances/<id>/calls. Its org is null:
        operator pages carry the tenant in `?org=`, where it is already
        visible. */}
    <BreadcrumbProvider>
    <NavHistoryProvider area="platform" orgId={null}>
    <div className="min-h-dvh flex flex-col md:flex-row">
      <Sidebar email={user?.email} />
      <MobileNav email={user?.email} />
      {/* min-w-0 stops wide tables/code blocks from widening the flex row and
          giving the whole page a horizontal scrollbar. */}
      <main className="flex-1 min-w-0 flex flex-col p-4 sm:p-5 md:p-8 space-y-5 sm:space-y-6">
        {/* The operator console watches every tenant at once, so it is the one
            place where "is this still live?" cannot be answered by recognising
            that your own numbers stopped moving. */}
        <div className="print-hide flex items-center justify-end gap-1">
          {/* First in the row; below `md` the phone bar carries it instead. */}
          <div className="hidden md:mr-1 md:flex">
            <BackButton />
          </div>
          <ThemeToggle />
          <RealtimeIndicator />
        </div>
        {children}
      </main>
    </div>
    </NavHistoryProvider>
    </BreadcrumbProvider>
    </RealtimeProvider>
  );
}
