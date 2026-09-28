import type { Metadata } from "next";
import Link from "next/link";
import { Hand } from "lucide-react";
import { Card, MonoLabel } from "@aura/ui";
import { LoadFailure } from "@/components/load-failure";
import { PageHeader } from "@/components/page-header";
import { viewHref, viewQueryFrom } from "@/lib/list-views";
import { DUE_WINDOWS, DUE_WINDOW_LABEL } from "@/lib/next-actions";
import { ownerTry } from "@/lib/owner-context";
import { requireOwnerFeature } from "@/lib/owner-features";
import { FilterSearch, FilterSelect, ListFilterForm } from "../list-filters";
import { loadMembers } from "../list-data";
import { withCurrent, type FilterOption } from "../list-options";
import { SavedViewsBar } from "../saved-views/saved-views-bar";
import { loadSavedViews } from "../saved-views/load";
import type { Task } from "../types";
import { TaskBrowser } from "./task-browser";

export const metadata: Metadata = { title: "Tasks" };

const STATUS_OPTIONS: readonly FilterOption[] = [
  { value: "", label: "Open" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

const DUE_OPTIONS: readonly FilterOption[] = [
  { value: "", label: "Any date" },
  ...DUE_WINDOWS.map((w) => ({ value: w, label: DUE_WINDOW_LABEL[w] })),
];

const PRIORITY_OPTIONS: readonly FilterOption[] = [
  { value: "", label: "Any priority" },
  { value: "high", label: "High" },
  { value: "normal", label: "Normal" },
  { value: "low", label: "Low" },
];

const SORT_OPTIONS: readonly FilterOption[] = [
  { value: "", label: "What to do next" },
  { value: "priority", label: "Priority" },
  { value: "created", label: "Newest" },
];

/** History window - 30 days, matching the console's other short-window defaults (not SLA's 90). */
const HISTORY_DAYS = 30;

interface ComplianceKpi {
  total: number;
  completed: number;
  overdue: number;
  pending: number;
  completedLate: number;
  completedOnTime: number;
  compliancePct: number | null;
}

/**
 * The workspace's follow-ups (Track A3), filterable and savable.
 *
 * The overdue count is server-rendered from its own query so the number is
 * right in the first paint - it is the one thing on this page somebody scans
 * for, and a count that arrives late reads as "nothing is overdue".
 *
 * The list itself is fetched in the browser (task-browser.tsx): its due-date
 * filter is the viewer's calendar, which the server does not know.
 */
export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Feature gate (migration 0093). Before any fetch: a page this tenant is
  // not provisioned for must neither cost a round trip nor 404 only after
  // proving the data behind it exists.
  await requireOwnerFeature("followups");

  const params = await searchParams;
  const current = viewQueryFrom("tasks", params);
  // Not a saved-view param (lib/list-views.ts), so it is read straight off the
  // URL rather than through the whitelist.
  const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);
  const offset = Math.max(0, Number(one(params.offset)) || 0);

  const [overdueResult, members, views, countsResult, historyResult] = await Promise.all([
    ownerTry<{ tasks: Task[]; total: number }>("/v1/tasks?overdue=1&limit=100"),
    loadMembers(),
    loadSavedViews("tasks"),
    // Only for the "waiting for your answer" banner (0135) - a failure just
    // means no banner, never a broken page.
    ownerTry<{ awaiting?: number }>("/v1/tasks/counts"),
    // Completed-vs-missed history (same `deal:view`-gated endpoint the SLA
    // report uses) - a scoped login gets their own numbers, `deal:view`'s
    // `owned` scope applied to `tasks` the same way it is there. A failure
    // just hides the card, never a broken page.
    ownerTry<{ kpi: ComplianceKpi }>(`/v1/reports/followup-compliance?days=${HISTORY_DAYS}`),
  ]);
  const awaiting = countsResult.ok ? (countsResult.data.awaiting ?? 0) : 0;
  const history = historyResult.ok ? historyResult.data.kpi : null;

  const whoOptions: FilterOption[] = [
    { value: "", label: "Everyone" },
    { value: "mine", label: "Assigned to me" },
    { value: "awaiting", label: "Waiting for my answer" },
    { value: "unassigned", label: "Unassigned" },
    ...members.map((m) => ({ value: m.userId, label: m.name ?? m.email })),
  ];

  return (
    <>
      <PageHeader title="Tasks" context="Your work" />

      {!overdueResult.ok ? (
        <LoadFailure what="tasks" failure={overdueResult} />
      ) : (
        <>
          <SavedViewsBar list="tasks" views={views} current={current} allLabel="Open tasks" />

          {/* Tasks somebody handed you that you have not accepted yet. Above
              the list rather than inside it: until you answer, the person who
              asked does not know whether it is being done. */}
          {awaiting > 0 && current.who !== "awaiting" ? (
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-strong bg-bg-subtle px-4 py-3"
            >
              <span className="flex items-center gap-2 text-sm text-text">
                <Hand aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
                {awaiting === 1
                  ? "1 task is waiting for you to accept or decline."
                  : `${awaiting} tasks are waiting for you to accept or decline.`}
              </span>
              <Link
                href="/owner/tasks?who=awaiting"
                className="text-sm font-medium text-text underline underline-offset-2 hover:text-text-muted"
              >
                Review them
              </Link>
            </div>
          ) : null}

          <div className="grid gap-6 xl:grid-cols-[1fr_18rem]">
            <Card className="space-y-4">
              <ListFilterForm key={viewHref("tasks", current)} path="/owner/tasks" label="Filter tasks">
                <FilterSearch defaultValue={current.q} placeholder="Task title" label="Search tasks" />
                <FilterSelect name="status" label="Status" defaultValue={current.status} options={STATUS_OPTIONS} />
                <FilterSelect name="who" label="Assigned to" defaultValue={current.who} options={withCurrent(whoOptions, current.who)} />
                <FilterSelect name="due" label="Due" defaultValue={current.due} options={DUE_OPTIONS} />
                <FilterSelect name="priority" label="Priority" defaultValue={current.priority} options={PRIORITY_OPTIONS} />
                <FilterSelect name="sort" label="Sort" defaultValue={current.sort} options={SORT_OPTIONS} />
              </ListFilterForm>
              <TaskBrowser filters={current} offset={offset} />
            </Card>

            <div className="space-y-6">
              <Card>
                <MonoLabel>Overdue</MonoLabel>
                <p className="mt-2 text-3xl font-semibold text-text tabular-nums">{overdueResult.data.total}</p>
                <p className="mt-1 text-xs text-text-muted">
                  {overdueResult.data.total === 0 ? "Nothing is past its due date." : "Open tasks past their due date."}
                </p>
                {overdueResult.data.tasks.length > 0 ? (
                  <ul className="mt-3 space-y-1.5">
                    {overdueResult.data.tasks.slice(0, 8).map((task) => (
                      <li key={task.id} className="text-xs break-words text-text-muted">
                        <span className="font-medium text-danger-text tabular-nums">{task.due_on}</span> {task.title}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Card>

              {history ? <TaskHistoryCard kpi={history} /> : null}
            </div>
          </div>
        </>
      )}
    </>
  );
}

/**
 * "Visible tracking" for missed follow-ups - a record, not a consequence: no
 * score, no automated action, just what a person (or, for an owner/manager
 * login, the floor) actually closed on time. Reuses the SLA report's own
 * `followup-compliance` KPI rather than a second query, so this card and that
 * report can never disagree, and is scoped by whatever `deal:view` resolves
 * to for this login - see that endpoint's own comment for why a telecaller
 * lands on their own numbers without a separate "mine" parameter.
 */
function TaskHistoryCard({ kpi }: { kpi: ComplianceKpi }) {
  // Both halves of "didn't keep the promise": still open and past due, or
  // closed but after the date it was promised for. Cancelled follow-ups are
  // excluded upstream (the API's own comment: tidying up isn't a miss).
  const missed = kpi.overdue + kpi.completedLate;
  return (
    <Card>
      <MonoLabel>Task history · {HISTORY_DAYS}d</MonoLabel>
      <div className="mt-2 grid grid-cols-2 gap-3">
        <div>
          <p className="text-2xl font-semibold text-text tabular-nums">{kpi.completedOnTime}</p>
          <p className="text-xs text-text-muted">Completed on time</p>
        </div>
        <div>
          <p className="text-2xl font-semibold text-danger-text tabular-nums">{missed}</p>
          <p className="text-xs text-text-muted">Missed</p>
        </div>
      </div>
      <p className="mt-3 text-xs text-text-muted">
        {kpi.total === 0
          ? "No follow-ups due in this window."
          : `${kpi.compliancePct ?? 0}% on time, out of ${kpi.total} due.`}
      </p>
    </Card>
  );
}
