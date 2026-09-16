import type { ReactNode } from "react";
import { cx } from "./cx";
import { STATE_TONE } from "./state";

/*
 * Colour alone must never be the difference between two statuses (WCAG 1.4.1,
 * and about 8% of men cannot make a red/green distinction reliably). It also
 * disappears entirely when an operator prints or screenshots a call list in
 * greyscale, which is how these get pasted into WhatsApp in this market.
 *
 * So each tone carries a distinct GLYPH as well as a distinct colour, and the
 * glyphs are chosen to differ in silhouette rather than in hue: a filled disc, a
 * hollow ring, a bar, a triangle. Squint at them in greyscale and they are still
 * four different marks.
 *
 * ── WHAT THIS COMPONENT IS FOR NOW ──────────────────────────────────────────
 *
 * Everything that is NOT one of the four states in `state.tsx`: a capability, a
 * plan tier, a device's enrolment, a count. Three of its four tones are
 * therefore NEUTRAL - grey, by design, because the functional colour rule says
 * a category is not a state and does not get a hue.
 *
 * `danger` is the exception and it is no longer red. Red now means MISSED and
 * only missed (see state.tsx for why), so the one thing StatusChip is still
 * allowed to colour - something the system failed at - takes the error orange
 * straight out of `STATE_TONE`, and keeps the triangle it always had. Call
 * sites did not have to change: every existing `tone="danger"` in the console
 * marks a failure, a stale device or a flagged call, which is exactly "error".
 *
 * For an actual call state, reach for `StateChip` instead. This component
 * cannot express "missed" and that is deliberate.
 */
const TONES = {
  solid: {
    className: "border-transparent bg-text text-bg",
    // Filled disc - "on / active".
    glyph: <circle cx="5" cy="5" r="3.5" fill="currentColor" />,
  },
  muted: {
    className: "border-border-strong bg-surface-hover text-text",
    // Bar - "neutral / informational".
    glyph: <rect x="1.5" y="4" width="7" height="2" rx="1" fill="currentColor" />,
  },
  outline: {
    className: "border-border-strong bg-transparent text-text-muted",
    // Hollow ring - "inactive / not yet".
    glyph: <circle cx="5" cy="5" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />,
  },
  // Orange, not red - and drawn from STATE_TONE rather than restating the
  // classes, so this chip and a StateChip labelled "Error" can never drift
  // into two different oranges.
  danger: {
    className: STATE_TONE.error.chip,
    glyph: STATE_TONE.error.glyph,
  },
} as const;

export function StatusChip({
  children,
  tone = "solid",
  className = "",
}: {
  children: ReactNode;
  tone?: keyof typeof TONES;
  className?: string;
}) {
  const { className: toneClass, glyph } = TONES[tone];
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        toneClass,
        className,
      )}
    >
      {/* aria-hidden: the glyph is a redundant encoding of the tone, and the
          chip's own text is what actually names the status. Announcing an
          unlabelled shape before it would make every chip read twice. */}
      <svg aria-hidden="true" viewBox="0 0 10 10" className="h-2.5 w-2.5 shrink-0">
        {glyph}
      </svg>
      {children}
    </span>
  );
}
