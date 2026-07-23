import { MobileNav } from "@/components/mobile-nav";
import { Sidebar } from "@/components/sidebar";
import { getSessionUser } from "@/lib/supabase/server";

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const user = await getSessionUser();

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
