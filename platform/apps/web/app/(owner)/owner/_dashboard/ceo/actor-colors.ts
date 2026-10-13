/**
 * One colour per person, the same colour everywhere (Build docs/46).
 *
 * The CEO layout asks about the same four or five actors in six places - the
 * attribution donuts, the per-metric bars, the effort scatter, the alert list.
 * They are only readable as one section if Brindha is the same blue in all of
 * them, so the mapping is made ONCE, from the floor's full roster, and handed
 * down. No panel picks its own colours.
 *
 * ── WHY THE SLOT IS FIXED TO THE PERSON ──────────────────────────────────
 *
 * Assigned by call volume, descending, and then held. The alternative - each
 * panel colouring its own rows in its own order - repaints the floor four
 * times on one screen: the top slice of the revenue donut and the top slice of
 * the calls donut would both be slot 1 blue while being different people. The
 * sort order already says who leads a panel; colour has to say who they are.
 *
 * ── AND WHY THE CLASS NAMES ARE WRITTEN OUT ──────────────────────────────
 *
 * Tailwind v4 only emits CSS for class names it can read statically in the
 * source. A computed `bg-chart-cat-${slot}` produces no rule at all and the
 * mark renders transparent - the same trap the seq ramp carries a warning
 * about in theme.css. Hence the literal table below.
 */

/** How many identity hues exist. A ninth actor folds into the neutral. */
export const ACTOR_SLOTS = 5;

interface ActorStyle {
  /** A filled mark: a donut arc, a bar, a dot. */
  fill: string;
  /** The same hue as a stroke, for the scatter's rings and the line marks. */
  stroke: string;
  /** The same hue as text, for a direct label that has to carry identity. */
  text: string;
}

/**
 * Slot 1-5, then the neutral. Index 5 is "Unattributed" and every actor past
 * the fifth: a deliberately grey, obviously-not-a-person tone, so a long tail
 * reads as a tail rather than as six more colleagues.
 */
const STYLES: readonly ActorStyle[] = [
  { fill: "bg-chart-cat-1", stroke: "stroke-chart-cat-1", text: "text-chart-cat-1" },
  { fill: "bg-chart-cat-2", stroke: "stroke-chart-cat-2", text: "text-chart-cat-2" },
  { fill: "bg-chart-cat-3", stroke: "stroke-chart-cat-3", text: "text-chart-cat-3" },
  { fill: "bg-chart-cat-4", stroke: "stroke-chart-cat-4", text: "text-chart-cat-4" },
  { fill: "bg-chart-cat-5", stroke: "stroke-chart-cat-5", text: "text-chart-cat-5" },
  { fill: "bg-chart-cat-other", stroke: "stroke-chart-cat-other", text: "text-chart-cat-other" },
];

/** The same six as raw CSS values, for SVG `fill`/`stroke` attributes. */
const VARS: readonly string[] = [
  "var(--color-chart-cat-1)",
  "var(--color-chart-cat-2)",
  "var(--color-chart-cat-3)",
  "var(--color-chart-cat-4)",
  "var(--color-chart-cat-5)",
  "var(--color-chart-cat-other)",
];

export const UNATTRIBUTED_SLOT = ACTOR_SLOTS;

export interface ActorPalette {
  /** The slot this id holds, 0-based; `UNATTRIBUTED_SLOT` for the tail. */
  slotOf(id: string): number;
  classesOf(id: string): ActorStyle;
  /** The CSS value, for an SVG attribute that cannot take a utility class. */
  varOf(id: string): string;
}

/**
 * Build the mapping from the floor's roster.
 *
 * `order` is the FULL roster in rank order, not one panel's filtered rows -
 * pass the same array to every panel on the page. An id that was not in it
 * (a person who appears in one measure and not another) lands on the neutral
 * rather than stealing a colleague's colour.
 */
export function actorPalette(order: readonly { id: string }[]): ActorPalette {
  const slots = new Map<string, number>();
  order.forEach((a, i) => {
    if (!slots.has(a.id)) slots.set(a.id, Math.min(i, UNATTRIBUTED_SLOT));
  });
  const slotOf = (id: string) => slots.get(id) ?? UNATTRIBUTED_SLOT;
  return {
    slotOf,
    classesOf: (id) => STYLES[slotOf(id)]!,
    varOf: (id) => VARS[slotOf(id)]!,
  };
}
