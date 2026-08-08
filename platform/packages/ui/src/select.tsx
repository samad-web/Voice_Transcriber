import type { ReactNode, SelectHTMLAttributes } from "react";
import { CONTROL_BASE, CONTROL_INVALID } from "./control-styles";
import { cx } from "./cx";

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  children: ReactNode;
  invalid?: boolean;
  className?: string;
}

/**
 * A native `<select>`, deliberately.
 *
 * A custom listbox is the single most common source of keyboard and screen
 * reader regressions in a design system, and it costs a client bundle on every
 * page that uses one. The native control gets type-ahead, mobile's native
 * picker, and correct announcement for free. The trade is that the option list
 * cannot be styled — which for a CRM picker and a country code is no loss.
 *
 * `appearance-none` + our own chevron so the closed state matches Input; the
 * chevron is `pointer-events-none` so clicks fall through to the select, and
 * the right padding leaves room for it. Long option labels are the reason for
 * `pr-9` rather than a background-image.
 */
export function Select({ children, invalid = false, className = "", ...rest }: SelectProps) {
  return (
    <div className="relative">
      <select
        aria-invalid={invalid || undefined}
        className={cx(
          CONTROL_BASE,
          "cursor-pointer appearance-none pr-9",
          invalid && CONTROL_INVALID,
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <svg
        aria-hidden="true"
        viewBox="0 0 12 12"
        className="pointer-events-none absolute top-1/2 right-3 h-3 w-3 -translate-y-1/2 text-text-muted"
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
