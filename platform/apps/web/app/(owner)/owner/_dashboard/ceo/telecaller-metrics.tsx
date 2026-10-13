import { ChartTable, TD, TD_NUM, TH, TH_NUM } from "../chart-parts";
import { BandHeading, Panel, PanelEmpty, PanelHead } from "./panel";

/**
 * Five small multiples: the same people, five measures (Build docs/46).
 *
 * ── THE ROW ORDER IS CONSTANT, AND THAT IS THE DESIGN ───────────────────────
 *
 * Every card lists the floor in ONE order - busiest caller first - and only
 * the bar lengths change between them. Sorting each card by its own measure
 * would make each one easier to read alone and the band impossible to read as
 * a band: finding one person across five cards would mean five searches, and
 * the comparison the layout exists to make ("she makes every call and he
 * converts every call") would be invisible.
 *
 * The cost is that a card's longest bar is not always its first row, which is
 * why each bar carries its own value as a direct label.
 *
 * ── EACH CARD HAS ITS OWN SCALE, AND SAYS WHAT IT IS ────────────────────────
 *
 * Bars are scaled to the biggest value IN THAT CARD, because the measures have
 * different units and a shared scale would be meaningless. The consequence -
 * that a full bar means "most calls" on one card and "1 deal" on another - is
 * the reason the value label is not optional and the reason the leader's bar
 * is the only one that ever reaches the end of its track.
 */

export interface MetricPerson {
  id: string;
  name: string;
  value: number;
  /** The value as the card prints it: "369", "4h 57m", "0.8", "–". */
  text: string;
}

export interface MetricCard {
  key: string;
  title: string;
  /** "30d", or a qualifier like "minutes" / "higher is better". */
  clock?: string;
  note?: string;
  /** The bar fill, as a literal class. */
  fill: string;
  rows: MetricPerson[];
}

export function TelecallerMetrics({ cards, heading }: { cards: readonly MetricCard[]; heading: string }) {
  const empty = cards.every((c) => c.rows.every((r) => r.value === 0));

  return (
    <section aria-labelledby="telecaller-metrics" className="space-y-4">
      <BandHeading>
        <span id="telecaller-metrics">{heading}</span>
      </BandHeading>

      {cards.length === 0 || cards[0]!.rows.length === 0 ? (
        <Panel>
          <PanelEmpty>No handsets are enrolled yet.</PanelEmpty>
        </Panel>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-3 xl:grid-cols-5">
          {cards.map((card) => {
            const top = Math.max(0, ...card.rows.map((r) => r.value));
            return (
              <Panel key={card.key}>
                <PanelHead title={card.title} clock={card.clock} note={card.note} />
                <ul className="space-y-2.5">
                  {card.rows.map((r) => (
                    <li key={r.id} className="space-y-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate text-xs text-text">{r.name}</span>
                        <span className="shrink-0 text-xs font-medium text-text tabular-nums">{r.text}</span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-subtle">
                        {r.value > 0 && top > 0 ? (
                          <span
                            className={`block h-full rounded-full ${card.fill}`}
                            // A non-zero value never draws thinner than 3%: a
                            // 1 beside a 369 still has to be visible, while a
                            // true zero draws nothing, so "none" and "barely
                            // any" stay different readings.
                            style={{ width: `${Math.max(3, (r.value / top) * 100)}%` }}
                          />
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </Panel>
            );
          })}
        </div>
      )}

      {empty ? null : (
        <ChartTable>
          <table className="w-full min-w-[480px] border-collapse">
            <caption className="sr-only">{heading}, every measure by person</caption>
            <thead>
              <tr>
                <th scope="col" className={TH}>Who</th>
                {cards.map((c) => (
                  <th key={c.key} scope="col" className={TH_NUM}>{c.title}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(cards[0]?.rows ?? []).map((person, i) => (
                <tr key={person.id}>
                  <th scope="row" className={`${TD} font-normal`}>{person.name}</th>
                  {cards.map((c) => (
                    <td key={c.key} className={TD_NUM}>{c.rows[i]?.text ?? "–"}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </ChartTable>
      )}
    </section>
  );
}
