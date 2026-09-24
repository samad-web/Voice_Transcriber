"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { ErrorBanner, MonoLabel, useAlert } from "@aura/ui";
import { useOrgTimeZone } from "@/components/org-time";
import { InlineListSkeleton } from "@/components/skeletons";
import { prioritise, workspaceToday } from "@/lib/next-actions";
import { fetchTasksAction, updateTaskAction } from "./crm-actions";
import { NewTaskButton, useAssigneeOptions } from "./task-composer";
import { TaskRow } from "./task-row";
import type { Task } from "./types";

/**
 * Follow-up tasks (Track A3) for one object, or for the whole workspace when
 * no filter is given.
 *
 * Ordered by what to do next, not merely by date (lib/next-actions.ts), and
 * every row carries the same Done / Log call / Log message actions as the
 * dashboard's Next actions - so a follow-up is closed where it is read, on
 * whichever page that happens to be.
 *
 * Completion is optimistic - a checkbox that waits for a round-trip feels
 * broken - and rolls back on failure, the same contract deals-board.tsx uses
 * for a drag between columns.
 */
export function TaskList({
  dealId,
  contactId,
  accountId,
  title = "Tasks",
  showComposer = true,
}: {
  dealId?: string;
  contactId?: string;
  accountId?: string;
  title?: string;
  showComposer?: boolean;
}) {
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const assignees = useAssigneeOptions();
  const alert = useAlert();
  const zone = useOrgTimeZone();
  // Inside a record's own page the record link would point at itself.
  const onRecord = Boolean(dealId || contactId || accountId);

  const load = useCallback(() => {
    let cancelled = false;
    void fetchTasksAction({ dealId, contactId, accountId, status: "open" }).then((result) => {
      if (cancelled) return;
      if (result.error) {
        setError(result.error);
        setTasks([]);
        return;
      }
      setTasks(result.tasks ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, [dealId, contactId, accountId]);

  useEffect(() => {
    // The workspace's date, the one the API counts overdue on - see lib/next-actions.ts.
    setToday(workspaceToday(zone));
    setTasks(null);
    return load();
  }, [load, zone]);

  const complete = (task: Task) => {
    // Optimistic: drop it from the open list immediately.
    setTasks((prev) => (prev ?? []).filter((t) => t.id !== task.id));
    startTransition(async () => {
      const result = await updateTaskAction(task.id, { status: "done" });
      if (result.error) {
        setTasks((prev) => [task, ...(prev ?? [])]);
        await alert({
          title: "Couldn't mark that task done",
          body: result.error,
          tone: "danger",
        });
      }
    });
  };

  // A row came back from the API changed - reassigned in its dialog, or
  // accepted / declined by the reader. The API's copy replaces ours whole, so
  // everyone's answers are the server's rather than a guess.
  const replace = (next: Task) => setTasks((prev) => (prev ?? []).map((t) => (t.id === next.id ? next : t)));

  const ordered = tasks && today ? prioritise(tasks, today) : [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <MonoLabel>{title}</MonoLabel>
        {showComposer ? (
          <NewTaskButton
            size="sm"
            assignees={assignees}
            dealId={dealId}
            contactId={contactId}
            accountId={accountId}
            onCreated={(task) => setTasks((prev) => [task, ...(prev ?? [])])}
          />
        ) : null}
      </div>

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {tasks === null || today === null ? (
        <InlineListSkeleton rows={3} lead="check" label="Loading tasks" />
      ) : ordered.length === 0 ? (
        <p className="py-3 text-xs text-text-muted">Nothing open</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {ordered.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              today={today}
              showRecord={!onRecord}
              showAssignee={!onRecord}
              assignees={assignees}
              onChanged={replace}
              onComplete={complete}
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
    </div>
  );
}
