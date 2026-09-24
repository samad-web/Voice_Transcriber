"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Search, SlidersHorizontal, X } from "lucide-react";
import { formatWait, leadCallbackState } from "@aura/shared";
import {
  Button,
  Input,
  Popover,
  Select,
  StatusChip,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@aura/ui";
import { FilterTag } from "@/components/filter-tag";
import { useOrgTimeZone } from "@/components/org-time";
import { formatDateRange } from "@/lib/report-dashboard";
import { BulkActionBar } from "../bulk/bulk-action-bar";
import { useRowSelection } from "../bulk/use-row-selection";
import { LeadDrawer } from "../lead-drawer";
import { CallReadChips } from "../call-intel";
import { CHANNEL_OPTIONS } from "../list-options";
import { ProjectChip } from "../project-chip";
import { TemperatureChip } from "../temperature-chip";
import {
  boardRef,
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

const STATUS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
] as const;

const RESPONDED_OPTIONS = [
  { value: "no", label: "Not yet" },
  { value: "yes", label: "Yes" },
] as const;

/** A telecaller identity a lead can be assigned to - from GET /v1/owner/team. */
export interface TelecallerOption {
  id: string;
  displayName: string;
  userId: string | null;
}

/**
 * The "Callback" column (migration 0134). Same vocabulary as the call log's
 * own callback line (calls-explorer.tsx's missedSummary / @aura/shared's
 * callbackLabel) - "Called back Xm later", "Not called back yet" - so a
 * manager reading both pages is reading one idea, not two.
 */
function leadCallbackLabel(lead: Lead): { text: string; waiting: boolean } | null {
  const state = leadCallbackState(lead.last_missed_at, lead.last_reached_at);
  if (!state) return null;
  if (state === "waiting") return { text: "Not called back yet", waiting: true };
  const minutes = (Date.parse(lead.last_reached_at as string) - Date.parse(lead.last_missed_at as string)) / 60_000;
  const wait = formatWait(minutes);
  return { text: `Called back ${wait === "under a minute" ? "within a minute" : `${wait} later`}`, waiting: false };
}

/**
 * The list view: the same leads as the board, but filterable and sortable -
 * what you use to answer "which leads has nobody touched in a fortnight?".
 *
 * Filters live in the URL, so a filtered view is a link an owner can bookmark
 * or send to a colleague, and the back button behaves.
 */
export function LeadsTable({
  leads,
  stages: mainStages,
  boards = [],
  projects,
  total,
  limit,
  offset,
  telecallers = [],
  canReassign = false,
}: {
  leads: Lead[];
  /** The Main board's columns. */
  stages: Stage[];
  /** Every lead board (0136), so each row's stage reads in its own board's words. */
  boards?: { id: string | null; name: string; stages: Stage[] }[];
  projects: Project[];
  total: number;
  limit: number;
  offset: number;
  /** The assignable roster - empty for personas that cannot reassign. */
  telecallers?: TelecallerOption[];
  /** Owner/manager: show the selection column and the bulk Reassign. */
  canReassign?: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const zone = useOrgTimeZone();
  const [rows, setRows] = useState(leads);
  const selection = useRowSelection(canReassign ? rows.map((l) => l.id) : []);
  /**
   * Whether this tenant has the `call_intel` module, decided from the payload
   * rather than a prop: the API omits these keys entirely for a tenant without
   * it (owner/leads.controller.ts), so their PRESENCE is the entitlement. A
   * flag threaded down from the layout would be a second copy of that decision
   * living in the browser, free to disagree with the one that matters.
   *
   * `some`, not `rows[0]`: the first page can legitimately be empty.
   */
  const showRead = rows.some((lead) => "call_sentiment" in lead);
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

  /** Change several parameters at once; `null` removes one. */
  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    // Any filter change invalidates the current page.
    if (!("offset" in patch)) next.delete("offset");
    router.push(`/owner/leads${next.toString() ? `?${next}` : ""}`);
  };
  const setParam = (key: string, value: string | null) => setParams({ [key]: value });

  const boardParam = params.get("boardId");
  const activeBoard = boardParam ? boards.find((b) => boardRef(b.id) === boardParam) : undefined;
  // The Stage filter offers the columns of the board being looked at - stage
  // keys belong to a board, so "all boards" offers the Main board's.
  const stages = activeBoard?.stages ?? mainStages;
  const stagesOf = (boardId: string | null | undefined) =>
    boards.find((b) => b.id === (boardId ?? null))?.stages ?? mainStages;
  const stageLabel = (lead: Lead) => stagesOf(lead.board_id).find((s) => s.key === lead.stage)?.label ?? lead.stage;
  const boardName = (boardId: string | null) => boards.find((b) => b.id === boardId)?.name ?? "";

  const stage = params.get("stage");
  const status = params.get("status");
  const project = params.get("projectId");
  const channel = params.get("sourceChannel") ?? "";
  const assignedTo = params.get("assignedTo") ?? "";
  const responded = params.get("responded") ?? "";
  const createdFrom = params.get("createdFrom");
  const createdTo = params.get("createdTo");

  /** The created-date window is set by a Reports drill-down; clearing it removes both ends at once. */
  const clearCreated = () => setParams({ createdFrom: null, createdTo: null });
  const sort = params.get("sort") ?? "activity";
  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));

  const activeProject = project ? projects.find((p) => p.id === project) : undefined;
  const activeAssignee = assignedTo ? telecallers.find((t) => t.id === assignedTo) : undefined;

  // Every active selection, as a removable tag - the same treatment the Calls
  // page's filters got. The date range is set by a Reports drill-down rather
  // than a control here, but it is still a filter narrowing this list, so it
  // belongs in the same row rather than its own special-cased chip.
  const tags: { key: string; label: string; onRemove: () => void }[] = [];
  if (boardParam)
    tags.push({
      key: "board",
      label: `Board: ${activeBoard?.name ?? boardParam}`,
      // The stage filter was chosen from this board's columns, so it goes too.
      onRemove: () => setParams({ boardId: null, stage: null }),
    });
  if (stage)
    tags.push({
      key: "stage",
      label: `Stage: ${stages.find((s) => s.key === stage)?.label ?? stage}`,
      onRemove: () => setParam("stage", null),
    });
  if (project)
    tags.push({
      key: "project",
      label: `Project: ${project === "none" ? "Unlabelled" : (activeProject?.name ?? project)}`,
      onRemove: () => setParam("projectId", null),
    });
  if (status)
    tags.push({
      key: "status",
      label: `Status: ${STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status}`,
      onRemove: () => setParam("status", null),
    });
  if (assignedTo)
    tags.push({
      key: "assignedTo",
      label: `Assigned to: ${assignedTo === "none" ? "Unassigned" : (activeAssignee?.displayName ?? assignedTo)}`,
      onRemove: () => setParam("assignedTo", null),
    });
  if (responded)
    tags.push({
      key: "responded",
      label: `Contacted: ${RESPONDED_OPTIONS.find((o) => o.value === responded)?.label ?? responded}`,
      onRemove: () => setParam("responded", null),
    });
  if (channel)
    tags.push({
      key: "channel",
      label: `Came in through: ${CHANNEL_OPTIONS.find((o) => o.value === channel)?.label ?? channel}`,
      onRemove: () => setParam("sourceChannel", null),
    });
  if (createdFrom || createdTo)
    tags.push({
      key: "created",
      label: `Arrived: ${formatDateRange(createdFrom ?? createdTo!, createdTo ?? createdFrom!)}`,
      onRemove: clearCreated,
    });

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
      <div className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setParam("q", query.trim() || null);
            }}
            className="min-w-0 flex-1"
          >
            <div className="relative">
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
                className="h-9.5 pr-9 pl-9"
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
          </form>
        </div>

        {tags.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {tags.map((tag) => (
              <FilterTag key={tag.key} label={tag.label} onRemove={tag.onRemove} />
            ))}
            {tags.length > 1 ? (
              <button
                type="button"
                onClick={() =>
                  setParams({
                    boardId: null,
                    stage: null,
                    projectId: null,
                    status: null,
                    assignedTo: null,
                    responded: null,
                    sourceChannel: null,
                    createdFrom: null,
                    createdTo: null,
                  })
                }
                className="px-1.5 text-xs font-medium text-text-muted underline underline-offset-2 hover:text-text"
              >
                Clear all
              </button>
            ) : null}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2.5">
          {/* Only once there is more than one board (0136). */}
          {boards.length > 1 ? (
            <Select
              size="sm"
              aria-label="Board"
              value={boardParam ?? ""}
              // A stage belongs to a board, so switching boards drops it.
              onChange={(e) => setParams({ boardId: e.target.value || null, stage: null })}
              className="h-8 w-40"
            >
              <option value="">All boards</option>
              {boards.map((b) => (
                <option key={boardRef(b.id)} value={boardRef(b.id)}>
                  {b.name}
                </option>
              ))}
            </Select>
          ) : null}

          <Select
            size="sm"
            aria-label="Stage"
            value={stage ?? ""}
            onChange={(e) => setParam("stage", e.target.value || null)}
            className="h-8 w-36"
          >
            <option value="">All stages</option>
            {stages.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </Select>

          {/* Only the active projects are offered. An archived one can still be
              reached by URL - a bookmarked filter must not break. */}
          {projects.length > 0 ? (
            <Select
              size="sm"
              aria-label="Project"
              value={project ?? ""}
              onChange={(e) => setParam("projectId", e.target.value || null)}
              className="h-8 w-36"
            >
              <option value="">All projects</option>
              {projects
                .filter((p) => p.active)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              {/* An owner needs to see the catalogue is missing an alias - without
                  this option, a silently unlabelled lead looks exactly like one
                  that genuinely has no project. */}
              <option value="none">Unlabelled</option>
            </Select>
          ) : null}

          <Select
            size="sm"
            aria-label="Status"
            value={status ?? ""}
            onChange={(e) => setParam("status", e.target.value || null)}
            className="h-8 w-32"
          >
            <option value="">Any status</option>
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>

          {/* Only where the roster could be read (owner/manager) - a telecaller's
              list is already narrowed to their own leads. */}
          {telecallers.length > 0 || assignedTo ? (
            <Select
              size="sm"
              aria-label="Assigned to"
              value={assignedTo}
              onChange={(e) => setParam("assignedTo", e.target.value || null)}
              className="h-8 w-40"
            >
              <option value="">Anyone</option>
              <option value="none">Unassigned</option>
              {telecallers.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.displayName}
                </option>
              ))}
              {assignedTo && assignedTo !== "none" && !telecallers.some((t) => t.id === assignedTo) ? (
                <option value={assignedTo}>(no longer active)</option>
              ) : null}
            </Select>
          ) : null}

          <LeadsAdvancedFilters
            responded={responded}
            channel={channel}
            onResponded={(value) => setParam("responded", value)}
            onChannel={(value) => setParam("sourceChannel", value)}
          />
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-border bg-surface">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-b border-border bg-bg-subtle px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-sm font-medium text-text tabular-nums">
              {total} lead{total === 1 ? "" : "s"}
            </span>
            <Select
              size="sm"
              aria-label="Order of leads"
              value={sort}
              onChange={(e) => setParam("sort", e.target.value)}
              className="h-8 w-32"
            >
              {SORTS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
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
            <table
              className={`w-full ${showRead ? "min-w-[1280px]" : "min-w-[1120px]"} border-collapse text-left text-sm`}
            >
              <TableHead>
                <tr>
                  {canReassign ? (
                    <TableHeaderCell className="w-10">
                      <input
                        type="checkbox"
                        checked={selection.allSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = selection.someSelected;
                        }}
                        onChange={selection.toggleAll}
                        aria-label={selection.allSelected ? "Deselect all leads on this page" : "Select all leads on this page"}
                        className="h-4 w-4 cursor-pointer accent-accent"
                      />
                    </TableHeaderCell>
                  ) : null}
                  <TableHeaderCell>Lead</TableHeaderCell>
                  <TableHeaderCell>How warm</TableHeaderCell>
                  <TableHeaderCell>Project</TableHeaderCell>
                  <TableHeaderCell>Stage</TableHeaderCell>
                  <TableHeaderCell className="text-right">Value</TableHeaderCell>
                  <TableHeaderCell>Assigned to</TableHeaderCell>
                  <TableHeaderCell>Handset</TableHeaderCell>
                  <TableHeaderCell className="text-right">Calls</TableHeaderCell>
                  <TableHeaderCell>Callback</TableHeaderCell>
                  {showRead ? <TableHeaderCell>Last call read</TableHeaderCell> : null}
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
                    aria-selected={canReassign ? selection.selected.has(lead.id) : undefined}
                    className={`cursor-pointer ${selection.selected.has(lead.id) ? "bg-surface-hover" : ""}`}
                  >
                    {canReassign ? (
                      // The row itself opens the drawer; the checkbox cell must not.
                      <TableCell
                        className="w-10"
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                      >
                        <input
                          type="checkbox"
                          checked={selection.selected.has(lead.id)}
                          onChange={() => selection.toggle(lead.id)}
                          aria-label={`Select ${lead.title}`}
                          className="h-4 w-4 cursor-pointer accent-accent"
                        />
                      </TableCell>
                    ) : null}
                    <TableCell>
                      <span className="block font-medium text-text">{lead.title}</span>
                      <span className="text-xs text-text-muted">{contactLabel(lead)}</span>
                    </TableCell>
                    <TableCell>
                      {lead.temperature ? (
                        <TemperatureChip
                          temperature={lead.temperature}
                          source={lead.temperature_source}
                        />
                      ) : (
                        <span className="text-xs text-text-subtle">-</span>
                      )}
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
                        {stageLabel(lead)}
                      </StatusChip>
                      {boards.length > 1 && lead.board_id ? (
                        <span className="mt-0.5 block text-xs text-text-muted">{boardName(lead.board_id)}</span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {num(lead.value_num) === null ? "-" : formatValue(lead.value_num)}
                    </TableCell>
                    <TableCell className="text-text-muted">{lead.assigned_telecaller_name ?? "-"}</TableCell>
                    <TableCell className="text-text-muted">{lead.telecaller ?? "-"}</TableCell>
                    <TableCell className="text-right tabular-nums">{lead.call_count}</TableCell>
                    <TableCell>
                      {(() => {
                        const cb = leadCallbackLabel(lead);
                        if (!cb) return <span className="text-xs text-text-subtle">-</span>;
                        return (
                          <span className={`text-xs ${cb.waiting ? "font-medium text-text" : "text-text-muted"}`}>
                            {cb.text}
                          </span>
                        );
                      })()}
                    </TableCell>
                    {showRead ? (
                      <TableCell>
                        {/* Renders nothing when the lead has no read yet - a
                            call that failed ASR, or one from before the module
                            was switched on. The dash keeps the column legible
                            rather than looking like a rendering fault. */}
                        {lead.call_sentiment || lead.call_outcome ? (
                          <CallReadChips
                            sentiment={lead.call_sentiment}
                            outcome={lead.call_outcome}
                          />
                        ) : (
                          <span className="text-xs text-text-subtle">-</span>
                        )}
                      </TableCell>
                    ) : null}
                    <TableCell className="max-w-[16rem] truncate text-text-muted">
                      {lead.next_action ?? "-"}
                    </TableCell>
                    <TableCell className="text-text-muted tabular-nums">
                      {relativeTime(lead.last_activity_at, zone)}
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

      {canReassign ? (
        // Reassign only: a lead has no tags and no email address - the contact
        // made from it does, on the Contacts list.
        <BulkActionBar
          object="leads"
          noun="lead"
          ids={selection.ids}
          onClear={selection.clear}
          reassign="telecallers"
        />
      ) : null}

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

/** A labelled native select that applies on change, for the filters with too many values for chips. */
function LeadSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <div className="min-w-[9rem]">
      <label htmlFor={id} className="block text-xs text-text-muted">
        {label}
      </label>
      <div className="mt-1.5">
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </div>
    </div>
  );
}

/**
 * "Contacted" and "Came in through" (point 5 of the Calls brief, applied
 * here too): specific enough that most readers never touch them, so they live
 * behind one button rather than two more always-visible selects.
 */
function LeadsAdvancedFilters({
  responded,
  channel,
  onResponded,
  onChannel,
}: {
  responded: string;
  channel: string;
  onResponded: (value: string) => void;
  onChannel: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const activeCount = (responded ? 1 : 0) + (channel ? 1 : 0);

  return (
    <Popover
      open={open}
      onDismiss={() => setOpen(false)}
      align="end"
      className="w-64 p-3"
      trigger={
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors duration-150 ease-out ${
            activeCount > 0
              ? "border-transparent bg-text text-bg"
              : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
          Advanced filters
          {activeCount > 0 ? (
            <span className="rounded-full bg-bg/25 px-1.5 py-px text-[10px]">{activeCount}</span>
          ) : null}
        </button>
      }
    >
      <div className="space-y-3">
        <LeadSelect
          id="leads-responded"
          label="Contacted"
          value={responded}
          onChange={onResponded}
          options={[{ value: "", label: "Either" }, ...RESPONDED_OPTIONS]}
        />
        <LeadSelect
          id="leads-channel"
          label="Came in through"
          value={channel}
          onChange={onChannel}
          options={CHANNEL_OPTIONS}
        />
      </div>
    </Popover>
  );
}
