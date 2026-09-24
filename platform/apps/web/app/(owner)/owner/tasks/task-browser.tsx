"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { CheckSquare } from "lucide-react";
import { Button, EmptyState, ErrorBanner, useAlert } from "@aura/ui";
import { useOrgTimeZone } from "@/components/org-time";
import { Pager } from "@/components/pager";
import { useRealtime } from "@/components/realtime-provider";
import { listPageHref } from "@/lib/list-views";
import { DUE_WINDOWS, dueWindowQuery, prioritise, workspaceToday, type DueWindow } from "@/lib/next-actions";
import { BulkActionBar } from "../bulk/bulk-action-bar";
import { useRowSelection } from "../bulk/use-row-selection";
import { fetchTasksAction, updateTaskAction } from "../crm-actions";
import { NewTaskButton, useAssigneeOptions } from "../task-composer";
import { TaskRow } from "../task-row";
import type { Task } from "../types";

/**
 * Rows per page (CRM dashboard Phase 8).
 *
 * This list used to fetch 100 and say "Showing 100 of 137", which is a list
 * that has quietly stopped: the other 37 were unreachable from the console.
 * Fifty and a pager instead - the page is in the URL, like every other list
 * here, and `ListFilterForm` drops it whenever a filter changes so page 3 of
 * one filter never becomes page 3 of another.
 */
const PAGE_SIZE = 50;

/** `who` values that are a word rather than a user id. */
const WHO_WORDS = new Set(["mine", "unassigned", "awaiting"]);

export interface TaskFilters {
  q?: string;
  /** `open` (default), `done`, `cancelled`. */
  status?: string;
  /** "" everyone visible, `mine`, `unassigned`, or a user id. */
  who?: string;
  due?: string;
  priority?: string;
  sort?: string;
}

/**
 * The Tasks page's list: filtered by the URL, fetched in the browser.
 *
 * "Due today" and "overdue" are the WORKSPACE's calendar (workspaceToday in
 * lib/next-actions.ts), the midnight the API's own overdue count uses. The due
 * filter is turned into date bounds here (dueWindowQuery) and sent to the API,
 * so the filter and the row colours use the same "today".
 *
 * "Select" switches the rows into selection mode for the bulk bar - the Done
 * checkbox and a selection checkbox never share a row.
 */
export function TaskBrowser({ filters, offset }: { filters: TaskFilters; offset: number }) {
  const alert = useAlert();
  const zone = useOrgTimeZone();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [, startTransition] = useTransition();
  const assignees = useAssigneeOptions();
  const selection = useRowSelection(selecting && tasks ? tasks.map((t) => t.id) : []);

  const { q, status = "open", who = "", due = "", priority = "", sort = "due" } = filters;

  const load = useCallback(() => {
    const day = workspaceToday(zone);
    setToday(day);
    const window = (DUE_WINDOWS as readonly string[]).includes(due) ? dueWindowQuery(due as DueWindow, day) : {};
    let cancelled = false;
    void fetchTasksAction({
      status,
      q: q || undefined,
      mine: who === "mine",
      unassigned: who === "unassigned",
      awaiting: who === "awaiting",
      assigneeUserId: who && !WHO_WORDS.has(who) ? who : undefined,
      priority: priority === "low" || priority === "normal" || priority === "high" ? priority : undefined,
      sort: sort === "created" || sort === "priority" ? sort : "due",
      limit: PAGE_SIZE,
      offset,
      ...window,
    }).then((result) => {
      if (cancelled) return;
      if (result.error) {
        setError(result.error);
        setTasks([]);
        return;
      }
      setError(null);
      setTasks(result.tasks ?? []);
      setTotal(result.total ?? 0);
    });
    return () => {
      cancelled = true;
    };
  }, [q, status, who, due, priority, sort, offset, zone]);

  useEffect(() => {
    setTasks(null);
    return load();
  }, [load]);

  // Another tab or teammate changing a task refreshes this list too.
  useRealtime(["task"], load);

  const complete = (task: Task) => {
    setTasks((prev) => (prev ?? []).filter((t) => t.id !== task.id));
    setTotal((n) => Math.max(0, n - 1));
    startTransition(async () => {
      const result = await updateTaskAction(task.id, { status: "done" });
      if (result.error) {
        setTasks((prev) => [task, ...(prev ?? [])]);
        setTotal((n) => n + 1);
        await alert({ title: "Couldn't mark that task done", body: result.error, tone: "danger" });
      }
    });
  };

  // A row came back changed (reassigned, accepted, declined). On the
  // "Waiting for my answer" view an answered task no longer belongs, so it
  // leaves; everywhere else the API's copy replaces ours.
  const replace = (next: Task) => {
    if (who === "awaiting" && next.my_status !== "pending") {
      setTasks((prev) => (prev ?? []).filter((t) => t.id !== next.id));
      setTotal((n) => Math.max(0, n - 1));
      return;
    }
    setTasks((prev) => (prev ?? []).map((t) => (t.id === next.id ? next : t)));
  };

  // The default "due" sort is what-to-do-next order (next-actions.ts); any
  // other sort is the server's order, untouched.
  const ordered = tasks && today ? (sort === "due" && status === "open" ? prioritise(tasks, today) : tasks) : [];
  // `prioritise` re-orders WITHIN the page, using the workspace's "today". The
  // page itself is the server's `sort=due` order, so the two agree about which
  // fifty these are; the browser only decides how they read.
  const page = Math.floor(offset / PAGE_SIZE) + 1;
  const first = offset + 1;
  const filtered = Boolean(q || who || due || priority || status !== "open");

  return (
    <div className="space-y-3">
      {/* Creating a task lived only on a contact, company or deal; the page
          named Tasks had no way to add one. A task made here is not tied to a
          record - the API allows that, and "remind Priya to send the brochure"
          does not always have a contact yet. */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-text-muted tabular-nums" aria-live="polite">
          {tasks === null
            ? "Loading…"
            : total > PAGE_SIZE
              ? `${first}-${first + ordered.length - 1} of ${total} tasks`
              : `${total} task${total === 1 ? "" : "s"}`}
        </p>
        <div className="flex flex-wrap items-center gap-2">
        {ordered.length > 0 ? (
          <Button
            type="button"
            size="sm"
            variant={selecting ? "secondary" : "ghost"}
            aria-pressed={selecting}
            onClick={() => {
              setSelecting((s) => !s);
              selection.clear();
            }}
          >
            <CheckSquare aria-hidden="true" className="h-3.5 w-3.5" />
            {selecting ? "Done selecting" : "Select"}
          </Button>
        ) : null}
          <NewTaskButton
            assignees={assignees}
            placeholder="e.g. Send the brochure to the Mehta family"
            onCreated={(task) => {
              // Shown straight away on the open list; any other view (done, a
              // different person) picks it up on its next load.
              if (status === "open" && who !== "awaiting") {
                setTasks((prev) => [task, ...(prev ?? [])]);
                setTotal((n) => n + 1);
              }
            }}
          />
        </div>
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {tasks === null || today === null ? null : ordered.length === 0 ? (
        <EmptyState
          title={filtered ? "No tasks match these filters" : "Nothing open"}
          description={filtered ? "Clear a filter above to see more." : "Follow-ups you or your team add appear here."}
        />
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {ordered.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              today={today}
              showAssignee
              assignees={assignees}
              onChanged={replace}
              onComplete={complete}
              selection={
                selecting ? { selected: selection.selected.has(task.id), onToggle: () => selection.toggle(task.id) } : undefined
              }
              onLogged={({ completed, next }) => {
                setTasks((prev) => {
                  const kept = (prev ?? []).filter((t) => !(completed && t.id === task.id));
                  return next ? [...kept, next] : kept;
                });
              }}
            />
          ))}
        </ul>
      )}

      {tasks !== null && total > PAGE_SIZE ? (
        <Pager
          total={total}
          page={page}
          pageSize={PAGE_SIZE}
          noun="task"
          previousLabel="← Previous"
          nextLabel="Next →"
          hrefFor={(to) => listPageHref("tasks", filters as Record<string, string>, (to - 1) * PAGE_SIZE)}
        />
      ) : null}

      {selecting ? (
        <BulkActionBar
          object="tasks"
          noun="task"
          ids={selection.ids}
          onClear={selection.clear}
          reassign="people"
        />
      ) : null}
    </div>
  );
}
