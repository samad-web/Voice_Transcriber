import type { ReactNode } from "react";
import { cx } from "./cx";

export interface Step {
  title: ReactNode;
  description: ReactNode;
  /** Decorative. Rendered aria-hidden. */
  icon?: ReactNode;
}

/**
 * "How it works" - a numbered sequence. Horizontal on desktop, stacked on
 * mobile (doc 10 §3, row 4).
 *
 * An `<ol>`, because the order is the information: handset → upload → AI →
 * CRM. On an unordered list a screen-reader user gets four unrelated cards.
 *
 * The visible number badges are `aria-hidden` - the `<ol>` already announces
 * "1 of 4", and a badge reading "1" next to it produces "1, 1 Capture".
 *
 * The connector rule between steps is drawn with a border on the list item
 * rather than an absolutely-positioned line, so it cannot drift out of
 * alignment when a step's text wraps to a different number of lines. It is
 * hidden below `md` where the layout is a stack.
 */
export function StepFlow({
  steps,
  className = "",
}: {
  steps: Step[];
  className?: string;
}) {
  return (
    <ol className={cx("grid gap-8 md:grid-cols-2 lg:grid-cols-4", className)}>
      {steps.map((step, i) => (
        <li
          key={i}
          className={cx(
            "relative flex flex-col gap-3 pt-6",
            // The rule sits above each step and stops before the first, so it
            // reads as a track running through them rather than as a top border
            // on four separate cards.
            "border-t border-border",
          )}
        >
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-subtle text-xs font-semibold text-accent-text tabular-nums"
            >
              {i + 1}
            </span>
            {step.icon ? (
              <span aria-hidden="true" className="text-text-muted">
                {step.icon}
              </span>
            ) : null}
          </div>
          <p className="text-lg font-semibold text-text">{step.title}</p>
          <p className="text-base text-pretty text-text-muted">{step.description}</p>
        </li>
      ))}
    </ol>
  );
}
