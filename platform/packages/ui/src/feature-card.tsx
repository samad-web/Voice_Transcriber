import type { ReactNode } from "react";
import { cx } from "./cx";

export interface FeatureCardProps {
  title: ReactNode;
  description: ReactNode;
  /** Decorative. Rendered aria-hidden - the title carries the meaning. */
  icon?: ReactNode;
  /** Optional bottom line: a proof point, a link, a `StatusChip`. */
  footer?: ReactNode;
  /**
   * Pass "h3" when the card sits under a `SectionHeading` h2 (the usual case),
   * or omit for a plain `<p>` when the cards are a list of outcomes rather than
   * navigable subsections.
   */
  as?: "h3" | "h4" | "p";
  className?: string;
}

/**
 * Outcome card for marketing sections ("What you get", the custom-CRM fork).
 *
 * `radius-lg`, not `radius-md`: doc 16 §1.3 puts feature cards on the large
 * radius with modals, because they are large surfaces read at a distance and the
 * 8px card radius disappears at that size.
 */
export function FeatureCard({
  title,
  description,
  icon,
  footer,
  as: Tag = "h3",
  className = "",
}: FeatureCardProps) {
  return (
    <div
      className={cx(
        "flex h-full flex-col rounded-lg border border-border bg-surface p-6 shadow-sm",
        "transition-colors duration-150 ease-out hover:border-border-strong",
        className,
      )}
    >
      {icon ? (
        <div
          aria-hidden="true"
          className="mb-4 flex h-10 w-10 items-center justify-center rounded-md bg-accent-subtle text-accent-text"
        >
          {icon}
        </div>
      ) : null}
      <Tag className="text-lg font-semibold text-text">{title}</Tag>
      <p className="mt-2 text-base text-pretty text-text-muted">{description}</p>
      {footer ? <div className="mt-4 pt-4 text-sm">{footer}</div> : null}
    </div>
  );
}
