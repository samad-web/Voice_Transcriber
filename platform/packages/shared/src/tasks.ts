import { z } from "zod";

/** Follow-up tasks (packages/db/migrations/0041). */

export const TaskStatus = z.enum(["open", "done", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskPriority = z.enum(["low", "normal", "high"]);
export type TaskPriority = z.infer<typeof TaskPriority>;

/** `YYYY-MM-DD`. A due date, not a due instant — see 0041's column comment. */
const DueOn = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const TaskInput = z.object({
  title: z.string().min(1).max(300),
  notes: z.string().max(10_000).nullish(),
  contactId: z.string().uuid().nullish(),
  accountId: z.string().uuid().nullish(),
  dealId: z.string().uuid().nullish(),
  assigneeUserId: z.string().uuid().nullish(),
  dueOn: DueOn.nullish(),
  priority: TaskPriority.default("normal"),
});
export type TaskInput = z.infer<typeof TaskInput>;

export const TaskUpdate = z.object({
  title: z.string().min(1).max(300).optional(),
  notes: z.string().max(10_000).nullable().optional(),
  assigneeUserId: z.string().uuid().nullable().optional(),
  dueOn: DueOn.nullable().optional(),
  priority: TaskPriority.optional(),
  status: TaskStatus.optional(),
});
export type TaskUpdate = z.infer<typeof TaskUpdate>;
