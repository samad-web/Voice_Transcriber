import { donutArcs, donutWedges, sliceShare, type ActorSlice } from "@/lib/ceo-dashboard";
import { ChartTable, edgeAlign, Insight, TD, TD_NUM, TH, TH_NUM, TOOLTIP } from "../chart-parts";
import type { ActorPalette } from "./actor-colors";
import { BandHeading, Panel, PanelEmpty, PanelHead } from "./panel";

/**
 * Four donuts: who closed the revenue, who made the leads, who dialled, who
 * was on the phone (Build docs/46).
 *
 * ── WHY A DONUT, WHICH IS USUALLY THE WRONG ANSWER ──────────────────────────
 *
 * A pie is a bad chart for comparing magnitudes and a worse one past five
 * categories, and the honest default for "who did what" is a bar chart - which
 * is exactly what the band under this one is. This band asks a different
 * question: not "how do these people rank" but "is this business carried by
 * one person". That is a part-to-WHOLE reading, the whole is meaningful (it is
 * the KPI above it), the answer is usually a single dominant share, and five
 * categories is the cap. Those are the conditions under which a donut is the
 * right form, and the centre hole is what makes it one - it holds the total,
 * so each card states its own denominator.
 *
 * ── ONE LEGEND FOR FOUR CHARTS ──────────────────────────────────────────────
 *
 * The colour-to-person mapping is fixed across the whole band (actor-colors.ts)
 * so it can be stated once, above all four. Four legends saying the same four
 * names is three legends of noise, and worse, it invites the reader to check
 * whether they agree.
 *
 * Each card still direct-labels every slice with its name and share, which is
 * what satisfies the contrast relief rule for the lighter hues - and means the
 * donut never has to be read by colour alone.
 */

export interface DriverCard {
  key: string;
  title: string;
  /** The hole's figure and its unit - "389" / "calls". */
  centre: string;
  centreUnit: string;
  slices: ActorSlice[];
  /** False where the API cannot break this measure down at all. */
  attributable: boolean;
  /** Formats a slice's raw value for the table twin. */
  format: (value: number) => string;
  /**
   * One sentence saying what this measure MEANS for one person, given their
   * formatted value - "brindha made 320 calls."
   *
   * Per card rather than derived from the title, because the verb is the whole
   * information: "closed", "found", "made" and "spent" are four different
   * claims about a person, and "brindha: Calls made 320" is the card's own
   * legend with the words rearranged. The hover exists to add the verb.
   */
  measureSentence: (who: string, value: string) => string;
  insight: string | null;
}

const R = 42;
const C = 2 * Math.PI * R;

export function WhoDrives({
  cards,
  palette,
  legend,
  clock,
}: {
  cards: readonly DriverCard[];
  palette: ActorPalette;
  /** The roster, in slot order - the band's one shared key. */
  legend: readonly { id: string; name: string }[];
  clock: string;
}) {
  return (
    <section aria-labelledby="who-drives" className="space-y-4">
      <BandHeading
        right={
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
            {legend.map((a) => (
              <li key={a.id} className="inline-flex items-center gap-1.5 text-xs text-text-muted">
                <span aria-hidden="true" className={`h-2.5 w-2.5 rounded-[2px] ${palette.classesOf(a.id).fill}`} />
                {a.name}
              </li>
            ))}
            <li className="inline-flex items-center gap-1.5 text-xs text-text-muted">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[2px] bg-chart-cat-other" />
              Unattributed
            </li>
          </ul>
        }
      >
        <span id="who-drives">Who drives the business</span>
      </BandHeading>

      {/*
        `items-stretch` + `h-full` on each Panel: the four cards are one band
        answering one question, and a grid row already makes them the same
        height - but only if the card stretches into it. Without this the
        insight sentence decides each card's height, so "Revenue won" ends
        three lines shorter than "Calls made" and the four "Show as table"
        links sit at four different heights, which reads as four unrelated
        cards rather than one comparison.
      */}
      <div className="grid grid-cols-1 items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <Panel key={card.key} className="flex h-full flex-col">
            <PanelHead title={card.title} clock={clock} />
            {/* A column, so `mt-auto` on the insight has an axis to push along. */}
            {!card.attributable ? (
              <PanelEmpty>This view cannot attribute {card.title.toLowerCase()} yet.</PanelEmpty>
            ) : card.slices.length === 0 ? (
              <PanelEmpty>Nothing in this window.</PanelEmpty>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                  <Donut card={card} palette={palette} />
                  <ul className="min-w-[8rem] flex-1 space-y-1">
                    {card.slices.map((s) => (
                      <li key={s.id} className="flex items-baseline gap-2 text-xs">
                        <span
                          aria-hidden="true"
                          className={`h-2.5 w-2.5 shrink-0 translate-y-0.5 rounded-[2px] ${
                            s.unattributed ? "bg-chart-cat-other" : palette.classesOf(s.id).fill
                          }`}
                        />
                        <span className="min-w-0 flex-1 truncate text-text">{s.name}</span>
                        <span className="shrink-0 font-medium text-text tabular-nums">
                          {sliceShare(s.fraction)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
                {/*
                  `mt-auto` pushes the insight to the bottom of the stretched
                  card, so the four sentences share a baseline instead of each
                  floating under its own donut. The wrapper is what the auto
                  margin needs to push against.
                */}
                {card.insight ? (
                  <div className="mt-auto">
                    <Insight>{card.insight}</Insight>
                  </div>
                ) : null}
              </>
            )}

            {card.slices.length > 0 ? (
              <ChartTable>
                <table className="w-full border-collapse">
                  <caption className="sr-only">{card.title} by person</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={TH}>Who</th>
                      <th scope="col" className={TH_NUM}>{card.title}</th>
                      <th scope="col" className={TH_NUM}>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {card.slices.map((s) => (
                      <tr key={s.id}>
                        <th scope="row" className={`${TD} font-normal`}>{s.name}</th>
                        <td className={TD_NUM}>{card.format(s.value)}</td>
                        <td className={TD_NUM}>{sliceShare(s.fraction)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ChartTable>
            ) : null}
          </Panel>
        ))}
      </div>
    </section>
  );
}

/**
 * The ring. An SVG rather than conic-gradient CSS, because the 2px gap between
 * arcs has to be a real gap in the stroke - a gradient's hard colour stop
 * leaves two arcs touching, and two adjacent slices then read as one.
 *
 * `aria-hidden`: the legend beside it names every slice with its share, and
 * the table twin carries the values, so a screen reader gets the data twice
 * already and does not need ninety path elements.
 */
function Donut({ card, palette }: { card: DriverCard; palette: ActorPalette }) {
  const arcs = donutArcs(card.slices, C, 2);
  const wedges = donutWedges(card.slices);
  // 128px (h-32), up from 96. The ring carries the card's headline figure in
  // its hole and five arcs around it, and at 96 the centre figure was 16px
  // with a 10px label under it - the smallest type on the page, holding the
  // number the card exists to state. Bigger also makes the hover wedges worth
  // having: a 5% slice of a 96px ring is a 5px target.
  //
  // It does NOT grow past this. The legend sits beside it inside a quarter of
  // a four-up grid, and at 160 the two stop fitting side by side on a laptop
  // and the legend wraps under - which costs more than the ring gains.
  return (
    <div className="relative h-32 w-32 shrink-0">
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90" aria-hidden="true">
        {/*
          The empty track, in the theme's own `--color-border`. Checked rather
          than assumed when the 100%-unattributed Revenue donut looked like an
          empty chart: the track is #e5e5e5 and `--color-chart-cat-other` is
          28% of the text colour, which is several steps darker - so the two
          are distinguishable and the apparent emptiness was the slice itself
          covering the whole ring, exactly as it should. The tooltips below are
          what resolve that reading, not a colour change.

          `stroke-border-subtle` was the first attempt and is NOT a token this
          theme defines - Tailwind emits no rule for it and the track would
          have rendered invisible, which is the same trap actor-colors.ts
          carries a warning about.
        */}
        <circle cx="50" cy="50" r={R} fill="none" className="stroke-border" strokeWidth={11} />
        {arcs.map((a) => (
          <circle
            key={a.id}
            cx="50"
            cy="50"
            r={R}
            fill="none"
            stroke={a.unattributed ? "var(--color-chart-cat-other)" : palette.varOf(a.id)}
            strokeWidth={11}
            strokeDasharray={a.dash}
            strokeDashoffset={a.offset}
          />
        ))}
      </svg>

      {/*
        ── ONE HOVERABLE WEDGE PER SLICE ──────────────────────────────────────

        Stacked over the ring, each in its own transparent SVG inside an HTML
        `group` - because the house tooltip (`TOOLTIP`, chart-parts.tsx) is an
        HTML box shown by `group-hover`, and SVG cannot contain HTML. The ring
        itself cannot be the hit area: its arcs are five overlapping circles
        that each cover the whole ring, so the topmost would answer for every
        slice.

        `-rotate-90` matches the ring exactly, so a wedge sits over the arc it
        names rather than a quarter-turn away.
      */}
      {wedges.map((w, i) => (
        <span key={w.id} className="group absolute inset-0 block">
          <svg
            viewBox="0 0 100 100"
            className="h-full w-full -rotate-90"
            aria-hidden="true"
          >
            <path d={w.d} fill="transparent" />
          </svg>
          <span
            className={`${TOOLTIP} bottom-full mb-1 ${edgeAlign(i, wedges.length)}`}
          >
            {/*
              ── IT SAYS WHAT THE SLICE IS, NOT JUST ITS NUMBER ──────────────
              
              The legend beside the donut already gives the name and the share,
              so a tooltip repeating those two would be a hover that tells you
              nothing you were not already looking at. What is NOT on the card
              is what the measure means for that person: the sentence under the
              heading is the whole point of the hover.
              
              Value first and strong, label second - the dataviz interaction
              rule the rest of this dashboard follows.
            */}
            <span className="block font-medium text-text">
              {w.name} &middot; {sliceShare(w.fraction)}
            </span>
            <span className="mt-0.5 block">
              {w.unattributed ? (
                <>
                  {card.format(w.value)} of the {card.centre} {card.centreUnit} in this window
                  have no handset or owner on them, so they cannot be credited to anybody.
                  Not a person - the absence of one.
                </>
              ) : (
                <>
                  {card.measureSentence(w.name, card.format(w.value))} That is{" "}
                  {sliceShare(w.fraction)} of the floor&apos;s {card.centre}{" "}
                  {card.centreUnit}.
                </>
              )}
            </span>
          </span>
        </span>
      ))}

      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-xl font-semibold text-text tabular-nums">{card.centre}</span>
        <span className="text-[11px] text-text-muted">{card.centreUnit}</span>
      </div>
    </div>
  );
}
