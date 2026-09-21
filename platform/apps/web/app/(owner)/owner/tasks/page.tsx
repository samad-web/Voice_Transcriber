import type { Metadata } from "next";
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

  const [overdueResult, members, views] = await Promise.all([
    ownerTry<{ tasks: Task[]; total: number }>("/v1/tasks?overdue=1&limit=100"),
    loadMembers(),
    loadSavedViews("tasks"),
  ]);

  const whoOptions: FilterOption[] = [
    { value: "", label: "Everyone" },
    { value: "mine", label: "Assigned to me" },
    { value: "unassigned", label: "Unassigned" },
    ...members.map((m) => ({ value: m.userId, label: m.name ?? m.email })),
  ];

  return (
    <>
      <PageHeader title="Tasks" context="Pipeline" />

      {!overdueResult.ok ? (
        <LoadFailure what="tasks" failure={overdueResult} />
      ) : (
        <>
          <SavedViewsBar list="tasks" views={views} current={current} allLabel="Open tasks" />

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
          </div>
        </>
      )}
    </>
  );
}
