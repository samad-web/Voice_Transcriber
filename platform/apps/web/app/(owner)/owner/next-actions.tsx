"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { Card, ErrorBanner, MonoLabel, useAlert } from "@aura/ui";
import { URGENCY_TONE, countByUrgency, localToday, prioritise } from "@/lib/next-actions";
import { useRealtime } from "@/components/realtime-provider";
import { InlineListSkeleton } from "@/components/skeletons";
import { fetchTasksAction, updateTaskAction } from "./crm-actions";
import { TaskRow } from "./task-row";
import type { Task } from "./types";

const SHOWN = 8;

/**
 * The top of the dashboard: the follow-ups to work next, in the order to work
 * them (lib/next-actions.ts), each with Done / Log call / Log message on the
 * row.
 *
 * "Mine" is every persona's default - a home page is about the person looking
 * at it. Owners and managers can flip to "Team" to see every open follow-up
 * their grants reach; the API applies the same scope either way, so a rep who
 * somehow asked for the team view would still only get their own.
 *
 * Client-fetched rather than server-rendered for one reason: "overdue" and
 * "today" are the VIEWER's calendar, which only the browser knows. Rendering
 * them on the server would use the server's date and then contradict itself on
 * hydration for anyone not in the server's timezone.
 */
export function NextActions({ canViewTeam }: { canViewTeam: boolean }) {
  const [scope, setScope] = useState<"mine" | "team">("mine");
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [today, setToday] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const alert = useAlert();

  const load = useCallback(() => {
    let cancelled = false;
    setError(null);
    void fetchTasksAction({ status: "open", mine: scope === "mine", limit: 200 }).then((result) => {
      if (cancelled) return;
      if (result.error) {
        setError(result.error);
        setTasks([]);
        return;
      }
      setTasks(result.tasks ?? []);
      setTotal(result.total ?? 0);
    });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  useEffect(() => {
    setToday(localToday());
    setTasks(null);
    return load();
  }, [load]);

  // A task assigned to you elsewhere in the console appears without a reload.
  useRealtime(["task"], load);

  const ordered = tasks && today ? prioritise(tasks, today) : [];
  const counts = tasks && today ? countByUrgency(tasks, today) : null;

  const complete = (task: Task) => {
    setTasks((prev) => (prev ?? []).filter((t) => t.id !== task.id));
    startTransition(async () => {
      const result = await updateTaskAction(task.id, { status: "done" });
      if (result.error) {
        setTasks((prev) => [task, ...(prev ?? [])]);
        await alert({ title: "Couldn't mark that done", body: result.error, tone: "danger" });
      }
    });
  };

  return (
    <Card elevated className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-baseline gap-3">
          <MonoLabel>Next actions</MonoLabel>
          <Link href="/owner/tasks" className="text-xs font-medium text-text-muted hover:text-text">
            All tasks →
          </Link>
        </div>
        {canViewTeam ? (
          <div role="group" aria-label="Whose follow-ups" className="inline-flex rounded-full border border-border-strong bg-surface p-0.5">
            {(["mine", "team"] as const).map((key) => (
              <button
                key={key}
                type="button"
                aria-pressed={scope === key}
                onClick={() => setScope(key)}
                className={`inline-flex h-7 items-center rounded-full px-3 text-xs font-medium transition-colors duration-150 ease-out ${
                  scope === key ? "bg-text text-bg" : "text-text-muted hover:text-text"
                }`}
              >
                {key === "mine" ? "Mine" : "Team"}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {counts ? (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm" aria-live="polite">
          <span className={counts.overdue > 0 ? URGENCY_TONE.overdue.text : "text-text-muted"}>
            {counts.overdue} overdue
          </span>
          <span className={counts.today > 0 ? URGENCY_TONE.today.text : "text-text-muted"}>
            {counts.today} due today
          </span>
          <span className="text-text-muted">{counts.upcoming + counts.undated} coming up</span>
        </p>
      ) : null}

      {error ? <ErrorBanner>{error}</ErrorBanner> : null}

      {tasks === null || today === null ? (
        <InlineListSkeleton rows={4} lead="check" label="Loading next actions" />
      ) : ordered.length === 0 ? (
        <p className="rounded-md border border-dashed border-border py-6 text-center text-sm text-text-muted">
          {scope === "mine" ? "Nothing waiting on you - you are clear." : "No open follow-ups on the team."}
        </p>
      ) : (
        <>
          <ul className="divide-y divide-border rounded-md border border-border">
            {ordered.slice(0, SHOWN).map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                today={today}
                showAssignee={scope === "team"}
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
          {total > SHOWN ? (
            <p className="text-xs text-text-muted">
              Showing the {SHOWN} most urgent of {total}.{" "}
              <Link href="/owner/tasks" className="font-medium text-accent-text hover:underline">
                See them all
              </Link>
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}
