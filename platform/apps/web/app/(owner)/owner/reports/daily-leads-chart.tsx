import Link from "next/link";
import { fillDays, formatDay, formatDuration, leadsArrivedHref, niceCeiling } from "@/lib/report-dashboard";

export interface DailyLeadsRow {
  date: string;
  leads: number;
  medianMinutes: number | null;
}

/**
 * New leads per day across the chosen range - a column per calendar day.
 *
 * Columns, because this is change over time with a count per bucket, and one
 * series: one hue, no legend. Days the report omitted are filled with zeros
 * (fillDays) so a quiet week reads as quiet rather than as missing.
 *
 * ── HOW IT IS OPERATED ──────────────────────────────────────────────────────
 *
 * Pointer: every day's full-height slot is the hit target (not just the painted
 * column), shows a tooltip, and opens that day's leads. Keyboard and screen
 * reader: ninety tab stops across a plot is a trap, so the plot is hidden from
 * both and the SAME links live in the table view below, one per day that had a
 * lead. Nothing is reachable only by hovering.
 */
export function DailyLeadsChart({ rows, from, to }: { rows: DailyLeadsRow[]; from: string; to: string }) {
  const days = fillDays(rows, from, to, (date) => ({ date, leads: 0, medianMinutes: null }));
  const total = days.reduce((sum, d) => sum + d.leads, 0);
  const top = niceCeiling(Math.max(0, ...days.map((d) => d.leads)));
  const busiest = days.reduce<DailyLeadsRow | null>((best, d) => (d.leads > (best?.leads ?? 0) ? d : best), null);
  const n = days.length;

  return (
    <>
      <p className="sr-only">
        {total} leads arrived between {formatDay(from)} and {formatDay(to)}
        {busiest ? `, most on ${formatDay(busiest.date)} with ${busiest.leads}` : ""}. The table below lists each day.
      </p>

      <div aria-hidden="true" className="mt-3 grid grid-cols-[auto_1fr] gap-x-2">
        {/* y-axis: the clean top and zero. Tabular figures so they align. */}
        <div className="flex h-40 flex-col justify-between text-right text-[11px] text-text-subtle tabular-nums">
          <span className="-translate-y-1/2">{top}</span>
          <span className="-translate-y-1/2">{top / 2 === Math.floor(top / 2) ? top / 2 : ""}</span>
          <span className="translate-y-1/2">0</span>
        </div>

        <div className="relative h-40">
          {/* Recessive hairlines at the top, middle and baseline. */}
          <span className="absolute inset-x-0 top-0 border-t border-border" />
          <span className="absolute inset-x-0 top-1/2 border-t border-border" />
          <span className="absolute inset-x-0 bottom-0 border-t border-border-strong" />

          <div className="absolute inset-0 flex items-end gap-[2px]">
            {days.map((day, i) => {
              const height = day.leads === 0 ? 0 : Math.max(2, (day.leads / top) * 100);
              // Tooltips at the edges open inward so they never leave the card.
              const align = i < n / 3 ? "left-0" : i > (2 * n) / 3 ? "right-0" : "left-1/2 -translate-x-1/2";
              const column = (
                <>
                  {height > 0 ? (
                    <span
                      className="w-full max-w-6 rounded-t bg-accent transition-opacity duration-150 ease-out group-hover:opacity-80"
                      style={{ height: `${height}%` }}
                    />
                  ) : null}
                  <span
                    className={`pointer-events-none invisible absolute bottom-full z-10 mb-1 w-max rounded-md border border-border bg-surface px-3 py-2 text-left text-xs text-text-muted shadow-md group-hover:visible ${align}`}
                  >
                    <span className="block text-sm font-semibold text-text">
                      {day.leads} lead{day.leads === 1 ? "" : "s"}
                    </span>
                    <span className="block">{formatDay(day.date)}</span>
                    {day.leads > 0 ? (
                      <span className="block">
                        {day.medianMinutes === null ? "None answered yet" : `Median response ${formatDuration(day.medianMinutes)}`}
                      </span>
                    ) : null}
                  </span>
                </>
              );
              return day.leads > 0 ? (
                <Link
                  key={day.date}
                  href={leadsArrivedHref(day.date, day.date)}
                  tabIndex={-1}
                  className="group relative flex h-full min-w-0 flex-1 items-end justify-center"
                >
                  {column}
                </Link>
              ) : (
                <span key={day.date} className="group relative flex h-full min-w-0 flex-1 items-end justify-center">
                  {column}
                </span>
              );
            })}
          </div>
        </div>

        <span />
        <div className="mt-1 flex justify-between text-[11px] text-text-subtle tabular-nums">
          <span>{formatDay(from)}</span>
          {n > 2 ? <span>{formatDay(days[Math.floor((n - 1) / 2)].date)}</span> : null}
          <span>{formatDay(to)}</span>
        </div>
      </div>

      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-text-muted hover:text-text">Show as table</summary>
        {total === 0 ? (
          <p className="mt-2 text-text-muted">No leads arrived in this range.</p>
        ) : (
          <div className="mt-2 max-h-64 overflow-auto">
            <table className="w-full min-w-[320px] border-collapse text-left">
              <thead>
                <tr className="text-text-muted">
                  <th className="border-b border-border px-2 py-1.5 font-medium">Day</th>
                  <th className="border-b border-border px-2 py-1.5 text-right font-medium">Leads</th>
                  <th className="border-b border-border px-2 py-1.5 text-right font-medium">Median response</th>
                </tr>
              </thead>
              <tbody>
                {days
                  .filter((d) => d.leads > 0)
                  .map((d) => (
                    <tr key={d.date} className="text-text">
                      <td className="px-2 py-1.5">
                        <Link href={leadsArrivedHref(d.date, d.date)} className="hover:underline">
                          {formatDay(d.date)}
                        </Link>
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{d.leads}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{formatDuration(d.medianMinutes)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </>
  );
}
