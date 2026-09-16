/**
 * "What should I do next" - the order follow-ups are worked in.
 *
 * ── THE ORDER ───────────────────────────────────────────────────────────────
 *
 *   1. OVERDUE      oldest first - the one promised longest ago is the one a
 *                   customer is most likely to have given up on - then high
 *                   priority before normal before low
 *   2. DUE TODAY    high priority first
 *   3. UPCOMING     soonest first, then priority
 *   4. NO DATE      priority, then newest - an undated task is a someday, and
 *                   it must never push a dated promise off the top of the list
 *
 * The API's own `sort=due` is "due_on ASC NULLS LAST", which is right for a
 * table and wrong for this: it puts a low-priority task that was due last week
 * above a high-priority one due today, and cannot rank inside a day at all.
 *
 * ── "TODAY" ─────────────────────────────────────────────────────────────────
 *
 * `today` is passed in as YYYY-MM-DD, never read from a clock in here. The
 * caller decides whose today - the component uses the VIEWER's local date, the
 * same one task-list.tsx has always used, so a rep in Chennai and a manager in
 * Dubai each see the day they are living in.
 */

export type Urgency = "overdue" | "today" | "upcoming" | "undated";

export interface UrgencyTask {
  due_on: string | null;
  priority: "low" | "normal" | "high";
  created_at: string;
}

const PRIORITY_RANK = { high: 0, normal: 1, low: 2 } as const;
const URGENCY_RANK: Record<Urgency, number> = { overdue: 0, today: 1, upcoming: 2, undated: 3 };

export function urgencyOf(task: { due_on: string | null }, today: string): Urgency {
  if (!task.due_on) return "undated";
  if (task.due_on < today) return "overdue";
  if (task.due_on === today) return "today";
  return "upcoming";
}

export function prioritise<T extends UrgencyTask>(tasks: readonly T[], today: string): T[] {
  return [...tasks].sort((a, b) => {
    const ua = urgencyOf(a, today);
    const ub = urgencyOf(b, today);
    if (ua !== ub) return URGENCY_RANK[ua] - URGENCY_RANK[ub];
    if (ua === "overdue" || ua === "upcoming") {
      if (a.due_on !== b.due_on) return (a.due_on ?? "") < (b.due_on ?? "") ? -1 : 1;
    }
    const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (byPriority !== 0) return byPriority;
    return a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0;
  });
}

/** Whole days between two YYYY-MM-DD dates (b - a), calendar-exact, no timezone involved. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** "Overdue by 3 days" / "Due today" / "Due tomorrow" / "Due in 5 days" / "No due date". */
export function dueText(task: { due_on: string | null }, today: string): string {
  const urgency = urgencyOf(task, today);
  if (urgency === "undated" || !task.due_on) return "No due date";
  if (urgency === "today") return "Due today";
  const days = daysBetween(today, task.due_on);
  if (urgency === "overdue") return `Overdue by ${-days} day${days === -1 ? "" : "s"}`;
  return days === 1 ? "Due tomorrow" : `Due in ${days} days`;
}

export function countByUrgency(tasks: readonly { due_on: string | null }[], today: string): Record<Urgency, number> {
  const counts: Record<Urgency, number> = { overdue: 0, today: 0, upcoming: 0, undated: 0 };
  for (const task of tasks) counts[urgencyOf(task, today)] += 1;
  return counts;
}

/**
 * THE colour decision for follow-ups, in one place.
 *
 *   overdue   red (the danger ramp) - what the console already used for late
 *             tasks on the dashboard, the task list and the Tasks page
 *   today     amber (the warning ramp)
 *   upcoming  neutral
 *   undated   neutral, quieter
 *
 * Never colour alone: every tone also has an icon and a word in the component.
 * Red here is the one exception the console's colour rule (@aura/ui's
 * state.tsx - red = a missed call) already carried for late follow-ups; to take
 * it back to neutral, change `overdue` below and nothing else.
 */
export const URGENCY_TONE: Record<Urgency, { text: string; chip: string; rail: string; label: string }> = {
  overdue: {
    label: "Overdue",
    text: "text-danger-text font-semibold",
    // Outlined, not a tinted fill: a danger-subtle fill with danger-text is the
    // missed-call STATE chip (console-palette.test.ts forbids re-implementing
    // it), and an overdue task must not read as a missed call at a glance.
    chip: "border-danger-text/40 bg-surface text-danger-text",
    rail: "bg-danger",
  },
  today: {
    label: "Due today",
    text: "text-warning-text font-medium",
    chip: "border-transparent bg-warning-subtle text-warning-text",
    rail: "bg-warning",
  },
  upcoming: {
    label: "Upcoming",
    text: "text-text-muted",
    chip: "border-border bg-surface text-text-muted",
    rail: "bg-border-strong",
  },
  undated: {
    label: "No date",
    text: "text-text-subtle",
    chip: "border-border bg-surface text-text-subtle",
    rail: "bg-border",
  },
};

/** Today in the viewer's own timezone, as YYYY-MM-DD. Client-side only - see the header. */
/** `YYYY-MM-DD` shifted by whole days - calendar arithmetic, no timezone involved. */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The Tasks list's "Due" filter. */
export const DUE_WINDOWS = ["overdue", "today", "week", "later", "none"] as const;
export type DueWindow = (typeof DUE_WINDOWS)[number];

export const DUE_WINDOW_LABEL: Record<DueWindow, string> = {
  overdue: "Overdue",
  today: "Due today",
  week: "Next 7 days",
  later: "Later",
  none: "No due date",
};

/**
 * The API query for a due window, in the VIEWER's calendar: `today` is the
 * browser's date (localToday), so "Due today" means the rep's today even when
 * the server's midnight has already passed. The same buckets urgencyOf draws,
 * so a filtered list and the row colours can never disagree about a task.
 */
export function dueWindowQuery(
  window: DueWindow,
  today: string,
): { dueFrom?: string; dueTo?: string; undated?: true } {
  switch (window) {
    case "overdue":
      return { dueTo: addDays(today, -1) };
    case "today":
      return { dueFrom: today, dueTo: today };
    case "week":
      return { dueFrom: today, dueTo: addDays(today, 6) };
    case "later":
      return { dueFrom: addDays(today, 7) };
    case "none":
      return { undated: true };
  }
}

export function localToday(now: Date = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}
