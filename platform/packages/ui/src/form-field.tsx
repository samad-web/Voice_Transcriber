import { cloneElement, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { cx } from "./cx";
import { Input } from "./input";
import { Label } from "./label";
import { PasswordInput } from "./password-input";
import { Select } from "./select";

export interface FormFieldProps {
  /** Visible question text. Sentence case. */
  label: ReactNode;
  /** Form field name. Also seeds the generated ids - see the note below. */
  name: string;
  /** Exactly one control: `Input`, `Select`, a `<textarea>`, anything. */
  children: ReactNode;
  /** Inline validation message. Null/undefined means valid. */
  error?: string | null;
  /** Help text shown under the control when there is no error. */
  hint?: ReactNode;
  required?: boolean;
  /** Override the derived id when two fields on one page share a `name`. */
  id?: string;
  className?: string;
}

/**
 * Label + control + hint + inline error, with the ARIA wiring done here so no
 * form in either app has to remember it.
 *
 * **Why ids are derived from `name` instead of `useId`.** `useId` is a hook, and
 * a hook makes this a Client Component - which would drag every form in an
 * RSC-first console, and the whole slice-4 funnel, into the client bundle for
 * the sake of a string. `name` is already required on any control that submits,
 * and is already unique within a form. Two fields sharing a `name` on one page
 * (two forms, same field) is the one case it breaks, and `id` overrides it.
 *
 * **What it wires:**
 * - `<label for>` → control `id`, so clicking the label focuses the control and
 *   a screen reader announces the question with it.
 * - `aria-describedby` → the hint id and/or the error id, merged with anything
 *   the child already declared. This is the bit that is always forgotten by
 *   hand, and the reason an error message otherwise exists only for sighted
 *   users.
 * - `aria-invalid` on the control when `error` is set.
 * - `role="alert"` on the error, so a server-action round trip announces the
 *   failure instead of silently repainting the field red.
 *
 * The error and the hint both use *text*, never colour alone (WCAG 1.4.1).
 * Hint text uses `--color-text-muted` (4.89:1) rather than `--color-text-subtle`
 * (3.45:1) - a hint carries information, so it is body text and owes the full
 * 4.5:1, not the large-text allowance.
 */
export function FormField({
  label,
  name,
  children,
  error,
  hint,
  required = false,
  id,
  className = "",
}: FormFieldProps) {
  // The child's own `id` wins, because the cloneElement below preserves it and
  // that is what actually lands in the DOM - deriving `htmlFor` from `name`
  // regardless would point the <label> at an element that does not exist.
  const childId =
    isValidElement(children) && typeof (children.props as Record<string, unknown>).id === "string"
      ? ((children.props as Record<string, unknown>).id as string)
      : undefined;
  const controlId = childId ?? id ?? `ff-${name}`;
  const errorId = `${controlId}-error`;
  const hintId = `${controlId}-hint`;

  // The hint is suppressed while an error is showing (see the render below), so
  // it must drop out of aria-describedby at the same time - pointing the control
  // at an id that is not in the document is a dangling reference that some
  // screen readers report as an empty description and others skip silently.
  const showHint = Boolean(hint) && !error;
  const describedBy = [showHint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ");

  let control: ReactNode = children;
  if (isValidElement(children)) {
    const existing = children.props as Record<string, unknown>;
    const existingDescribedBy =
      typeof existing["aria-describedby"] === "string" ? existing["aria-describedby"] : "";
    const merged = [existingDescribedBy, describedBy].filter(Boolean).join(" ");

    control = cloneElement(children as ReactElement<Record<string, unknown>>, {
      id: (existing.id as string | undefined) ?? controlId,
      name: (existing.name as string | undefined) ?? name,
      required: (existing.required as boolean | undefined) ?? required,
      "aria-describedby": merged || undefined,
      "aria-invalid": error ? true : (existing["aria-invalid"] as boolean | undefined),
      // `invalid` is our own prop on Input/Select and drives the danger border.
      // Passing it to a plain <textarea> would leak an unknown DOM attribute, so
      // it is only set for components we know accept it: our own Input/Select
      // (matched by identity, so the common `<FormField><Input/></FormField>`
      // actually turns red), or any child that already declares the prop.
      ...(children.type === Input ||
      children.type === PasswordInput ||
      children.type === Select ||
      "invalid" in existing
        ? { invalid: Boolean(error) }
        : {}),
    });
  }

  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <Label htmlFor={controlId} required={required}>
        {label}
      </Label>
      {control}
      {/* Hint hides while an error is showing: two competing sub-labels under
          one control is noise, and the error is the thing that needs reading. */}
      {showHint ? (
        <p id={hintId} className="text-xs text-text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-xs font-medium text-danger-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
