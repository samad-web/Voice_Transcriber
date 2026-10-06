"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { PortalScreen } from "@aura/shared/dist/partners";
import { cx } from "@aura/ui";

/**
 * The portal's whole navigation: five links in a horizontal strip.
 *
 * A client component for one reason - it needs `usePathname()` to mark the
 * current screen - and for that reason only. The screen LIST comes from
 * `PORTAL_SCREENS` in @aura/shared, passed down from the server layout, so
 * there is exactly one place the five screens are enumerated and it is the
 * file with the argument for why there are five.
 *
 * Deliberately not `Sidebar` or `MobileNav`. Both resolve their items from an
 * `OwnerMembership` - persona, modules, feature overrides - and a partner has
 * none of those; a rail that had to be told to hide 38 pages would be one
 * forgotten condition away from offering one.
 *
 * `/portal` is matched exactly rather than by prefix, or the Submit screen
 * would read as current on all five.
 */
export function PortalNav({ screens }: { screens: readonly PortalScreen[] }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Portal" className="border-t border-border">
      {/* Scrolls sideways at phone width instead of wrapping into two rows:
          five labels do not fit 360px, and a nav that changes height between
          screens shifts the page under the reader's thumb. */}
      <ul className="mx-auto flex w-full max-w-5xl gap-1 overflow-x-auto px-2 sm:px-4">
        {screens.map((screen) => {
          const current = screen.href === "/portal" ? pathname === "/portal" : pathname.startsWith(screen.href);
          return (
            <li key={screen.href} className="shrink-0">
              <Link
                href={screen.href}
                aria-current={current ? "page" : undefined}
                className={cx(
                  "inline-block border-b-2 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors",
                  current
                    ? "border-accent text-text"
                    : "border-transparent text-text-muted hover:border-border hover:text-text",
                )}
              >
                {screen.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
