import type { ReactNode } from "react";

/**
 * The bar across the top of the console: which tenant, search, and the
 * always-there actions (live status, notifications).
 *
 * Deliberately SLOTS rather than the controls themselves. The owner console
 * fills them with its tenant switcher, its search box and its bell; a console
 * backed by another CRM, or the operator console later, fills them with its
 * own - the bar's layout and behaviour do not move.
 *
 * Sticky from `md` up only. Below that, <MobileNav>'s own sticky bar already
 * holds the top of the screen (and carries the tenant name and accent), and
 * two sticky bars stacked would eat a phone's viewport.
 *
 * The accent hairline is the tenant's colour (lib/tenant-accent.ts) - the one
 * thing on screen that changes when you switch tenant even if you never read
 * the name.
 */
export function ConsoleHeader({
  tenant,
  search,
  actions,
  accentColor,
}: {
  tenant: ReactNode;
  search: ReactNode;
  actions: ReactNode;
  accentColor?: string;
}) {
  return (
    <header
      // The hairline from `md` up only: below it <MobileNav>'s sticky bar
      // carries the same line, and two stacked accent lines read as a border.
      className={`print-hide z-20 border-b border-border bg-surface md:sticky md:top-0 ${
        accentColor ? "md:shadow-[inset_0_3px_0_0_var(--tenant-accent)]" : ""
      }`}
      style={accentColor ? ({ "--tenant-accent": accentColor } as React.CSSProperties) : undefined}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3.5 pb-2.5 sm:px-5 md:flex-nowrap md:px-8">
        <div className="min-w-0 shrink">{tenant}</div>
        <div className="order-last w-full md:order-none md:mx-auto md:w-auto md:max-w-xl md:flex-1">
          {search}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1 md:ml-0">{actions}</div>
      </div>
    </header>
  );
}
