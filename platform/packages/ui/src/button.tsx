import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/*
 * No "use client".
 *
 * A module without the directive is pulled into whichever graph imports it: a
 * Server Component renders it to plain HTML, a Client Component bundles it and
 * its `onClick` works normally. Marking it "use client" would force every page
 * that merely renders a static link-styled button into the client bundle for
 * nothing. (Checked: only one non-client file in apps/web renders BrutalButton
 * — instances/page.tsx — and it passes no handler.)
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  // accent-fg, not white: in dark mode the accent brightens to #3B82F6 so that
  // the focus ring clears 3:1, and white-on-#3B82F6 is only 3.95:1. The token
  // flips to near-black there and the label stays at 5.19:1.
  primary:
    "bg-accent text-accent-fg border-accent hover:bg-accent-hover hover:border-accent-hover",
  secondary:
    "bg-surface text-text border-border-strong hover:bg-surface-hover hover:border-text-subtle",
  ghost: "bg-transparent text-text border-transparent hover:bg-surface-hover",
  // The hover colour is the `-text` token rather than a dedicated danger-hover:
  // it is darker than --color-danger in light mode and lighter in dark, which
  // is the correct direction of travel in each. Label contrast holds both ways.
  danger:
    "bg-danger text-danger-fg border-danger hover:bg-danger-text hover:border-danger-text",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-3 text-xs",
  md: "h-10 gap-2 px-4 text-sm",
  lg: "h-12 gap-2 px-6 text-base",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, blocks the click, and marks the control `aria-busy`. */
  loading?: boolean;
  className?: string;
}

/**
 * The one button.
 *
 * Accessibility notes that are easy to lose in review:
 * - `type` is NOT defaulted. HTML's default is `submit`, and several console
 *   forms depend on that; defaulting to `button` here would silently stop them
 *   submitting. Set `type="button"` at the call site for non-submit buttons.
 * - An icon-only button MUST be given `aria-label` — there is no text node for
 *   a screen reader to announce.
 * - Disabled styling uses explicit tokens, not `opacity-50`. Halving the
 *   opacity of already-muted text produces an unpredictable ratio; a fixed pair
 *   is at least a known quantity. (WCAG 1.4.3 exempts inactive controls, so the
 *   goal here is legibility, not a ratio.)
 */
export function Button({
  children,
  variant = "primary",
  size = "md",
  loading = false,
  className = "",
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      // `disabled` rather than aria-disabled: these are real buttons, and a
      // disabled button correctly drops out of the tab order here because the
      // console never uses one as the only explanation of why an action is
      // unavailable — that always sits in adjacent text.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex cursor-pointer select-none items-center justify-center rounded-md border font-medium",
        "transition-colors duration-150 ease-out",
        "disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-hover disabled:text-text-subtle disabled:hover:bg-surface-hover",
        SIZES[size],
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <>
          {/* aria-hidden + an sr-only string: the spinning ring is decoration,
              the word "Loading" is the information. Under
              prefers-reduced-motion the global rule in theme.css flattens the
              animation, which is why the text has to carry the meaning. */}
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            className="h-4 w-4 shrink-0 animate-spin"
            fill="none"
          >
            <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="2" opacity="0.25" />
            <path
              d="M14 8a6 6 0 0 0-6-6"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
          <span className="sr-only">Loading</span>
        </>
      ) : null}
      {children}
    </button>
  );
}
