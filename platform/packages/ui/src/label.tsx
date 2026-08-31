import type { LabelHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export interface LabelProps extends LabelHTMLAttributes<HTMLLabelElement> {
  children: ReactNode;
  /** Renders the required marker. Does not itself set `required` on the control. */
  required?: boolean;
  className?: string;
}

export function Label({ children, required = false, className = "", ...rest }: LabelProps) {
  return (
    <label className={cx("block text-sm font-medium text-text", className)} {...rest}>
      {children}
      {required ? (
        <>
          {/* The asterisk is aria-hidden and paired with a real word, because
              "*" is announced inconsistently across screen readers - VoiceOver
              says "star", NVDA often says nothing at all. The control itself
              also carries `required`/`aria-required`; this is the visual half. */}
          <span aria-hidden="true" className="ml-0.5 text-danger">
            *
          </span>
          <span className="sr-only"> (required)</span>
        </>
      ) : null}
    </label>
  );
}
