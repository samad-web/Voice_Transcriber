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
 * holds the top of the screen, and two sticky bars stacked would eat a
 * phone's viewport.
 *
 * The brand-gradient hairline across the very top of the screen - above this
 * bar AND the sidebar beside it, edge to edge of the viewport - is the owner
 * layout's own `fixed` strip, not this component's: it has to span both
 * columns of that layout's flex row, which is a width this bar does not have.
 */
export function ConsoleHeader({
  tenant,
  search,
  back,
  actions,
}: {
  tenant: ReactNode;
  search: ReactNode;
  /**
   * The Back control (doc 28 §3.1): the upper right-centre of the screen -
   * at `xl` the start of column 3, immediately right of the centred search;
   * from `md` to `xl` directly left of the icons. Hidden below `md`, where the
   * header scrolls away and <MobileNav>'s sticky bar carries its own, so a
   * phone never shows two.
   */
  back?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <header className="print-hide z-20 border-b border-border bg-surface md:sticky md:top-0">
      {/* xl+: equal outer columns put search on the bar's true centre; flex alone centres it in the uneven gap between tenant and actions. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-3.5 pb-2.5 sm:px-5 md:flex-nowrap md:px-8 xl:grid xl:grid-cols-[minmax(0,1fr)_minmax(0,36rem)_minmax(0,1fr)]">
        <div className="min-w-0 shrink">{tenant}</div>
        <div className="order-last w-full md:order-none md:mx-auto md:w-auto md:max-w-xl md:flex-1 xl:w-full">
          {search}
        </div>
        {/* xl+: column 3 stretches so Back can sit at its START (right beside
            the search) while the icons keep its end. */}
        <div className="ml-auto flex shrink-0 items-center gap-1 md:ml-0 xl:min-w-0 xl:justify-self-stretch">
          {back ? <div className="hidden md:mr-1 md:flex">{back}</div> : null}
          <div className="ml-auto flex items-center gap-1">{actions}</div>
        </div>
      </div>
    </header>
  );
}
