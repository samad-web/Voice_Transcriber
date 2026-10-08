import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { brandingCssVars, browserTitleFor, parseBranding } from "@aura/shared";
import { PORTAL_SCREENS } from "@aura/shared/dist/partners";
import { Logo, MonoLabel } from "@aura/ui";
import { OrgRegionProvider } from "@/components/org-region";
import { signOutAction } from "../login/actions";
import { getPortal } from "./portal-context";
import { PortalNav } from "./portal-nav";

/**
 * The tab title and favicon, from the TENANT's branding (0065/0126).
 *
 * A template, like the owner console's, so each of the five pages names itself
 * and the workspace's name is written once. The fallback is the workspace name
 * rather than "Aura": a partner is in their client's portal, not in a product
 * they bought, and a tab reading "Aura" would be the only place in the whole
 * surface that said so.
 */
export async function generateMetadata(): Promise<Metadata> {
  const portal = await getPortal();
  const branding = parseBranding(portal?.workspace.branding);
  const brand = browserTitleFor(branding, portal?.workspace.name || "Partner portal");
  return {
    title: { default: brand, template: `%s - ${brand}` },
    ...(branding.faviconUrl ? { icons: { icon: branding.faviconUrl } } : {}),
    // The portal is one tenant's private surface. Nothing here belongs in a
    // search index, and the submission form's URL should not leak through a
    // Referer header either.
    robots: { index: false, follow: false },
    referrer: "no-referrer",
  };
}

/**
 * The portal shell (Build docs/39 §19).
 *
 * ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
 *
 * No `Sidebar`, no `MobileNav`, no `ConsoleSectionTabs`, no `GlobalSearch`, no
 * `NotificationBell`, no `TenantContextSwitcher`, no `BreadcrumbProvider`, no
 * `RealtimeProvider`, no `SetupGate`. Not because they would look wrong -
 * several would look fine - but because every one of them is built to read an
 * `OwnerMembership`, and wiring a partner through a component that expects a
 * persona, a module list and a feature map is how a broker ends up seeing a
 * nav item for Leads. The portal's value is that it is small (§19); the layout
 * is where that is either true or merely intended.
 *
 * Five links, a name, a sign-out. The owner rail is 38 pages behind seven
 * sections; this is a `<nav>` with five `<a>`s.
 *
 * ── BRANDING ───────────────────────────────────────────────────────────────
 *
 * Applied here once, exactly as the owner layout applies it: `brandingCssVars`
 * returns the custom properties this tenant overrides and they are set on the
 * wrapper, so they inherit into every page and every kit component without a
 * single one of them knowing a tenant exists.
 *
 * The four STATE hues are deliberately left alone, for the reason the owner
 * layout gives: `--color-danger`, `--color-success` and the rest encode
 * meaning (red is MISSED, orange is an error), and a surface where red meant
 * "on brand" for one client would have no colour system at all. White-labelling
 * owns the chrome; it does not own the alphabet.
 *
 * ── AND ITS WHOLE SECURITY MODEL ───────────────────────────────────────────
 *
 * This redirect plus `getPortal()`. The partner and their org are resolved on
 * the server from a verified Supabase session by an API guard that reads
 * `partner_users` - never from the URL, a header or a cookie claim - so there
 * is no id a partner could change to see another partner or another tenant.
 * A signed-in person who is NOT a partner lands here too (`getPortal()`
 * returns null for a 403) and is sent to the console, which is where a member
 * of the tenant belongs.
 */
export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const portal = await getPortal();
  // Not a partner. Either a member of a tenant who typed /portal, or somebody
  // whose portal access was suspended. The middleware already sent a
  // signed-OUT visitor to /login before this ran.
  if (!portal) redirect("/");

  // The portal is switched off for this workspace (Build docs/40 §A2).
  //
  // A 404 rather than the redirect above, and the difference matters. The
  // redirect answers "you are in the wrong place" and sends a tenant's own
  // member somewhere they belong. There is nowhere to send a PARTNER: they hold
  // no membership, so `/` would bounce them through middleware to a login they
  // have already completed, and they would read that as the sign-in being
  // broken. "This page does not exist" is both true and the end of the journey.
  //
  // `undefined` counts as off - see `portalEnabled` on PortalContext for why a
  // web tier ahead of its API has to fail closed here.
  if (!portal.portalEnabled) notFound();

  const branding = parseBranding(portal.workspace.branding);
  const brandVars = brandingCssVars(branding);
  const background = brandVars["--color-bg"];

  return (
    // The one console provider the portal does take: `PhoneInput` reads it to
    // decide which country the submission form's number field starts on, and
    // getting that wrong means a Delhi broker's ten digits are stored as an
    // American number - permanently, since the vault key is derived from them.
    <OrgRegionProvider country={portal.workspace.country} currency={portal.workspace.currency}>
    <div
      className="min-h-dvh flex flex-col"
      // Validated hexes out of the Branding schema, never raw tenant input -
      // `parseBranding` has already turned anything malformed into `{}`.
      style={{ ...brandVars, ...(background ? { backgroundColor: background } : {}) } as React.CSSProperties}
    >
      {/* ── NO BRAND-GRADIENT HAIRLINE HERE, AND THAT IS A DECISION ──────────
          The owner console draws one (`app/(owner)/layout.tsx`, on
          console-palette.test.ts's `GRADIENT_CHROME` list) because the gradient
          is the PRODUCT's identity and that console is ours.

          This surface is not ours. It belongs to the tenant, and a partner
          opening it should see their client's business - logo, accent,
          background, all out of `brandingCssVars` above - and no mark that says
          "Aura". So the first draft's hairline was removed rather than added to
          GRADIENT_CHROME: it was the one element on the page whose only job was
          to make the portal look like the product, which is exactly what a
          white-labelled portal must not do. A plain token border does the same
          structural work.

          If a later change does want it, the correctly-scoped way is one line
          on GRADIENT_CHROME, not a weaker regex. */}
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            {branding.logoUrl ? (
              // A bare <img>: the host is arbitrary and tenant-supplied, which
              // is the same reason @aura/ui's Logo gives for not using
              // next/image on these.
              <img src={branding.logoUrl} alt="" aria-hidden="true" className="h-8 w-auto max-w-[140px] object-contain" />
            ) : (
              <Logo size={32} />
            )}
            <div className="min-w-0">
              <p className="truncate text-sm leading-tight font-semibold text-text">
                {portal.workspace.name || "Partner portal"}
              </p>
              <MonoLabel className="mt-0.5">Partner portal</MonoLabel>
            </div>
          </div>

          <div className="ml-auto flex min-w-0 items-center gap-3">
            <div className="hidden min-w-0 text-right sm:block">
              <p className="truncate text-sm leading-tight font-medium text-text">{portal.partner.name}</p>
              {/* The referral code, because it is the one thing a partner is
                  asked for on the phone and the one thing they can never
                  find. */}
              <p className="truncate text-xs leading-tight text-text-muted">{portal.partner.code}</p>
            </div>
            {/* The console's own sign-out action, reused rather than
                reimplemented: it clears the cookies locally and deliberately
                does NOT attempt a global revoke, which is the trap doc 27
                records (a failed global signOut removes the local session in
                auth-js and leaves the browser in a half-signed-in state). */}
            <form action={signOutAction}>
              <button type="submit" className="shrink-0 text-sm font-medium text-accent hover:underline">
                Sign out
              </button>
            </form>
          </div>
        </div>

        <PortalNav screens={PORTAL_SCREENS} />
      </header>

      {/* max-w-5xl, not the console's full width: five screens of forms and one
          table do not need 1600px, and a 16px side gutter at phone width is
          what the kit's layout rules ask for. */}
      <main className="mx-auto w-full max-w-5xl flex-1 space-y-5 p-4 sm:p-6">{children}</main>

      <footer className="border-t border-border px-4 py-4 text-center text-xs leading-relaxed text-text-muted sm:px-6">
        {/* Says whose surface this is. A partner submitting somebody else's
            customer's phone number should be able to see, without asking, that
            it goes to this business and not to a marketplace. */}
        A partner portal operated by {portal.workspace.name || "this business"}.
      </footer>
    </div>
    </OrgRegionProvider>
  );
}
