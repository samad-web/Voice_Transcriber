import { redirect } from "next/navigation";
import { MobileNav } from "@/components/mobile-nav";
import { Sidebar } from "@/components/sidebar";
import { getOwner } from "@/lib/owner-context";

/**
 * The customer owner's console.
 *
 * Its entire security model is this redirect plus `getOwner()`: the org is
 * resolved on the server from a verified session, never from the URL or a
 * header, so there is no id an owner could change to see another tenant. Pages
 * inside pass that org explicitly to every API call.
 */
export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const owner = await getOwner();
  // Signed in but not an owner → the operator console. Not signed in at all →
  // the middleware already sent them to /login before this ran.
  if (!owner) redirect("/dashboard");

  const company = owner.membership.orgName || "Owner Console";

  return (
    <div className="min-h-dvh flex flex-col md:flex-row">
      <Sidebar email={owner.email} area="owner" title={company} subtitle="Sales Pipeline" />
      <MobileNav email={owner.email} area="owner" title={company} subtitle="Sales Pipeline" />
      <main className="flex-1 min-w-0 flex flex-col p-4 sm:p-5 md:p-8 space-y-5 sm:space-y-6">
        {children}
      </main>
    </div>
  );
}
