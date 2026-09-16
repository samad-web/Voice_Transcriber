import type { ReactNode } from "react";
import { cx } from "./cx";
import { StateChip } from "./state-chip";
import type { ConsoleState } from "./state";

/**
 * A KPI tile.
 *
 * ── WHY IT IS A SOLID FILL ──────────────────────────────────────────────────
 *
 * A dashboard's top row answers "how is the business doing" and every other
 * panel answers "why". Before this, the tiles were white cards on a white page
 * separated by a hairline, which made them the least prominent thing on screen
 * despite being the reason the page exists - people scrolled straight past
 * them to the tables.
 *
 * A solid fill fixes that with no extra ink: the row reads as one band, it is
 * the first thing the eye lands on, and the numbers inside it are large
 * high-contrast type on a saturated ground rather than dark type on white like
 * everything else. Nothing else in the console is filled, so nothing competes.
 *
 * ── AND WHOSE COLOUR IT IS ──────────────────────────────────────────────────
 *
 * The tenant's, where they have set one. Nothing in this file knows that: it
 * spends `--color-kpi` / `--color-kpi-fg` / `--color-kpi-hairline`, and the
 * owner console's layout re-points all three from `organizations.branding`.
 * The default is the orange below.
 *
 * That is also why the foreground is a TOKEN and not `text-white`. A hardcoded
 * white label is correct for exactly as long as the fill stays dark, and a
 * tenant with a yellow brand colour would have had white-on-yellow across the
 * whole headline row. `kpiSurface()` in @aura/shared picks paper or ink per
 * tenant, and shifts the fill itself when neither would have cleared 4.5:1.
 *
 * ── AND WHY THAT DOES NOT BREAK THE COLOUR RULE ─────────────────────────────
 *
 * The rule (state.tsx) is that colour encodes STATE, with orange reserved for
 * errors. A wall of orange tiles is in obvious tension with that, and the
 * tension is resolved by making the two oranges structurally impossible to
 * confuse rather than by hoping nobody notices:
 *
 *  - They are different colours from different tokens. `--color-kpi` (#C2410C
 *    by default, the tenant's own hue when branded) is a whole filled surface
 *    whose shade is chosen so 12px text clears 4.5:1 on it; `--color-orange`
 *    (#EA580C) is a bright signal orange that is never a surface. On a branded
 *    console they are not even the same hue.
 *  - They never appear in the same role. The KPI orange is only ever a whole
 *    filled surface. The error orange is only ever a chip, a glyph or a word on
 *    a neutral surface. A filled card is not a state and a state is never a
 *    filled card.
 *  - A state INSIDE a tile drops its hue entirely. `state` below renders an
 *    inverted chip in the tile's own foreground colour, and the state is
 *    carried by its glyph - the slashed ring, the triangle - exactly the
 *    greyscale-safe encoding the whole system already depends on. A red chip on
 *    a filled tile would read as decoration, and one matching the fill would
 *    vanish. This is also what keeps the tile honest on a branded console whose
 *    KPI colour happens to BE red: the chip is never the brand hue.
 *
 * `tone="plain"` opts a tile out of the fill for the rare case where a
 * secondary strip of tiles sits below the headline row and must not compete
 * with it.
 *
 * ── NUMBERS AND STRINGS ─────────────────────────────────────────────────────
 *
 * These tiles carry both - "1,284" and "Never seen" and "Sarvam / Saarika v2"
 * all end up here - and the two want opposite typography. A number wants
 * `tabular-nums` so a polling dashboard does not reflow by a pixel every few
 * seconds; a word set in tabular figures looks gappy and wrong because the
 * digits are the only glyphs being padded. A number is also short and can be
 * huge, while a string is long and has to come down in size or it wraps to
 * three lines and blows the tile's height out.
 *
 * So the tile decides, from the value itself, rather than making 35 call sites
 * remember to say. `format` overrides it when the guess is wrong - a version
 * string like "2.1" is numeric by shape and textual by meaning.
 */

export type StatFormat = "auto" | "number" | "text";

export interface StatCardProps {
  label: string;
  /** A number, a string, or arbitrary nodes. See the typography note above. */
  value: ReactNode;
  /**
   * The SECOND LINE - what this number means, or what it is a fraction of.
   * A bare "42" tells a reader nothing they can act on; "42 · 12 new this
   * week" does. Sits directly under the value, inside the fill.
   */
  context?: ReactNode;
  icon?: ReactNode;
  /** Renders an inverted state chip in the tile's corner. See the note above. */
  state?: ConsoleState;
  /** Overrides the state's default word ("Missed", "Error", …). */
  stateLabel?: string;
  /** Below the divider - a link, a comparison, a timestamp. */
  footer?: ReactNode;
  /** `plain` drops the fill for a secondary tile that must not compete. */
  tone?: "kpi" | "plain";
  format?: StatFormat;
  className?: string;
}

/**
 * A figure, as this console actually writes them: an optional currency mark, a
 * number, optionally over another number, optionally followed by a short unit.
 * "1,284", "₹4.5L", "82%", "30 min", "12/20", "45d".
 *
 * Anchored on a LEADING DIGIT rather than assembled from an allowlist of
 * characters, which is what the first version did and got wrong: a class
 * permissive enough to admit "₹4.5L" and "1.2k" also admitted "-" (the
 * console's own empty marker) and rejected "30 min", because "i" was not in
 * it. Structure is the thing being tested here, not vocabulary.
 */
const NUMERIC = /^\s*[₹$€£]?\s*[+\-–—]?\d[\d.,\s]*(?:\/\s*\d[\d.,]*)?\s*[a-zA-Z%]{0,4}\s*$/;

function isNumeric(value: ReactNode, format: StatFormat): boolean {
  if (format === "number") return true;
  if (format === "text") return false;
  if (typeof value === "number") return true;
  if (typeof value !== "string") return false;
  return NUMERIC.test(value);
}

/**
 * Long strings step down so the tile keeps its height. Numbers never do -
 * a seven-figure count is still short, and shrinking the headline number
 * because the business grew would be a strange thing for a dashboard to do.
 */
function sizeFor(value: ReactNode, numeric: boolean): string {
  if (numeric || typeof value !== "string") return "text-3xl";
  if (value.length <= 8) return "text-3xl";
  if (value.length <= 16) return "text-2xl";
  if (value.length <= 28) return "text-xl";
  return "text-lg";
}

export function StatCard({
  label,
  value,
  context,
  icon,
  state,
  stateLabel,
  footer,
  tone = "kpi",
  format = "auto",
  className = "",
}: StatCardProps) {
  const filled = tone === "kpi";
  const numeric = isNumeric(value, format);

  return (
    <div
      className={cx(
        "flex flex-col justify-between rounded-xl border p-6 shadow-card",
        filled
          ? // No border colour of its own: a hairline in any other colour
            // around a saturated fill reads as a printing error. The border
            // stays for layout parity with every unfilled Card on the page.
            "border-transparent bg-kpi text-kpi-fg"
          : "border-border bg-surface text-text",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        {/* min-w-0 + break-words: long values (region codes, 7-digit counts)
            wrap inside a narrow single-column card instead of overflowing it. */}
        <div className="min-w-0">
          {/* Full-contrast, not a tinted white. The label is 12px, which WCAG
              1.4.3 governs at 4.5:1, and `--color-kpi-fg` on `--color-kpi` is
              5.18:1. It is de-emphasised by weight and size instead. */}
          <p
            className={cx(
              "text-xs font-medium tabular-nums",
              filled ? "text-kpi-fg" : "text-text-muted",
            )}
          >
            {label}
          </p>
          <p
            className={cx(
              "mt-2 font-semibold break-words",
              sizeFor(value, numeric),
              // tabular-nums on a word pads its digits and nothing else, which
              // is why this is conditional rather than always on.
              numeric && "tabular-nums",
              filled ? "text-kpi-fg" : "text-text",
            )}
          >
            {value}
          </p>
          {context ? (
            <p
              className={cx(
                "mt-1 text-xs",
                filled ? "text-kpi-fg" : "text-text-muted",
              )}
            >
              {context}
            </p>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          {icon ? (
            // aria-hidden: the icon restates the label, and an unlabelled <svg>
            // announced next to it is noise. Callers pass lucide icons, which
            // otherwise expose themselves as generic graphics.
            <div
              aria-hidden="true"
              className={cx(
                "rounded-md p-2",
                // On the fill the icon is tinted, not boxed: a lighter box
                // behind it would be a third orange nobody measured. The tint
                // itself is 3.91:1 on the fill, past the 3:1 graphic floor.
                filled ? "text-kpi-hairline" : "bg-accent-subtle text-accent-text",
              )}
            >
              {icon}
            </div>
          ) : null}
          {state ? (
            <StateChip state={state} onFill={filled}>
              {stateLabel}
            </StateChip>
          ) : null}
        </div>
      </div>

      {footer ? (
        <div
          className={cx(
            "mt-4 flex items-center gap-1.5 border-t pt-3 text-xs tabular-nums",
            filled ? "border-kpi-hairline/40 text-kpi-fg" : "border-border text-text-muted",
          )}
        >
          {footer}
        </div>
      ) : null}
    </div>
  );
}
