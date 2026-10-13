import type { ReactNode } from "react";
import { Card } from "@aura/ui";
import { ClockChip } from "./panel";

/**
 * The CEO layout's headline band (Build docs/46): six tiles, one line of
 * evidence under each.
 *
 * ── WHY THESE ARE NOT `StatCard` ────────────────────────────────────────────
 *
 * `StatCard` is a solid KPI-orange fill, and it is that way for a good reason
 * (stat-card.tsx): on the old four-tile row the numbers were white cards on a
 * white page and people scrolled past them. That reason does not survive six
 * tiles. A six-wide band of saturated fill is a third of the first screen in
 * one colour, it flattens the six into a texture rather than six numbers, and
 * - the part that actually breaks - the layout needs to say "this number is a
 * problem" on two or three of them, which a tile that is already a solid
 * colour cannot do. `StatCard` resolves that by dropping the hue and using a
 * glyph, which works for one tile carrying one state and not for a row where
 * concern is the main reading.
 *
 * So: a plain surface, with CONCERN carried by the figure's own colour, and
 * never by colour alone - a concerned tile also says what is wrong in its
 * caption ("top caller idle 15 days", "3 open leads, unvalued"). The caption
 * is the encoding; the hue is the accelerator.
 *
 * The hue is `--color-orange`, the system's error orange, used here in its
 * documented role: a signal on a neutral surface, never a surface itself.
 * Deliberately NOT danger red - red in this console means a customer was not
 * picked up (state.tsx), and "pipeline is empty" is not a missed call.
 */

export interface KpiTile {
  key: string;
  label: string;
  /** "30d" · "now" · "7d" · "proj." - the clock this figure is on. */
  clock: string;
  /** The figure. A string so the caller owns currency and compaction. */
  value: ReactNode;
  /** The one line of evidence under it. Required: a bare number is not a KPI. */
  context: ReactNode;
  /**
   * Draw the figure and its caption in the signal hue. Set it only where the
   * CAPTION also says what is wrong - see the note above.
   */
  concern?: boolean;
}

/**
 * TWO UP ON A PHONE, not one.
 *
 * Six full-width tiles is two whole screens of scrolling before the reader
 * reaches a chart - the headline row becomes the thing you scroll PAST, which
 * is the exact failure the solid fill was introduced to fix on desktop. These
 * figures are short by construction ("₹2.5 L", "6%", "0 of 1"), so two fit a
 * 390px screen with room, and the whole band lands in one thumb's reach.
 */
export function KpiRow({ tiles }: { tiles: readonly KpiTile[] }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
      {tiles.map((t) => (
        <Card key={t.key} className="flex flex-col gap-2 p-4">
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs text-text-muted">{t.label}</p>
            <ClockChip>{t.clock}</ClockChip>
          </div>
          <p
            className={`text-2xl font-semibold tabular-nums ${t.concern ? "text-orange" : "text-text"}`}
          >
            {t.value}
          </p>
          <p className={`text-xs ${t.concern ? "text-orange-text" : "text-text-muted"}`}>{t.context}</p>
        </Card>
      ))}
    </div>
  );
}
