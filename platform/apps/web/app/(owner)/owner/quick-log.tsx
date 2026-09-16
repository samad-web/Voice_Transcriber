"use client";

import { useState, useTransition } from "react";
import { Button, useToast } from "@aura/ui";
import { createTaskAction, logInteractionAction, updateTaskAction, type LogInteractionInput, type TimelineParent } from "./crm-actions";
import type { Interaction, Task } from "./types";

type Mode = "call" | "message";
type Outcome = NonNullable<LogInteractionInput["outcome"]>;

const OUTCOMES: { key: Outcome; label: string }[] = [
  { key: "connected", label: "Connected" },
  { key: "no_answer", label: "No answer" },
  { key: "busy", label: "Busy" },
  { key: "voicemail", label: "Voicemail" },
  { key: "wrong_number", label: "Wrong number" },
];

const CHANNELS: { key: "whatsapp" | "sms" | "email"; label: string }[] = [
  { key: "whatsapp", label: "WhatsApp" },
  { key: "sms", label: "SMS" },
  { key: "email", label: "Email" },
];

const TEXTAREA =
  "w-full resize-y rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-text " +
  "placeholder:text-text-muted hover:border-text-subtle";

/** Which record a task's activity belongs on: its contact, else its deal, else its account. */
export function logParentFor(task: Pick<Task, "contact_id" | "deal_id" | "account_id">): {
  parent: TimelineParent;
  id: string;
} | null {
  if (task.contact_id) return { parent: "contacts", id: task.contact_id };
  if (task.deal_id) return { parent: "deals", id: task.deal_id };
  if (task.account_id) return { parent: "accounts", id: task.account_id };
  return null;
}

/**
 * Log a call or a message against a follow-up's record, right where the
 * follow-up is listed - no page change, no modal.
 *
 * Closing the loop is the point, so the form does the two things that usually
 * come next in the same save: it marks the follow-up done (on by default - you
 * logged the call you were asked to make) and, if a date is picked, schedules
 * the next one on the same record with the same title.
 *
 * The call is written as a HAND-LOGGED call (see crm-actions.ts), never as a
 * recording.
 */
export function QuickLog({
  task,
  mode,
  onClose,
  onDone,
}: {
  task: Task;
  mode: Mode;
  onClose: () => void;
  /** After a successful save: whether the task was completed, the logged row, and any follow-up created. */
  onDone: (result: { completed: boolean; interaction?: Interaction; next?: Task }) => void;
}) {
  const target = logParentFor(task);
  const [outcome, setOutcome] = useState<Outcome>("connected");
  const [channel, setChannel] = useState<"whatsapp" | "sms" | "email">("whatsapp");
  const [minutes, setMinutes] = useState("");
  const [notes, setNotes] = useState("");
  const [complete, setComplete] = useState(true);
  const [nextOn, setNextOn] = useState("");
  const [pending, startTransition] = useTransition();
  const toast = useToast();

  if (!target) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-text-muted">
        This follow-up isn&apos;t linked to a contact, deal or company, so there is no record to log against.
        Open it from a contact or deal to log activity.
      </p>
    );
  }

  const save = () => {
    if (mode === "message" && !notes.trim()) {
      toast("Say what the message was about before saving it.");
      return;
    }
    startTransition(async () => {
      const input: LogInteractionInput =
        mode === "call"
          ? {
              type: "call",
              outcome,
              direction: "outgoing",
              body: notes.trim() || null,
              durationS: minutes && Number(minutes) > 0 ? Math.round(Number(minutes) * 60) : null,
            }
          : { type: channel, direction: "outgoing", body: notes.trim() };

      const logged = await logInteractionAction(target.parent, target.id, input);
      if (logged.error) {
        toast(`Couldn't log it: ${logged.error}`);
        return;
      }

      let completed = false;
      if (complete) {
        const done = await updateTaskAction(task.id, { status: "done" });
        if (done.error) toast(`Logged, but couldn't mark the follow-up done: ${done.error}`);
        else completed = true;
      }

      let next: Task | undefined;
      if (nextOn) {
        const created = await createTaskAction({
          title: task.title,
          dueOn: nextOn,
          priority: task.priority,
          contactId: task.contact_id,
          dealId: task.deal_id,
          accountId: task.account_id,
          // The next follow-up stays with whoever owned this one - a rep
          // scheduling their own callback must not orphan it.
          assigneeUserId: task.assignee_user_id,
        });
        if (created.error) toast(`Logged, but couldn't schedule the next follow-up: ${created.error}`);
        else next = created.task;
      }

      toast(mode === "call" ? "Call logged" : "Message logged");
      onDone({ completed, interaction: logged.interaction, next });
    });
  };

  // A phone is where a call gets logged - on a floor, one-handed, straight
  // after hanging up. 40px targets there, the compact row beside a cursor.
  const pill = (active: boolean) =>
    `inline-flex h-10 items-center rounded-full border px-4 text-sm font-medium sm:h-7 sm:px-3 sm:text-xs transition-colors duration-150 ease-out ${
      active
        ? "border-transparent bg-text text-bg"
        : "border-border-strong bg-surface text-text-muted hover:bg-surface-hover hover:text-text"
    }`;

  return (
    <div className="space-y-2.5 rounded-md border border-border bg-bg-subtle p-3">
      {mode === "call" ? (
        <>
          <div role="group" aria-label="How did the call go" className="flex flex-wrap gap-1.5">
            {OUTCOMES.map((o) => (
              <button key={o.key} type="button" aria-pressed={outcome === o.key} onClick={() => setOutcome(o.key)} className={pill(outcome === o.key)}>
                {o.label}
              </button>
            ))}
          </div>
          {outcome === "connected" ? (
            <label className="flex items-center gap-2 text-xs text-text-muted">
              Talked for
              <input
                type="number"
                inputMode="numeric"
                min={0}
                max={600}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                className="h-10 w-20 rounded-sm border border-border-strong bg-surface px-2 text-base text-text tabular-nums sm:h-8 sm:w-16 sm:text-sm"
              />
              minutes
            </label>
          ) : null}
        </>
      ) : (
        <div role="group" aria-label="Which channel" className="flex flex-wrap gap-1.5">
          {CHANNELS.map((c) => (
            <button key={c.key} type="button" aria-pressed={channel === c.key} onClick={() => setChannel(c.key)} className={pill(channel === c.key)}>
              {c.label}
            </button>
          ))}
        </div>
      )}

      <textarea
        rows={2}
        maxLength={20000}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder={mode === "call" ? "What was said? (optional)" : "What did you send?"}
        aria-label={mode === "call" ? "Call notes" : "Message summary"}
        className={TEXTAREA}
      />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-text-muted">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={complete} onChange={(e) => setComplete(e.target.checked)} className="h-5 w-5 accent-accent sm:h-4 sm:w-4" />
          Mark this follow-up done
        </label>
        <label className="flex items-center gap-1.5">
          Next follow-up
          <input
            type="date"
            value={nextOn}
            onChange={(e) => setNextOn(e.target.value)}
            aria-label="Next follow-up date"
            className="h-10 rounded-sm border border-border-strong bg-surface px-2 text-base text-text sm:h-8 sm:text-sm"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={save} loading={pending}>
          {mode === "call" ? "Log call" : "Log message"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {mode === "call" ? (
        <p className="text-[11px] text-text-subtle">Saved as a hand-logged call - it is not a recording.</p>
      ) : null}
    </div>
  );
}
