"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { Button, Input, MonoLabel, StatusChip } from "@aura/ui";
import { createTaskAction, fetchTasksAction, updateTaskAction } from "./crm-actions";
import type { Task } from "./types";

/** Today in the VIEWER's timezone, as `YYYY-MM-DD` - the same shape the API
 *  speaks, so "overdue" compares two plain dates and never a timestamp. */
function today(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function dueLabel(due: string | null): { text: string; overdue: boolean } {
  if (!due) return { text: "No date", overdue: false };
  const now = today();
  if (due < now) return { text: `Overdue · ${due}`, overdue: true };
  if (due === now) return { text: "Due today", overdue: false };
  return { text: `Due ${due}`, overdue: false };
}

/**
 * Follow-up tasks (Track A3) for one object, or for the whole workspace when
 * no filter is given.
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
  const [pending, startTransition] = useTransition();

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
    setTasks(null);
    return load();
  }, [load]);

  const add = () => {
    if (!draft.title.trim()) {
      setError("Give the task a title");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createTaskAction({
        title: draft.title.trim(),
        dueOn: draft.dueOn || null,
        dealId: dealId ?? null,
        contactId: contactId ?? null,
        accountId: accountId ?? null,
      });
      if (result.error) {
        setError(result.error);
        return;
      }
      if (result.task) setTasks((prev) => sortByDue([result.task!, ...(prev ?? [])]));
      setDraft({ title: "", dueOn: "" });
    });
  };

  const complete = (task: Task) => {
    setError(null);
    // Optimistic: drop it from the open list immediately.
    setTasks((prev) => (prev ?? []).filter((t) => t.id !== task.id));
    startTransition(async () => {
      const result = await updateTaskAction(task.id, { status: "done" });
      if (result.error) {
        setError(result.error);
        setTasks((prev) => sortByDue([task, ...(prev ?? [])]));
      }
    });
  };

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

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-danger bg-danger-subtle p-2 text-xs font-medium text-danger-text"
        >
          {error}
        </p>
      ) : null}

      {tasks === null ? (
        <p className="py-3 text-xs text-text-muted">Loading…</p>
      ) : tasks.length === 0 ? (
        <p className="py-3 text-xs text-text-muted">Nothing open</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {tasks.map((task) => {
            const due = dueLabel(task.due_on);
            return (
              <li key={task.id} className="flex items-start gap-3 px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={false}
                  onChange={() => complete(task)}
                  aria-label={`Mark "${task.title}" done`}
                  className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer rounded-sm accent-accent"
                />
                <div className="min-w-0 flex-1">
                  <span className="block text-xs font-medium break-words text-text">
                    {task.title}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-2">
                    <span
                      className={`text-xs tabular-nums ${
                        due.overdue ? "font-medium text-danger-text" : "text-text-muted"
                      }`}
                    >
                      {due.text}
                    </span>
                    {task.priority !== "normal" ? (
                      <StatusChip tone="outline">{task.priority}</StatusChip>
                    ) : null}
                    {task.assignee_name ? (
                      <span className="text-xs text-text-muted">{task.assignee_name}</span>
                    ) : null}
                    {!dealId && !contactId && task.deal_name ? (
                      <span className="text-xs text-text-muted">· {task.deal_name}</span>
                    ) : null}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Undated last, mirroring the API's `NULLS LAST` so an optimistic insert
 *  lands where a refetch would have put it. */
function sortByDue(rows: Task[]): Task[] {
  return [...rows].sort((a, b) => {
    if (a.due_on === b.due_on) return 0;
    if (!a.due_on) return 1;
    if (!b.due_on) return -1;
    return a.due_on < b.due_on ? -1 : 1;
  });
}
