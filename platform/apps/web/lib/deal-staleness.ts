/**
 * "Nobody has touched this deal in N days" - the rule behind the stale flag on
 * the deals board and table.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────
 *
 * A deal is stale when it is still OPEN and its `last_activity_at` is at least
 * the pipeline's `stale_after_days` whole days ago. Won and lost deals are never
 * stale: nothing is owed on a closed deal, and flagging the whole Won column
 * red-handed after a week would train people to ignore the flag.
 *
 * `last_activity_at` is what every logged interaction, call and stage move
 * already bumps (interactions.controller.ts keeps it honest), so "activity"
 * here means the same thing the board sorts by.
 *
 * The threshold is per PIPELINE (migration 0106), not per person: a team
 * looking at the same board must see the same flags, and a long B2B pipeline
 * and a same-week retail one need different numbers. The API's per-column
 * `staleCount` applies the identical predicate in SQL - keep them in step.
 */

export const DEFAULT_STALE_AFTER_DAYS = 7;
export const MIN_STALE_AFTER_DAYS = 1;
export const MAX_STALE_AFTER_DAYS = 365;

const DAY_MS = 86_400_000;

/** Whole days since `iso`, floored; null for a missing or unparseable time. */
export function idleDays(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((now - then) / DAY_MS));
}

/**
 * Days idle when the deal is stale, else null - so a caller renders the flag
 * with the number it needs in one check.
 */
export function staleDays(
  deal: { status: string; last_activity_at: string | null },
  thresholdDays: number,
  now: number = Date.now(),
): number | null {
  if (deal.status !== "open") return null;
  const days = idleDays(deal.last_activity_at, now);
  return days !== null && days >= thresholdDays ? days : null;
}

/** A threshold from anywhere untrusted (a form, an older API without the column), clamped. */
export function normaliseStaleAfterDays(value: unknown): number {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return DEFAULT_STALE_AFTER_DAYS;
  return Math.min(MAX_STALE_AFTER_DAYS, Math.max(MIN_STALE_AFTER_DAYS, Math.round(n)));
}
