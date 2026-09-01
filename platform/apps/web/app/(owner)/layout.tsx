import { redirect } from "next/navigation";
import { MobileNav } from "@/components/mobile-nav";
import { Sidebar } from "@/components/sidebar";
import { crmShadowReadEnabled } from "@/lib/crm-cutover";
import { getOwner } from "@/lib/owner-context";
import { NotificationBell } from "./owner/notifications/notification-bell";

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
  // A6: which page group the sidebar leads with. Neither group is hidden by
  // this - see lib/crm-cutover.ts.
  const crmPrimary = crmShadowReadEnabled();
  // Whether this ORG has the CRM module at all (migration 0072) - unlike
  // crmPrimary, this does hide nav items. See nav.ts's CRM_GATED_HREFS.
  const crmEnabled = owner.membership.enabledModules.includes("crm");
  // Same column, separate entitlement: whether this client may read the AI
  // read of their own calls, and the transcripts behind it (org-modules.ts).
  const callIntelEnabled = owner.membership.enabledModules.includes("call_intel");

  return (
    <div className="min-h-dvh flex flex-col md:flex-row">
      <Sidebar
        email={owner.email}
        area="owner"
        ownerRole={owner.membership.ownerRole}
        crmPrimary={crmPrimary}
        crmEnabled={crmEnabled}
        callIntelEnabled={callIntelEnabled}
        title={company}
        subtitle="Sales Pipeline"
      />
      <MobileNav
        email={owner.email}
        area="owner"
        ownerRole={owner.membership.ownerRole}
        crmPrimary={crmPrimary}
        crmEnabled={crmEnabled}
        callIntelEnabled={callIntelEnabled}
        title={company}
        subtitle="Sales Pipeline"
      />
      <main className="flex-1 min-w-0 flex flex-col p-4 sm:p-5 md:p-8 space-y-5 sm:space-y-6">
        {/* The bell sits in the layout rather than on a page, so an assignment
            reaches somebody wherever they happen to be in the console. */}
        <div className="flex justify-end">
          <NotificationBell />
        </div>
        {children}
      </main>
    </div>
  );
}
