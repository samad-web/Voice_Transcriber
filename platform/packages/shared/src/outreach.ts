/**
 * Outreach cadences — the follow-up ladder (migration 0058).
 *
 * The ladder SCHEDULES HUMAN WORK. It does not send. Safety rule 3 says
 * nothing automated can send, and the sweep that drives this only ever moves
 * a step from 'waiting' to 'due'; a person opens the console and acts. The
 * schema it is modelled on (B2 Consultants') dispatches WhatsApp on a timer —
 * that half is deliberately absent, and the absence is the design.
 */
import { z } from "zod";

/** What a rep is being asked to do at a rung. */
export const OutreachChannel = z.enum(["call", "whatsapp", "email", "other"]);
export type OutreachChannel = z.infer<typeof OutreachChannel>;

/**
 * What ends a journey early.
 *
 * The whole value of a cadence is "chase until X, then stop" — a ladder with
 * no stop condition is just a way to annoy somebody who has already said yes.
 */
export const OutreachStopCondition = z.enum(["booked", "replied", "won", "none"]);
export type OutreachStopCondition = z.infer<typeof OutreachStopCondition>;

export const OutreachJourneyStatus = z.enum(["active", "completed", "stopped"]);
export type OutreachJourneyStatus = z.infer<typeof OutreachJourneyStatus>;

/**
 * 'skipped' is a rep saying "not doing this one" — a decision, kept.
 * 'cancelled' is the ladder stopping underneath them — not their choice, and
 * not a thing to hold against a rep's completion rate. They are different
 * facts and are stored as different words.
 */
export const OutreachStepStatus = z.enum(["waiting", "due", "done", "skipped", "cancelled"]);
export type OutreachStepStatus = z.infer<typeof OutreachStepStatus>;

export const CadenceStepInput = z.object({
  label: z.string().min(1).max(160),
  channel: OutreachChannel.default("call"),
  /**
   * Hours from when the JOURNEY started, not from the previous step.
   *
   * Anchoring to the start is what keeps a schedule stable. Chaining delays
   * means a rep who acts on step 2 three days late drags steps 3 and 4 three
   * days with them — but the enquiry did not move, and "call two hours after
   * they enquired" does not become "call two hours after I got round to it".
   */
  delayHours: z.number().min(0).max(8760).default(0),
  guidance: z.string().max(2000).nullish(),
});
export type CadenceStepInput = z.infer<typeof CadenceStepInput>;

export const CadenceInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullish(),
  stopOn: OutreachStopCondition.default("booked"),
  active: z.boolean().default(true),
  steps: z
    .array(CadenceStepInput)
    .min(1, "a cadence with no steps would enrol people and never ask for anything")
    .max(40),
});
export type CadenceInput = z.infer<typeof CadenceInput>;

/**
 * When a step falls due.
 *
 * Pure and explicit about its clock so the schedule can be asserted at exact
 * boundaries. `delayHours` is fractional-capable (0.25 = fifteen minutes),
 * which is why the arithmetic is in milliseconds rather than whole hours.
 */
export function stepDueAt(journeyStartedAt: Date, delayHours: number): Date {
  return new Date(journeyStartedAt.getTime() + Math.round(delayHours * 3_600_000));
}

/** The rungs of a cadence, materialised for a journey starting at `startedAt`. */
export function materialiseSteps(
  steps: CadenceStepInput[],
  startedAt: Date,
): Array<CadenceStepInput & { stepIndex: number; dueAt: Date }> {
  return steps.map((step, stepIndex) => ({
    ...step,
    stepIndex,
    dueAt: stepDueAt(startedAt, step.delayHours),
  }));
}

/** Statuses that mean the rung is finished with, however it ended. */
export const TERMINAL_STEP_STATUSES: readonly OutreachStepStatus[] = [
  "done",
  "skipped",
  "cancelled",
];

export function isTerminalStep(status: OutreachStepStatus): boolean {
  return TERMINAL_STEP_STATUSES.includes(status);
}

/**
 * A human sentence for why a journey stopped.
 *
 * Kept here rather than built at each call site because it is read by people
 * on the contact timeline, and three subtly different phrasings for the same
 * event is how a timeline stops being scannable.
 */
export function stopReasonFor(condition: OutreachStopCondition): string {
  switch (condition) {
    case "booked":
      return "they booked a call";
    case "replied":
      return "they replied";
    case "won":
      return "the deal was won";
    case "none":
      return "the cadence finished";
    default: {
      const never: never = condition;
      return String(never);
    }
  }
}

export const JourneyEnrolInput = z.object({
  cadenceId: z.string().uuid(),
  contactId: z.string().uuid(),
  dealId: z.string().uuid().nullish(),
  ownerUserId: z.string().uuid().nullish(),
  /**
   * Backdate the clock to when the enquiry actually arrived.
   *
   * Without this, enrolling somebody an hour after they came in restarts the
   * ladder from now, and the "message within five minutes" rung is scheduled
   * five minutes from the moment a rep got round to enrolling them — which
   * reports a speed-to-lead that never happened.
   */
  startedAt: z.coerce.date().optional(),
});
export type JourneyEnrolInput = z.infer<typeof JourneyEnrolInput>;

export const StepActInput = z
  .object({
    status: z.enum(["done", "skipped"]),
    note: z.string().max(2000).nullish(),
  })
  .strict();
export type StepActInput = z.infer<typeof StepActInput>;
