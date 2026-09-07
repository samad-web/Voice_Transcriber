"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Button, Card, EmptyState, StatusChip, useAlert } from "@aura/ui";
import { updateTaskAction } from "../crm-actions";
import type { FollowupCounts, Task } from "../types";

export type Bucket = "all" | "overdue" | "today" | "upcoming" | "completed";

const TABS: { key: Bucket; label: string }[] = [
  { key: "overdue", label: "Overdue" },
  { key: "today", label: "Today" },
  { key: "upcoming", label: "Upcoming" },
  { key: "all", label: "All open" },
  { key: "completed", label: "Completed" },
];

/**
 * The time on a follow-up, when it has one.
 *
 * Rendered in the VIEWER's timezone from the stored instant, which is the
 * whole reason `due_at` is an instant rather than a wall-clock string: a
 * manager in another country reading "15:00" would have no way to know whose
 * three o'clock it was.
 */
function timeLabel(dueAt: string | null): string | null {
  if (!dueAt) return null;
  return new Date(dueAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function dueLabel(task: Task, today: string): { text: string; late: boolean } {
  if (!task.due_on) return { text: "No date", late: false };
  const time = timeLabel(task.due_at);
  const suffix = time ? ` at ${time}` : "";
  if (task.status === "done") {
    // The one comparison that matters on a completed row: was it closed by the
    // day it was promised for. `completed_at` is an instant and `due_on` a
    // date, so this compares the date halves - the same rule the compliance
    // report applies server-side, kept identical so the page and the report
    // cannot disagree about who was late.
    const closedOn = task.completed_at?.slice(0, 10) ?? null;
    if (closedOn && closedOn > task.due_on) return { text: `Closed late · ${closedOn}`, late: true };
    return { text: closedOn ? `Closed ${closedOn}` : "Closed", late: false };
  }
  if (task.due_on < today) return { text: `Overdue · ${task.due_on}${suffix}`, late: true };
  if (task.due_on === today) return { text: `Due today${suffix}`, late: false };
  return { text: `Due ${task.due_on}${suffix}`, late: false };
}

/**
 * The follow-up queue: five tabs over one table.
 *
 * ── WHY THIS REPLACED THE OLD TASKS PAGE RATHER THAN JOINING IT ─────────────
 *
 * The Hawcus teardown (§3.2) found follow-ups as a separate object from tasks,
 * with its own page, its own counts and its own compliance report. Copying
 * that shape would have meant two tables holding the same kind of row and two
 * pages a person has to choose between - and "is this a task or a follow-up"
 * is a question about our schema, not about their work.
 *
 * So it is one table with a lead link (0095), and this is its queue. A row
 * with `lead_id` IS a follow-up and shows the lead it is about; a row without
 * one is still "prepare Monday's pipeline review", which 0041 was right to
 * allow. Nothing had to be migrated and no bookmark broke.
 *
 * ── THE COUNTS COME FROM THE SERVER, NOT FROM THE ROWS ──────────────────────
 *
 * Every tab shows a total the page did not compute. Counting the loaded rows
 * would silently cap at the page size, so a floor with 300 overdue follow-ups
 * would read "Overdue 100" and look like it was doing better than it is. The
 * numbers on this page are the ones somebody is judged by; they are not
 * allowed to be a side effect of pagination.
 */
export function FollowupQueue({
  initial,
  counts,
  bucket,
  today,
}: {
  initial: Task[];
  counts: FollowupCounts;
  bucket: Bucket;
  today: string;
}) {
  const [tasks, setTasks] = useState(initial);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const alert = useAlert();

  const complete = (task: Task) => {
    setPendingId(task.id);
    // Optimistic, and rolled back on failure - the same contract task-list.tsx
    // uses. A checkbox that waits for a round trip feels broken, and this is a
    // page people work down.
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    startTransition(async () => {
      const result = await updateTaskAction(task.id, { status: "done" });
      setPendingId(null);
      if (result.error) {
        setTasks((prev) => [task, ...prev]);
        await alert({ title: "Couldn't complete it", body: result.error, tone: "danger" });
      }
    });
  };

  const reopen = (task: Task) => {
    setPendingId(task.id);
    setTasks((prev) => prev.filter((t) => t.id !== task.id));
    startTransition(async () => {
      const result = await updateTaskAction(task.id, { status: "open" });
      setPendingId(null);
      if (result.error) {
        setTasks((prev) => [task, ...prev]);
        await alert({ title: "Couldn't reopen it", body: result.error, tone: "danger" });
      }
    });
  };

  return (
    <>
      <nav className="flex flex-wrap gap-1" aria-label="Follow-up buckets">
        {TABS.map((tab) => {
          const active = tab.key === bucket;
          const count = counts[tab.key];
          return (
            <Link
              key={tab.key}
              href={`/owner/tasks?bucket=${tab.key}`}
              aria-current={active ? "page" : undefined}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                active
                  ? "border-border-strong bg-surface-hover font-medium text-text"
                  : "border-border text-text-muted hover:text-text"
              }`}
            >
              {tab.label}{" "}
              <span
                className={`tabular-nums ${
                  tab.key === "overdue" && count > 0 ? "text-danger-text" : "text-text-muted"
                }`}
              >
                {count.toLocaleString()}
              </span>
            </Link>
          );
        })}
      </nav>

      {tasks.length === 0 ? (
        <EmptyState
          title={
            bucket === "overdue"
              ? "Nothing is overdue"
              : bucket === "today"
                ? "Nothing due today"
                : bucket === "completed"
                  ? "Nothing completed yet"
                  : "No follow-ups"
          }
          description={
            bucket === "overdue"
              ? "Every promise that has come due has been kept."
              : "Follow-ups you set against a lead or a deal show up here."
          }
        />
      ) : (
        <ul className="space-y-2">
          {tasks.map((task) => {
            const due = dueLabel(task, today);
            return (
              <li key={task.id}>
                <Card className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-text">{task.title}</span>
                      {task.priority === "high" ? (
                        <StatusChip tone="danger">High</StatusChip>
                      ) : null}
                      {/* The escalation count, shown only once it means
                          something. "Chased 3 times" is a fact about the
                          follow-up that no due date carries, and it is the
                          number a manager acts on. */}
                      {task.reminders_sent > 1 ? (
                        <StatusChip tone="outline">Chased {task.reminders_sent}×</StatusChip>
                      ) : null}
                    </div>
                    <p className="text-xs">
                      <span className={due.late ? "text-danger-text" : "text-text-muted"}>
                        {due.text}
                      </span>
                      {task.assignee_name ? (
                        <span className="text-text-muted"> · {task.assignee_name}</span>
                      ) : (
                        <span className="text-text-muted"> · unassigned</span>
                      )}
                    </p>
                    {/* What the promise is ABOUT. A follow-up with no visible
                        subject is a line of text somebody has to remember the
                        context for, which is how a queue stops being worked. */}
                    {task.lead_id ? (
                      <p className="text-xs text-text-muted">
                        <Link
                          href={`/owner/leads/${task.lead_id}`}
                          className="underline underline-offset-2 hover:text-text"
                        >
                          {task.lead_title ?? "Lead"}
                        </Link>
                        {task.lead_stage ? ` · ${task.lead_stage}` : ""}
                      </p>
                    ) : task.deal_name ?? task.contact_name ? (
                      <p className="text-xs text-text-muted">
                        {task.deal_name ?? task.contact_name}
                      </p>
                    ) : null}
                    {task.notes ? (
                      <p className="max-w-prose text-sm leading-relaxed text-text-muted">
                        {task.notes}
                      </p>
                    ) : null}
                  </div>

                  {task.status === "done" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={pendingId === task.id}
                      onClick={() => reopen(task)}
                    >
                      Reopen
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      disabled={pendingId === task.id}
                      onClick={() => complete(task)}
                    >
                      Done
                    </Button>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
