"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import type { OwnerRole } from "@aura/shared";
import { ownerRailFor, ownerTabsFor, platformRail, type Entitlement, type NavArea } from "@/lib/nav";

/**
 * The second level of a console's navigation: the pages of the
 * section you are in, as a strip across the top of the page (lib/nav.ts,
 * "THE RAIL AND THE TABS").
 *
 * ── ONE STRIP, DRAWN BY THE LAYOUT ──────────────────────────────────────────
 *
 * Rendered once, in the owner layout, above every page - not by each page. The
 * messaging switcher that came before this was one line per page, and five
 * pages remembering a line is fine; thirty-five is how one of them forgets.
 * The layout also keeps the strip on screen while the next page loads, so
 * moving between tabs does not flash the row away and back.
 *
 * It takes the same entitlement props as <Sidebar> and derives its tabs from
 * the same `ownerRailFor`, so a tab can never be offered that the rail would
 * hide.
 *
 * ── LINKS, NOT TABS ─────────────────────────────────────────────────────────
 *
 * These look like tabs and are deliberately NOT `role="tablist"`. Each one is a
 * separate route with its own server data; a real tab panel is content already
 * in the document that a click reveals. `<nav>` + `aria-current="page"` says
 * the true thing, and keeps back-button behaviour, open-in-new-tab and
 * prefetch, all of which a tablist would throw away.
 *
 * The active tab gets an underline and full-contrast text, not the brand
 * gradient: the rail entry above it already carries that, and two gradient
 * fills on one screen stop reading as "you are here".
 */
export function ConsoleSectionTabs({
  area = "owner",
  ownerRole,
  crmPrimary,
  crmEnabled,
  callIntelEnabled,
  entitlement,
}: {
  /** Which console. The operator rail takes no entitlement props - see `platformRail`. */
  area?: NavArea;
  ownerRole?: OwnerRole;
  crmPrimary?: boolean;
  crmEnabled?: boolean;
  callIntelEnabled?: boolean;
  entitlement?: Entitlement;
}) {
  const pathname = usePathname();
  // Derived from the SAME function that builds each console's rail, so a tab can
  // never be offered that the rail would hide. The home href differs per console
  // and has to be passed through: it is a prefix of every other route in its
  // console, so the longest-prefix search needs the exact-match exception.
  const owner = area === "owner";
  const rail = owner
    ? ownerRailFor(ownerRole ?? "owner", crmPrimary, crmEnabled, callIntelEnabled, entitlement)
    : platformRail();
  const strip = ownerTabsFor(pathname, rail, owner ? "/owner" : "/dashboard");
  if (!strip) return null;

  const tab =
    // The strip scrolls horizontally, which clips the block axis too - the
    // theme's focus ring sits 2px outside the element and would be cropped.
    // Drawn inside instead.
    "flex h-11 shrink-0 items-center rounded-t-md border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 ease-out focus-visible:-outline-offset-2 sm:px-4 ";

  return (
    <nav
      aria-label={strip.label}
      className="print-hide -mx-4 -mt-1 overflow-x-auto border-b border-border px-4 sm:-mx-5 sm:px-5 md:-mx-8 md:px-8"
    >
      <ul className="-mb-px flex gap-0.5">
        {strip.back ? (
          <li className="mr-1 flex items-center border-r border-border pr-1">
            <Link href={strip.back.href} className={`${tab} gap-1.5 border-transparent text-text-muted hover:text-text`}>
              <ArrowLeft className="h-4 w-4 shrink-0" aria-hidden="true" />
              {strip.back.label}
            </Link>
          </li>
        ) : null}
        {strip.tabs.map((item) => {
          const on = item.href === strip.activeHref;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={on ? "page" : undefined}
                className={tab + (on ? "border-text text-text" : "border-transparent text-text-muted hover:text-text")}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
