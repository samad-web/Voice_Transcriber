"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { AlertTriangle, CalendarDays, CircleDashed, Clock, MessageCircle, Phone, Users } from "lucide-react";
import { Button, Input, StatusChip, useAlert } from "@aura/ui";
import { URGENCY_TONE, dueText, urgencyOf, type Urgency } from "@/lib/next-actions";
import type { AssigneeOption } from "./bulk/actions";
import { respondToTaskAction } from "./crm-actions";
import { QuickLog, logParentFor } from "./quick-log";
import { AnswerIcon, ReassignDialog } from "./task-composer";
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
  assignees,
  onChanged,
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
  /**
   * The team, when the row may hand the task to someone else. With it (and
   * `onChanged`), the row gets a Reassign button that opens the people
   * dialog - one or several teammates, each asked to accept (0135).
   */
  assignees?: AssigneeOption[] | null;
  /** The task came back changed - reassigned, accepted or declined. */
  onChanged?: (task: Task) => void;
}) {
  const [mode, setMode] = useState<"call" | "message" | null>(null);
  const [reassigning, setReassigning] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [answering, startAnswer] = useTransition();
  const alert = useAlert();
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
  // Everyone on it with their answer (0135); a row from an older API has only
  // the primary, who by definition already had it.
  const people =
    task.assignees ??
    (task.assignee_user_id
      ? [{ user_id: task.assignee_user_id, name: task.assignee_name ?? null, status: "accepted" as const }]
      : []);
  const waitingOnMe = isOpen && task.my_status === "pending" && !selection;

  const answer = (response: "accept" | "decline") =>
    startAnswer(async () => {
      const result = await respondToTaskAction(task.id, response, response === "decline" ? reason : undefined);
      if (result.error) {
        await alert({
          title: response === "accept" ? "Couldn't accept that task" : "Couldn't decline that task",
          body: result.error,
          tone: "danger",
        });
        return;
      }
      setDeclining(false);
      setReason("");
      if (result.task) onChanged?.(result.task);
    });

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
            {/* Shown on a record's own page too once there is more than the
                one accepted person to say - that is news, not repetition. */}
            {showAssignee || people.length > 1 || people.some((p) => p.status !== "accepted") ? (
              people.length === 0 ? (
                <span className="text-text-muted">· Unassigned</span>
              ) : (
                // Declined stays visible, struck through, so whoever asked can
                // see who turned it down rather than wondering where they went.
                <span className="inline-flex flex-wrap items-center gap-1" aria-label="Assigned to">
                  {people.map((p) => (
                    <span
                      key={p.user_id}
                      title={`${p.name ?? "Former member"}: ${p.status}`}
                      className={`inline-flex max-w-[11rem] items-center gap-1 rounded-full border px-2 py-0.5 ${
                        p.status === "pending"
                          ? "border-dashed border-border-strong text-text-muted"
                          : p.status === "declined"
                            ? "border-border text-text-subtle line-through"
                            : "border-border text-text-muted"
                      }`}
                    >
                      <AnswerIcon status={p.status} />
                      <span className="truncate">{p.name ?? "Former member"}</span>
                    </span>
                  ))}
                </span>
              )
            ) : null}
            {isOpen && !selection && onChanged && assignees && assignees.length > 0 ? (
              <button
                type="button"
                onClick={() => setReassigning(true)}
                aria-label={`Reassign "${task.title}"`}
                className="inline-flex h-7 items-center gap-1 rounded-full px-2 text-text-muted hover:bg-surface-hover hover:text-text"
              >
                <Users aria-hidden="true" className="h-3 w-3" />
                Reassign
              </button>
            ) : null}
          </span>
          {waitingOnMe ? (
            <div className="mt-2 rounded-md border border-border-strong bg-bg-subtle px-3 py-2">
              {declining ? (
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-[12rem] flex-1">
                    <Input
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="Reason (optional, shown to whoever asked)"
                      aria-label="Reason for declining"
                      maxLength={500}
                      autoFocus
                    />
                  </div>
                  <Button type="button" size="sm" variant="secondary" onClick={() => setDeclining(false)} disabled={answering}>
                    Back
                  </Button>
                  <Button type="button" size="sm" onClick={() => answer("decline")} loading={answering}>
                    Decline task
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-medium text-text">You&apos;ve been asked to take this on</span>
                  <span className="flex gap-2">
                    <Button type="button" size="sm" variant="secondary" onClick={() => setDeclining(true)} disabled={answering}>
                      Decline
                    </Button>
                    <Button type="button" size="sm" onClick={() => answer("accept")} loading={answering}>
                      Accept
                    </Button>
                  </span>
                </div>
              )}
            </div>
          ) : null}
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
      {reassigning && onChanged ? (
        <ReassignDialog
          task={task}
          assignees={assignees ?? null}
          open={reassigning}
          onClose={() => setReassigning(false)}
          onSaved={onChanged}
        />
      ) : null}
    </li>
  );
}
