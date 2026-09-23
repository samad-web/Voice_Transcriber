import type { ButtonHTMLAttributes, Ref } from "react";
import { cx } from "./cx";

/*
 * No "use client" - see button.tsx. The consumers that need state (the theme
 * toggle, the bell) are client components already.
 */

/**
 * The round, grey, 36px control the console header is made of: the theme
 * toggle, the notification bell and the Back button.
 *
 * Three hand-copied class strings was the point doc 24 said to stop copying:
 * the next one would have been a fourth chance for the header's controls to
 * stop lining up. Grey on purpose - colour in this console means call state,
 * and nothing in the header is a call.
 *
 * `wide` is the labelled form (an icon plus a word, e.g. "← Back" from `lg`):
 * same height and hover, padded instead of square. The focus ring is the
 * kit's global `:focus-visible` outline (theme.css), deliberately not
 * restated here.
 *
 * The class string is exported on its own because a link cannot be a
 * <button>: the Back button is a real `next/link` anchor, and the kit does not
 * import Next.
 */
export function headerIconButtonClass({ wide = false }: { wide?: boolean } = {}): string {
  return cx(
    "relative inline-flex h-9 shrink-0 items-center justify-center rounded-full text-text-muted",
    "transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-text active:bg-surface-hover",
    wide ? "gap-1.5 px-3 text-sm font-medium" : "w-9",
  );
}

export interface HeaderIconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon-only control has no other accessible name. */
  "aria-label": string;
  wide?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function HeaderIconButton({ wide = false, className, type = "button", ref, ...rest }: HeaderIconButtonProps) {
  return <button ref={ref} type={type} className={cx(headerIconButtonClass({ wide }), className)} {...rest} />;
}
