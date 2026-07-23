import { redirect } from "next/navigation";
import { Card, MonoLabel } from "@aura/ui";
import { MobileNav } from "@/components/mobile-nav";
import { Sidebar } from "@/components/sidebar";
import { SignOutButton } from "@/components/sign-out-button";
import { getPrincipal, isOperator } from "@/lib/owner-context";
import { getSessionUser } from "@/lib/supabase/server";

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

  // Every page in this group resolves its org from DEV_ORG_ID, so a customer
  // owner must never land here — they would be looking at another tenant's
  // calls. Send them to the console that is scoped to their own instance.
  const principal = await getPrincipal();
  if (principal?.kind === "owner") redirect("/owner");

  // Signed in, not an owner, and not on PLATFORM_OPERATOR_EMAILS. Shown rather
  // than redirected: the middleware bounces a signed-in user off /login, so
  // sending them there would just ping-pong.
  if (principal && !isOperator(principal)) {
    return (
      <main className="min-h-dvh flex items-center justify-center p-6">
        <Card shadow className="max-w-md space-y-4">
          <MonoLabel>No console access</MonoLabel>
          <p className="text-sm font-sans text-neutral-600 leading-relaxed">
            {principal.email} is signed in but is not linked to an instance. Ask
            your provider to create an owner login for your company.
          </p>
          <SignOutButton />
        </Card>
      </main>
    );
  }

  return (
    <div className="min-h-dvh flex flex-col md:flex-row">
      <Sidebar email={user?.email} />
      <MobileNav email={user?.email} />
      {/* min-w-0 stops wide tables/code blocks from widening the flex row and
          giving the whole page a horizontal scrollbar. */}
      <main className="flex-1 min-w-0 flex flex-col p-4 sm:p-5 md:p-8 space-y-5 sm:space-y-6">
        {children}
      </main>
    </div>
  );
}
