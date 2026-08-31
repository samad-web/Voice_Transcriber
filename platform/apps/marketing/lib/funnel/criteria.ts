import {
  DEFAULT_FUNNEL_CRITERIA,
  validateCriteria,
  type FunnelCriteria,
} from "@aura/shared";
import { query } from "./db";

/**
 * The qualification rules this funnel is currently running.
 *
 * ── IT FAILS TO THE DEFAULTS, NOT TO AN ERROR ──────────────────────────────
 *
 * Every path out of here returns usable criteria. A funnel that could not
 * decide an outcome would have to either reject the submission - losing a real
 * enquiry to a database blip - or qualify everybody, which is a silent policy
 * change nobody asked for. Falling back to the rules compiled into the release
 * is the third option, and the only one where a stranger's enquiry is still
 * handled the way it was yesterday.
 *
 * The stored row is validated on the way IN (the API refuses to save anything
 * else) and again here, because a row can also be edited by hand in psql, and
 * the funnel is the wrong place to discover that somebody typed a field name
 * wrong.
 *
 * ── CACHED FOR A MINUTE ────────────────────────────────────────────────────
 *
 * These change a few times a year and are read on every step-2 submission.
 * A minute is short enough that an operator editing rules sees them take
 * effect while they are still looking at the console, and long enough that a
 * burst of traffic does not turn into a query per visitor.
 */

const TTL_MS = 60_000;

let cached: { value: FunnelCriteria; atMs: number } | null = null;

export async function loadFunnelCriteria(): Promise<FunnelCriteria> {
  if (cached && Date.now() - cached.atMs < TTL_MS) return cached.value;

  try {
    const rows = await query<{ enabled: boolean; rules: unknown }>(
      `SELECT enabled, rules FROM marketing.funnel_criteria WHERE id = 1`,
    );
    const row = rows[0];
    if (!row) {
      // Table exists but is empty - migration 0031 seeds it, so this means
      // somebody deleted the row. The defaults ARE the seed, so behaviour is
      // unchanged rather than undefined.
      cached = { value: DEFAULT_FUNNEL_CRITERIA, atMs: Date.now() };
      return DEFAULT_FUNNEL_CRITERIA;
    }

    const candidate = { enabled: row.enabled, rules: row.rules } as unknown;
    const check = validateCriteria(candidate);
    if (!check.ok) {
      console.error(`[funnel] stored criteria are invalid, using defaults: ${check.error}`);
      cached = { value: DEFAULT_FUNNEL_CRITERIA, atMs: Date.now() };
      return DEFAULT_FUNNEL_CRITERIA;
    }

    const value = candidate as FunnelCriteria;
    cached = { value, atMs: Date.now() };
    return value;
  } catch (err) {
    // Unreachable database, or migration 0031 not applied yet. Loud in the log,
    // and the funnel keeps working exactly as the release says it should.
    console.error("[funnel] could not read criteria, using defaults", err);
    return DEFAULT_FUNNEL_CRITERIA;
  }
}

/** Tests and long-lived dev servers only. */
export function resetCriteriaCacheForTests(): void {
  cached = null;
}
