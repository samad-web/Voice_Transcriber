"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import {
  Button,
  Input,
  MonoLabel,
  StatusChip,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@aura/ui";
import { LeadDrawer } from "../lead-drawer";
import { ProjectChip } from "../project-chip";
import {
  contactLabel,
  formatValue,
  num,
  relativeTime,
  type Lead,
  type Project,
  type Stage,
} from "../types";

const SORTS = [
  { key: "activity", label: "Recent" },
  { key: "created", label: "Newest" },
  { key: "value", label: "Value" },
  { key: "title", label: "A-Z" },
] as const;

/**
 * The list view: the same leads as the board, but filterable and sortable -
 * what you use to answer "which leads has nobody touched in a fortnight?".
 *
 * Filters live in the URL, so a filtered view is a link an owner can bookmark
 * or send to a colleague, and the back button behaves.
 */
export function LeadsTable({
  leads,
  stages,
  projects,
  total,
  limit,
  offset,
}: {
  leads: Lead[];
  stages: Stage[];
  projects: Project[];
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
  const project = params.get("projectId");
  const sort = params.get("sort") ?? "activity";
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));

  const patch = (leadId: string, update: Partial<Lead>) => {
    setRows((prev) => prev.map((l) => (l.id === leadId ? { ...l, ...update } : l)));
    setOpen((current) => (current && current.id === leadId ? { ...current, ...update } : current));
  };

  // Strip `focus` from the URL on close - otherwise the deep-link effect
  // above reopens the same lead the next time `leads` revalidates for any
  // other reason (a stage move elsewhere, a poll, etc).
  const closeDrawer = () => {
    setOpen(null);
    if (params.get("focus")) {
      const next = new URLSearchParams(params.toString());
      next.delete("focus");
      router.replace(`/owner/leads${next.toString() ? `?${next}` : ""}`);
    }
  };

  return (
    <>
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:gap-5">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setParam("q", query.trim() || null);
          }}
          className="min-w-0 flex-1"
        >
          <MonoLabel>Search</MonoLabel>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-muted"
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Name, number or what the call was about"
                aria-label="Search leads"
                // The icon and the clear button sit inside the field, so the
                // padding has to clear both.
                className="pr-9 pl-9"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => {
                    setQuery("");
                    setParam("q", null);
                  }}
                  aria-label="Clear search"
                  className="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-1 text-text-muted transition-colors duration-150 ease-out hover:text-text"
                >
                  <X className="h-3.5 w-3.5" aria-hidden="true" />
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

      {/* Only the active projects are offered. An archived one can still be
          reached by URL - a bookmarked filter must not break - but putting it
          in the chip row would grow the list forever. */}
      {projects.length > 0 ? (
        <div>
          <MonoLabel>Project</MonoLabel>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <FilterChip active={!project} onClick={() => setParam("projectId", null)}>
              All
            </FilterChip>
            {projects
              .filter((p) => p.active)
              .map((p) => (
                <FilterChip
                  key={p.id}
                  active={project === p.id}
                  onClick={() => setParam("projectId", project === p.id ? null : p.id)}
                >
                  {p.name}
                </FilterChip>
              ))}
            {/* The list an owner needs to see to find out their catalogue is
                missing an alias. Without it, a silently unlabelled lead looks
                exactly like a lead that genuinely has no project. */}
            <FilterChip
              active={project === "none"}
              onClick={() => setParam("projectId", project === "none" ? null : "none")}
            >
              Unlabelled
            </FilterChip>
          </div>
        </div>
      ) : null}

      {status ? (
        <div className="flex items-center gap-2">
          <MonoLabel>Filtered to</MonoLabel>
          <FilterChip active onClick={() => setParam("status", null)}>
            {status} ✕
          </FilterChip>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-md border border-border bg-surface">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-bg-subtle px-4 py-3">
          <span className="text-sm font-medium text-text tabular-nums">
            {total} lead{total === 1 ? "" : "s"}
          </span>
          <span className="text-xs text-text-muted tabular-nums">
            page {page} of {pages}
          </span>
        </div>

        {rows.length === 0 ? (
          <p className="py-12 text-center text-sm text-text-muted">
            No leads match these filters
          </p>
        ) : (
          // The kit's <Table> is not used here because it draws its own border
          // and radius, and this table already lives inside a bordered panel
          // with a heading strip. The row/cell primitives below are the same
          // ones it composes, so the type and spacing still match every other
          // table in the console. tabIndex+role keep the horizontal scroll
          // keyboard-operable, which is what <Table> would have provided.
          <div
            tabIndex={0}
            role="region"
            aria-label="Leads"
            className="overflow-x-auto"
          >
            <table className="w-full min-w-[980px] border-collapse text-left text-sm">
              <TableHead>
                <tr>
                  <TableHeaderCell>Lead</TableHeaderCell>
                  <TableHeaderCell>Project</TableHeaderCell>
                  <TableHeaderCell>Stage</TableHeaderCell>
                  <TableHeaderCell className="text-right">Value</TableHeaderCell>
                  <TableHeaderCell>Telecaller</TableHeaderCell>
                  <TableHeaderCell className="text-right">Calls</TableHeaderCell>
                  <TableHeaderCell>Next action</TableHeaderCell>
                  <TableHeaderCell>Last activity</TableHeaderCell>
                </tr>
              </TableHead>
              <TableBody>
                {rows.map((lead) => (
                  <TableRow
                    key={lead.id}
                    onClick={() => setOpen(lead)}
                    // Rows open the drawer the same way board.tsx's cards do
                    // (Enter/Space), but a <tr> has no built-in interactive
                    // semantics - role/tabIndex/onKeyDown supply what a real
                    // <button> would otherwise give for free.
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${lead.title}`}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setOpen(lead);
                      }
                    }}
                    className="cursor-pointer"
                  >
                    <TableCell>
                      <span className="block font-medium text-text">{lead.title}</span>
                      <span className="text-xs text-text-muted">{contactLabel(lead)}</span>
                    </TableCell>
                    <TableCell>
                      {lead.project_name ? (
                        <ProjectChip
                          name={lead.project_name}
                          color={lead.project_color}
                          source={lead.project_source}
                        />
                      ) : (
                        <span className="text-xs text-text-subtle">-</span>
                      )}
                    </TableCell>
                    <TableCell>
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
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {num(lead.value_num) === null ? "-" : formatValue(lead.value_num)}
                    </TableCell>
                    <TableCell className="text-text-muted">{lead.telecaller ?? "-"}</TableCell>
                    <TableCell className="text-right tabular-nums">{lead.call_count}</TableCell>
                    <TableCell className="max-w-[16rem] truncate text-text-muted">
                      {lead.next_action ?? "-"}
                    </TableCell>
                    <TableCell className="text-text-muted tabular-nums">
                      {relativeTime(lead.last_activity_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </table>
          </div>
        )}

        {pages > 1 ? (
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={page <= 1}
              onClick={() => setParam("offset", String(Math.max(0, offset - limit)))}
            >
              ← Previous
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={page >= pages}
              onClick={() => setParam("offset", String(offset + limit))}
            >
              Next →
            </Button>
          </div>
        ) : null}
      </div>

      <LeadDrawer
        lead={open}
        stages={stages}
        projects={projects}
        onClose={closeDrawer}
        onChanged={patch}
      />
    </>
  );
}

/** Selected filter = the gradient fill, the same "you are here" the sidebar and page header use. */
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
      style={active ? { backgroundImage: "var(--brand-gradient)" } : undefined}
      className={`inline-flex h-8 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-out ${
        active
          ? "border-transparent text-white"
          : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}
