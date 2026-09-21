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

/**
 * Everything a control looks like except its WIDTH. Split out so Input and
 * Select can leave `w-full` off when the caller asks for a width - see
 * OWNS_WIDTH.
 */
export const CONTROL_CHROME =
  "rounded-sm border border-border-strong bg-surface text-text " +
  "transition-colors duration-150 ease-out " +
  "placeholder:text-text-muted " +
  "hover:border-text-subtle " +
  "disabled:cursor-not-allowed disabled:border-border disabled:bg-surface-hover disabled:text-text-subtle";

/**
 * The full-width control. Select uses it as is, and hand-rolled controls in the
 * consoles (the note textareas in lead-drawer and the call explorer, the list
 * filters' select box) mirror it BY HAND and say so in their comments - so it
 * stays the one canonical string, byte-for-byte what it was before CONTROL_CHROME
 * was split out of it.
 */
export const CONTROL_BASE = `w-full ${CONTROL_CHROME}`;

/**
 * Does `className` set its own width? An unprefixed `w-*` - `w-48`, `w-auto`,
 * `w-[12rem]` - does; `min-w-*`, `max-w-*` and responsive `sm:w-*` do not, since
 * those sit ON TOP of a `w-full` base and already work.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * Same trap as Card's `p-6` and Skeleton's `rounded-sm` (cx.ts explains it):
 * `cx()` is a plain join, so `className="w-48"` did not REPLACE the base
 * `w-full`, it only landed after it, and Tailwind broke the tie by position in
 * the generated stylesheet - where `w-48` is emitted BEFORE `w-full`, so the
 * base won. Eleven call sites across both consoles asked for a fixed width
 * (`w-24` ... `w-56`, and `w-auto`) and every one silently got a full-width
 * control instead. No type error, no lint, no warning: a row of fields meant to
 * sit side by side stacked, one per line. cx.ts's own header says base classes
 * must stay free of width for exactly this reason; this file broke that rule.
 */
export const OWNS_WIDTH = /(?:^|\s)w-\S/;

/** A width utility under any variant: `w-48`, `sm:w-64`. Not `min-w-*` / `max-w-*`. */
const WIDTH_TOKEN = /^(?:[a-z0-9-]+:)*w-/;

/**
 * Splits width utilities off a `className`, for a control that is wrapped.
 *
 * Select needs it: its `<select>` sits inside a `relative` wrapper that also
 * positions the chevron. Narrowing only the `<select>` would leave the wrapper
 * full-width and the chevron stranded at the far right, away from the control it
 * belongs to. So width goes on the wrapper - which the select then fills with its
 * own `w-full` - and everything else stays on the `<select>`.
 */
export function splitWidth(className: string): { width: string; rest: string } {
  const tokens = className.split(/\s+/).filter(Boolean);
  return {
    width: tokens.filter((t) => WIDTH_TOKEN.test(t)).join(" "),
    rest: tokens.filter((t) => !WIDTH_TOKEN.test(t)).join(" "),
  };
}

/**
 * Padding and type size, split out of CONTROL_BASE so a caller can pick one
 * instead of overriding it.
 *
 * ── WHY A PROP AND NOT A className ──────────────────────────────────────────
 *
 * `cx()` is a plain join, so a `className="text-xs"` does not REPLACE the base
 * `text-sm` - both land in the string and Tailwind breaks the tie by position
 * in the generated stylesheet, not by argument order. That is the trap doc 22
 * §4 records against `Card`'s `p-6`, and it fails silently: no type error, no
 * warning, the control just keeps the size it was told to drop. Swapping the
 * whole token here means there is never a tie to break.
 *
 * `sm` exists because dense table rows are a real call site - the operator
 * console's team grid had two selects hand-rolled at `text-[10px] px-1 py-0.5`
 * precisely because the primitive offered nothing between "full width form
 * control" and "write your own".
 *
 * These are the DESKTOP sizes. On a phone every text control in the console is
 * raised to 16px by one rule in apps/web/app/globals.css - iOS Safari zooms a
 * focused control below that and never zooms back - and it is done there rather
 * than here because the console has thirty-odd hand-rolled inputs beside these
 * primitives, and a class only fixes the primitives.
 */
export const CONTROL_SIZES = {
  sm: "px-2 py-1 text-xs",
  md: "px-3 py-2 text-sm",
} as const;

export type ControlSize = keyof typeof CONTROL_SIZES;

/**
 * Invalid state. The red border is a *second* channel on top of the error text
 * FormField renders - never the only one, because a colour-blind or greyscale
 * user gets nothing from a red edge.
 */
export const CONTROL_INVALID = "border-danger hover:border-danger";
