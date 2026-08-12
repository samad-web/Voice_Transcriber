import Link from "next/link";
import { ButtonLink } from "./ui/button";
import { Logo } from "@/components/brand/logo";
import { BRAND, NAV } from "@/lib/site";

/**
 * Sticky header.
 *
 * Rebuilt on 2026-08-08. What it holds now, and why it holds nothing else:
 *
 * · The lockup, at the same left edge as the hero headline. Both sit in a
 *   max-w-6xl / px-6 measure, so the mark lines up with the H1 below it rather
 *   than landing a few pixels off — the header used a Container with a
 *   different gutter (px-4 on phones) and that misalignment was visible.
 *
 * · Two anchors. This site is one page with five sections; a nav is a table of
 *   contents for it, not a site map. Compatibility, Security and Pricing came
 *   out at the owner's instruction — and three of the five links were pointing
 *   at sections the homepage cut, so the nav was quietly scrolling people to
 *   the footer.
 *
 * · One CTA. `/start` is the single conversion target for the whole site, and
 *   it is the only thing in here with a filled background. The "Sign in" that
 *   used to sit beside it is gone: it competed for the same corner of the same
 *   bar as the primary action, and it was aimed at people who already bought.
 *   Console access is now an address — /admin — which redirects to the login.
 *
 * Still zero client JavaScript, and now with nothing to hydrate at all. The
 * `<details>` mobile menu is gone with the nav it was holding: two in-page
 * anchors on a page you scroll anyway do not earn a disclosure widget, a
 * summary element and a popover on a phone. Below `md` the header is the
 * lockup and the CTA, which is the only thing a phone visitor needs from it.
 */
export function SiteHeader() {
  return (
    <header className="mk-header">
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-6">
        <Link href="/" className="mk-brand" aria-label={`${BRAND}, home`}>
          <Logo size={30} />
          <span>{BRAND}</span>
        </Link>

        {/* Left-adjacent rather than centred: with two items a centred nav
            floats in the middle of an empty bar with no relationship to
            anything. Sitting next to the mark, it reads as belonging to it. */}
        <nav aria-label="Main" className="ml-6 hidden md:block">
          <ul className="flex items-center gap-1">
            {NAV.map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="mk-nav-link">
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <Link href="/start" className="mk-cta mk-cta-sm ml-auto">
          {/* The short form of the page's CTA. The body buttons say "Book my
              call now"; this drops the "now" because it is a persistent header
              button rather than a moment of decision, and an urgency word that
              follows you down every scroll stops reading as urgency. Same verb
              and same object, so it is unmistakably the same action. */}
          Book my call
          <span aria-hidden="true">→</span>
        </Link>
      </div>
    </header>
  );
}

/** Skip link. First focusable element on every page; visible only when focused. */
export function SkipLink() {
  return (
    <ButtonLink
      href="#main"
      variant="primary"
      size="sm"
      className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[100]"
    >
      Skip to content
    </ButtonLink>
  );
}
