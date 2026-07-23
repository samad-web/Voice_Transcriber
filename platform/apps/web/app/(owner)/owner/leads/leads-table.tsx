"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { MonoLabel, StatusChip } from "@aura/ui";
import { LeadDrawer } from "../lead-drawer";
import {
  contactLabel,
  formatValue,
  num,
  relativeTime,
  type Lead,
  type Stage,
} from "../types";

const SORTS = [
  { key: "activity", label: "Recent" },
  { key: "created", label: "Newest" },
  { key: "value", label: "Value" },
  { key: "title", label: "A–Z" },
] as const;

/**
 * The list view: the same leads as the board, but filterable and sortable —
 * what you use to answer "which leads has nobody touched in a fortnight?".
 *
 * Filters live in the URL, so a filtered view is a link an owner can bookmark
 * or send to a colleague, and the back button behaves.
 */
export function LeadsTable({
  leads,
  stages,
  total,
  limit,
  offset,
}: {
  leads: Lead[];
  stages: Stage[];
  total: number;
  limit: number;
  offset: number;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [rows, setRows] = useState(leads);
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [open, setOpen] = useState<Lead | null>(null);

  // The server re-renders this component with fresh props after any navigation
  // or revalidate; local state must follow rather than pin the first page.
  useEffect(() => setRows(leads), [leads]);

  // Deep link from elsewhere in the console: /owner/leads?focus=<id>.
  useEffect(() => {
    const focus = params.get("focus");
    if (focus) setOpen(leads.find((l) => l.id === focus) ?? null);
  }, [params, leads]);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params.toString());
    if (value === null || value === "") next.delete(key);
    else next.set(key, value);
    // Any filter change invalidates the current page.
    if (key !== "offset") next.delete("offset");
    router.push(`/owner/leads${next.toString() ? `?${next}` : ""}`);
  };

  const stage = params.get("stage");
  const status = params.get("status");
  const sort = params.get("sort") ?? "activity";
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));

  const patch = (leadId: string, update: Partial<Lead>) => {
    setRows((prev) => prev.map((l) => (l.id === leadId ? { ...l, ...update } : l)));
    setOpen((current) => (current && current.id === leadId ? { ...current, ...update } : current));
  };

  return (
    <>
      <div className="flex flex-col lg:flex-row lg:items-end gap-3 lg:gap-5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setParam("q", query.trim() || null);
          }}
          className="flex-1 min-w-0"
        >
          <MonoLabel>Search</MonoLabel>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Name, number or what the call was about"
                aria-label="Search leads"
                className="w-full pl-9 pr-8 py-2 text-sm font-sans border-2 border-black rounded-none focus:outline-none focus:ring-2 focus:ring-black"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setParam("q", null);
                  }}
                  aria-label="Clear search"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-neutral-400 hover:text-black"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </div>
        </form>

        <div>
          <MonoLabel>Stage</MonoLabel>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <FilterChip active={!stage} onClick={() => setParam("stage", null)}>
              All
            </FilterChip>
            {stages.map((s) => (
              <FilterChip
                key={s.key}
                active={stage === s.key}
                onClick={() => setParam("stage", stage === s.key ? null : s.key)}
              >
                {s.label}
              </FilterChip>
            ))}
          </div>
        </div>

        <div>
          <MonoLabel>Sort</MonoLabel>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {SORTS.map((s) => (
              <FilterChip key={s.key} active={sort === s.key} onClick={() => setParam("sort", s.key)}>
                {s.label}
              </FilterChip>
            ))}
          </div>
        </div>
      </div>

      {status ? (
        <div className="flex items-center gap-2">
          <MonoLabel>Filtered to</MonoLabel>
          <FilterChip active onClick={() => setParam("status", null)}>
            {status} ✕
          </FilterChip>
        </div>
      ) : null}

      <div className="border-2 border-black bg-white overflow-hidden">
        <div className="px-5 py-3 border-b-2 border-black bg-neutral-50 flex items-center justify-between gap-3">
          <span className="text-xs font-display font-bold uppercase tracking-wider">
            {total} lead{total === 1 ? "" : "s"}
          </span>
          <span className="text-[10px] font-mono text-neutral-400 font-bold uppercase tracking-wider">
            page {page} of {pages}
          </span>
        </div>

        {rows.length === 0 ? (
          <p className="text-xs font-mono font-bold uppercase text-neutral-400 py-12 text-center">
            No leads match these filters
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left border-collapse">
              <thead>
                <tr className="bg-neutral-100 border-b-2 border-neutral-200 font-mono text-[10px] text-black font-bold uppercase tracking-wider">
                  <th className="py-3 px-5">Lead</th>
                  <th className="py-3 px-4">Stage</th>
                  <th className="py-3 px-4 text-right">Value</th>
                  <th className="py-3 px-4">Telecaller</th>
                  <th className="py-3 px-4 text-right">Calls</th>
                  <th className="py-3 px-4">Next action</th>
                  <th className="py-3 px-4">Last activity</th>
                </tr>
              </thead>
              <tbody className="divide-y-2 divide-neutral-100 text-sm">
                {rows.map((lead) => (
                  <tr
                    key={lead.id}
                    onClick={() => setOpen(lead)}
                    className="hover:bg-neutral-50 cursor-pointer"
                  >
                    <td className="py-3.5 px-5">
                      <span className="font-display font-bold text-black block">{lead.title}</span>
                      <span className="text-[10px] font-mono text-neutral-400">
                        {contactLabel(lead)}
                      </span>
                    </td>
                    <td className="py-3.5 px-4">
                      <StatusChip
                        tone={
                          lead.status === "won"
                            ? "solid"
                            : lead.status === "lost"
                              ? "muted"
                              : "outline"
                        }
                      >
                        {stages.find((s) => s.key === lead.stage)?.label ?? lead.stage}
                      </StatusChip>
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono text-xs font-bold">
                      {num(lead.value_num) === null ? "—" : formatValue(lead.value_num)}
                    </td>
                    <td className="py-3.5 px-4 font-sans text-xs text-neutral-600">
                      {lead.telecaller ?? "—"}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono text-xs">{lead.call_count}</td>
                    <td className="py-3.5 px-4 font-sans text-xs text-neutral-600 max-w-[16rem] truncate">
                      {lead.next_action ?? "—"}
                    </td>
                    <td className="py-3.5 px-4 font-mono text-[11px] text-neutral-500">
                      {relativeTime(lead.last_activity_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 ? (
          <div className="px-5 py-3 border-t-2 border-black flex items-center justify-between gap-3">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setParam("offset", String(Math.max(0, offset - limit)))}
              className="text-[10px] font-mono font-bold uppercase tracking-wider px-3 py-1.5 border-2 border-black disabled:opacity-30 disabled:cursor-not-allowed hover:bg-black hover:text-white disabled:hover:bg-white disabled:hover:text-black"
            >
              ← Previous
            </button>
            <button
              type="button"
              disabled={page >= pages}
              onClick={() => setParam("offset", String(offset + limit))}
              className="text-[10px] font-mono font-bold uppercase tracking-wider px-3 py-1.5 border-2 border-black disabled:opacity-30 disabled:cursor-not-allowed hover:bg-black hover:text-white disabled:hover:bg-white disabled:hover:text-black"
            >
              Next →
            </button>
          </div>
        ) : null}
      </div>

      <LeadDrawer lead={open} stages={stages} onClose={() => setOpen(null)} onChanged={patch} />
    </>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`text-[10px] font-mono font-bold uppercase tracking-wider px-2.5 py-1.5 border-2 border-black transition-colors ${
        active ? "bg-black text-white" : "bg-white text-neutral-500 hover:text-black"
      }`}
    >
      {children}
    </button>
  );
}
