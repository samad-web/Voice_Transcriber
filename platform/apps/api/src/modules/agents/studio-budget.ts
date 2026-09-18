/**
 * How many AI runs the studio may spend per organisation, per hour.
 *
 * ── WHY THE STUDIO NEEDS ITS OWN LIMIT ──────────────────────────────────────
 *
 * Every console request arrives on the admin key, and config/throttling.ts
 * skips the throttler for that key on purpose - a per-IP limit would cap the
 * whole customer console at twenty page loads a minute. So nothing stood
 * between a Test button and the AI provider's bill. That was tolerable while
 * only the platform operator could reach the studio; it is not once every
 * tenant's manager can.
 *
 * A "run" is one request that reaches a model: drafting an agent from a
 * description, testing one against a call or a conversation, or drafting a
 * reply. Background work (the pipeline, the qualification sweep) is not
 * counted - it already has its own ceilings and is not something a person can
 * click repeatedly.
 *
 * ── SHAPE ───────────────────────────────────────────────────────────────────
 *
 * A sliding window of timestamps per org, in memory. Same trade the throttler
 * makes (one API container, see throttling.ts): complete counts today, and a
 * limit that multiplies by the replica count the day the API is scaled out.
 * Losing the window on a restart gives a tenant a fresh hour, which is the
 * safe direction for a courtesy limit.
 */
export const DEFAULT_STUDIO_RUNS_PER_HOUR = 60;
const HOUR_MS = 60 * 60 * 1000;

export class StudioBudget {
  private readonly runs = new Map<string, number[]>();

  constructor(
    private readonly limit: number = Number(
      process.env.AGENT_STUDIO_RUNS_PER_HOUR ?? DEFAULT_STUDIO_RUNS_PER_HOUR,
    ),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Spend one run for `orgId`. Returns the number of minutes until a run frees
   * up when the budget is exhausted, or null when the run was granted.
   */
  take(orgId: string): number | null {
    const now = this.now();
    const recent = (this.runs.get(orgId) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= this.limit) {
      this.runs.set(orgId, recent);
      const oldest = recent[0] ?? now;
      return Math.max(1, Math.ceil((HOUR_MS - (now - oldest)) / 60_000));
    }
    recent.push(now);
    this.runs.set(orgId, recent);
    return null;
  }
}
