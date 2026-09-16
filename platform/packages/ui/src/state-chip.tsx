import type { ReactNode } from "react";
import { cx } from "./cx";
import { STATE_TONE, type ConsoleState } from "./state";

export interface StateChipProps {
  state: ConsoleState;
  /** Overrides the state's default word. The TONE is not overridable - that is
   *  the whole point of the system. */
  children?: ReactNode;
  /**
   * Inverted rendering, for a chip sitting on a KPI tile's solid orange fill.
   * The state's hue is unusable there (an orange chip vanishes into it and a
   * red one reads as decoration), so on a filled tile the glyph carries the
   * state on its own and the chip is simply white.
   */
  onFill?: boolean;
  className?: string;
}

/**
 * The one way a state is shown.
 *
 * Prefer this over `StatusChip` whenever the thing being labelled is one of
 * the four states in `state.tsx`. StatusChip stays for everything that is NOT
 * a state - a capability, a plan tier, a count - and its tones are neutral by
 * design.
 */
export function StateChip({ state, children, onFill = false, className = "" }: StateChipProps) {
  const tone = STATE_TONE[state];
  const label = children ?? tone.label;

  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        onFill ? "border-transparent bg-kpi-fg text-kpi" : tone.chip,
        className,
      )}
    >
      {/* aria-hidden: the glyph is a redundant encoding of the state for
          sighted readers who cannot use the hue. What a screen reader gets is
          the label, plus `meaning` below when the label does not already
          contain it. */}
      <svg aria-hidden="true" viewBox="0 0 10 10" className="h-2.5 w-2.5 shrink-0">
        {tone.glyph}
      </svg>
      {label}
      {/* A call site that renames "Missed" to "12" (a count chip) would
          otherwise announce as a bare number with the state carried entirely
          in a colour and a shape - both invisible to a screen reader. */}
      {children !== undefined && tone.meaning ? (
        <span className="sr-only">{` (${tone.meaning})`}</span>
      ) : null}
    </span>
  );
}

/**
 * The leading rule down the side of a table row or card.
 *
 * 3px of colour at the row's left edge, which is enough to make a list of
 * calls scannable at arm's length without putting a chip in every row. It is
 * always accompanied by a real chip or a word somewhere in the row - this is
 * an accelerator, never the only carrier of the state.
 */
export function StateRule({ state, className = "" }: { state: ConsoleState; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "absolute inset-y-0 left-0 w-[3px] rounded-r-sm",
        state === "neutral" ? "bg-transparent" : STATE_TONE[state].dot,
        className,
      )}
    />
  );
}
