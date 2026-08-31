import type {
  HTMLAttributes,
  ReactNode,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";
import { cx } from "./cx";

/**
 * Data table primitives.
 *
 * Real `<table>` markup, not a grid of divs: the console's call and lead lists
 * are tabular data, and a screen reader's table mode (row/column navigation,
 * "column 3 of 7, Status") only exists if the elements are real. A div grid
 * would need a full `role="grid"` reimplementation to get back what the browser
 * gives away.
 *
 * Two things callers must supply:
 * - `caption` - the table's accessible name. Rendered visually hidden by
 *   default because most console tables already have a heading above them, but
 *   NOT optional: an unnamed table in a page with three tables is unnavigable.
 * - `scope` on header cells. `TableHeaderCell` defaults it to `col`, which is
 *   right for the header row; pass `scope="row"` for a row header.
 *
 * The wrapper scrolls horizontally on its own (`overflow-x-auto`) so a wide
 * table never makes the whole page scroll sideways on a phone, and is
 * `tabIndex={0}` so a keyboard user can actually reach that scroll.
 */
export function Table({
  caption,
  captionVisible = false,
  children,
  className = "",
}: {
  caption: string;
  captionVisible?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      // tabIndex + role: a scrollable region must be keyboard-operable
      // (WCAG 2.1.1). Without these, a wide table can be seen but its
      // right-hand columns cannot be reached without a mouse.
      tabIndex={0}
      role="region"
      aria-label={caption}
      className={cx("overflow-x-auto rounded-xl border border-border", className)}
    >
      <table className="w-full border-collapse text-sm">
        <caption
          className={cx(
            captionVisible
              ? "border-b border-border bg-bg-subtle px-4 py-3 text-left text-sm font-medium text-text"
              : "sr-only",
          )}
        >
          {caption}
        </caption>
        {children}
      </table>
    </div>
  );
}

export function TableHead({
  children,
  className = "",
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead className={cx("bg-bg-subtle", className)} {...rest}>
      {children}
    </thead>
  );
}

export function TableBody({
  children,
  className = "",
  ...rest
}: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody className={cx("divide-y divide-border", className)} {...rest}>
      {children}
    </tbody>
  );
}

export function TableRow({
  children,
  className = "",
  ...rest
}: HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cx("transition-colors duration-150 ease-out hover:bg-surface-hover", className)}
      {...rest}
    >
      {children}
    </tr>
  );
}

export function TableHeaderCell({
  children,
  scope = "col",
  className = "",
  ...rest
}: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope={scope}
      className={cx(
        "border-b border-border px-4 py-3 text-left text-xs font-medium whitespace-nowrap text-text-muted",
        className,
      )}
      {...rest}
    >
      {children}
    </th>
  );
}

export function TableCell({
  children,
  className = "",
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement>) {
  return (
    <td className={cx("px-4 py-3 align-middle text-text", className)} {...rest}>
      {children}
    </td>
  );
}
