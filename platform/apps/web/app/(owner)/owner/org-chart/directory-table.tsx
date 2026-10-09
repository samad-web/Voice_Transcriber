"use client";

import { useMemo, useState } from "react";
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  StatusChip,
} from "@aura/ui";
import { POSITION_STATUS_LABELS, type ParentMap } from "@aura/shared";
import type { ChartNode } from "./types";

/**
 * §6.6's list / directory view: the same data as the chart, as a sortable
 * table, and the default on a small screen (§3, §14).
 *
 * ── BUILT FROM THE CHART PAYLOAD, NOT FROM /directory ──────────────────────
 *
 * The API has a `GET /org-chart/directory` that does this server-side, and
 * this component deliberately does not call it. The chart payload already
 * holds every column this table shows, the page has it in hand, and a second
 * request would make switching view a round trip for data already on the
 * client - plus two code paths that could disagree about what "vacant" means.
 *
 * `/directory` exists for the ONE column the chart payload has no business
 * carrying: §6.6 lists employment type, which comes from
 * `employment_contracts` and is only sent to a reader holding
 * `employment_contract:view`. A tenant who needs that column gets it from the
 * API; this table is the view every persona can have.
 *
 * ── EXPORT IS CLIENT-SIDE, AND THAT IS A PERMISSION DECISION ───────────────
 *
 * §6.6 asks for an export. It is built in the browser from the rows already on
 * screen rather than through a `position:export` route, which means there is
 * no new way for data to leave the system and therefore no new grid cell -
 * somebody exporting this is exporting what they are already looking at.
 * `ENFORCED_PERMISSIONS` has no `position:export` for exactly this reason: a
 * cell with no route behind it is a checkbox somebody might believe.
 */

type SortKey = "title" | "holderName" | "department" | "manager" | "status";

export interface DirectoryTableProps {
  asOf: string;
  nodes: ChartNode[];
  parents: ParentMap;
  onOpen: (positionId: string) => void;
}

export function DirectoryTable({ asOf, nodes, parents, onOpen }: DirectoryTableProps) {
  const [sort, setSort] = useState<SortKey>("title");
  const [descending, setDescending] = useState(false);

  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  const rows = useMemo(() => {
    const value = (node: ChartNode): string => {
      switch (sort) {
        case "holderName":
          return node.holder?.name ?? node.holder?.email ?? "";
        case "department":
          return node.departmentName ?? "";
        case "manager": {
          const managerId = parents.get(node.id);
          return managerId ? (byId.get(managerId)?.title ?? "") : "";
        }
        case "status":
          return POSITION_STATUS_LABELS[node.status];
        default:
          return node.title;
      }
    };
    return [...nodes].sort((a, b) => {
      // Empty last whichever way the sort runs - a vacant seat sorting to the
      // top of "holder" because its name is the empty string is the sort
      // looking broken.
      const av = value(a);
      const bv = value(b);
      if (!av && bv) return 1;
      if (av && !bv) return -1;
      const compared = av.localeCompare(bv) || a.title.localeCompare(b.title);
      return descending ? -compared : compared;
    });
  }, [nodes, sort, descending, parents, byId]);

  const header = (key: SortKey, label: string) => (
    <TableHeaderCell>
      <button
        type="button"
        onClick={() => {
          if (sort === key) setDescending((d) => !d);
          else {
            setSort(key);
            setDescending(false);
          }
        }}
        aria-sort={sort === key ? (descending ? "descending" : "ascending") : "none"}
        className="inline-flex items-center gap-1 text-left transition-colors hover:text-text"
      >
        {label}
        <span aria-hidden className="text-text-subtle">
          {sort === key ? (descending ? "↓" : "↑") : ""}
        </span>
      </button>
    </TableHeaderCell>
  );

  const exportCsv = () => {
    const columns = ["Position", "Who", "Email", "Department", "Team", "Reports to", "Status"];
    const body = rows.map((node) => {
      const managerId = parents.get(node.id);
      return [
        node.title,
        node.holder?.name ?? "",
        node.holder?.email ?? "",
        node.departmentName ?? "",
        node.teamName ?? "",
        managerId ? (byId.get(managerId)?.title ?? "") : "",
        POSITION_STATUS_LABELS[node.status],
      ];
    });
    /**
     * Quoted and doubled, by hand.
     *
     * `papaparse` is a dependency of this app and `unparse` would do it - but
     * it is pulled in for the IMPORT screens, where it parses files somebody
     * uploads. Seven columns of known shape do not need it, and keeping it out
     * of the chart bundle matters more here than saving six lines: this page
     * loads for every persona.
     */
    const escape = (cell: string) => `"${cell.replace(/"/g, '""')}"`;
    const csv = [columns, ...body].map((line) => line.map(escape).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `org-chart-directory-${asOf}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-text-muted">
          {rows.length} position{rows.length === 1 ? "" : "s"}
        </p>
        <Button variant="ghost" onClick={exportCsv}>
          Download CSV
        </Button>
      </div>

      {/* `overflow-x-auto`, because this is the small-screen default view and
          seven columns do not fit a phone. The alternative - dropping columns
          below a breakpoint - would make the CSV and the screen disagree. */}
      <div className="overflow-x-auto">
        {/* The kit requires a caption and keeps it for screen readers unless
            `captionVisible` - which is right here: the heading above the table
            already says what it is, and a second visible one would be noise. */}
        <Table caption={`Every position on the chart as of ${asOf}`}>
          <TableHead>
            <TableRow>
              {header("title", "Position")}
              {header("holderName", "Who")}
              {header("department", "Department")}
              {header("manager", "Reports to")}
              {header("status", "Status")}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((node) => {
              const managerId = parents.get(node.id);
              return (
                <TableRow key={node.id}>
                  <TableCell>
                    <button
                      type="button"
                      onClick={() => onOpen(node.id)}
                      className="text-left font-medium text-accent-text underline-offset-2 hover:underline"
                    >
                      {node.title}
                    </button>
                    {node.teamName ? (
                      <span className="block text-xs text-text-muted">{node.teamName}</span>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {node.holder ? (
                      <>
                        <span className="text-text">{node.holder.name ?? node.holder.email}</span>
                        {node.acting.length > 0 ? (
                          <span className="block text-xs text-info-text">
                            Acting: {node.acting.map((a) => a.name).filter(Boolean).join(", ")}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-text-muted">—</span>
                    )}
                  </TableCell>
                  <TableCell>{node.departmentName ?? <span className="text-text-muted">—</span>}</TableCell>
                  <TableCell>
                    {managerId ? (
                      <button
                        type="button"
                        onClick={() => onOpen(managerId)}
                        className="text-left text-accent-text underline-offset-2 hover:underline"
                      >
                        {byId.get(managerId)?.title ?? "—"}
                      </button>
                    ) : (
                      <span className="text-text-muted">Top of the chart</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusChip tone={node.status === "vacant" ? "outline" : "muted"}>
                      {POSITION_STATUS_LABELS[node.status]}
                    </StatusChip>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
