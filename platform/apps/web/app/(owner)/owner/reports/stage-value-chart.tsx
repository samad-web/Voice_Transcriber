import Link from "next/link";
import { openDealsHref } from "@/lib/report-dashboard";
import { formatValue } from "../types";

export interface StageValueRow {
  stage: string;
  label: string;
  deals: number;
  amount: number;
  weightedAmount: number;
  avgDaysInStage: number | null;
}

/**
 * Open pipeline value by stage - a horizontal bar per stage, in the pipeline's
 * own column order.
 *
 * Horizontal because the categories are words (stage names) that need room to
 * be read, and in order because a pipeline is a sequence: sorting by value
 * would turn "where is the money stuck" into a ranking nobody asked for.
 *
 * One series, so one hue and no legend - the title says what is plotted. The
 * value sits at the bar's tip; the tooltip adds what the tip has no room for
 * (the weighted forecast, the average days in stage). Each bar is a link to
 * that stage's open deals, and the same numbers are in the table beneath it.
 */
export function StageValueChart({ rows, pipelineId }: { rows: StageValueRow[]; pipelineId: string | null }) {
  const max = Math.max(0, ...rows.map((r) => r.amount));

  if (rows.length === 0) {
    return <p className="mt-3 text-sm text-text-muted">This pipeline has no open stages.</p>;
  }

  return (
    <>
      <ul className="mt-3 space-y-0.5">
        {rows.map((row) => {
          const ratio = max === 0 ? 0 : row.amount / max;
          return (
            <li key={row.stage}>
              <Link
                href={openDealsHref(pipelineId, row.stage)}
                className="group relative grid grid-cols-[minmax(5rem,8rem)_1fr] items-center gap-3 rounded-sm px-2 py-1.5 transition-colors duration-150 ease-out hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                aria-label={`${row.label}: ${formatValue(row.amount)} across ${row.deals} open deal${row.deals === 1 ? "" : "s"}. Open them.`}
              >
                <span className="truncate text-sm text-text">{row.label}</span>
                <span className="flex min-w-0 items-center gap-2">
                  {/* Width is a share of the track minus room for the tip label,
                      so the longest bar's label never runs off the card. A
                      zero is a hairline, not nothing - the stage exists. */}
                  <span
                    aria-hidden="true"
                    className={`h-4 shrink-0 rounded-r transition-opacity duration-150 ease-out group-hover:opacity-80 ${
                      row.amount > 0 ? "bg-accent" : "bg-border-strong"
                    }`}
                    style={{ width: row.amount > 0 ? `max(3px, calc((100% - 7rem) * ${ratio.toFixed(4)}))` : "1px" }}
                  />
                  <span className="text-xs whitespace-nowrap text-text-muted tabular-nums">
                    <span className="font-medium text-text">{formatValue(row.amount)}</span> · {row.deals}
                  </span>
                </span>
                <span
                  role="tooltip"
                  className="pointer-events-none invisible absolute top-full left-[8.5rem] z-10 mt-1 w-max max-w-[16rem] rounded-md border border-border bg-surface px-3 py-2 text-xs text-text-muted shadow-md group-hover:visible group-focus-visible:visible"
                >
                  <span className="block text-sm font-semibold text-text">{formatValue(row.amount)}</span>
                  <span className="block">
                    {row.label} · {row.deals} open deal{row.deals === 1 ? "" : "s"}
                  </span>
                  <span className="block">Weighted {formatValue(row.weightedAmount)}</span>
                  {row.avgDaysInStage !== null ? <span className="block">~{row.avgDaysInStage} days in stage</span> : null}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>

      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-text-muted hover:text-text">Show as table</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[420px] border-collapse text-left">
            <thead>
              <tr className="text-text-muted">
                <th className="border-b border-border px-2 py-1.5 font-medium">Stage</th>
                <th className="border-b border-border px-2 py-1.5 text-right font-medium">Open deals</th>
                <th className="border-b border-border px-2 py-1.5 text-right font-medium">Value</th>
                <th className="border-b border-border px-2 py-1.5 text-right font-medium">Weighted</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.stage} className="text-text">
                  <td className="px-2 py-1.5">{row.label}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{row.deals}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatValue(row.amount)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatValue(row.weightedAmount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
