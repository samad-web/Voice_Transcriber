"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Button, ErrorBanner, Input, MonoLabel, useAlert } from "@aura/ui";
import { localToday, prioritise } from "@/lib/next-actions";
import { createTaskAction, fetchTasksAction, updateTaskAction } from "./crm-actions";
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
  const [draft, setDraft] = useState({ title: "", dueOn: "" });
  const [today, setToday] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const alert = useAlert();
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
    // The viewer's own date, read after mount - see lib/next-actions.ts.
    setToday(localToday());
    setTasks(null);
    return load();
  }, [load]);

  const add = () => {
    if (!draft.title.trim()) {
      void alert({
        title: "Couldn't add the task",
        body: "Give the task a title",
        tone: "danger",
      });
      return;
    }
    startTransition(async () => {
      const result = await createTaskAction({
        title: draft.title.trim(),
        dueOn: draft.dueOn || null,
        dealId: dealId ?? null,
        contactId: contactId ?? null,
        accountId: accountId ?? null,
      });
      if (result.error) {
        await alert({ title: "Couldn't add the task", body: result.error, tone: "danger" });
        return;
      }
      if (result.task) setTasks((prev) => [result.task!, ...(prev ?? [])]);
      setDraft({ title: "", dueOn: "" });
    });
  };

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

  const ordered = tasks && today ? prioritise(tasks, today) : [];

  return (
    <div className="space-y-3">
      <MonoLabel>{title}</MonoLabel>

      {showComposer ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <Input
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="Call back about the quote"
              maxLength={300}
              aria-label="New follow-up"
              onKeyDown={(e) => {
                if (e.key === "Enter") add();
              }}
            />
          </div>
          <input
            type="date"
            value={draft.dueOn}
            onChange={(e) => setDraft({ ...draft, dueOn: e.target.value })}
            aria-label="Due date"
            className="h-9 rounded-md border border-border-strong bg-surface px-2 text-sm text-text"
          />
          <Button type="button" size="sm" onClick={add} loading={pending}>
            Add
          </Button>
        </div>
      ) : null}

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {tasks === null || today === null ? (
        <p className="py-3 text-xs text-text-muted">Loading…</p>
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
