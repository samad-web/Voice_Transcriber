"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";
import { ChevronDown, MoreHorizontal } from "lucide-react";
import { ownerRailState, type NavItem, type OwnerRail } from "@/lib/nav";

/**
 * The owner console's rail: the promoted pages, then one "More" disclosure
 * holding the grouped rest (lib/nav.ts, "THE TOP-LEVEL RAIL").
 *
 * Shared by <Sidebar> and <MobileNav> so the two breakpoints cannot disagree
 * about what is top-level or what "you are here" looks like. `variant` only
 * changes the tap target height - a thumb needs more than a cursor.
 *
 * More OPENS BY ITSELF when the current page is inside it, and re-opens on
 * navigation into it. Otherwise a person who followed a link to Team would see
 * no highlighted item anywhere on the rail.
 */
export function OwnerRailNav({
  rail,
  pathname,
  variant,
}: {
  rail: OwnerRail;
  pathname: string;
  variant: "sidebar" | "drawer";
}) {
  const { activeHref, primaryParentHref, inMore } = ownerRailState(pathname, rail);
  const [moreOpen, setMoreOpen] = useState(inMore);
  const moreId = useId();

  useEffect(() => {
    if (inMore) setMoreOpen(true);
  }, [inMore, pathname]);

  const pad = variant === "drawer" ? "py-3" : "py-2";

  const link = (item: NavItem, parent = false) => {
    const Icon = item.icon;
    const isActive = item.href === activeHref;
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={isActive ? "page" : undefined}
        style={isActive ? { backgroundImage: "var(--brand-gradient)" } : undefined}
        className={`flex w-full items-center gap-3 rounded-full px-3 ${pad} text-sm font-medium transition-colors duration-150 ease-out ${
          isActive
            ? "text-white"
            : parent
              ? // The area the current page sits under: quieter than the active
                // fill so only one item ever reads as "here".
                "bg-surface-hover text-text"
              : "text-text-muted hover:bg-surface-hover hover:text-text active:bg-surface-hover"
        }`}
      >
        <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{item.label}</span>
      </Link>
    );
  };

  return (
    <div className="space-y-1">
      <section aria-label="Primary" className="space-y-0.5">
        {rail.primary.map((item) => link(item, item.href === primaryParentHref))}
      </section>

      {rail.more.length > 0 ? (
        <section aria-label="More" className="space-y-0.5 pt-1">
          <button
            type="button"
            onClick={() => setMoreOpen((v) => !v)}
            aria-expanded={moreOpen}
            aria-controls={moreId}
            className={`flex w-full items-center gap-3 rounded-full px-3 ${pad} text-sm font-medium text-text-muted transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-text`}
          >
            <MoreHorizontal className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="flex-1 text-left">More</span>
            <ChevronDown
              className={`h-4 w-4 shrink-0 transition-transform duration-150 ${moreOpen ? "rotate-180" : ""}`}
              aria-hidden="true"
            />
          </button>
          <div id={moreId} hidden={!moreOpen} className="space-y-3 pt-2">
            {rail.more.map((group) => (
              <section key={group.key ?? "top"} aria-label={group.label ?? undefined} className="space-y-0.5">
                {group.label ? (
                  <h2 className="px-3 pb-1 text-[11px] font-semibold tracking-wide text-text-subtle uppercase">
                    {group.label}
                  </h2>
                ) : null}
                {group.items.map((item) => link(item))}
              </section>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
