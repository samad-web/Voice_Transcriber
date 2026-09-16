import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * SELF-TEACHING MICROCOPY.
 *
 * One line, inside the row, saying what this control does or what the system
 * is doing - written for somebody who has never seen the screen before and is
 * not going to read documentation.
 *
 * ── WHY IN THE ROW AND NOT IN A TOOLTIP ─────────────────────────────────────
 *
 * A tooltip has to be discovered. It requires a hover, which does not exist on
 * the phones half this console is read on, and it disappears the moment the
 * pointer moves - so it cannot be read while operating the thing it describes.
 * The information that decides whether somebody flips a switch has to be
 * visible at the moment they are deciding, which is the moment they are
 * looking at the switch.
 *
 * The cost is vertical space, and it is worth paying exactly where a row asks
 * the reader to DO something or tells them the system is MID-SOMETHING. A row
 * that is simply reporting a fact gets no hint - a table where every row
 * carries a sentence is a table nobody scans, and the copy stops being read at
 * all, which is worse than not having it.
 *
 * ── WHY IT IS NEVER COLOURED ────────────────────────────────────────────────
 *
 * A hint is not a state (state.tsx). It is always muted grey, even on an
 * errored row, because the state is already carried by the row's chip and
 * rule - saying it twice in two different reds would be the fastest way to
 * spend down a colour system that only works while it is scarce.
 */

export type RowHintKind = "toggle" | "dropzone" | "syncing" | "action" | "blocked";

const GLYPHS: Record<RowHintKind, ReactNode> = {
  // A switch in its off position - the shape of the control being described.
  toggle: (
    <>
      <rect x="0.75" y="3" width="10.5" height="6" rx="3" fill="none" stroke="currentColor" />
      <circle cx="3.75" cy="6" r="1.6" fill="currentColor" />
    </>
  ),
  // An arrow dropping into a tray.
  dropzone: (
    <>
      <path
        d="M6 1.5 V6.5 M3.8 4.6 L6 6.8 L8.2 4.6"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M1.75 8.5 V9.75 H10.25 V8.5" fill="none" stroke="currentColor" strokeLinecap="round" />
    </>
  ),
  // Three-quarter ring - a spinner at rest. The motion is added below.
  syncing: (
    <path
      d="M10 6 A4 4 0 1 1 6 2"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
  ),
  // A pointer nudging right - "your move".
  action: (
    <path
      d="M2 6 H9 M6.5 3.5 L9 6 L6.5 8.5"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ),
  blocked: (
    <>
      <rect x="2.5" y="5.25" width="7" height="4.5" rx="1" fill="none" stroke="currentColor" />
      <path d="M4.25 5.25 V3.75 a1.75 1.75 0 0 1 3.5 0 V5.25" fill="none" stroke="currentColor" />
    </>
  ),
};

export interface RowHintProps {
  kind: RowHintKind;
  children: ReactNode;
  /**
   * Set this and point the control's `aria-describedby` at it. Without that
   * wiring the hint is visible to a sighted reader and silent for a screen
   * reader landing directly on the switch, which is the reader who most needs
   * to be told what it does before flipping it.
   */
  id?: string;
  className?: string;
}

export function RowHint({ kind, children, id, className = "" }: RowHintProps) {
  return (
    <p
      id={id}
      className={cx(
        "mt-1 flex items-start gap-1.5 text-xs leading-snug text-text-muted",
        className,
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 12 12"
        // 0.5 stroke-width baseline keeps the 12px glyphs from going muddy;
        // individual paths above override where they need weight.
        strokeWidth="1"
        className={cx(
          "mt-[0.15rem] h-3 w-3 shrink-0",
          // The only animated hint. `motion-reduce:animate-none` rather than
          // relying on theme.css's global duration kill: that clamps
          // transitions and animation-duration, and a spinner reduced to
          // 0.01ms still spins - it just does it 100 times a second.
          kind === "syncing" && "animate-spin motion-reduce:animate-none",
        )}
      >
        {GLYPHS[kind]}
      </svg>
      <span>{children}</span>
    </p>
  );
}

/**
 * The hint for a row the system is actively working on.
 *
 * Separate from `<RowHint kind="syncing">` only in that it announces itself:
 * a row that changes underneath a screen-reader user with no announcement is a
 * row that appears to have done nothing. `aria-live="polite"` waits for a
 * pause rather than interrupting, which is right for "still working" - it is
 * never urgent.
 */
export function SyncingHint({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <span role="status" aria-live="polite">
      <RowHint kind="syncing" className={className}>
        {children}
      </RowHint>
    </span>
  );
}
