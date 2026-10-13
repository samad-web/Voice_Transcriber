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
 *
 * ── `stacked`: ONE CARD PER ROW ON A PHONE ──────────────────────────────────
 *
 * Sideways scrolling keeps a wide table from breaking the page, but it is a
 * poor way to READ one on a phone: the reader loses the identifying column
 * the moment they scroll to the column they wanted, and has to shuttle back
 * and forth to pair a value with a row.
 *
 * `stacked` turns each row into a card below `md`, one labelled line per
 * cell. It needs each `TableCell` to carry a `label` - the column's own
 * heading - because a bare column of values with the header row gone is
 * unreadable. A cell with no `label` still renders, just without a label
 * line: that is how a checkbox or a row-actions menu opts out of the card
 * without the phone losing the control.
 *
 * It is OPT-IN rather than the default for two reasons: a table whose cells
 * have no labels would silently render as an unlabelled list, and some
 * tables (a dense numeric matrix, a timesheet) genuinely read better as a
 * grid you scroll. The markup stays a real `<table>` either way - the
 * stacking is CSS, so a screen reader keeps its table semantics.
 */
export function Table({
  caption,
  captionVisible = false,
  stacked = false,
  children,
  className = "",
}: {
  caption: string;
  captionVisible?: boolean;
  /** Below `md`, draw each row as a labelled card. Cells need a `label`. */
  stacked?: boolean;
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
      data-stacked={stacked ? "true" : undefined}
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
  label,
  className = "",
  ...rest
}: TdHTMLAttributes<HTMLTableCellElement> & {
  /**
   * The column's heading, repeated on the cell so a stacked card can show it.
   * Only read when the enclosing `Table` has `stacked`; it costs an attribute
   * otherwise. A cell with no label still renders when stacked, just without
   * a label line - that is how a checkbox or an actions column opts out.
   */
  label?: string;
}) {
  return (
    <td
      data-label={label}
      className={cx("px-4 py-3 align-middle text-text", className)}
      {...rest}
    >
      {children}
    </td>
  );
}
