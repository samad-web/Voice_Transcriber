/*
 * Shared chrome for text-entry controls (Input, Select, and anything added
 * later). Kept in one place because the thing that must not drift between them
 * is the *border*: with the brutalist 2px black outline gone, the edge of a
 * control is the only thing that says "you can type here", which makes it
 * exactly the "visual information required to identify a UI component" that
 * WCAG 1.4.11 puts a 3:1 floor under. --color-border-strong is tuned to clear
 * that against bg, surface and bg-subtle; --color-border (the decorative
 * hairline) is 1.26:1 and must never be used here.
 */

export const CONTROL_BASE =
  "w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-text " +
  "transition-colors duration-150 ease-out " +
  "placeholder:text-text-muted " +
  "hover:border-text-subtle " +
  "disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-hover disabled:text-text-subtle";

/**
 * Invalid state. The red border is a *second* channel on top of the error text
 * FormField renders — never the only one, because a colour-blind or greyscale
 * user gets nothing from a red edge.
 */
export const CONTROL_INVALID = "border-danger hover:border-danger";
