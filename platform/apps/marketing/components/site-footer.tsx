import Link from "next/link";
import { Container } from "./ui/layout";
import { Logo } from "@/components/brand/logo";
import { LEGAL_PAGES } from "@/lib/legal";
import { BRAND, BRAND_LINE, CONSOLE_ENTRY, LEGAL_ENTITY, NAV } from "@/lib/site";

/**
 * Footer.
 *
 * Doc 10 §14 requires /security, /privacy, /dpa and /consent to be live AND
 * linked from here. /privacy, /dpa and /terms are now WRITTEN and routed, but
 * each stays unpublished until the company facts it needs are filled in
 * (lib/legal.ts) - a 404 behind "Privacy policy" on a site whose central claim
 * is data protection is worse than an honest "not published yet". The lists
 * below are derived from the same flag the pages use, so the two cannot
 * disagree.
 *
 * Updated 2026-08-08 alongside the header. Three fixes:
 *
 * · The Product column listed five links, three of which (/#integrations,
 *   /#custom-crm, /#pricing) pointed at sections the homepage cut. It now
 *   renders NAV, so it cannot drift out of step with the page again.
 * · The mark was a hardcoded "A" in a box - a placeholder that outlived the
 *   real logo arriving. It uses the same Logo component as everywhere else.
 * · Console sign-in points at /admin rather than the console origin directly,
 *   so the door has one address and CONSOLE_URL is referenced in one place.
 *
 * The Trust column keeps /compatibility and /security even though both came
 * out of the header. They are the data-handling disclosures for a product that
 * records customer phone calls; a site that makes that claim and links its
 * notice from nowhere has a compliance problem, not a tidier nav.
 */

const LIVE = [
  { href: "/compatibility", label: "Phone compatibility" },
  { href: "/security", label: "How we handle your data" },
  { href: "/consent", label: "Call recording and consent" },
];

/**
 * The legal documents that are actually publishable.
 *
 * DERIVED, not hand-listed. Each page carries a `ready` flag from lib/legal.ts,
 * which is false while any company fact it needs is unset - and the pages
 * themselves 404 on the same flag. So the footer cannot link a 404, and a
 * document that goes live appears here without anyone remembering to add it.
 *
 * Unready documents are now simply ABSENT. They used to be listed greyed out as
 * "in legal review, not yet published", which was honest but drew the eye to
 * three things the site does not have; a visitor reads it as missing paperwork
 * rather than as work in progress. /security carries the substantive
 * data-handling disclosure in the meantime, and it is linked above.
 */
const legalLive = LEGAL_PAGES.filter((p) => p.ready);

export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-border bg-bg-subtle">
      <Container className="py-12">
        <div className="grid gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <p className="flex items-center gap-2.5 font-semibold text-text">
              {/* Not `priority` - the footer is below the fold on every page,
                  and preloading it would compete with the hero mark. */}
              <Logo size={28} priority={false} />
              {BRAND}
            </p>
            <p className="mt-3 text-base text-text-muted">{BRAND_LINE}</p>
          </div>

          {/* Rendered only when there is something in it. NAV is currently
              empty by design (see lib/site.ts), and a "Product" heading with no
              links under it looks like a rendering fault rather than a choice. */}
          {NAV.length > 0 ? (
            <nav aria-label="Product">
              <h2 className="text-sm font-semibold text-text">Product</h2>
              <ul className="mt-3 space-y-2">
                {NAV.map((item) => (
                  <li key={item.href}>
                    <FooterLink href={item.href}>{item.label}</FooterLink>
                  </li>
                ))}
              </ul>
            </nav>
          ) : null}

          <nav aria-label="Trust">
            <h2 className="text-sm font-semibold text-text">Trust</h2>
            <ul className="mt-3 space-y-2">
              {LIVE.map((l) => (
                <li key={l.href}>
                  <FooterLink href={l.href}>{l.label}</FooterLink>
                </li>
              ))}
              {legalLive.map((l) => (
                <li key={l.href}>
                  <FooterLink href={l.href}>{l.label}</FooterLink>
                </li>
              ))}
            </ul>
          </nav>

          <nav aria-label="Customers">
            <h2 className="text-sm font-semibold text-text">Customers</h2>
            <ul className="mt-3 space-y-2">
              <li>
                {/* A plain anchor, not next/link. /admin is a route handler
                    that 307s to another origin - a client-side navigation
                    would prefetch it on hover and then have to unwind a
                    cross-origin redirect the router cannot follow. This wants
                    a full document request. */}
                <a
                  href={CONSOLE_ENTRY}
                  className="rounded-md text-base text-text-muted transition-colors duration-150 ease-out hover:text-text"
                >
                  Sign in to the console
                </a>
              </li>
            </ul>
          </nav>
        </div>

        <p className="mt-10 border-t border-border pt-6 text-sm text-text-muted">
          © {year} {LEGAL_ENTITY}. {BRAND} is a call intelligence platform for sales
          teams in India.
        </p>
      </Container>
    </footer>
  );
}

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-md text-base text-text-muted transition-colors duration-150 ease-out hover:text-text"
    >
      {children}
    </Link>
  );
}
