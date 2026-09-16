import type { ComponentPropsWithRef } from "react";
import { CONTROL_BASE, CONTROL_INVALID } from "./control-styles";
import { cx } from "./cx";

/**
 * `ComponentPropsWithRef`, not `InputHTMLAttributes`, so callers can hold a
 * ref to the element. React 19 passes `ref` to a function component as an
 * ordinary prop, so no `forwardRef` is needed - but the props type has to
 * admit it, and `InputHTMLAttributes` alone does not. Strictly wider than what
 * this accepted before; nothing that compiled stops compiling.
 *
 * The confirm dialog's type-DELETE gate needs it: that field has to take focus
 * the moment the dialog opens.
 */
export interface InputProps extends ComponentPropsWithRef<"input"> {
  /** Sets `aria-invalid` and the danger border. FormField sets this for you. */
  invalid?: boolean;
  className?: string;
}

/**
 * A plain `<input>` with the system's chrome. Uncontrolled by default, so it
 * works inside a Server Action form with no client JS at all - which is what the
 * slice-4 funnel needs on a 4G phone.
 *
 * There is no `label` prop: use `FormField`, which owns the id/`for` wiring.
 * A bare `Input` with no associated `<label>` is a WCAG 3.3.2 failure and this
 * component cannot detect that for you.
 */
export function Input({ invalid = false, className = "", ...rest }: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cx(CONTROL_BASE, invalid && CONTROL_INVALID, className)}
      {...rest}
    />
  );
}
