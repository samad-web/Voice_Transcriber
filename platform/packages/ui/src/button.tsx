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

// `primary`'s fill is applied via inline style (see PRIMARY_GRADIENT below), not
// a class — a linear-gradient background isn't expressible as a Tailwind colour
// utility. Its class string here only carries the label colour, border removal,
// and the lift-on-hover motion; the gradient itself, and disabled/loading's
// override of it, are handled in the component body.
// Every variant now also defines an `active:` (press/tap) state, matching the
// precedent already set elsewhere in the kit (mobile-nav.tsx's iconButton,
// e.g. `active:bg-surface-hover`) — without it the button gave no feedback on
// a touch tap at all, since touch never fires `:hover`.
const VARIANTS: Record<ButtonVariant, string> = {
  // White label: the same gradient the marketing CTA already ships white text
  // on in production (mk-cta), so this pairing is already proven, not re-derived.
  // The gradient is an inline `background-image`, so an `active:bg-*` class
  // token would be painted underneath it and never show — hence `brightness`
  // (a filter, not a background) for the press state here, plus resetting the
  // hover lift so a press reads as "pushed back down."
  primary:
    "border-transparent text-white hover:-translate-y-px hover:shadow-md active:translate-y-0 active:shadow-none active:brightness-95",
  // Border shifts to the brand gradient's midpoint on hover, mirroring
  // mk-cta-ghost — no lift, unlike primary: this variant appears many times
  // per dense screen (toolbar/dialog buttons), where a translateY on every
  // hover would read as fidgety rather than branded.
  secondary:
    "bg-surface text-text border-border-strong hover:bg-surface-hover hover:border-[var(--brand-mid)] active:bg-surface-hover",
  ghost: "bg-transparent text-text border-transparent hover:bg-surface-hover active:bg-surface-hover",
  // The hover colour is the `-text` token rather than a dedicated danger-hover:
  // it is darker than --color-danger in light mode and lighter in dark, which
  // is the correct direction of travel in each. Label contrast holds both ways.
  // Active reuses the same pair, for the same touch-parity reason as above.
  danger:
    "bg-danger text-danger-fg border-danger hover:bg-danger-text hover:border-danger-text active:bg-danger-text active:border-danger-text",
};

/** Applied inline because a gradient fill can't be a Tailwind colour utility. */
const PRIMARY_GRADIENT = { backgroundImage: "var(--brand-gradient)" };

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
  // Disabled/loading primary buttons fall back to the same muted disabled
  // classes every other variant uses — an inline gradient would otherwise beat
  // `disabled:bg-surface-hover` outright, since inline style always wins over a
  // class for the same CSS property.
  const isDisabled = disabled || loading;
  const style = variant === "primary" && !isDisabled ? PRIMARY_GRADIENT : undefined;

  return (
    <button
      // `disabled` rather than aria-disabled: these are real buttons, and a
      // disabled button correctly drops out of the tab order here because the
      // console never uses one as the only explanation of why an action is
      // unavailable — that always sits in adjacent text.
      disabled={isDisabled}
      aria-busy={loading || undefined}
      style={style}
      className={cx(
        "inline-flex cursor-pointer select-none items-center justify-center rounded-full border font-medium",
        "transition-[color,background-color,border-color,box-shadow,transform] duration-150 ease-out",
        "disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-hover disabled:text-text-subtle disabled:hover:bg-surface-hover disabled:hover:translate-y-0 disabled:hover:shadow-none",
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
