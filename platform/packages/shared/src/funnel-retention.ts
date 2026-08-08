/**
 * How long an enquiry is kept, as ONE number.
 *
 * ── WHY IT LIVES IN SHARED AND NOT IN EITHER PLACE THAT USES IT ────────────
 *
 * Two things reference this and they must never disagree:
 *
 *   apps/marketing/lib/legal.ts    the PROMISE — §5 of the published privacy
 *                                  policy says "we keep it for N days"
 *   apps/worker/.../funnel-retention.ts  the ENFORCEMENT — the job that deletes
 *
 * If the promise said 365 and the job ran on 400, the privacy policy would be
 * false — and it would be false in the specific way regulators care about,
 * because a retention period is a statutory disclosure under the DPDP Act, not
 * a marketing sentence. Keeping the number in one module means the published
 * page and the DELETE statement are the same integer by construction.
 *
 * ── WHY 365 ────────────────────────────────────────────────────────────────
 *
 * The DPDP Act does not permit personal data to be kept indefinitely once its
 * purpose is exhausted, and until this job existed the marketing database had no
 * expiry at all. A year is long enough that a business which was not ready this
 * season is still reachable next season — which is the actual commercial reason
 * to keep an enquiry — and short enough to be defensible as a purpose limit.
 *
 * Changing it changes what the published policy says. That is the point.
 */
export const FUNNEL_ENQUIRY_RETENTION_DAYS = 365;

/**
 * The floor the sweep refuses to go below.
 *
 * Not a style rule. The retention constant is an ordinary number in a source
 * file, and a fat-fingered `35` → `3` would quietly delete almost every live
 * enquiry on the next tick, irreversibly, with the deletions looking exactly
 * like normal operation in the log. The job asserts against this and refuses to
 * start rather than trusting the constant.
 */
export const FUNNEL_ENQUIRY_RETENTION_FLOOR_DAYS = 30;
