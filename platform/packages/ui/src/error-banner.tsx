import type { ReactNode } from "react";
import { cx } from "./cx";
import { STATE_TONE } from "./state";

/**
 * "That didn't work" - the panel a page shows after an action fails.
 *
 * ── WHY IT IS A COMPONENT ───────────────────────────────────────────────────
 *
 * Nine pages had grown their own, each one a hand-written
 * `border border-danger bg-danger-subtle text-danger-text` with slightly
 * different padding, and every one of them was red. Red now means MISSED
 * (state.tsx), so all nine were painting a failed save in the colour reserved
 * for the number an owner scans this console to find. Fixing that in nine
 * places would have left a tenth to be written next week.
 *
 * ── WHY IT IS NOT A TOAST ───────────────────────────────────────────────────
 *
 * These stay on screen. A toast is right for "saved" and wrong for "we could
 * not save": the person needs the text while they decide what to do about it,
 * and a message that removes itself after four seconds is one they will read
 * half of. `role="alert"` announces it once, immediately - which is the
 * correct urgency for something that just failed, and would be wrong for the
 * polite `role="status"` a syncing row uses.
 */
export function ErrorBanner({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cx(
        "flex items-start gap-2 rounded-md border px-3 py-2.5 text-sm",
        // Straight from STATE_TONE, so this banner and an "Error" chip can
        // never end up two different oranges.
        STATE_TONE.error.chip,
        className,
      )}
    >
      {/* The triangle, same as the chip's. Colour is never the only carrier of
          the state - in greyscale, on a print-out, or for a reader who cannot
          separate orange from red, the silhouette is what says "problem". */}
      <svg aria-hidden="true" viewBox="0 0 10 10" className="mt-1 h-3 w-3 shrink-0">
        {STATE_TONE.error.glyph}
      </svg>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
