import type { ComponentPropsWithRef } from "react";
import {
  CONTROL_BASE,
  CONTROL_CHROME,
  CONTROL_INVALID,
  CONTROL_SIZES,
  OWNS_WIDTH,
  type ControlSize,
} from "./control-styles";
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
/*
 * `size` is omitted from the native props and redefined. HTML's `size` on an
 * <input> is a width in CHARACTERS, which is meaningless here - every control
 * in this system is sized by `w-full` and its container - and nothing in either
 * app passes it (checked: the only numeric `size=` call sites are `Logo`'s own
 * prop). Taking the name buys the same `size="sm"` spelling Button already uses,
 * so one word means one thing across the kit.
 */
export interface InputProps extends Omit<ComponentPropsWithRef<"input">, "size"> {
  /** Sets `aria-invalid` and the danger border. FormField sets this for you. */
  invalid?: boolean;
  /** `sm` for dense rows. See CONTROL_SIZES for why this is a prop, not a class. */
  size?: ControlSize;
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
 *
 * Full width by default. A caller's own `w-*` REPLACES that rather than fighting
 * it - see OWNS_WIDTH for why a plain `className="w-48"` used to be ignored.
 */
export function Input({ invalid = false, size = "md", className = "", ...rest }: InputProps) {
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cx(
        OWNS_WIDTH.test(className) ? CONTROL_CHROME : CONTROL_BASE,
        CONTROL_SIZES[size],
        invalid && CONTROL_INVALID,
        className,
      )}
      {...rest}
    />
  );
}
