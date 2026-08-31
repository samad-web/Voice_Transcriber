import { z } from "zod";

/**
 * Workflow automation (PRD Layer 2) - "when X happens, do Y".
 *
 * ── WHAT THIS FILE IS, AND IS NOT ─────────────────────────────────────────
 *
 * The PURE half: what a rule looks like, whether a rule matches a thing that
 * happened, and what it would do about it. No database, no network, no clock
 * beyond what is handed in. That split exists because the executing half runs
 * in the worker while the enqueueing half runs in the API, and a rule engine
 * whose two halves disagree about what "amount is at least 10,000" means is
 * worse than no rule engine.
 *
 * ── THE ACTION LIST IS DELIBERATELY SHORT ─────────────────────────────────
 *
 * There is no send-an-email action, and that is not an oversight. Outbound
 * mail reaches a person who never asked to be in this CRM and cannot be
 * recalled; a rule that misfires at 3am against 400 contacts is a different
 * kind of incident from a rule that creates 400 tasks. Every action below is
 * reversible and stays inside the console. Sending stays where B4 put it: one
 * message, composed by a person, who confirmed the address.
 */

export const AutomationTrigger = z.enum([
  /** A deal was created - by hand, or projected from a call. */
  "deal.created",
  /** A deal moved between stages. */
  "deal.stage_changed",
  /** A deal has had no activity for a while. Produced by the worker sweep. */
  "deal.idle",
  /** A task passed its due date without being completed. Worker sweep. */
  "task.overdue",
  /** Something landed on a timeline - a call, an email, a note. */
  "interaction.logged",
  /** A contact was created. */
  "contact.created",
  /** A call's AI read flagged a compliance/escalation risk (0069). Enqueued
   *  by the worker pipeline once the call's lead/deal has resolved, so
   *  `notify`'s deal_owner/contact_owner target has something to resolve. */
  "call.risk_flagged",
  /** A promised callback (outreach_journey_steps.due_at) passed unactioned.
   *  Produced by the worker sweep, same shape as task.overdue. */
  "outreach_step.overdue",
]);
export type AutomationTrigger = z.infer<typeof AutomationTrigger>;

/** Triggers a person cannot cause directly - the sweep produces them. */
export const SWEEP_TRIGGERS: AutomationTrigger[] = [
  "deal.idle",
  "task.overdue",
  "outreach_step.overdue",
];

/**
 * Conditions, as data rather than an expression language.
 *
 * A DSL here would need a parser, a sandbox and a story about what happens
 * when a tenant writes an infinite loop into a text box. These cover what
 * rules are actually written about, and every one of them is a field
 * comparison somebody can see in the UI without learning a syntax.
 */
export const AutomationConditions = z.object({
  /** Deal is in one of these stages. */
  stage: z.array(z.string().max(40)).max(20).optional(),
  /** Deal moved INTO one of these stages - stage_changed only. */
  toStage: z.array(z.string().max(40)).max(20).optional(),
  /** Deal moved OUT OF one of these stages - stage_changed only. */
  fromStage: z.array(z.string().max(40)).max(20).optional(),
  status: z.array(z.enum(["open", "won", "lost"])).max(3).optional(),
  amountGte: z.number().optional(),
  amountLte: z.number().optional(),
  /** interaction.logged only - call | email | note | meeting … */
  interactionType: z.array(z.string().max(40)).max(10).optional(),
  /** deal.idle / task.overdue - how stale before it counts. */
  idleDays: z.number().int().min(1).max(365).optional(),
  /** call.risk_flagged only - only match flags at or above this severity. */
  riskSeverity: z.array(z.enum(["low", "medium", "high"])).max(3).optional(),
  /** outreach_step.overdue only - hour-scale grace period, distinct from
   *  idleDays' day-scale (a promised callback is missed in hours, not days). */
  graceHours: z.number().int().min(1).max(168).optional(),
});
export type AutomationConditions = z.infer<typeof AutomationConditions>;

/** Who an action is aimed at, resolved against the subject at run time. */
export const ActionTarget = z.union([
  z.literal("deal_owner"),
  z.literal("contact_owner"),
  z.literal("task_assignee"),
  /** outreach_step.overdue only - the outreach journey's own owner, a
   *  different person than a deal's or contact's owner. */
  z.literal("journey_owner"),
  z.string().uuid(),
]);
export type ActionTarget = z.infer<typeof ActionTarget>;

export const AutomationAction = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create_task"),
    title: z.string().min(1).max(200),
    notes: z.string().max(2000).nullish(),
    /** Relative, because a rule is written once and fires for months. */
    dueInDays: z.number().int().min(0).max(365).default(1),
    priority: z.enum(["low", "normal", "high"]).default("normal"),
    assignTo: ActionTarget.default("deal_owner"),
  }),
  z.object({
    type: z.literal("notify"),
    target: ActionTarget.default("deal_owner"),
    title: z.string().min(1).max(200),
    body: z.string().max(1000).nullish(),
  }),
  z.object({
    type: z.literal("add_note"),
    body: z.string().min(1).max(2000),
  }),
  z.object({
    type: z.literal("set_custom_field"),
    key: z.string().min(1).max(64),
    /** Validated against the field's declared type when it is written. */
    value: z.string().max(1000),
  }),
  /**
   * Moving a deal is included because "when it goes quiet for 30 days, drop
   * it back to Nurture" is a real rule people write. It cannot cause a loop:
   * the executor never enqueues events for its own writes - see the module
   * header in the worker's automation.ts.
   */
  z.object({
    type: z.literal("move_stage"),
    stage: z.string().min(1).max(40),
  }),
]);
export type AutomationAction = z.infer<typeof AutomationAction>;

export const AutomationRuleInput = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).nullish(),
    trigger: AutomationTrigger,
    conditions: AutomationConditions.default({}),
    actions: z.array(AutomationAction).min(1).max(10),
    status: z.enum(["active", "paused"]).default("active"),
  })
  .superRefine((rule, ctx) => {
    // A stage condition that can never be true is a rule that silently does
    // nothing, which is the worst failure mode an automation can have - it
    // looks configured and it is not.
    if (rule.trigger !== "deal.stage_changed" && (rule.conditions.toStage || rule.conditions.fromStage)) {
      ctx.addIssue({
        code: "custom",
        path: ["conditions"],
        message: "toStage/fromStage only mean anything on a stage-change trigger",
      });
    }
    if (rule.trigger !== "interaction.logged" && rule.conditions.interactionType) {
      ctx.addIssue({
        code: "custom",
        path: ["conditions", "interactionType"],
        message: "interactionType only means anything on an interaction trigger",
      });
    }
    if (rule.trigger !== "call.risk_flagged" && rule.conditions.riskSeverity) {
      ctx.addIssue({
        code: "custom",
        path: ["conditions", "riskSeverity"],
        message: "riskSeverity only means anything on the call.risk_flagged trigger",
      });
    }
    if (rule.trigger !== "outreach_step.overdue" && rule.conditions.graceHours !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["conditions", "graceHours"],
        message: "graceHours only means anything on the outreach_step.overdue trigger",
      });
    }
    // Every action needs a subject to hang off. A rule triggered by a contact
    // has no deal, so a move_stage on it could never run.
    if (rule.trigger === "contact.created") {
      const dealOnly = rule.actions.find((a) => a.type === "move_stage");
      if (dealOnly) {
        ctx.addIssue({
          code: "custom",
          path: ["actions"],
          message: "a contact trigger has no deal to move",
        });
      }
    }
  });
export type AutomationRuleInput = z.infer<typeof AutomationRuleInput>;

/**
 * The facts about the thing that happened, flattened. Built by whoever
 * enqueued the event, so matching never needs a database.
 */
export interface AutomationSubject {
  dealId?: string | null;
  contactId?: string | null;
  accountId?: string | null;
  taskId?: string | null;
  stage?: string | null;
  fromStage?: string | null;
  toStage?: string | null;
  status?: string | null;
  amount?: number | null;
  interactionType?: string | null;
  idleDays?: number | null;
  dealOwnerUserId?: string | null;
  contactOwnerUserId?: string | null;
  taskAssigneeUserId?: string | null;
  /** call.risk_flagged only - the highest severity among the call's flags. */
  riskSeverity?: string | null;
  /** outreach_step.overdue only - how many hours past due_at. */
  overdueHours?: number | null;
  /** outreach_step.overdue only - the outreach journey's own owner. */
  journeyOwnerUserId?: string | null;
}

/**
 * Does this rule apply?
 *
 * Every condition is ANDed, and an ABSENT condition matches everything -
 * which is the behaviour people expect from a form where they filled in two
 * of six boxes. A present condition the subject has no value for does NOT
 * match: "amount at least 10,000" should not fire on a deal with no amount,
 * because nobody writing that rule meant "or unknown".
 */
export function matchesConditions(
  conditions: AutomationConditions,
  subject: AutomationSubject,
): boolean {
  const inList = (list: string[] | undefined, value: string | null | undefined): boolean => {
    if (!list || list.length === 0) return true;
    return value !== null && value !== undefined && list.includes(value);
  };

  if (!inList(conditions.stage, subject.stage)) return false;
  if (!inList(conditions.toStage, subject.toStage)) return false;
  if (!inList(conditions.fromStage, subject.fromStage)) return false;
  if (!inList(conditions.status, subject.status)) return false;
  if (!inList(conditions.interactionType, subject.interactionType)) return false;
  if (!inList(conditions.riskSeverity, subject.riskSeverity)) return false;

  if (conditions.amountGte !== undefined) {
    if (subject.amount === null || subject.amount === undefined) return false;
    if (subject.amount < conditions.amountGte) return false;
  }
  if (conditions.amountLte !== undefined) {
    if (subject.amount === null || subject.amount === undefined) return false;
    if (subject.amount > conditions.amountLte) return false;
  }
  if (conditions.idleDays !== undefined) {
    if (subject.idleDays === null || subject.idleDays === undefined) return false;
    if (subject.idleDays < conditions.idleDays) return false;
  }
  if (conditions.graceHours !== undefined) {
    if (subject.overdueHours === null || subject.overdueHours === undefined) return false;
    if (subject.overdueHours < conditions.graceHours) return false;
  }
  return true;
}

/** Which user an action is for, or null when the subject has nobody to name. */
export function resolveTarget(target: ActionTarget, subject: AutomationSubject): string | null {
  switch (target) {
    case "deal_owner":
      return subject.dealOwnerUserId ?? null;
    case "contact_owner":
      return subject.contactOwnerUserId ?? null;
    case "task_assignee":
      return subject.taskAssigneeUserId ?? null;
    case "journey_owner":
      return subject.journeyOwnerUserId ?? null;
    default:
      return target;
  }
}

/**
 * `dueInDays` as a `YYYY-MM-DD` date.
 *
 * Built from an explicit `now` rather than reading the clock, so it is
 * testable - and computed in UTC deliberately: `tasks.due_on` is a date
 * column, and deriving it from a server's local midnight is exactly the bug
 * that made every due date read a day early on this platform once already.
 */
export function dueDate(dueInDays: number, now: Date): string {
  const due = new Date(now.getTime() + dueInDays * 86_400_000);
  return due.toISOString().slice(0, 10);
}
