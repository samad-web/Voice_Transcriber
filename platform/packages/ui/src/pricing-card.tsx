import type { ReactNode } from "react";
import { cx } from "./cx";

export interface PricingCardProps {
  name: string;
  /** e.g. "₹1,200" - or "Talk to us" for the enterprise tier. */
  price: ReactNode;
  /** e.g. "per handset, per month". Omit when `price` is not a number. */
  period?: ReactNode;
  description?: ReactNode;
  features: ReactNode[];
  /** The CTA. Pass a `Button`, or a link styled as one. */
  action?: ReactNode;
  /** Small print under the CTA: fair-use allowance, overage rate, VAT. */
  note?: ReactNode;
  /** Visually promotes the tier and adds the "Most popular" flag. */
  featured?: boolean;
  className?: string;
}

/**
 * One pricing tier.
 *
 * Two accessibility details that are easy to get wrong here:
 *
 * - The featured tier is marked by a **border, a badge and a label**, not by
 *   colour alone. A blue-ringed card is invisible to a colour-blind visitor and
 *   prints identically to the others (WCAG 1.4.1).
 * - The feature list is a real `<ul>`, so a screen reader announces "list, 6
 *   items" and the visitor can skip it. The tick marks are `aria-hidden`; the
 *   list semantics already say "included", and announcing "tick" six times is
 *   noise. If a tier ever needs to show an *excluded* feature, that must be a
 *   different component - a greyed row with a cross reads as "included" to
 *   anyone not looking at the icon.
 */
export function PricingCard({
  name,
  price,
  period,
  description,
  features,
  action,
  note,
  featured = false,
  className = "",
}: PricingCardProps) {
  return (
    <div
      className={cx(
        "flex h-full flex-col rounded-lg border bg-surface p-6",
        featured ? "border-accent shadow-md" : "border-border shadow-sm",
        className,
      )}
    >
      <div className="flex items-center gap-3">
        <h3 className="text-lg font-semibold text-text">{name}</h3>
        {featured ? (
          <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-xs font-medium text-accent-text">
            Most popular
          </span>
        ) : null}
      </div>

      {description ? <p className="mt-2 text-sm text-text-muted">{description}</p> : null}

      <p className="mt-6 flex flex-wrap items-baseline gap-x-2">
        <span className="text-4xl font-semibold text-text tabular-nums">{price}</span>
        {period ? <span className="text-sm text-text-muted">{period}</span> : null}
      </p>

      <ul className="mt-6 flex flex-col gap-3 text-sm text-text">
        {features.map((f, i) => (
          <li key={i} className="flex items-start gap-2.5">
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              className="mt-0.5 h-4 w-4 shrink-0 text-success"
              fill="none"
            >
              <path
                d="M3 8.5l3.2 3.2L13 5"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="min-w-0">{f}</span>
          </li>
        ))}
      </ul>

      {/* mt-auto pins the CTA to the bottom so a row of tiers with different
          feature counts still has its buttons on one line. */}
      {action ? <div className="mt-auto pt-8">{action}</div> : null}
      {note ? <p className="mt-3 text-xs text-text-muted">{note}</p> : null}
    </div>
  );
}
