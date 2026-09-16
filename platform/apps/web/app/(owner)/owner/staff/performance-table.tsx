import { StatusChip, Table, TableBody, TableCell, TableHead, TableRow, TableHeaderCell } from "@aura/ui";
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
    <Table caption="Staff performance">
      <TableHead>
        <tr>
          {COLUMNS.map((heading) => (
            <TableHeaderCell key={heading}>{heading}</TableHeaderCell>
          ))}
        </tr>
      </TableHead>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.userId ?? row.telecallerId}>
            <th scope="row" className="px-4 py-3 text-left align-middle font-normal">
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
            <TableCell className="tabular-nums whitespace-nowrap">{cell(row.callsMade)}</TableCell>
            <TableCell className="tabular-nums whitespace-nowrap">
              {cell(row.callsReceived)}
            </TableCell>
            <TableCell className="tabular-nums whitespace-nowrap">
              {talk(row.talkSeconds)}
            </TableCell>
            <TableCell className="tabular-nums whitespace-nowrap">
              {cell(row.leadsAssigned)}
              {row.leadsSourced !== null && row.leadsSourced > 0 ? (
                <span className="ml-1 text-xs text-text-muted">
                  (+{row.leadsSourced} sourced)
                </span>
              ) : null}
            </TableCell>
            <TableCell className="tabular-nums whitespace-nowrap">{cell(row.leadsWon)}</TableCell>
            <TableCell className="tabular-nums whitespace-nowrap">
              {row.medianResponseMinutes === null ? "—" : `${row.medianResponseMinutes}m`}
            </TableCell>
            <TableCell className="tabular-nums whitespace-nowrap">
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
            </TableCell>
            <TableCell className="tabular-nums whitespace-nowrap">
              {cell(row.messagesSent)}
            </TableCell>
            <TableCell className="tabular-nums whitespace-nowrap">
              {cell(row.stageMoves)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
