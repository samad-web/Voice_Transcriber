import { formatDayMonth, formatTime } from "./time";
import { fillTemplate, firstNameOf, placeholdersIn } from "./message-templates";

/**
 * The message a manager gets when one of their telecallers never started a
 * shift (doc 33 follow-up) - and the ten ready-made wordings they can start
 * from.
 *
 * ── WHY THIS IS A TEMPLATE AT ALL ──────────────────────────────────────────
 *
 * Every other attendance alert is a fixed English sentence written here
 * (attendance-alerts.ts, `attendanceAlertText`). That is right for a leave
 * request, which is a form the reader is about to act on. It is wrong for an
 * absence: how a workspace talks to its own managers about a missing employee
 * is a matter of house style and, in a lot of the workspaces on this product,
 * of language - and a fixed "Samad is away" is not something a workspace can
 * soften, sharpen, or translate.
 *
 * So the wording is theirs. The TRIGGER is not: when this fires is decided by
 * the shift pattern and its grace period, not by the text.
 *
 * ── WHY THE RENDERER IS BORROWED ───────────────────────────────────────────
 *
 * `fillTemplate` (message-templates.ts) already solves the hard half: it never
 * leaves a literal brace pair on somebody's phone, and it falls back to a
 * neutral word rather than an empty string. Writing a second renderer here
 * would mean two sets of rules about what an unresolved placeholder looks
 * like, and the one that renders less often would be the one that is wrong.
 *
 * Its two OPTIONAL placeholders (meet_link, reschedule_link) are funnel ones
 * and cannot appear here - `validateAbsenceMessage` rejects any placeholder
 * not in `ABSENCE_PLACEHOLDERS` at save time - so the delete-the-sentence
 * branch never runs on these bodies.
 *
 * ── WHY THERE IS NO LINK PLACEHOLDER ───────────────────────────────────────
 *
 * The console link is appended by the sender, not written by the tenant. A
 * placeholder could be deleted while editing, and an alert with no way to get
 * to the attendance board is an alert that makes somebody go hunting. The
 * notification carries it in `link_path`; WhatsApp gets it appended.
 */

/** What each placeholder means, shown beside the editor. */
export const ABSENCE_PLACEHOLDERS: Record<string, string> = {
  name: "The telecaller's full name, as it appears on their staff profile",
  first_name: "Just their first name",
  shift: "The name of the shift they were rostered on, e.g. “Morning”",
  shift_start: "When the shift was due to begin, e.g. “9:30 am”",
  shift_end: "When the shift is due to end, e.g. “6:00 pm”",
  grace: "The grace period on that shift, in minutes, e.g. “15”",
  late_by: "How long since the shift started, e.g. “45 minutes”",
  date: "The day of the shift, e.g. “29 Sep”",
  time_now: "The time the alert was raised, e.g. “10:15 am”",
  workspace: "Your workspace name",
};

/** Longer than a WhatsApp alert needs, short enough to stay on one screen. */
export const ABSENCE_MESSAGE_MAX = 600;

/**
 * The absence alert's own WABA template, two variables: the workspace's
 * rendered message, and the link to the live board.
 *
 * Two rather than three, and the message whole rather than in pieces, because
 * the wording belongs to the tenant - there is no fixed sentence here for Meta
 * to approve the shape of. Meta review is stricter about a template that is
 * almost entirely one variable, so a workspace may have to argue for it; until
 * it is approved the alert simply stays in the console, and nothing treats
 * that as an error.
 *
 * Lives HERE, not beside `ATTENDANCE_WABA_TEMPLATE`, because that one is
 * declared twice - once in the API and once in the worker, which cannot import
 * each other. Both can import this package, so this pair cannot drift.
 */
export const ATTENDANCE_ABSENCE_WABA_TEMPLATE = "attendance_absence_alert";
export const ATTENDANCE_ABSENCE_WABA_TEMPLATE_PARAMS = 2;

/**
 * Ten wordings to start from. They differ in TONE and in LENGTH, not in
 * decoration: a manager reads these on a phone, between calls.
 *
 * None of them names a consequence, accuses anybody of anything, or asks for a
 * reason - at the moment this fires nobody knows yet why the person is not
 * there, and a bus that broke down reads exactly like a no-show. The nearest
 * any of them comes is asking whether the reader wants to check in.
 */
export const ABSENCE_MESSAGE_PRESETS: readonly { id: string; label: string; body: string }[] = [
  {
    id: "plain",
    label: "Plain",
    body: "{{name}} has not started their shift. It was due to begin at {{shift_start}} and the {{grace}}-minute grace period has now passed.",
  },
  {
    id: "brief",
    label: "Brief",
    body: "{{name}} is not active. Shift was due at {{shift_start}}.",
  },
  {
    id: "with-date",
    label: "With the date",
    body: "{{date}}: {{name}} has not checked in. Their {{shift}} shift began at {{shift_start}}.",
  },
  {
    id: "how-late",
    label: "How late they are",
    body: "{{name}} is {{late_by}} past a {{shift_start}} start and has not begun their shift.",
  },
  {
    id: "asks",
    label: "Asks you to act",
    body: "{{name}} has not begun their {{shift}} shift, due at {{shift_start}}. Would you like to check in with them?",
  },
  {
    id: "formal",
    label: "Formal",
    body: "Attendance alert for {{workspace}}: {{name}} has not reported for the {{shift}} shift beginning {{shift_start}} on {{date}}.",
  },
  {
    id: "neutral",
    label: "Neutral",
    body: "No sign of {{name}} yet. Their shift was due to start at {{shift_start}} and there has been no activity on their phone since.",
  },
  {
    id: "first-name",
    label: "First name",
    body: "{{first_name}} has not clocked in today. Shift: {{shift_start}} to {{shift_end}}.",
  },
  {
    id: "log",
    label: "Log line",
    body: "{{time_now}} - {{name}} not started. Rostered {{shift_start}} to {{shift_end}}, grace {{grace}} min.",
  },
  {
    id: "detailed",
    label: "Detailed",
    body: "{{name}} has not started their {{shift}} shift on {{date}}. It was due at {{shift_start}}, the {{grace}}-minute grace period has passed, and they are now {{late_by}} late. No check-in and no calls have been recorded.",
  },
];

/** What a workspace that has never opened the editor sends. */
export const DEFAULT_ABSENCE_MESSAGE = ABSENCE_MESSAGE_PRESETS[0]!.body;

/** "45 minutes" / "1 hour" / "2 hours 5 minutes". Never "0 minutes". */
export function humanMinutes(total: number): string {
  const mins = Math.max(1, Math.round(total));
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  const h = hours === 1 ? "1 hour" : `${hours} hours`;
  const m = rest === 1 ? "1 minute" : `${rest} minutes`;
  if (hours === 0) return m;
  return rest === 0 ? h : `${h} ${m}`;
}

export interface AbsenceMessageFacts {
  /** `telecallers.display_name`. */
  name: string;
  /** `shift_patterns.name`, when they are on a named pattern. */
  shiftName?: string | null;
  /** The shift's start and end as instants, already resolved to this date. */
  shiftStart: number;
  shiftEnd: number;
  graceMinutes: number;
  /** When the alert is being raised. */
  now: number;
  zone: string;
  /** `organizations.name`. */
  workspace?: string | null;
}

/**
 * Every placeholder gets a value, always. A blank one would reach
 * `fillTemplate`'s neutral fallback and put "there" in the middle of a
 * sentence about a shift, which reads like a bug to the manager who gets it.
 */
export function absenceMessageVars(facts: AbsenceMessageFacts): Record<string, string> {
  return {
    name: facts.name,
    first_name: firstNameOf(facts.name) ?? facts.name,
    shift: facts.shiftName?.trim() || "scheduled",
    shift_start: formatTime(facts.shiftStart, facts.zone),
    shift_end: formatTime(facts.shiftEnd, facts.zone),
    grace: String(facts.graceMinutes),
    late_by: humanMinutes((facts.now - facts.shiftStart) / 60_000),
    date: formatDayMonth(facts.shiftStart, facts.zone),
    time_now: formatTime(facts.now, facts.zone),
    workspace: facts.workspace?.trim() || "your workspace",
  };
}

/**
 * The message to send. A workspace that has not written one, or that somehow
 * stored a blank, gets the default rather than an empty WhatsApp message.
 */
export function renderAbsenceMessage(body: string | null | undefined, facts: AbsenceMessageFacts): string {
  const chosen = body?.trim() ? body : DEFAULT_ABSENCE_MESSAGE;
  return fillTemplate(chosen, absenceMessageVars(facts));
}

/**
 * Checked at SAVE time, where a person can still fix it - the same bargain
 * `validateTemplateBody` makes for the funnel. Returns the reason it cannot be
 * saved, or null.
 */
export function validateAbsenceMessage(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return "The message cannot be empty.";
  if (trimmed.length > ABSENCE_MESSAGE_MAX) {
    return `The message is ${trimmed.length} characters; the limit is ${ABSENCE_MESSAGE_MAX}.`;
  }
  const unknown = placeholdersIn(trimmed).filter((p) => !(p in ABSENCE_PLACEHOLDERS));
  if (unknown.length > 0) {
    const names = unknown.map((u) => `{{${u}}}`).join(", ");
    return `${names} ${unknown.length === 1 ? "is not a placeholder" : "are not placeholders"} you can use here.`;
  }
  /*
   * A lone brace, or an unclosed `{{name}`, would otherwise be SENT: the
   * renderer's regex simply does not match it, so it survives untouched and
   * the manager reads punctuation. Caught here instead, after the well-formed
   * placeholders have been removed from the string.
   */
  if (/[{}]/.test(trimmed.replace(/\{\{\s*[a-z_]+\s*\}\}/g, ""))) {
    return "There is a stray { or } in the message. Placeholders look like {{name}}.";
  }
  return null;
}
