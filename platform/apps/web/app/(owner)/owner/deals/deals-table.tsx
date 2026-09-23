"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowDown } from "lucide-react";
import {
  EmptyState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@aura/ui";
import { useOrgTimeZone } from "@/components/org-time";
import { staleDays } from "@/lib/deal-staleness";
import { StaleFlag } from "../board/kanban-board";
import { BulkActionBar } from "../bulk/bulk-action-bar";
import { useRowSelection } from "../bulk/use-row-selection";
import { fetchDealAction } from "../crm-actions";
import { DealDrawer } from "../deal-drawer";
import { useFocusParam } from "../lib/use-focus-param";
import { TagChips } from "../tag-chips";
import { formatValue, relativeTime, type Deal, type Stage } from "../types";
import { dealsHref, type DealsSort, type DealsState } from "./deals-url";

const SORT_LABEL: Record<DealsSort, string> = {
  activity: "Last activity",
  amount: "Value",
  name: "Deal",
  created: "Newest",
};

/**
 * The same deals as the board, as rows - for when the question is "which",
 * not "where": the biggest deals, the ones nobody has touched, everything in
 * one stage at once.
 *
 * Unlike a board column, which only ever holds its top 50, this pages through
 * EVERY deal in the pipeline (the page fetches one page at a time from
 * `GET /v1/deals`, never the whole table). A row opens the same DealDrawer the
 * board opens, and `?focus=` deep links land here the same way.
 *
 * Sorting is by column header, and every header is a LINK carrying the rest of
 * the URL state (deals-url.ts), so a sorted, filtered page is shareable.
 */
export function DealsTable({
  deals: initial,
  stages,
  staleAfterDays,
  state,
}: {
  deals: Deal[];
  stages: Stage[];
  staleAfterDays: number;
  state: DealsState;
}) {
  const [rows, setRows] = useState(initial);
  const [open, setOpen] = useState<Deal | null>(null);
  const selection = useRowSelection(rows.map((d) => d.id));
  const zone = useOrgTimeZone();

  // The server re-renders with fresh rows after any navigation or revalidate;
  // follow it, but never swap the rows out from under an open drawer.
  useEffect(() => {
    if (!open) setRows(initial);
  }, [initial, open]);

  const { clearFocus } = useFocusParam<Deal>({
    findLoaded: (id) => rows.find((d) => d.id === id) ?? null,
    load: fetchDealAction,
    open: setOpen,
  });

  const stageLabel = (key: string) => stages.find((s) => s.key === key)?.label ?? key;
  const terminalOf = (key: string) => stages.find((s) => s.key === key)?.terminal;

  const patch = (dealId: string, update: Partial<Deal>) => {
    setRows((prev) => prev.map((d) => (d.id === dealId ? { ...d, ...update } : d)));
    setOpen((current) => (current && current.id === dealId ? { ...current, ...update } : current));
  };

  const filtered = Boolean(
    state.stage || state.staleOnly || state.owner || state.tagId || state.q || state.status || state.createdFrom || state.createdTo,
  );

  if (rows.length === 0) {
    return (
      <EmptyState
        title={filtered ? "No deals match these filters" : "No deals yet"}
        description={
          filtered
            ? "Clear a filter above to see more of this pipeline."
            : "Deals appear here when a qualified call creates one, or when one is added by hand."
        }
      />
    );
  }

  const header = (sort: DealsSort, align: "left" | "right" = "left") => {
    const active = state.sort === sort;
    return (
      <TableHeaderCell className={align === "right" ? "text-right" : undefined} aria-sort={active ? "descending" : undefined}>
        <Link
          href={dealsHref(state, { sort })}
          className={`inline-flex items-center gap-1 hover:text-text ${active ? "text-text" : ""}`}
        >
          {SORT_LABEL[sort]}
          {active ? <ArrowDown aria-hidden="true" className="h-3 w-3" /> : null}
        </Link>
      </TableHeaderCell>
    );
  };

  return (
    <>
      <Table caption="Deals">
        <TableHead>
          <tr>
            <TableHeaderCell className="w-10">
              <input
                type="checkbox"
                checked={selection.allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = selection.someSelected;
                }}
                onChange={selection.toggleAll}
                aria-label={selection.allSelected ? "Deselect all deals on this page" : "Select all deals on this page"}
                className="h-4 w-4 cursor-pointer accent-accent"
              />
            </TableHeaderCell>
            {header("name")}
            <TableHeaderCell>Stage</TableHeaderCell>
            {header("amount", "right")}
            <TableHeaderCell className="hidden md:table-cell">Owner</TableHeaderCell>
            <TableHeaderCell className="hidden xl:table-cell">Tags</TableHeaderCell>
            <TableHeaderCell className="hidden lg:table-cell">Next action</TableHeaderCell>
            {header("activity")}
          </tr>
        </TableHead>
        <TableBody>
          {rows.map((deal) => {
            const stale = staleDays(deal, staleAfterDays);
            const terminal = terminalOf(deal.stage);
            const checked = selection.selected.has(deal.id);
            return (
              <TableRow key={deal.id} aria-selected={checked || undefined} className={checked ? "bg-surface-hover" : undefined}>
                <TableCell className="w-10">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => selection.toggle(deal.id)}
                    aria-label={`Select ${deal.name}`}
                    className="h-4 w-4 cursor-pointer accent-accent"
                  />
                </TableCell>
                <TableCell className="min-w-[12rem]">
                  <button
                    type="button"
                    onClick={() => setOpen(deal)}
                    className="block text-left font-medium text-text hover:underline"
                  >
                    {deal.name}
                  </button>
                  <span className="block text-xs text-text-muted">
                    {deal.account_name ?? deal.contact_name ?? "no contact"}
                  </span>
                  {/* Repeated here below `sm`: on a phone the Last activity
                      column is off-screen behind the table's own scroll, and a
                      flag nobody scrolls to is not a flag. */}
                  {stale !== null ? (
                    <span className="mt-1 flex sm:hidden">
                      <StaleFlag days={stale} />
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${
                      // The board's neutral weights (kanban-board.tsx): a stage
                      // is not a state, so won leads by inversion, not by green.
                      terminal === "won"
                        ? "border-transparent bg-text text-bg"
                        : terminal === "lost"
                          ? "border-border bg-surface-hover text-text-muted"
                          : "border-border bg-surface text-text"
                    }`}
                  >
                    {stageLabel(deal.stage)}
                  </span>
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {deal.amount === null ? <span className="text-text-muted">-</span> : formatValue(deal.amount)}
                </TableCell>
                <TableCell className="hidden whitespace-nowrap text-text-muted md:table-cell">{deal.owner_name ?? "-"}</TableCell>
                <TableCell className="hidden xl:table-cell">
                  <TagChips tags={deal.tags} />
                </TableCell>
                <TableCell className="hidden max-w-[18rem] truncate text-text-muted lg:table-cell">
                  {deal.next_action ?? "-"}
                </TableCell>
                <TableCell className="whitespace-nowrap text-text-muted tabular-nums">
                  <span className="flex items-center gap-2">
                    {relativeTime(deal.last_activity_at, zone)}
                    {stale !== null ? <StaleFlag days={stale} /> : null}
                  </span>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      <BulkActionBar
        object="deals"
        noun="deal"
        ids={selection.ids}
        onClear={selection.clear}
        reassign="people"
        tag
        // The deal's contact's address - a deal has none of its own.
        emailRecipients={rows
          .filter((d) => selection.selected.has(d.id))
          .map((d) => ({ id: d.id, name: d.contact_name ?? d.name, email: d.contact_email ?? null }))}
      />

      <DealDrawer
        deal={open}
        stages={stages}
        onClose={() => {
          setOpen(null);
          clearFocus();
        }}
        onChanged={patch}
      />
    </>
  );
}
