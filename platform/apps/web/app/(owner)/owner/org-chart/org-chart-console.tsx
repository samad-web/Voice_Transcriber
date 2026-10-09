"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Download, Network, Rows3, Search } from "lucide-react";
import {
  Button,
  EmptyState,
  ErrorBanner,
  FormField,
  Input,
  Select,
  useToast,
} from "@aura/ui";
import {
  POSITION_STATUS_LABELS,
  ancestorsOf,
  childMapOf,
  parentMapAsOf,
  pathsToReveal,
  subtreeOf,
} from "@aura/shared";
import { ChartCanvas } from "./chart-canvas";
import { DirectoryTable } from "./directory-table";
import { StructurePanel } from "./structure-panel";
import { PositionDrawer } from "./position-drawer";
import { createPositionAction, movePositionAction } from "./actions";
import type {
  AssignableMember,
  ChartAbilities,
  ChartPayload,
  ChangeRow,
  DepartmentRow,
  TeamRow,
} from "./types";

/**
 * The organization chart's console shell
 * (Build docs/org-chart-build-plan.md §5.2, §5.3, §6.6, milestones M2/M6/M8).
 *
 * Owns everything that is a VIEW decision rather than data: which view, what
 * is collapsed, what is searched for, which date, and which node is open.
 *
 * ── THE VIEW PREFERENCE IS REMEMBERED, THE DATE IS NOT ─────────────────────
 *
 * §5.2 asks the chart to "remember the user's choice" of view, and it does -
 * in `localStorage`, per viewer. The AS-OF DATE deliberately is not: coming
 * back tomorrow to a chart still showing last March, with a banner somebody
 * has learned to ignore, is how a person makes a decision from a year-old
 * structure. Time travel resets to today on every visit, and lives in the URL
 * so a specific historical view can still be linked to.
 *
 * ── WHAT "READ-ONLY IN THE PAST" ACTUALLY STOPS ────────────────────────────
 *
 * §5.2: "read-only in that mode with a clear banner". Dragging is disabled and
 * every editor in the drawer hides itself. It is a CONSOLE rule rather than an
 * API one - the API will accept a write with a past effective date, which is
 * sometimes exactly right (recording a move that happened last week is a
 * backfill, not a mistake). ORG_CHART_DECISIONS.md §6 records that split.
 */

const VIEW_KEY = "aura.org-chart.view";

type View = "tree" | "horizontal" | "list";

export interface OrgChartConsoleProps {
  chart: ChartPayload;
  departments: DepartmentRow[];
  teams: TeamRow[];
  changes: ChangeRow[];
  members: AssignableMember[];
  abilities: ChartAbilities;
}

export function OrgChartConsole({
  chart,
  departments,
  teams,
  changes,
  members,
  abilities,
}: OrgChartConsoleProps) {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();
  const [, startTransition] = useTransition();

  const [view, setView] = useState<View>("tree");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(chart.collapsed));
  const [query, setQuery] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);
  const [departmentId, setDepartmentId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [status, setStatus] = useState("");
  const [showDotted, setShowDotted] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(params.get("position"));
  const [pendingMove, setPendingMove] = useState<{ id: string; managerId: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportToken, setExportToken] = useState(0);
  const [adding, setAdding] = useState(false);
  const [structureOpen, setStructureOpen] = useState(false);

  /**
   * §5.2's remembered view, and the one case where it is overridden.
   *
   * §3/§14: "on small screens default to the list view". A remembered `tree`
   * must not win on a phone - the chart is genuinely unusable at 380px, and
   * honouring a preference into a dead end is worse than ignoring it. So the
   * stored value is read, then narrowed by the viewport once.
   *
   * Wrapped in try/catch because `localStorage` throws in a private window and
   * is empty during a thumbnail capture - a preference is a convenience and
   * must never be able to stop the page rendering.
   */
  useEffect(() => {
    let stored: View | null = null;
    try {
      const raw = window.localStorage.getItem(VIEW_KEY);
      if (raw === "tree" || raw === "horizontal" || raw === "list") stored = raw;
    } catch {
      stored = null;
    }
    const narrow = window.matchMedia("(max-width: 767px)").matches;
    setView(narrow ? "list" : (stored ?? "tree"));
  }, []);

  const chooseView = (next: View) => {
    setView(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      // A viewer who cannot store a preference still gets the view they asked
      // for, for this visit.
    }
  };

  // ── Filters (§5.2) ───────────────────────────────────────────────────────

  /**
   * Filtering HIDES nodes; it does not re-root the tree.
   *
   * A filtered node's children are kept and re-attached to the nearest visible
   * ancestor by `layoutTree`'s own root detection - a position whose manager
   * is not in the set becomes a root. Which means filtering to one department
   * shows that department as its own small chart rather than as a scatter of
   * disconnected cards, with no special code for it here.
   */
  const visibleNodes = useMemo(
    () =>
      chart.nodes
        .filter((node) => (departmentId ? node.departmentId === departmentId : true))
        .filter((node) => (teamId ? node.teamId === teamId : true))
        .filter((node) => (status ? node.status === status : true)),
    [chart.nodes, departmentId, teamId, status],
  );

  const visibleIds = useMemo(() => new Set(visibleNodes.map((n) => n.id)), [visibleNodes]);

  const lines = useMemo(
    () =>
      chart.solidLines.map((e) => ({
        positionId: e.positionId,
        managerPositionId: e.managerPositionId,
        type: "solid" as const,
      })),
    [chart.solidLines],
  );

  const parents = useMemo(() => parentMapAsOf(lines, "9999-12-31"), [lines]);
  const children = useMemo(() => childMapOf(chart.nodes, parents), [chart.nodes, parents]);

  // ── Search (§5.2) ────────────────────────────────────────────────────────

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return [] as string[];
    return visibleNodes
      .filter((node) =>
        [
          node.title,
          node.holder?.name,
          node.holder?.email,
          node.departmentName,
          node.teamName,
          POSITION_STATUS_LABELS[node.status],
        ]
          .filter((value): value is string => !!value)
          .some((value) => value.toLowerCase().includes(needle)),
      )
      .map((node) => node.id);
  }, [query, visibleNodes]);

  const matchSet = useMemo(() => new Set(matches), [matches]);

  /**
   * §5.2: "auto-expand the path to them".
   *
   * `pathsToReveal` returns the ancestors of every match and NOT the matches
   * themselves - expanding a match would dump its whole subtree on somebody
   * who searched for the node rather than for its reports.
   *
   * The expansion is applied to `collapsed` rather than layered on top of it,
   * so closing a branch after a search stays closed. A derived "effective
   * collapsed" set would silently re-open it on the next keystroke.
   */
  const lastRevealed = useRef("");
  useEffect(() => {
    if (matches.length === 0) return;
    const key = matches.join(",");
    if (lastRevealed.current === key) return;
    lastRevealed.current = key;
    const reveal = pathsToReveal(parents, matches);
    setCollapsed((current) => {
      const next = new Set(current);
      for (const id of reveal) next.delete(id);
      return next;
    });
    setMatchIndex(0);
  }, [matches, parents]);

  useEffect(() => {
    if (matches.length === 0) return;
    setSelectedId(matches[Math.min(matchIndex, matches.length - 1)] ?? null);
  }, [matchIndex, matches]);

  // ── Selection and the URL (§5.2's path highlight) ────────────────────────

  const pathIds = useMemo(() => {
    if (!selectedId) return new Set<string>();
    return new Set([selectedId, ...ancestorsOf(parents, selectedId)]);
  }, [selectedId, parents]);

  /**
   * The open node lives in the URL, so a link to somebody's position works -
   * which is what the `reporting_change` notification links to.
   *
   * `replace`, not `push`: opening six nodes in a row should not need six
   * presses of Back to leave the page.
   */
  useEffect(() => {
    const current = params.get("position");
    if (current === (selectedId ?? null)) return;
    const next = new URLSearchParams(params.toString());
    if (selectedId) next.set("position", selectedId);
    else next.delete("position");
    router.replace(`/owner/org-chart${next.toString() ? `?${next}` : ""}`, { scroll: false });
    // `params` identity changes on every render in Next's client router, so it
    // is deliberately not a dependency - only the selection drives this.
  }, [selectedId, router]);

  // ── §5.2's as-of date ────────────────────────────────────────────────────

  const setAsOf = (value: string) => {
    const next = new URLSearchParams(params.toString());
    if (value && value !== chart.today) next.set("asOf", value);
    else next.delete("asOf");
    startTransition(() => {
      router.push(`/owner/org-chart${next.toString() ? `?${next}` : ""}`);
    });
  };

  const readOnly = chart.isHistorical || chart.isFuture;

  // ── §5.2's move, behind the confirm dialog §5.2 requires ─────────────────

  const [moveDate, setMoveDate] = useState(chart.today);
  const [moveReason, setMoveReason] = useState("");

  const confirmMove = async () => {
    if (!pendingMove) return;
    const result = await movePositionAction(pendingMove.id, {
      newManagerPositionId: pendingMove.managerId,
      effectiveDate: moveDate,
      reason: moveReason.trim() || null,
    });
    if (result.error) {
      setError(result.error);
      return;
    }
    setError(null);
    setPendingMove(null);
    setMoveReason("");
    toast("Reporting line changed.");
    router.refresh();
  };

  const byId = useMemo(() => new Map(chart.nodes.map((n) => [n.id, n])), [chart.nodes]);

  // ── §5.3's first-run state ───────────────────────────────────────────────

  if (chart.nodes.length === 0) {
    return (
      <div className="space-y-4">
        <EmptyState
          title="Nobody is on the chart yet"
          description="Start with the position at the top - usually the owner or managing director - then add the positions that report to it."
        />
        {abilities.canCreate ? (
          <FirstPosition
            onDone={() => {
              toast("The top position is on the chart.");
              router.refresh();
            }}
          />
        ) : (
          <p className="text-sm text-text-muted">
            An owner or admin sets up the chart. Ask them to add the first position.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {readOnly ? (
        /**
         * §5.2's "clear banner". Worded as what the reader is LOOKING AT
         * rather than as what they cannot do, because the second reads as a
         * failure and this is a feature somebody chose.
         */
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-orange bg-orange-subtle px-3 py-2">
          <p className="text-sm text-orange-text">
            {chart.isHistorical
              ? `This is the chart as it stood on ${chart.asOf}. Nothing can be changed from here.`
              : `This is the chart as it will stand on ${chart.asOf}, based on changes already recorded.`}
          </p>
          <Button variant="secondary" onClick={() => setAsOf(chart.today)}>
            Back to today
          </Button>
        </div>
      ) : null}

      {chart.problems.length > 0 ? <ProblemBanner chart={chart} /> : null}

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1">
          <FormField label="Search" name="org-chart-search">
            <div className="relative">
              <Search
                aria-hidden
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-subtle"
              />
              <Input
                id="org-chart-search"
                value={query}
                placeholder="Name, position, department…"
                className="pl-8"
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </FormField>
        </div>

        {query.trim() ? (
          <div className="flex items-center gap-1 pb-0.5">
            <span aria-live="polite" className="text-xs text-text-muted">
              {matches.length === 0
                ? "No matches"
                : `${Math.min(matchIndex + 1, matches.length)} of ${matches.length}`}
            </span>
            <button
              type="button"
              aria-label="Previous match"
              disabled={matches.length === 0}
              onClick={() => setMatchIndex((i) => (i - 1 + matches.length) % matches.length)}
              className="rounded border border-border px-1.5 text-text-muted transition-colors hover:bg-surface-hover disabled:opacity-40"
            >
              ↑
            </button>
            <button
              type="button"
              aria-label="Next match"
              disabled={matches.length === 0}
              onClick={() => setMatchIndex((i) => (i + 1) % matches.length)}
              className="rounded border border-border px-1.5 text-text-muted transition-colors hover:bg-surface-hover disabled:opacity-40"
            >
              ↓
            </button>
          </div>
        ) : null}

        <FormField label="Department" name="org-chart-department">
          <Select
            id="org-chart-department"
            value={departmentId}
            onChange={(event) => setDepartmentId(event.target.value)}
          >
            <option value="">All departments</option>
            {departments.map((department) => (
              <option key={department.id} value={department.id}>
                {department.name}
              </option>
            ))}
          </Select>
        </FormField>

        <FormField label="Team" name="org-chart-team">
          <Select
            id="org-chart-team"
            value={teamId}
            onChange={(event) => setTeamId(event.target.value)}
          >
            <option value="">All teams</option>
            {teams
              .filter((team) => !departmentId || team.departmentId === departmentId)
              .map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
          </Select>
        </FormField>

        <FormField label="Status" name="org-chart-status">
          <Select
            id="org-chart-status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">Any status</option>
            <option value="filled">{POSITION_STATUS_LABELS.filled}</option>
            <option value="vacant">{POSITION_STATUS_LABELS.vacant}</option>
            <option value="frozen">{POSITION_STATUS_LABELS.frozen}</option>
          </Select>
        </FormField>

        <FormField label="As of" name="org-chart-asof">
          <Input
            id="org-chart-asof"
            type="date"
            value={chart.asOf}
            max="2099-12-31"
            onChange={(event) => setAsOf(event.target.value)}
          />
        </FormField>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="group"
          aria-label="How to show the chart"
          className="flex overflow-hidden rounded-md border border-border"
        >
          {(
            [
              { key: "tree", label: "Tree", icon: Network },
              { key: "horizontal", label: "Sideways", icon: Network },
              { key: "list", label: "List", icon: Rows3 },
            ] as const
          ).map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => chooseView(entry.key)}
              aria-pressed={view === entry.key}
              className={
                view === entry.key
                  ? "bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg"
                  : "px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
              }
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {view !== "list" ? (
            <>
              <label className="flex items-center gap-1.5 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={showDotted}
                  onChange={(event) => setShowDotted(event.target.checked)}
                />
                Show dotted lines
              </label>
              <Button
                variant="ghost"
                onClick={() => setCollapsed(new Set())}
                aria-label="Expand every position"
              >
                Expand all
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  // "Collapse to level 1": fold every manager at depth 1 and
                  // below, which leaves the top two ranks visible. §5.2 asks
                  // for "collapse to level N"; one control for the level that
                  // is actually useful beats a number nobody tunes.
                  const next = new Set<string>();
                  for (const node of chart.nodes) {
                    if ((children.get(node.id) ?? []).length === 0) continue;
                    if (chart.roots.includes(node.id)) continue;
                    next.add(node.id);
                  }
                  setCollapsed(next);
                }}
              >
                Collapse
              </Button>
              <Button variant="ghost" onClick={() => setExportToken((t) => t + 1)}>
                <Download aria-hidden className="mr-1 size-3.5" />
                PNG
              </Button>
            </>
          ) : null}
          <a
            href={`/api/owner/org-chart-pdf?asOf=${encodeURIComponent(chart.asOf)}&orientation=${view === "horizontal" ? "horizontal" : "vertical"}`}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-text-muted transition-colors hover:bg-surface-hover hover:text-text"
          >
            PDF
          </a>
          {abilities.canCreate && !readOnly ? (
            <>
              <Button variant="secondary" onClick={() => setStructureOpen((v) => !v)}>
                Departments &amp; teams
              </Button>
              <Button onClick={() => setAdding((v) => !v)}>Add a position</Button>
            </>
          ) : null}
        </div>
      </div>

      {structureOpen ? (
        <StructurePanel
          departments={departments}
          teams={teams}
          canEdit={abilities.canEdit}
          canDelete={abilities.canDelete}
          positions={chart.nodes.map((node) => ({ id: node.id, title: node.title }))}
          onClose={() => setStructureOpen(false)}
        />
      ) : null}

      {adding ? (
        <AddPosition
          nodes={chart.nodes.map((n) => ({ id: n.id, title: n.title }))}
          departments={departments}
          teams={teams}
          suggestedManagerId={selectedId}
          onCancel={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            toast("Position added.");
            router.refresh();
          }}
          onFail={setError}
        />
      ) : null}

      {view === "list" ? (
        <DirectoryTable
          asOf={chart.asOf}
          nodes={visibleNodes}
          parents={parents}
          onOpen={setSelectedId}
        />
      ) : (
        <ChartCanvas
          nodes={visibleNodes}
          solidLines={chart.solidLines.filter(
            (e) => visibleIds.has(e.positionId) && visibleIds.has(e.managerPositionId),
          )}
          dottedLines={chart.dottedLines.filter(
            (e) => visibleIds.has(e.positionId) && visibleIds.has(e.managerPositionId),
          )}
          collapsed={collapsed}
          onToggleCollapse={(id) =>
            setCollapsed((current) => {
              const next = new Set(current);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          selectedId={selectedId}
          onSelect={setSelectedId}
          matches={matchSet}
          pathIds={pathIds}
          orientation={view === "horizontal" ? "horizontal" : "vertical"}
          showDotted={showDotted}
          canMove={abilities.canEdit && !readOnly}
          onRequestMove={(id, managerId) => {
            setMoveDate(chart.today);
            setPendingMove({ id, managerId });
          }}
          exportToken={exportToken}
          exportFileName={`org-chart-${chart.asOf}.png`}
        />
      )}

      {/* §5.2's confirm dialog: a drop cannot become a write without somebody
          answering "from when". */}
      {pendingMove ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-text/40 p-4">
          <div className="w-full max-w-md space-y-3 rounded-lg border border-border bg-surface p-5 shadow-xl">
            <h2 className="text-base font-semibold text-text">Change the reporting line?</h2>
            <p className="text-sm text-text-muted">
              <strong className="text-text">{byId.get(pendingMove.id)?.title}</strong> will report
              to <strong className="text-text">{byId.get(pendingMove.managerId)?.title}</strong>.
              {(subtreeOf(children, pendingMove.id).length - 1 > 0) ? (
                <>
                  {" "}
                  Everything under it moves too -{" "}
                  {subtreeOf(children, pendingMove.id).length - 1} other position
                  {subtreeOf(children, pendingMove.id).length - 1 === 1 ? "" : "s"}.
                </>
              ) : null}
            </p>
            <FormField label="Effective from" name="org-chart-move-date">
              <Input
                id="org-chart-move-date"
                type="date"
                value={moveDate}
                onChange={(event) => setMoveDate(event.target.value)}
              />
            </FormField>
            <FormField label="Why (optional)" name="org-chart-move-reason">
              <Input
                id="org-chart-move-reason"
                value={moveReason}
                maxLength={500}
                placeholder="South region split"
                onChange={(event) => setMoveReason(event.target.value)}
              />
            </FormField>
            <p className="text-xs text-text-muted">
              The old reporting line is kept, closed off the day before this date - the chart as it
              stood before the move stays correct.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setPendingMove(null)}>
                Cancel
              </Button>
              {/* `void`, not the async function itself: an onClick returning
                  a promise is an unhandled rejection waiting to happen, and
                  `confirmMove` already reports its own failures. */}
              <Button onClick={() => void confirmMove()}>Change it</Button>
            </div>
          </div>
        </div>
      ) : null}

      {selectedId && byId.has(selectedId) ? (
        <PositionDrawer
          positionId={selectedId}
          asOf={chart.asOf}
          readOnly={readOnly}
          abilities={abilities}
          members={members}
          changes={changes}
          onClose={() => setSelectedId(null)}
          onJumpTo={setSelectedId}
          onChanged={() => router.refresh()}
        />
      ) : null}
    </div>
  );
}

/**
 * §10's "missing data" alerts, on the chart itself.
 *
 * Shown to every reader rather than only to owners: a chart with two roots
 * renders as two trees, and the person most likely to notice is whoever is
 * looking at it. The wording says what is WRONG and not what to click,
 * because the fix depends on which of the four it is.
 */
function ProblemBanner({ chart }: { chart: ChartPayload }) {
  const titleOf = (id: string) => chart.nodes.find((n) => n.id === id)?.title ?? "a position";
  const lines = chart.problems.map((problem) => {
    switch (problem.kind) {
      case "multiple_roots":
        return `More than one position sits at the top: ${problem.positionIds.map(titleOf).join(", ")}. Give all but one of them a manager.`;
      case "no_manager":
        return `${titleOf(problem.positionId)} reports to a position that is no longer on the chart.`;
      case "multiple_solid_managers":
        return `${titleOf(problem.positionId)} has more than one manager at once.`;
      case "cycle":
        return `These positions report to each other in a loop: ${problem.positionIds.map(titleOf).join(", ")}.`;
    }
  });
  return (
    <div className="rounded-md border border-orange bg-orange-subtle px-3 py-2">
      <p className="text-xs font-medium uppercase tracking-wide text-orange-text">
        The chart needs attention
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm text-orange-text">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

/** §5.3's guided first position. */
function FirstPosition({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="max-w-md space-y-3 rounded-lg border border-border bg-surface p-4">
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      <FormField
        label="The position at the top"
        name="org-chart-first"
        hint="A position, not a person - you choose who holds it next."
      >
        <Input
          id="org-chart-first"
          value={title}
          maxLength={200}
          placeholder="Managing Director"
          onChange={(event) => setTitle(event.target.value)}
        />
      </FormField>
      <Button
        disabled={pending || !title.trim()}
        onClick={() =>
          start(async () => {
            const result = await createPositionAction({ title: title.trim() });
            if (result.error) setError(result.error);
            else onDone();
          })
        }
      >
        Create it
      </Button>
    </div>
  );
}

/** §5.2's "add report below" / "add sibling", as one form. */
function AddPosition({
  nodes,
  departments,
  teams,
  suggestedManagerId,
  onCancel,
  onDone,
  onFail,
}: {
  nodes: { id: string; title: string }[];
  departments: DepartmentRow[];
  teams: TeamRow[];
  suggestedManagerId: string | null;
  onCancel: () => void;
  onDone: () => void;
  onFail: (message: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [managerId, setManagerId] = useState(suggestedManagerId ?? "");
  const [departmentId, setDepartmentId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [pending, start] = useTransition();

  return (
    <div className="grid gap-3 rounded-lg border border-border bg-surface p-4 sm:grid-cols-2">
      <FormField label="Position title" name="org-chart-new-title">
        <Input
          id="org-chart-new-title"
          value={title}
          maxLength={200}
          placeholder="Regional Sales Manager"
          onChange={(event) => setTitle(event.target.value)}
        />
      </FormField>
      <FormField
        label="Reports to"
        name="org-chart-new-manager"
        hint="Pre-filled with whichever position you had open."
      >
        <Select
          id="org-chart-new-manager"
          value={managerId}
          onChange={(event) => setManagerId(event.target.value)}
        >
          <option value="">Choose a manager…</option>
          {nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.title}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Department (optional)" name="org-chart-new-department">
        <Select
          id="org-chart-new-department"
          value={departmentId}
          onChange={(event) => setDepartmentId(event.target.value)}
        >
          <option value="">None</option>
          {departments.map((department) => (
            <option key={department.id} value={department.id}>
              {department.name}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Team (optional)" name="org-chart-new-team">
        <Select
          id="org-chart-new-team"
          value={teamId}
          onChange={(event) => setTeamId(event.target.value)}
        >
          <option value="">None</option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </Select>
      </FormField>
      <div className="flex items-end gap-2 sm:col-span-2">
        <Button
          disabled={pending || !title.trim() || !managerId}
          onClick={() =>
            start(async () => {
              const result = await createPositionAction({
                title: title.trim(),
                managerPositionId: managerId,
                departmentId: departmentId || null,
                teamId: teamId || null,
              });
              if (result.error) onFail(result.error);
              else onDone();
            })
          }
        >
          Add it
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
