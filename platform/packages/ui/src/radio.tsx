import type { InputHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "type"> {
  label: ReactNode;
  description?: ReactNode;
  className?: string;
}

/**
 * One radio option. Same native-control reasoning as `Checkbox`.
 *
 * Radios only make sense in a group, and a group needs a group label — wrap them
 * in `RadioGroup` rather than dropping loose `Radio`s next to a `<p>`. Arrow-key
 * navigation and roving focus come from the browser as long as every option in
 * the group shares a `name`.
 */
export function Radio({ label, description, className = "", ...rest }: RadioProps) {
  return (
    <label
      className={cx(
        "flex cursor-pointer items-start gap-2.5 text-sm text-text",
        rest.disabled && "cursor-not-allowed text-text-subtle",
        className,
      )}
    >
      <input
        type="radio"
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed"
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

/**
 * `<fieldset>` + `<legend>` around a set of `Radio`s.
 *
 * This is not decoration. Without it a screen reader announces "Yes, radio
 * button, 1 of 3" with no indication of what the question was — the legend is
 * the only thing that attaches the question to the answers. The funnel's three
 * CRM questions (doc 16 §3.7) are exactly this shape.
 *
 * `legend` is styled rather than visually hidden, because these questions are
 * meant to be read.
 */
export function RadioGroup({
  legend,
  hint,
  children,
  className = "",
}: {
  legend: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <fieldset className={cx("min-w-0 border-0 p-0", className)}>
      <legend className="mb-1 text-sm font-medium text-text">{legend}</legend>
      {hint ? <p className="mb-2 text-xs text-text-muted">{hint}</p> : null}
      <div className="mt-2 flex flex-col gap-2">{children}</div>
    </fieldset>
  );
}
