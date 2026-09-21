import type { ReactNode, SelectHTMLAttributes } from "react";
import {
  CONTROL_BASE,
  CONTROL_INVALID,
  CONTROL_SIZES,
  splitWidth,
  type ControlSize,
} from "./control-styles";
import { cx } from "./cx";

/*
 * `size` is omitted from the native props and redefined - see Input's note. On
 * a <select> the native `size` is the number of VISIBLE ROWS, and any value
 * above 1 turns the control into a permanently-open list box, which is a
 * different component from the one this file documents. Nothing in either app
 * passes it.
 */
export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "size"> {
  children: ReactNode;
  invalid?: boolean;
  /** `sm` for dense table rows. See CONTROL_SIZES for why this is a prop. */
  size?: ControlSize;
  className?: string;
}

/** Right padding that clears the chevron, and the chevron's own inset, per size. */
const CHEVRON: Record<ControlSize, { pad: string; inset: string }> = {
  sm: { pad: "pr-7", inset: "right-2 h-2.5 w-2.5" },
  md: { pad: "pr-9", inset: "right-3 h-3 w-3" },
};

/**
 * A native `<select>`, deliberately.
 *
 * A custom listbox is the single most common source of keyboard and screen
 * reader regressions in a design system, and it costs a client bundle on every
 * page that uses one. The native control gets type-ahead, mobile's native
 * picker, and correct announcement for free. The trade is that the option list
 * cannot be styled - which for a CRM picker and a country code is no loss.
 *
 * `appearance-none` + our own chevron so the closed state matches Input; the
 * chevron is `pointer-events-none` so clicks fall through to the select, and
 * the right padding leaves room for it. Long option labels are the reason for
 * `pr-9` rather than a background-image.
 *
 * A `w-*` in `className` sizes the WRAPPER, not the `<select>`: the wrapper is
 * what the chevron is positioned against, so narrowing only the select would
 * strand the chevron at the far right. The select keeps its `w-full` and simply
 * fills whatever width the wrapper was given. Everything else in `className`
 * (`text-xs`, `min-w-*`, ...) still lands on the `<select>` itself.
 */
export function Select({
  children,
  invalid = false,
  size = "md",
  className = "",
  ...rest
}: SelectProps) {
  const chevron = CHEVRON[size];
  const { width, rest: selectClass } = splitWidth(className);
  return (
    <div className={cx("relative", width)}>
      <select
        aria-invalid={invalid || undefined}
        className={cx(
          CONTROL_BASE,
          CONTROL_SIZES[size],
          "cursor-pointer appearance-none",
          chevron.pad,
          invalid && CONTROL_INVALID,
          selectClass,
        )}
        {...rest}
      >
        {children}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 12 12"
        className={cx(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-text-muted",
          chevron.inset,
        )}
        fill="none"
      >
        <path
          d="M2.5 4.5 6 8l3.5-3.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
