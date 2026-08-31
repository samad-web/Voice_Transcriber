import type { Metadata } from "next";
import { Card, MonoLabel } from "@aura/ui";
import { PageHeader } from "@/components/page-header";
import { ownerGet } from "@/lib/owner-context";
import { TaskList } from "../task-list";
import type { Task } from "../types";

export const metadata: Metadata = { title: "Tasks - Aura" };

/**
 * The workspace's open follow-ups (Track A3).
 *
 * The overdue count is server-rendered from its own query so the number is
 * right in the first paint - it is the one thing on this page somebody scans
 * for, and a count that arrives late reads as "nothing is overdue".
 */
export default async function TasksPage() {
  const overdue = await ownerGet<{ tasks: Task[]; total: number }>("/v1/tasks?overdue=1&limit=100");

  return (
    <>
      <PageHeader title="Tasks" context="Pipeline" />

      {overdue === null ? (
        <Card>
          <MonoLabel>Data unavailable</MonoLabel>
          <p className="mt-2 text-sm text-text-muted">
            The platform API did not answer. If this persists, contact your provider.
          </p>
        </Card>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1fr_18rem]">
          <Card>
            <TaskList title="Open tasks" />
          </Card>

          <Card>
            <MonoLabel>Overdue</MonoLabel>
            <p className="mt-2 text-3xl font-semibold text-text tabular-nums">{overdue.total}</p>
            <p className="mt-1 text-xs text-text-muted">
              {overdue.total === 0
                ? "Nothing is past its due date."
                : "Open tasks past their due date."}
            </p>
            {overdue.tasks.length > 0 ? (
              <ul className="mt-3 space-y-1.5">
                {overdue.tasks.slice(0, 8).map((task) => (
                  <li key={task.id} className="text-xs break-words text-text-muted">
                    <span className="font-medium text-danger-text tabular-nums">{task.due_on}</span>{" "}
                    {task.title}
                  </li>
                ))}
              </ul>
            ) : null}
          </Card>
        </div>
      )}
    </>
  );
}
