import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/**
 * The standard surface: a 1px hairline and 24px of padding.
 *
 * Every card carries `--shadow-card` - the same soft, long-throw ambient
 * shadow as marketing's `.mk-card` - by default now, not just the ones that
 * opt in. In dark mode `--shadow-card` swaps to true black rather than a
 * light-mode tint, the same adjustment marketing's own token makes, so it
 * still registers against a dark ground.
 *
 * Props otherwise mirror Button's extensibility: the rest of a div's standard
 * HTML attributes (`id`/`style`/`onClick`/`aria-*`/`data-*`) pass through, so
 * a call site isn't stuck without them the way the old `{children, shadow,
 * className}`-only surface was.
 */
export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /**
   * Lifts the card further above the page with `--shadow-lift` (an
   * accent-tinted glow) instead of the default ambient `--shadow-card` - for
   * the handful of cards that should stand out from the rest of the page (a
   * primary CTA's card, a hero panel). Renamed from `shadow`: every card gets
   * a shadow by default now, so a prop named `shadow` no longer meant "has a
   * shadow vs. flat" - it only ever meant "lifted further than the rest."
   */
  elevated?: boolean;
  className?: string;
}

export function Card({ children, elevated = false, className = "", ...rest }: CardProps) {
  return (
    <div
      className={cx(
        "rounded-xl border border-border bg-surface p-6",
        elevated ? "shadow-lift" : "shadow-card",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
