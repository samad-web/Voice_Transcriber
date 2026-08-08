import type { InputHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Visible label text. Required — an unlabelled checkbox is a WCAG failure. */
  label: ReactNode;
  /** Secondary line under the label: consent wording, an explanation, a caveat. */
  description?: ReactNode;
  className?: string;
}

/**
 * Native `<input type="checkbox">` inside a wrapping `<label>`.
 *
 * Two decisions worth defending:
 *
 * 1. **Native, tinted with `accent-color`,** not an `appearance-none` box with a
 *    hand-drawn tick. A custom checkbox has to re-implement the checked state,
 *    the indeterminate state, the focus ring and the announcement, and it is
 *    where design systems most often quietly break for screen readers. The tint
 *    is one property and the browser keeps everything else correct.
 *
 * 2. **Wrapping label, not `htmlFor`.** Implicit association cannot go stale,
 *    and it makes the text a click target, which on a phone is the difference
 *    between a 16px hit area and a 44px one. `id` still passes through for
 *    anything that needs to point at the control.
 *
 * The consent checkbox in the slice-4 funnel must ship `defaultChecked={false}`:
 * a pre-ticked consent box is not consent under the DPDP Act or the GDPR
 * (doc 16 §0.3). This component deliberately does not default it either way.
 */
export function Checkbox({ label, description, className = "", ...rest }: CheckboxProps) {
  return (
    <label
      className={cx(
        "flex cursor-pointer items-start gap-2.5 text-sm text-text",
        rest.disabled && "cursor-not-allowed text-text-subtle",
        className,
      )}
    >
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded-sm accent-accent disabled:cursor-not-allowed"
        {...rest}
      />
      <span className="min-w-0">
        {label}
        {description ? (
          <span className="mt-0.5 block text-xs text-text-muted">{description}</span>
        ) : null}
      </span>
    </label>
  );
}
