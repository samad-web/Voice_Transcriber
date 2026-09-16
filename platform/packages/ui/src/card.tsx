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

/**
 * Does `className` already set all-sides padding?
 *
 * `cx` is a plain join (see cx.ts): a caller's class does not REPLACE a base
 * class, it only lands later in the string, and Tailwind breaks that tie by
 * stylesheet order rather than by string order. Tailwind emits `.p-0` before
 * `.p-6`, so `p-6` was winning - which meant every `<Card className="p-0">` in
 * the console (fourteen of them, each wrapping a full-bleed table or header
 * strip that is supposed to run to the card's edge) still carried the 24px it
 * had explicitly asked to drop. Dropping the base when the caller owns padding
 * is the fix that does not add tailwind-merge to a kit whose whole point is
 * having no runtime dependency beyond React.
 *
 * Only an unprefixed, all-sides `p-*` counts:
 * - `sm:p-0` is a responsive override that still needs the base at other sizes.
 * - `px-*`/`py-*` are partial overrides, and Tailwind's own ordering already
 *   resolves those against `p-6` correctly (the directional utilities are
 *   emitted after the all-sides one).
 */
const OWNS_PADDING = /(?:^|\s)p-\S/;

export function Card({ children, elevated = false, className = "", ...rest }: CardProps) {
  return (
    <div
      className={cx(
        "rounded-xl border border-border bg-surface",
        OWNS_PADDING.test(className) ? null : "p-6",
        elevated ? "shadow-lift" : "shadow-card",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
