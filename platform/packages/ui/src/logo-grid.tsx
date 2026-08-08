import type { ReactNode } from "react";
import { cx } from "./cx";

export interface LogoGridItem {
  /** Provider name. Always rendered as text — see the note below. */
  name: string;
  /** Optional mark. Rendered aria-hidden, because `name` is already there. */
  logo?: ReactNode;
  /**
   * Honest status flag. Doc 16 §3.7: Zoho, Salesforce, monday.com and
   * Dynamics 365 authenticate with pasted tokens that expire in hours and the
   * OAuth refresh flow is unbuilt. Zoho is the market leader in India, so it
   * will be a common answer — a grid that implies turnkey integration for it
   * sets up a sales call that starts with a correction. Pass a `StatusChip`.
   */
  badge?: ReactNode;
}

/**
 * The connector catalogue, as a grid.
 *
 * **The name is always visible text, not just an image.** Two reasons, and the
 * second is the real one: an SVG logo needs an `alt`/title to be announced at
 * all, and — more practically — this repo does not have licensed logo assets for
 * fifteen CRM vendors, so a grid that depends on them ships empty. Text-first
 * degrades to something honest and legible; add marks later without touching
 * consumers.
 *
 * A `<ul>`, so it announces as "list, 15 items" and can be skipped.
 */
export function LogoGrid({
  items,
  className = "",
}: {
  items: LogoGridItem[];
  className?: string;
}) {
  return (
    <ul
      className={cx(
        "grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5",
        className,
      )}
    >
      {items.map((item) => (
        <li
          key={item.name}
          className="flex min-h-24 flex-col items-center justify-center gap-2 rounded-md border border-border bg-surface px-3 py-4 text-center"
        >
          {item.logo ? (
            <span aria-hidden="true" className="flex h-8 items-center text-text-muted">
              {item.logo}
            </span>
          ) : null}
          <span className="text-sm font-medium text-text">{item.name}</span>
          {item.badge}
        </li>
      ))}
    </ul>
  );
}
