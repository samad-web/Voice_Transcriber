import type { ReactNode } from "react";
import { cx } from "./cx";

export interface CTABannerProps {
  title: ReactNode;
  description?: ReactNode;
  /** Primary action — usually the WhatsApp link. */
  action: ReactNode;
  /** Secondary action, rendered next to it. Deep-links to /start in doc 16 §4.1. */
  secondaryAction?: ReactNode;
  /** Point the enclosing `<section aria-labelledby>` here. */
  id?: string;
  className?: string;
}

/**
 * Full-width call to action between sections and at the foot of a page.
 *
 * Uses `--color-accent-subtle` rather than a filled accent block. Doc 16 §1.1 is
 * explicit that the accent is for the primary CTA, active nav, focus ring and
 * selection — a page with three saturated blue slabs spends the accent on
 * decoration, and the actual button inside the banner then has nothing left to
 * stand out against. The tint keeps the emphasis on the button.
 *
 * Renders as `<aside>` because a CTA is complementary to the page's argument,
 * not a step in it; that gives it a landmark a screen-reader user can skip.
 */
export function CTABanner({
  title,
  description,
  action,
  secondaryAction,
  id,
  className = "",
}: CTABannerProps) {
  return (
    <aside
      aria-labelledby={id}
      className={cx(
        "flex flex-col gap-6 rounded-lg border border-border bg-accent-subtle px-6 py-10 sm:px-10",
        "md:flex-row md:items-center md:justify-between",
        className,
      )}
    >
      <div className="min-w-0">
        <p id={id} className="text-2xl font-semibold text-balance text-text">
          {title}
        </p>
        {description ? (
          <p className="mt-2 max-w-xl text-base text-pretty text-text-muted">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        {action}
        {secondaryAction}
      </div>
    </aside>
  );
}
