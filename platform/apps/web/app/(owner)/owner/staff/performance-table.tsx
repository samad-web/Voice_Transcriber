import { Card, StatusChip } from "@aura/ui";
import type { PerformanceResponse } from "./types";

type Row = PerformanceResponse["staff"][number];

/**
 * The scorecard table.
 *
 * ── A DASH IS A LOAD-BEARING VALUE HERE ───────────────────────────────────
 *
 * `null` means the metric could not be measured for this person - almost always
 * because a console login and a handset identity were never linked to each
 * other. It is rendered as an em dash and NEVER as 0.
 *
 * That is the whole reason this file has a `cell` helper rather than
 * `{row.callsMade}`. A zero in a scorecard is read as a fact about the person;
 * `0 ?? "-"` would print "0" for an unmeasured value, and the bug would be
 * invisible in every screenshot and obvious only in somebody's performance
 * review. The API's own header makes the same argument from the SQL side.
 */
function cell(value: number | null, suffix = ""): string {
  if (value === null) return "—";
  return `${value.toLocaleString()}${suffix}`;
}

function talk(seconds: number | null): string {
  if (seconds === null) return "—";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

const COLUMNS = [
  "Person",
  "Calls out",
  "Calls in",
  "Talk",
  "Leads",
  "Won",
  "Median response",
  "Follow-ups",
  "Messages",
  "Stage moves",
];

export function PerformanceTable({ rows }: { rows: Row[] }) {
  return (
    <Card className="overflow-hidden p-0">
      <div tabIndex={0} role="region" aria-label="Staff performance" className="overflow-x-auto">
        <table className="w-full min-w-[900px] border-collapse text-left text-sm">
          <thead className="bg-bg-subtle">
            <tr>
              {COLUMNS.map((heading) => (
                <th
                  key={heading}
                  scope="col"
                  className="border-b border-border px-3 py-2.5 text-xs font-medium whitespace-nowrap text-text-muted"
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr
                key={row.userId ?? row.telecallerId}
                className="transition-colors duration-150 ease-out hover:bg-surface-hover"
              >
                <th scope="row" className="px-3 py-2.5 text-left font-normal">
                  <span className="block font-medium text-text">{row.name}</span>
                  <span className="text-xs text-text-muted">
                    {[row.staffCode, row.jobTitle].filter(Boolean).join(" · ") ||
                      row.email ||
                      "Handset identity"}
                  </span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {row.status === "suspended" ? (
                      <StatusChip tone="danger">suspended</StatusChip>
                    ) : null}
                    {/* Named, not hidden. Somebody whose two identities are not
                        linked is doing real work that this table can only half
                        see, and the chip is what turns a row of dashes from a
                        rendering bug into a setup step. */}
                    {!row.linked ? (
                      <StatusChip tone="outline">
                        {row.userId ? "no handset linked" : "no login"}
                      </StatusChip>
                    ) : null}
                  </span>
                </th>
                <td className="px-3 py-2.5 tabular-nums whitespace-nowrap">
                  {cell(row.callsMade)}
                </td>
                <td className="px-3 py-2.5 tabular-nums whitespace-nowrap">
                  {cell(row.callsReceived)}
                </td>
                <td className="px-3 py-2.5 tabular-nums whitespace-nowrap">
                  {talk(row.talkSeconds)}
                </td>
                <td className="px-3 py-2.5 tabular-nums whitespace-nowrap">
                  {cell(row.leadsAssigned)}
                  {row.leadsSourced !== null && row.leadsSourced > 0 ? (
                    <span className="ml-1 text-xs text-text-muted">
                      (+{row.leadsSourced} sourced)
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 tabular-nums whitespace-nowrap">{cell(row.leadsWon)}</td>
                <td className="px-3 py-2.5 tabular-nums whitespace-nowrap">
                  {row.medianResponseMinutes === null ? "—" : `${row.medianResponseMinutes}m`}
                </td>
                <td className="px-3 py-2.5 tabular-nums whitespace-nowrap">
                  {/* Compliance leads, the raw counts follow it. The percentage
                      is what a manager acts on; the counts are what stops them
                      acting on 100% of two. */}
                  {row.compliancePct === null ? (
                    "—"
                  ) : (
                    <span className={row.compliancePct < 60 ? "text-danger-text" : undefined}>
                      {row.compliancePct}%
                    </span>
                  )}
                  {row.followupsDue !== null && row.followupsDue > 0 ? (
                    <span className="ml-1 text-xs text-text-muted">
                      {row.followupsCompleted}/{row.followupsDue}
                      {row.followupsOverdue ? `, ${row.followupsOverdue} late` : ""}
                    </span>
                  ) : null}
                </td>
                <td className="px-3 py-2.5 tabular-nums whitespace-nowrap">
                  {cell(row.messagesSent)}
                </td>
                <td className="px-3 py-2.5 tabular-nums whitespace-nowrap">
                  {cell(row.stageMoves)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
