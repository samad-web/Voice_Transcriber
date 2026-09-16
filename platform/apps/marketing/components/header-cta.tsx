"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The header's one call to action - everywhere except the page it points at.
 *
 * ── WHY IT DISAPPEARS ON /start ────────────────────────────────────────────
 *
 * `/start` IS the booking form. A sticky button that follows you down it saying
 * "Book my call" links to the page you are already reading, so it does nothing
 * - and on a phone it sits directly above a form whose own submit button is the
 * real action, competing with it for the same decision. A CTA that cannot be
 * acted on is not urgency, it is furniture.
 *
 * ── WHY THIS IS A CLIENT COMPONENT, AND WHAT THAT COST ─────────────────────
 *
 * `SiteHeader` is rendered by the root layout, which in the App Router is not
 * told the pathname. The alternatives were worse than a few lines of JavaScript:
 * splitting every route between two route-group layouts so each could render
 * its own header, or having /start inject CSS to hide an element the header had
 * already sent.
 *
 * `usePathname` resolves during the server render too, so the button is absent
 * from the HTML on /start rather than being sent and then removed - no flash,
 * and nothing for a reader on a slow connection to tap before it vanishes.
 *
 * It does mean the header is no longer literally zero-JavaScript, which its own
 * comment used to claim. That claim has been corrected rather than quietly left
 * standing.
 */
export function HeaderCta() {
  const pathname = usePathname();
  if (pathname === "/start") return null;

  return (
    // ml-auto only below `sm`: from `sm` up the "Log in" link carries it, and two
    // auto margins would split the free space and strand that link mid-bar.
    <Link href="/start" className="mk-cta mk-cta-sm ml-auto sm:ml-2">
      {/* The short form of the page's CTA. The body buttons say "Book my call
          now"; this drops the "now" because it is a persistent header button
          rather than a moment of decision, and an urgency word that follows you
          down every scroll stops reading as urgency. Same verb and same object,
          so it is unmistakably the same action. */}
      Book my call
      <span aria-hidden="true">→</span>
    </Link>
  );
}
