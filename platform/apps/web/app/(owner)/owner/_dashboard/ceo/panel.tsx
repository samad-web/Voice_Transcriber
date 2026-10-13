import type { ReactNode } from "react";
import Link from "next/link";
import { Card } from "@aura/ui";
import { PANEL_LINK } from "../../dashboard-panels";

/**
 * The CEO layout's panel chrome (Build docs/46): a title, the clock the panel
 * is on, and an optional link out.
 *
 * ── WHY THE CLOCK IS A CHIP AND NOT A SUBTITLE ──────────────────────────────
 *
 * This page puts windowed figures and live ones side by side - "revenue won in
 * 30d" sits two cards from "open pipeline right now", and "open leads by age"
 * is next to a 30-day funnel. The redesign's rule is that every figure names
 * its clock (docs/29 P1); on a page this dense a sentence under each title is
 * four extra lines of chrome and gets skipped. A chip in the title row is read
 * in the same glance as the title.
 *
 * Three values and no more: the window as the page words it ("30d", "7d", or a
 * custom range's dates), `now` for a live count, and `proj.` for anything
 * projected. A fourth would stop being a glance.
 *
 * ── AND WHY THE TITLE IS NOT UPPERCASE ──────────────────────────────────────
 *
 * The design the layout comes from sets these in caps. The system retired that
 * convention on purpose (mono-label.tsx, doc 16 §1.2): it hurts scanning at
 * 11px and does nothing at all for Tamil, Hindi and Telugu, which have no case
 * - and native support for those scripts is this product's headline claim.
 * Weight and colour carry the hierarchy instead.
 */
export function PanelHead({
  title,
  clock,
  note,
  link,
  children,
}: {
  title: ReactNode;
  /** "30d" · "now" · "proj." · a custom range. Omit where the title says it. */
  clock?: ReactNode;
  /** A short qualifier opposite the title - "log scale", "higher is better". */
  note?: ReactNode;
  link?: { label: string; href: string } | null;
  /** Anything else for the right-hand end, e.g. a confidence warning. */
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-text">{title}</h3>
        {clock ? <ClockChip>{clock}</ClockChip> : null}
        {note ? <span className="text-xs text-text-muted">{note}</span> : null}
      </div>
      {children}
      {link ? (
        <Link href={link.href} className={PANEL_LINK}>
          {link.label} →
        </Link>
      ) : null}
    </div>
  );
}

/** The window pill. Outlined, never filled - it is a caption, not a status. */
export function ClockChip({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-text-muted tabular-nums">
      {children}
    </span>
  );
}

/** A panel: the standard card, the standard internal rhythm. */
export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <Card className={`space-y-4 ${className}`}>{children}</Card>;
}

/**
 * The band label above a group of panels ("Who drives the business").
 *
 * An `h2`, with the panels' own titles as `h3` under it, so the heading list a
 * screen-reader user navigates by describes the page's four questions rather
 * than its fourteen cards.
 */
export function BandHeading({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <h2 className="text-lg font-semibold text-text">{children}</h2>
      {right}
    </div>
  );
}

/** What a panel says when it has nothing to draw, rather than drawing zeros. */
export function PanelEmpty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-text-muted">{children}</p>;
}
