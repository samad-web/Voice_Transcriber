"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { Check, Clock, Plus, Search, X } from "lucide-react";
import { Button, Dialog, ErrorBanner, FormField, Input, Select } from "@aura/ui";
import { fetchAssigneeOptionsAction, type AssigneeOption } from "./bulk/actions";
import { createTaskAction, updateTaskAction } from "./crm-actions";
import type { Task } from "./types";

/**
 * The people a task can be given to, loaded once per list.
 *
 * `null` while loading, `[]` when the roster could not be read - a persona the
 * API will not show the member list to, or a failed request. Callers treat
 * both as "no picker": the task is still created, just unassigned, and the API
 * remains the control over who may be assigned what (`assertMembers` in
 * tasks.controller.ts refuses anyone outside the org).
 */
export function useAssigneeOptions(): AssigneeOption[] | null {
  const [options, setOptions] = useState<AssigneeOption[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchAssigneeOptionsAction("people").then((result) => {
      if (!cancelled) setOptions(result.options ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return options;
}

const STATUS_TEXT = { pending: "Waiting", accepted: "Accepted", declined: "Declined" } as const;

/**
 * Choose one or several teammates - a searchable checklist, not a <select
 * multiple>, which on a desktop needs Ctrl-click nobody discovers and on a
 * phone is a different control altogether.
 *
 * Order matters: the first person ticked is the PRIMARY assignee (the one
 * reminders and reports count - see migration 0135), and the picker says so.
 * `answers` shows, beside anyone already on the task, whether they have
 * accepted yet.
 */
export function PeoplePicker({
  people,
  selected,
  onChange,
  answers,
}: {
  people: AssigneeOption[] | null;
  selected: string[];
  onChange: (ids: string[]) => void;
  answers?: Map<string, keyof typeof STATUS_TEXT>;
}) {
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (people ?? []).filter((p) => !q || p.label.toLowerCase().includes(q));
  }, [people, query]);

  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);

  if (people === null) return <p className="text-sm text-text-muted">Loading your team…</p>;
  if (people.length === 0) {
    return <p className="text-sm text-text-muted">Your team list isn&apos;t available, so this task will be unassigned.</p>;
  }

  return (
    <div className="space-y-2">
      {people.length > 6 ? (
        <div className="relative">
          <Search aria-hidden="true" className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-subtle" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search people"
            aria-label="Search people"
            className="pl-9"
            autoComplete="off"
          />
        </div>
      ) : null}
      <ul
        role="group"
        aria-label="People"
        className="max-h-56 divide-y divide-border overflow-y-auto rounded-md border border-border"
      >
        {shown.map((person) => {
          const position = selected.indexOf(person.id);
          const on = position >= 0;
          const answer = answers?.get(person.id);
          return (
            <li key={person.id}>
              <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-surface-hover">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(person.id)}
                  className="h-4 w-4 shrink-0 cursor-pointer rounded-sm accent-accent"
                />
                <span className="min-w-0 flex-1 truncate text-text">{person.label}</span>
                {on && answer ? (
                  <span className="shrink-0 text-xs text-text-muted">{STATUS_TEXT[answer]}</span>
                ) : null}
                {position === 0 && selected.length > 1 ? (
                  <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-text-muted">
                    Primary
                  </span>
                ) : null}
              </label>
            </li>
          );
        })}
        {shown.length === 0 ? <li className="px-3 py-2 text-sm text-text-muted">Nobody matches “{query}”</li> : null}
      </ul>
      <p className="text-xs text-text-muted" aria-live="polite">
        {selected.length === 0
          ? "Nobody yet - it will sit in the unassigned queue."
          : `${selected.length} ${selected.length === 1 ? "person" : "people"} will be asked to accept it. You don't need to accept a task you give yourself.`}
      </p>
    </div>
  );
}

/**
 * "New task" - a button that opens the full form in a dialog.
 *
 * Replaces the inline row that used to sit above every task list: that row
 * could only hold one assignee, crowded the list on a phone, and read as a
 * search box. A dialog has room for notes and a proper people picker, and the
 * list goes back to being a list.
 *
 * Used by the Tasks page (no record) and the Follow-ups box on a contact,
 * company or deal (record ids set), exactly where the inline row was.
 */
export function NewTaskButton({
  assignees,
  dealId,
  contactId,
  accountId,
  placeholder = "e.g. Call back about the quote",
  size = "md",
  onCreated,
}: {
  assignees: AssigneeOption[] | null;
  dealId?: string;
  contactId?: string;
  accountId?: string;
  placeholder?: string;
  size?: "sm" | "md";
  onCreated: (task: Task) => void;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [dueOn, setDueOn] = useState("");
  const [priority, setPriority] = useState<"low" | "normal" | "high">("normal");
  // Kept between tasks: several follow-ups for the same people in a row is
  // the common case, and re-picking them each time is friction.
  const [people, setPeople] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const close = () => {
    if (pending) return;
    setOpen(false);
    setError(null);
  };

  const submit = () => {
    setError(null);
    if (!title.trim()) return setError("Give the task a title.");
    startTransition(async () => {
      const result = await createTaskAction({
        title: title.trim(),
        notes: notes.trim() || null,
        dueOn: dueOn || null,
        priority,
        assigneeUserIds: people,
        dealId: dealId ?? null,
        contactId: contactId ?? null,
        accountId: accountId ?? null,
      });
      if (result.error) return setError(result.error);
      if (result.task) onCreated(result.task);
      setTitle("");
      setNotes("");
      setDueOn("");
      setPriority("normal");
      setOpen(false);
    });
  };

  return (
    <>
      <Button type="button" size={size} onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" className="h-4 w-4" />
        New task
      </Button>

      <Dialog
        open={open}
        onClose={close}
        title="New task"
        description="Everyone you assign it to is asked to accept it before it counts as theirs."
        footer={
          <>
            <Button type="button" variant="secondary" onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" onClick={submit} loading={pending}>
              {people.length > 0 ? "Create and send" : "Create task"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error ? <ErrorBanner>{error}</ErrorBanner> : null}
          <FormField label="What needs doing?" name="task-title" required>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={placeholder}
              maxLength={300}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") submit();
              }}
            />
          </FormField>
          <FormField label="Notes" name="task-notes" hint="Optional - anything the person will need">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={10_000}
              className="w-full rounded-md border border-border-strong bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
          </FormField>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Due date" name="task-due" hint="Optional">
              <Input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
            </FormField>
            <FormField label="Priority" name="task-priority">
              <Select value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </Select>
            </FormField>
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-text">Assign to</legend>
            <PeoplePicker people={assignees} selected={people} onChange={setPeople} />
          </fieldset>
        </div>
      </Dialog>
    </>
  );
}

/**
 * Change who a task is with - the row's "Reassign", in the same dialog shape
 * as New task.
 *
 * Everyone already on it keeps their answer; anyone added is asked. Removing
 * somebody takes it off their list without a notification (tasks.controller.ts
 * explains why).
 */
export function ReassignDialog({
  task,
  assignees,
  open,
  onClose,
  onSaved,
}: {
  task: Task;
  assignees: AssigneeOption[] | null;
  open: boolean;
  onClose: () => void;
  onSaved: (task: Task) => void;
}) {
  const current = useMemo(() => currentPeople(task), [task]);
  const [people, setPeople] = useState<string[]>(current.map((a) => a.user_id));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Reset to the task's own set each time it opens.
  useEffect(() => {
    if (open) {
      setPeople(current.map((a) => a.user_id));
      setError(null);
    }
  }, [open, current]);

  // Somebody who has since left the team still shows, so saving does not
  // silently drop them from a task they had accepted.
  const roster = useMemo(() => {
    if (assignees === null) return null;
    const known = new Set(assignees.map((a) => a.id));
    return [
      ...assignees,
      ...current.filter((a) => !known.has(a.user_id)).map((a) => ({ id: a.user_id, label: a.name ?? "Former member", detail: null })),
    ];
  }, [assignees, current]);

  const answers = useMemo(() => new Map(current.map((a) => [a.user_id, a.status])), [current]);

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await updateTaskAction(task.id, { assigneeUserIds: people });
      if (result.error) return setError(result.error);
      if (result.task) onSaved(result.task);
      onClose();
    });
  };

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!pending) onClose();
      }}
      title="Reassign task"
      description={task.title}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" onClick={save} loading={pending}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        <PeoplePicker people={roster} selected={people} onChange={setPeople} answers={answers} />
      </div>
    </Dialog>
  );
}

/**
 * Who is on a task and still counts - declined people are shown on the row
 * but are not "on" it, so the Reassign dialog starts without them ticked.
 * Falls back to the lone primary for a row from an API that predates 0135.
 */
export function currentPeople(task: Task) {
  const list =
    task.assignees ??
    (task.assignee_user_id
      ? [{ user_id: task.assignee_user_id, name: task.assignee_name ?? null, status: "accepted" as const }]
      : []);
  return list.filter((a) => a.status !== "declined");
}

/** Accepted / waiting / declined, as a small icon beside a name. */
export function AnswerIcon({ status }: { status: keyof typeof STATUS_TEXT }) {
  const Icon = status === "accepted" ? Check : status === "declined" ? X : Clock;
  return <Icon aria-label={STATUS_TEXT[status]} className="h-3 w-3 shrink-0" />;
}
