"use client";

import Link from "next/link";
import { ownerRailState, type OwnerRail, type OwnerRailEntry } from "@/lib/nav";

/**
 * The owner console's rail: Home and the daily-work sections, then Settings
 * pinned apart below them (lib/nav.ts, "THE RAIL AND THE TABS").
 *
 * One link per section and nothing folded away. A section's own pages are the
 * tabs across the top of the page (<OwnerSectionTabs>), so the rail only has to
 * answer "which part of the business", and the whole of it fits on one screen
 * without a disclosure somebody has to know to open.
 *
 * Shared by <Sidebar> and <MobileNav> so the two breakpoints cannot disagree
 * about what is top-level or what "you are here" looks like. `variant` only
 * changes the tap target height - a thumb needs more than a cursor.
 */
export function OwnerRailNav({
  rail,
  pathname,
  variant,
  /** Icon-only rail (sidebar.tsx's collapse toggle). Never true for "drawer" -
   *  the mobile nav has no collapsed state of its own. */
  collapsed = false,
}: {
  rail: OwnerRail;
  pathname: string;
  variant: "sidebar" | "drawer";
  collapsed?: boolean;
}) {
  const { activeKey } = ownerRailState(pathname, rail);
  const pad = variant === "drawer" ? "py-3" : "py-2";

  const link = (entry: OwnerRailEntry) => {
    const Icon = entry.icon;
    const isActive = entry.key === activeKey;
    return (
      <Link
        key={entry.key}
        href={entry.href}
        // The entry stands for a whole section, so it is current on every tab
        // of it - "page" only when the reader is on the section's first page.
        aria-current={isActive ? (pathname === entry.href ? "page" : "true") : undefined}
        // Collapsed rows have no visible label, so the name still has to reach
        // someone hovering with a mouse - a native title tooltip, same as any
        // other icon-only control.
        title={collapsed ? entry.label : undefined}
        style={isActive ? { backgroundImage: "var(--brand-gradient)" } : undefined}
        className={`flex w-full items-center rounded-full px-3 ${pad} text-sm font-medium transition-colors duration-150 ease-out ${
          collapsed ? "justify-center" : "gap-3"
        } ${
          isActive
            ? "text-white"
            : "text-text-muted hover:bg-surface-hover hover:text-text active:bg-surface-hover"
        }`}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        {collapsed ? null : <span className="truncate">{entry.label}</span>}
      </Link>
    );
  };

  return (
    <div className="space-y-1">
      <section aria-label="Primary" className="space-y-0.5">
        {rail.primary.map(link)}
      </section>

      {rail.footer.length > 0 ? (
        // Set-up, not daily work: a hairline and a gap say so without a
        // heading the reader would have to read.
        <section aria-label="Settings" className="mt-3 space-y-0.5 border-t border-border pt-3">
          {rail.footer.map(link)}
        </section>
      ) : null}
    </div>
  );
}
