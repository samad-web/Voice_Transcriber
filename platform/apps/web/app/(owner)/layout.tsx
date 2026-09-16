import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  OWNER_ROLE_LABELS,
  brandingCssVars,
  browserTitleFor,
  seesSetupChecklist,
  type SetupState,
} from "@aura/shared";
import { BreadcrumbProvider, OwnerBreadcrumbs } from "@/components/breadcrumbs";
import { ConsoleHeader } from "@/components/console-header";
import { GlobalSearch } from "@/components/global-search";
import { MobileNav } from "@/components/mobile-nav";
import { TenantContextSwitcher, type TenantChip } from "@/components/tenant-context-switcher";
import { RealtimeIndicator } from "@/components/realtime-indicator";
import { RealtimeProvider } from "@/components/realtime-provider";
import { Sidebar } from "@/components/sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import { crmShadowReadEnabled } from "@/lib/crm-cutover";
import { SetupGate } from "@/components/setup-gate";
import { getOwner, getOwnerBranding, ownerGet, type OwnerMembership } from "@/lib/owner-context";
import { tenantAccent, tenantInitials } from "@/lib/tenant-accent";
import { NotificationBell } from "./owner/notifications/notification-bell";
import { switchTenantAction } from "./owner/tenant-actions";

/** A membership as the header's tenant switcher draws it. */
function tenantChip(m: OwnerMembership): TenantChip {
  const name = m.orgName || "Your workspace";
  return {
    orgId: m.orgId,
    name,
    initials: tenantInitials(name),
    logoUrl: m.branding.logoUrl ?? null,
    roleLabel: OWNER_ROLE_LABELS[m.ownerRole],
    accent: tenantAccent(m.orgId, m.branding),
  };
}

/**
 * The tab title and favicon for every page under /owner (migration 0065's
 * `branding.browserTitle` / `branding.faviconUrl`).
 *
 * A TEMPLATE, not a fixed title. The 38 pages below each set their own name
 * ("Contacts", "Lead Board"), and Next fills this in around it - so the org's
 * name is written once, here, instead of in every page. Those pages used to
 * hardcode "- Aura" in their own titles, which is why `browserTitle` had never
 * worked no matter what this layout did: a nested page title replaces its
 * parent's outright.
 *
 * The fallback is "Aura" rather than the org name deliberately - it keeps the
 * tab reading exactly as it did for every tenant that has not set a title, so
 * this change is invisible until somebody asks for it.
 *
 * `icons` overrides the app/favicon.ico file convention for this route group
 * only; the operator console and the marketing site keep the Aura mark, which
 * is right - they are ours, not the tenant's.
 */
export async function generateMetadata(): Promise<Metadata> {
  const branding = await getOwnerBranding();
  const brand = browserTitleFor(branding, "Aura");

  return {
    title: { default: brand, template: `%s - ${brand}` },
    ...(branding.faviconUrl ? { icons: { icon: branding.faviconUrl } } : {}),
  };
}

/**
 * The customer owner's console.
 *
 * Its entire security model is this redirect plus `getOwner()`: the org is
 * resolved on the server from a verified session, never from the URL or a
 * header, so there is no id an owner could change to see another tenant. Pages
 * inside pass that org explicitly to every API call.
 *
 * ── WHERE BRANDING IS APPLIED ───────────────────────────────────────────────
 *
 * Here, once, for the whole console. `brandingCssVars` returns the custom
 * properties this org overrides and they are set on the root element below, so
 * they inherit into every page.
 *
 * That is the entire mechanism, and it is why nothing else in the console had
 * to change: theme.css declares `--brand-gradient` in terms of `--brand-from` /
 * `--brand-mid` / `--brand-to`, and CSS substitutes custom properties where
 * they are USED, not where they are declared. Moving the three stops here
 * re-colours every consumer of that gradient - the primary Button, PageHeader,
 * the active nav item, every tab strip, the loading skeletons - without
 * touching any of them. The accent ramp works the same way for `bg-accent`,
 * `text-accent-text` and the focus ring, and so does the dashboard's KPI band:
 * `--color-kpi` / `--color-kpi-fg` / `--color-kpi-hairline` land here and every
 * StatCard in the console picks them up without knowing a tenant exists.
 *
 * The KPI trio is the one set that is COMPUTED rather than passed through -
 * it is the only place a tenant's hex becomes a filled surface with 12px text
 * printed on it, so `kpiSurface()` shifts the fill where it has to and derives
 * the matching foreground. See branding.ts.
 *
 * What is deliberately NOT here: the four state hues. `--color-danger`,
 * `--color-success`, `--color-accent`-as-outgoing and `--color-orange` encode
 * call state (@aura/ui's state.tsx), and a console where red meant "missed" for
 * one customer and "on brand" for another would have no colour system at all.
 * White-labelling owns the chrome; it does not own the alphabet.
 *
 * The colours are only applied to THIS route group. The operator console is
 * cross-tenant: painting it in one customer's colours would misrepresent whose
 * data is on screen.
 */
export default async function OwnerLayout({ children }: { children: React.ReactNode }) {
  const owner = await getOwner();
  // Signed in but not an owner → the operator console. Not signed in at all →
  // the middleware already sent them to /login before this ran.
  if (!owner) redirect("/dashboard");

  const branding = await getOwnerBranding();
  const brandVars = brandingCssVars(branding);
  // Only paint a background when the tenant actually chose one. Falling through
  // to the body's own colour keeps an unbranded console pixel-identical to what
  // it was, rather than shifting every tenant from #F9F9F9 to the token's white.
  const background = brandVars["--color-bg"];

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
  // The finer axis (migration 0101): which FEATURES inside those modules the
  // client has switched on. Passed RAW to both rails and resolved inside
  // `ownerRailFor`, which calls the same `enabledFeatures` the API and the
  // worker use - one resolution, three tiers, so the rail can never offer a
  // page the API refuses. The page-level `requireFeature` is the backstop for
  // a bookmark, not the primary experience.
  const entitlement = {
    modules: owner.membership.enabledModules,
    features: owner.membership.featureOverrides,
  };

  // Read here, on the server, rather than baked into the client bundle: an
  // operator turning live updates off must take effect on a restart, not on a
  // rebuild. Same variable the API and worker read (realtime.service.ts).
  const realtimeEnabled = process.env.REALTIME_DISABLED !== "1";

  // ── The new-client setup checklist (migration 0106) ───────────────────────
  //
  // Two gates before the fetch, and they are the whole performance story.
  //
  // `setupCompletedAt` rides on the org row `contextFor` already read, so a
  // tenant that finished onboarding - which is every tenant, for all but the
  // first few days of its life - costs NOTHING here: no call, no query, no
  // render. Every existing org was backfilled as complete by 0106, so this is
  // invisible to them from the moment it ships.
  //
  // The persona check is not an optimisation, it is the same rule the API
  // enforces: a telecaller cannot upload a logo or connect a payment account,
  // so a checklist about it would be a standing notice about somebody else's
  // job.
  //
  // Only when both say yes does the layout spend one round trip - during
  // onboarding, which is exactly when it earns it.
  const needsSetup =
    !owner.membership.setupCompletedAt && seesSetupChecklist(owner.membership.ownerRole);
  const setup = needsSetup
    ? (await ownerGet<{ setup: SetupState | null }>("/v1/owner/setup"))?.setup ?? null
    : null;

  // The header's tenant context. Built from the memberships the session
  // already resolved - no extra request - and only ever offering tenants this
  // person belongs to and that are active (switchTenantAction re-checks both).
  const currentTenant = tenantChip(owner.membership);
  const otherTenants = owner.memberships
    .filter((m) => m.orgId !== owner.membership.orgId && m.orgStatus === "active")
    .map(tenantChip);

  return (
    <RealtimeProvider enabled={realtimeEnabled}>
    <div
      className="min-h-dvh flex flex-col md:flex-row"
      // Custom properties are not in React's CSSProperties, hence the cast -
      // the values themselves are all validated hexes out of the Zod schema,
      // never raw tenant input.
      style={{ ...brandVars, ...(background ? { backgroundColor: background } : {}) } as React.CSSProperties}
    >
      <Sidebar
        email={owner.email}
        area="owner"
        ownerRole={owner.membership.ownerRole}
        crmPrimary={crmPrimary}
        crmEnabled={crmEnabled}
        callIntelEnabled={callIntelEnabled}
        entitlement={entitlement}
        title={company}
        subtitle="Sales Pipeline"
        logoUrl={branding.logoUrl}
      />
      <MobileNav
        email={owner.email}
        area="owner"
        ownerRole={owner.membership.ownerRole}
        crmPrimary={crmPrimary}
        crmEnabled={crmEnabled}
        callIntelEnabled={callIntelEnabled}
        entitlement={entitlement}
        title={company}
        subtitle="Sales Pipeline"
        logoUrl={branding.logoUrl}
        accentColor={currentTenant.accent.swatch}
      />
      <BreadcrumbProvider>
      <div className="flex min-w-0 flex-1 flex-col">
      <ConsoleHeader
        accentColor={currentTenant.accent.swatch}
        tenant={
          <TenantContextSwitcher
            current={currentTenant}
            others={otherTenants}
            switchAction={switchTenantAction}
          />
        }
        search={<GlobalSearch />}
        actions={
          // The bell sits in the layout rather than on a page, so an assignment
          // reaches somebody wherever they happen to be in the console. The live
          // indicator sits beside it because they answer the same question from
          // two directions: the bell says what happened, this says whether you
          // would have been told. The theme toggle sits here too - one click,
          // reachable from every page, rather than a control someone has to
          // remember lives inside the account panel.
          <>
            <ThemeToggle />
            <RealtimeIndicator />
            <NotificationBell />
          </>
        }
      />
      <main className="flex-1 min-w-0 flex flex-col p-4 sm:p-5 md:p-8 space-y-5 sm:space-y-6">
        {/* Nested views only - renders nothing on a top-level page. */}
        <OwnerBreadcrumbs
          ownerRole={owner.membership.ownerRole}
          crmPrimary={crmPrimary}
          crmEnabled={crmEnabled}
          callIntelEnabled={callIntelEnabled}
          entitlement={entitlement}
        />
        {/* Above the tenant's own banner and above the page: it is the first
            thing a new client should read, and the last thing they should have
            to scroll for. */}
        {setup && !setup.complete ? (
          <SetupGate setup={setup} canDismiss={owner.membership.ownerRole === "owner"} />
        ) : null}
        {branding.bannerUrl ? (
          // Decorative, and `print-hide`: a tenant's banner is console chrome,
          // not part of a report somebody is sending to their client - the same
          // reasoning the rails carry that class for.
          //
          // A bare <img> rather than next/image because the host is arbitrary
          // and tenant-supplied; see the note in @aura/ui's Logo. Capped in
          // height so a tall image cannot push the whole console below the fold.
          <img
            src={branding.bannerUrl}
            alt=""
            aria-hidden="true"
            className="print-hide max-h-32 w-full rounded-xl border border-border object-cover"
          />
        ) : null}
        {children}
      </main>
      </div>
      </BreadcrumbProvider>
    </div>
    </RealtimeProvider>
  );
}
