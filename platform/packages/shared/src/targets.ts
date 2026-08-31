import { z } from "zod";

/**
 * Sales targets (PRD Layer 5, migration 0050).
 *
 * A target turns every number on the reports page from a fact into a
 * judgement: 400,000 closed is excellent or alarming depending entirely on
 * what the quarter was for.
 */

export const TargetMetric = z.enum([
  /** Money closed in the period. */
  "won_value",
  /** Deals closed in the period. */
  "won_count",
]);
export type TargetMetric = z.infer<typeof TargetMetric>;

export const SalesTargetInput = z
  .object({
    /** Absent = a team target for the whole org. */
    ownerUserId: z.string().uuid().nullish(),
    workspaceId: z.string().uuid().nullish(),
    periodStart: z.string().date(),
    periodEnd: z.string().date(),
    metric: TargetMetric.default("won_value"),
    targetValue: z.number().positive(),
    notes: z.string().max(500).nullish(),
  })
  .superRefine((target, ctx) => {
    if (target.periodEnd < target.periodStart) {
      ctx.addIssue({
        code: "custom",
        path: ["periodEnd"],
        message: "the period ends before it starts",
      });
    }
    // A count target of 2.5 deals is a typo, not a stretch goal. Caught here
    // rather than by the numeric column, which would happily store it and
    // then render "3 of 2.5".
    if (target.metric === "won_count" && !Number.isInteger(target.targetValue)) {
      ctx.addIssue({
        code: "custom",
        path: ["targetValue"],
        message: "a deal-count target has to be a whole number",
      });
    }
  });
export type SalesTargetInput = z.infer<typeof SalesTargetInput>;

export interface Attainment {
  targetId: string;
  ownerUserId: string | null;
  ownerName: string | null;
  metric: TargetMetric;
  periodStart: string;
  periodEnd: string;
  target: number;
  actual: number;
  /** actual/target, uncapped. */
  ratio: number;
  /**
   * How far through the period we are, 0-1. The number that stops a target
   * being read wrong: 40% of a quarterly number is behind in week eleven and
   * ahead in week two, and a bare percentage cannot tell those apart.
   */
  periodElapsed: number;
  /** target × periodElapsed - where a steady seller would be right now. */
  pace: number;
}

/**
 * How much of the period has passed, as of `now`.
 *
 * Inclusive of both end dates, so a one-day period is 0 at its start and 1 at
 * its end rather than dividing by zero. Clamped, because a target somebody
 * wrote for next quarter should read 0 rather than a negative number, and one
 * from last year should read 1 rather than 4.
 */
export function periodElapsed(start: string, end: string, now: Date): number {
  const from = Date.parse(`${start}T00:00:00Z`);
  // End of the last day, not its start - a period ending today is not over
  // until today is.
  const to = Date.parse(`${end}T00:00:00Z`) + 86_400_000;
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 1;

  const ratio = (now.getTime() - from) / (to - from);
  return Number(Math.min(1, Math.max(0, ratio)).toFixed(4));
}

/**
 * Is this person ahead or behind?
 *
 * Deliberately compares against PACE rather than against the whole target -
 * "62% of the way to a number with three weeks left" is not a verdict, and a
 * dashboard that colours it red teaches people to ignore the colour.
 */
export function attainmentStatus(
  ratio: number,
  elapsed: number,
): "ahead" | "on track" | "behind" | "not started" {
  if (elapsed <= 0) return "not started";
  // The whole number, banked, whatever the calendar says.
  if (ratio >= 1) return "ahead";
  if (ratio > elapsed) return "ahead";
  // A 10% band, so somebody a fraction behind pace on a Tuesday is not told
  // they are failing.
  if (ratio >= elapsed * 0.9) return "on track";
  return "behind";
}
