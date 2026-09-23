"use client";

import { useState } from "react";
import Link from "next/link";
import { AlertTriangle, CalendarDays, CircleDashed, Clock, MessageCircle, Phone } from "lucide-react";
import { StatusChip } from "@aura/ui";
import { URGENCY_TONE, dueText, urgencyOf, type Urgency } from "@/lib/next-actions";
import { QuickLog, logParentFor } from "./quick-log";
import type { Interaction, Task } from "./types";

const URGENCY_ICON: Record<Urgency, typeof Clock> = {
  overdue: AlertTriangle,
  today: Clock,
  upcoming: CalendarDays,
  undated: CircleDashed,
};

/**
 * One follow-up, with what you would do about it one tap away: tick it done,
 * log the call, log the message.
 *
 * Shared by the dashboard's Next actions and the task lists on records and the
 * Tasks page, so "overdue" looks and reads the same wherever a task appears
 * (the tones live in lib/next-actions.ts, in one table).
 *
 * `today` comes from the parent, computed once per render on the WORKSPACE's
 * calendar (workspaceToday in lib/next-actions.ts), so every row agrees on
 * what day it is - and agrees with the API's overdue count.
 */
export function TaskRow({
  task,
  today,
  showRecord = true,
  showAssignee = false,
  onComplete,
  onLogged,
  selection,
}: {
  task: Task;
  today: string;
  /** Link to the contact/deal - off inside that record's own page. */
  showRecord?: boolean;
  showAssignee?: boolean;
  onComplete: (task: Task) => void;
  onLogged: (result: { completed: boolean; interaction?: Interaction; next?: Task }) => void;
  /**
   * Selecting for a bulk action (the Tasks list's "Select" mode). The Done
   * checkbox becomes a selection checkbox and the log actions step aside, so
   * one tick can never mean two different things in the same row.
   */
  selection?: { selected: boolean; onToggle: () => void };
}) {
  const [mode, setMode] = useState<"call" | "message" | null>(null);
  const isOpen = task.status === "open";
  // A finished task is not urgent; it keeps the neutral rail whatever its date.
  const urgency = isOpen ? urgencyOf(task, today) : "undated";
  const tone = URGENCY_TONE[urgency];
  const Icon = URGENCY_ICON[urgency];
  const canLog = Boolean(logParentFor(task)) && isOpen && !selection;
  const recordHref = task.contact_id
    ? `/owner/contacts/${task.contact_id}`
    : task.deal_id
      ? `/owner/deals?focus=${task.deal_id}`
      : task.account_id
        ? `/owner/accounts/${task.account_id}`
        : null;
  const recordName = task.contact_name ?? task.deal_name ?? null;

  const actionButton = (next: "call" | "message", label: string, ActionIcon: typeof Phone) => (
    <button
      type="button"
      onClick={() => setMode((m) => (m === next ? null : next))}
      aria-expanded={mode === next}
      disabled={!canLog}
      title={canLog ? undefined : "Link this follow-up to a contact or deal to log against it"}
      // 40px on a phone (a thumb, often on a moving floor), 32px beside a cursor.
      className={`inline-flex h-10 items-center justify-center gap-1.5 rounded-full border px-4 text-sm font-medium whitespace-nowrap sm:h-8 sm:px-3 sm:text-xs transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-50 ${
        mode === next
          ? "border-transparent bg-text text-bg"
          : "border-border-strong bg-surface text-text hover:bg-surface-hover"
      }`}
    >
      <ActionIcon aria-hidden="true" className="h-4 w-4 shrink-0 sm:h-3.5 sm:w-3.5" />
      {/* A short word on a phone, where the pair shares one row; the full
          label beside a cursor. The accessible name is the full label either way. */}
      <span className="sm:hidden" aria-hidden="true">
        {label.replace(/^Log /, "").replace(/^./, (c) => c.toUpperCase())}
      </span>
      <span className="sr-only sm:not-sr-only">{label}</span>
    </button>
  );

  return (
    <li className="relative px-3 py-3 pl-4">
      {/* The urgency rail - a second channel beside the words, never instead of them. */}
      <span aria-hidden="true" className={`absolute top-3 bottom-3 left-0 w-1 rounded-full ${tone.rail}`} />
      <div className="flex items-start gap-3">
        {selection ? (
          <input
            type="checkbox"
            checked={selection.selected}
            onChange={selection.onToggle}
            aria-label={`Select "${task.title}"`}
            className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded-sm accent-accent sm:h-4 sm:w-4"
          />
        ) : isOpen ? (
          <input
            type="checkbox"
            checked={false}
            onChange={() => onComplete(task)}
            aria-label={`Mark "${task.title}" done`}
            className="mt-0.5 h-5 w-5 shrink-0 cursor-pointer rounded-sm accent-accent sm:h-4 sm:w-4"
          />
        ) : (
          <input
            type="checkbox"
            checked={task.status === "done"}
            disabled
            aria-label={`"${task.title}" is ${task.status}`}
            className="mt-0.5 h-5 w-5 shrink-0 rounded-sm accent-accent sm:h-4 sm:w-4"
          />
        )}
        <div className="min-w-0 flex-1">
          <span className={`block text-sm font-medium break-words ${isOpen ? "text-text" : "text-text-muted line-through"}`}>
            {task.title}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 tabular-nums ${tone.chip}`}>
              <Icon aria-hidden="true" className="h-3 w-3" />
              {isOpen ? dueText(task, today) : task.status === "done" ? "Done" : "Cancelled"}
            </span>
            {task.priority === "high" ? <StatusChip tone="outline">High priority</StatusChip> : null}
            {task.priority === "low" ? <span className="text-text-subtle">Low priority</span> : null}
            {showRecord && recordHref && recordName ? (
              <Link href={recordHref} className="max-w-[14rem] truncate text-text-muted hover:text-text hover:underline">
                {recordName}
              </Link>
            ) : null}
            {showAssignee ? (
              <span className="text-text-muted">{task.assignee_name ? `· ${task.assignee_name}` : "· Unassigned"}</span>
            ) : null}
          </span>
        </div>
        {/* Wide screens: actions on the row. Narrow: below it, full-size targets.
            Not on a finished task, and not while selecting. */}
        {isOpen && !selection ? (
          <div className="hidden shrink-0 gap-1.5 sm:flex">
            {actionButton("call", "Log call", Phone)}
            {actionButton("message", "Log message", MessageCircle)}
          </div>
        ) : null}
      </div>
      {isOpen && !selection ? (
        <div className="mt-2 grid grid-cols-2 gap-2 pl-8 sm:hidden">
          {actionButton("call", "Log call", Phone)}
          {actionButton("message", "Log message", MessageCircle)}
        </div>
      ) : null}
      {mode ? (
        <div className="mt-2 sm:pl-7">
          <QuickLog
            task={task}
            mode={mode}
            onClose={() => setMode(null)}
            onDone={(result) => {
              setMode(null);
              onLogged(result);
            }}
          />
        </div>
      ) : null}
    </li>
  );
}
