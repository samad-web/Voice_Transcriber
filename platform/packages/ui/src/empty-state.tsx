import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * The "nothing here yet" panel: no calls, no leads, no devices, no results.
 *
 * `title` is a `<p>`, not a heading. These land inside a page that already has
 * an `<h1>` and usually an `<h2>` for the section, and inserting an out-of-order
 * heading breaks the document outline a screen-reader user navigates by. If a
 * caller genuinely needs a heading here, they should render one above the
 * component.
 *
 * `description` should say what to do next, not restate the title. An empty
 * state is the highest-intent moment in a console and "No results" wastes it.
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Decorative. Rendered aria-hidden - never the only carrier of meaning. */
  icon?: ReactNode;
  /** Usually a `Button` or a link styled as one. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cx(
        "flex flex-col items-center justify-center rounded-md border border-dashed border-border px-6 py-12 text-center",
        className,
      )}
    >
      {icon ? (
        <div aria-hidden="true" className="mb-4 text-text-subtle">
          {icon}
        </div>
      ) : null}
      <p className="text-base font-medium text-text">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-sm text-text-muted">{description}</p>
      ) : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}
