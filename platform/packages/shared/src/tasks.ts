import { z } from "zod";

/** Follow-up tasks (packages/db/migrations/0041). */

export const TaskStatus = z.enum(["open", "done", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskPriority = z.enum(["low", "normal", "high"]);
export type TaskPriority = z.infer<typeof TaskPriority>;

/** `YYYY-MM-DD`. A due date, not a due instant - see 0041's column comment. */
const DueOn = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

/**
 * The promised TIME, when the promise has one (migration 0095).
 *
 * Optional beside `dueOn` rather than replacing it. "Ring him back Thursday"
 * is most follow-ups and genuinely has no hour; "ring him back at 3" is the
 * one that matters on a telecalling floor and a date cannot hold it. When this
 * is set the database derives `dueOn` from it in the org's own reporting
 * timezone, so there is one authority for the day and every existing query on
 * `due_on` keeps working.
 *
 * Sent as an ISO instant, not a wall-clock time: "15:00" would be ambiguous
 * the moment anyone opens the console from another timezone, which on a
 * distributed team is the first week.
 */
const DueAt = z.string().datetime({ offset: true });

/**
 * Everyone the task is given to (migration 0135), first = the primary
 * assignee. Each of them is asked to accept; somebody giving a task to
 * themselves is not. Twenty is a team, not a broadcast - a task for the whole
 * floor is an announcement, and the bell is the wrong tool for one.
 */
const AssigneeIds = z
  .array(z.string().uuid())
  .max(20)
  .transform((ids) => [...new Set(ids)]);

export const TaskAssigneeStatus = z.enum(["pending", "accepted", "declined"]);
export type TaskAssigneeStatus = z.infer<typeof TaskAssigneeStatus>;

/** One person on a task and their answer, as the list returns it. */
export interface TaskAssignee {
  user_id: string;
  name: string | null;
  status: TaskAssigneeStatus;
}

/** An assignee's answer: `POST /v1/tasks/:id/respond`. */
export const TaskRespondInput = z.object({
  response: z.enum(["accept", "decline"]),
  /** Optional, and only kept on a decline - it is what the creator reads. */
  reason: z.string().trim().max(500).nullish(),
});
export type TaskRespondInput = z.infer<typeof TaskRespondInput>;

export const TaskInput = z.object({
  title: z.string().min(1).max(300),
  notes: z.string().max(10_000).nullish(),
  contactId: z.string().uuid().nullish(),
  accountId: z.string().uuid().nullish(),
  dealId: z.string().uuid().nullish(),
  /** The lead this is a promise about (0095). What makes a task a follow-up. */
  leadId: z.string().uuid().nullish(),
  /** One person. Kept for callers that predate 0135; `assigneeUserIds` wins when both are sent. */
  assigneeUserId: z.string().uuid().nullish(),
  assigneeUserIds: AssigneeIds.optional(),
  dueOn: DueOn.nullish(),
  dueAt: DueAt.nullish(),
  priority: TaskPriority.default("normal"),
});
export type TaskInput = z.infer<typeof TaskInput>;

export const TaskUpdate = z.object({
  title: z.string().min(1).max(300).optional(),
  notes: z.string().max(10_000).nullable().optional(),
  /** Replaces everyone on the task with this one person (or nobody). */
  assigneeUserId: z.string().uuid().nullable().optional(),
  /**
   * Replaces the whole set. People already on it keep their answer; anybody
   * new - or anybody who had declined and is being asked again - is pending.
   */
  assigneeUserIds: AssigneeIds.optional(),
  leadId: z.string().uuid().nullable().optional(),
  dueOn: DueOn.nullable().optional(),
  dueAt: DueAt.nullable().optional(),
  priority: TaskPriority.optional(),
  status: TaskStatus.optional(),
});
export type TaskUpdate = z.infer<typeof TaskUpdate>;
