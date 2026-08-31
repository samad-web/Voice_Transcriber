/**
 * Workflow DRY RUN - "if this rule had been live last month, what would it
 * have done?"
 *
 * ── WHY ─────────────────────────────────────────────────────────────────
 *
 * Nobody arms an automation they cannot preview. Aura's rules move deals
 * between stages, create tasks and write custom fields on live records, and
 * the only way to find out what a rule does today is to switch it on and
 * watch. That is a bad trade on a tenant's real pipeline.
 *
 * ── PURE, AND WHY THAT MATTERS HERE ─────────────────────────────────────
 *
 * No database, no clock, no `process.env`. Every input - the rule, the
 * historical events, the instant - is handed in. The projection is therefore
 * testable at exact boundaries, and, more importantly, it CANNOT write
 * anything: a preview that could mutate a record would defeat its own purpose.
 * `server`-side code does the fetching; this file does the thinking.
 *
 * ── FIDELITY IS THE WHOLE POINT ─────────────────────────────────────────
 *
 * The walk below mirrors the worker's `processEvent()` step for step:
 * validation of conditions and actions first, then `matchesConditions()`, then
 * the actions in order. Same functions, not a re-implementation - a preview
 * that diverges from the executor is worse than none, because it is believed.
 *
 * Aura's engine makes this unusually honest. Rules are single-shot: there are
 * no waits, no branches and no enrollment state, so there is no virtual clock
 * to advance and no re-entry rules to model. And `automation_events.payload`
 * stores the subject's facts AS THEY WERE at the moment the event fired, so
 * replaying an event is replaying history rather than re-judging an old event
 * against today's record.
 *
 * ── WHAT IT CANNOT KNOW, SAID OUT LOUD ──────────────────────────────────
 *
 * Anything depending on database state at execution time. Those are returned
 * as `approximations` rather than being quietly assumed to succeed - the same
 * discipline B2 Consultants' dry run applies, and the reason its output can be
 * trusted where a bare "12 matches" could not.
 */
import {
  AutomationAction,
  AutomationConditions,
  matchesConditions,
  resolveTarget,
  dueDate,
  type AutomationSubject,
  type AutomationTrigger,
} from "./automation";

/** One historical event, as `automation_events` stores it. */
export interface DryRunEvent {
  id: string;
  trigger: AutomationTrigger;
  subjectType: string | null;
  subjectId: string | null;
  payload: AutomationSubject;
  occurredAt: Date;
}

/** The rule being previewed. May be unsaved - a preview precedes saving. */
export interface DryRunRule {
  trigger: AutomationTrigger;
  conditions: unknown;
  actions: unknown;
}

/** One action that would have run, described in the words the UI shows. */
export interface ProjectedAction {
  type: string;
  /** Human-readable summary, e.g. `create task "Call them back" due 2026-08-21`. */
  describe: string;
  /** The user the action targets, when it targets one. */
  targetUserId?: string | null;
  /** Set when the action would NOT have completed, and why. */
  blocked?: string;
}

export interface ProjectedFiring {
  eventId: string;
  subjectId: string | null;
  subjectType: string | null;
  occurredAt: Date;
  actions: ProjectedAction[];
}

export interface DryRunResult {
  /** Events considered - the whole window, matched or not. */
  eventsConsidered: number;
  /** How many the conditions matched. */
  matched: number;
  /** Every projected firing, newest first. */
  firings: ProjectedFiring[];
  /**
   * Things this projection could not determine. Never empty when an action
   * depends on live state - see the header.
   */
  approximations: string[];
  /** Set when the rule itself does not validate; nothing is projected. */
  invalid?: string;
}

/**
 * Project a rule over historical events.
 *
 * `now` is used only for relative dates (`dueInDays`), and is passed rather
 * than read so a preview rendered twice gives the same answer.
 */
export function projectDryRun(
  rule: DryRunRule,
  events: DryRunEvent[],
  now: Date,
): DryRunResult {
  // Validated exactly as processEvent() validates a stored rule, so a shape
  // the executor would reject is reported here instead of previewing happily
  // and failing at run time.
  const conditions = AutomationConditions.safeParse(rule.conditions ?? {});
  const actions = AutomationAction.array().safeParse(rule.actions ?? []);
  if (!conditions.success) {
    return empty(events.length, "conditions failed validation");
  }
  if (!actions.success) {
    return empty(events.length, "actions failed validation");
  }
  if (actions.data.length === 0) {
    return empty(events.length, "the rule has no actions");
  }

  const approximations = new Set<string>();
  const firings: ProjectedFiring[] = [];

  // Only this rule's own trigger. The caller normally filters in SQL too, but
  // a preview that silently counted another trigger's events would overstate
  // the blast radius - the one number somebody reads off this screen.
  const relevant = events.filter((e) => e.trigger === rule.trigger);

  for (const event of relevant) {
    if (!matchesConditions(conditions.data, event.payload)) continue;

    const projected: ProjectedAction[] = actions.data.map((action) =>
      describeAction(action, event.payload, now, approximations),
    );
    firings.push({
      eventId: event.id,
      subjectId: event.subjectId,
      subjectType: event.subjectType,
      occurredAt: event.occurredAt,
      actions: projected,
    });
  }

  firings.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());

  if (relevant.length < events.length) {
    approximations.add(
      `${events.length - relevant.length} event(s) in the window belong to other triggers and were ignored.`,
    );
  }
  if (relevant.length === 0) {
    approximations.add(
      "No events for this trigger in the window - the rule may be correct and simply untested. Widen the window, or check that the trigger fires at all.",
    );
  }

  return {
    eventsConsidered: relevant.length,
    matched: firings.length,
    firings,
    approximations: [...approximations],
  };
}

function describeAction(
  action: AutomationAction,
  subject: AutomationSubject,
  now: Date,
  approximations: Set<string>,
): ProjectedAction {
  switch (action.type) {
    case "create_task": {
      const target = resolveTarget(action.assignTo, subject);
      // A task with no assignee is legal - 0041 makes assignee_user_id
      // nullable so it sits in a shared queue - so this is a note, not a
      // block. Saying it matters: "assigned to the deal owner" silently
      // becoming "assigned to nobody" is the difference between a rule that
      // works and one that fills an unwatched queue.
      const where = target ? `assigned to ${target}` : "UNASSIGNED (the subject has no owner)";
      return {
        type: action.type,
        targetUserId: target,
        describe: `create task "${action.title}" due ${dueDate(action.dueInDays, now)}, ${where}`,
      };
    }

    case "notify": {
      const target = resolveTarget(action.target, subject);
      if (!target) {
        // notify has nobody to write to. The executor drops it; the preview
        // must say so rather than counting a notification that never lands.
        return {
          type: action.type,
          targetUserId: null,
          describe: `notify "${action.title}"`,
          blocked: "the subject has no owner to notify",
        };
      }
      return {
        type: action.type,
        targetUserId: target,
        describe: `notify ${target}: "${action.title}"`,
      };
    }

    case "add_note":
      return {
        type: action.type,
        describe: `add a note: "${truncate(action.body, 80)}"`,
      };

    case "set_custom_field":
      // The value is validated against the field's DECLARED TYPE at execution
      // time, and the definition lives in the database. A preview cannot know
      // whether "high" is a valid option for `priority`, so it says so once
      // rather than implying the write is certain.
      approximations.add(
        `set_custom_field is validated against the field definition when it runs; this preview does not check that "${action.key}" accepts "${truncate(action.value, 40)}".`,
      );
      return {
        type: action.type,
        describe: `set custom field ${action.key} = "${truncate(action.value, 40)}"`,
      };

    case "move_stage":
      // Same reasoning: the stage must exist in the deal's pipeline, which is
      // tenant data this projection never reads.
      approximations.add(
        `move_stage requires "${action.stage}" to exist in the deal's pipeline; this preview does not verify that.`,
      );
      return {
        type: action.type,
        describe: `move the deal to stage "${action.stage}"`,
      };

    default: {
      // Exhaustiveness: a new action variant added to the shared union without
      // a branch here fails the typecheck rather than silently previewing as
      // nothing.
      const never: never = action;
      return { type: "unknown", describe: String(never) };
    }
  }
}

function empty(considered: number, invalid: string): DryRunResult {
  return {
    eventsConsidered: considered,
    matched: 0,
    firings: [],
    approximations: [],
    invalid,
  };
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
