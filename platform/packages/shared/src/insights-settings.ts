import { z } from "zod";

/**
 * The API-only tier's per-org knobs (migration 0195's `insights_settings`,
 * `Build docs/no-crm-api-dashboard-build-plan.md` §8.11 and §16).
 *
 * Every column in that table is NULLable with NO DEFAULT and the defaults live
 * here - the same call `org_chart_settings` (0177) and `finance_settings`
 * (0172) make, for the reason those migrations give: a DEFAULT in SQL would be
 * a second copy that quietly wins, so changing the value here would reach new
 * orgs only, which is the hardest kind of inconsistency to notice.
 */

/**
 * Who may see the leaderboard, and how much of it.
 *
 * §16's default is `own_rank`, and the choice belongs to the owner because a
 * leaderboard is a management decision, not a product one. A floor where
 * everybody can see everybody's ranking is a different workplace from one
 * where they cannot, and shipping either as a product default would be making
 * that choice on a customer's behalf.
 *
 * `hidden`   - nobody but owners, admins and managers sees any ranking.
 * `own_rank` - a telecaller sees "7th of 24" and no other row.
 * `full`     - everybody sees the whole board.
 */
export const LeaderboardVisibility = z.enum(["hidden", "own_rank", "full"]);
export type LeaderboardVisibility = z.infer<typeof LeaderboardVisibility>;

export interface InsightsSettings {
  leaderboardVisibility: LeaderboardVisibility;
  demoMode: boolean;
  staleFeedHours: number;
  coverageFloor: number;
}

export const INSIGHTS_DEFAULTS: InsightsSettings = {
  leaderboardVisibility: "own_rank",
  // §8.1's demo data is OFF by default. A dashboard that silently shows sample
  // numbers to somebody who thinks they are looking at their own floor is the
  // one failure this whole tier cannot afford, so the flag starts off and the
  // console watermarks every surface while it is on.
  demoMode: false,
  // §8.7's "data feed stopped for N hours" alert, and the point at which the
  // freshness stamp stops being a note and becomes a warning. Four hours is
  // long enough to survive a deploy on the customer's side and short enough
  // that a day's data is never silently missing.
  staleFeedHours: 4,
  // Doc 41 G2. Below this fraction of the configured weight answering, the
  // composite is suppressed rather than reported over a subset.
  coverageFloor: 0.6,
};

export const InsightsSettingsInput = z.object({
  leaderboardVisibility: LeaderboardVisibility.optional(),
  demoMode: z.boolean().optional(),
  staleFeedHours: z.number().int().min(1).max(168).optional(),
  coverageFloor: z.number().min(0.1).max(1).optional(),
});
export type InsightsSettingsInput = z.infer<typeof InsightsSettingsInput>;

/**
 * Coalesce a stored row onto the defaults.
 *
 * Takes the raw row shape rather than a parsed object so the API can hand it
 * straight from `pg` - every column nullable, every null meaning "use the
 * default", which is the whole contract of that table.
 */
export function resolveInsightsSettings(row: {
  leaderboard_visibility?: string | null;
  demo_mode?: boolean | null;
  stale_feed_hours?: number | null;
  coverage_floor?: string | number | null;
} | null): InsightsSettings {
  if (!row) return { ...INSIGHTS_DEFAULTS };
  const visibility = LeaderboardVisibility.safeParse(row.leaderboard_visibility);
  // `numeric` comes back from node-postgres as a string. Parsing it here rather
  // than at every call site is the reason this function takes the row.
  const coverage =
    row.coverage_floor === null || row.coverage_floor === undefined
      ? null
      : Number(row.coverage_floor);
  return {
    leaderboardVisibility: visibility.success ? visibility.data : INSIGHTS_DEFAULTS.leaderboardVisibility,
    demoMode: row.demo_mode ?? INSIGHTS_DEFAULTS.demoMode,
    staleFeedHours: row.stale_feed_hours ?? INSIGHTS_DEFAULTS.staleFeedHours,
    coverageFloor:
      coverage !== null && Number.isFinite(coverage) && coverage > 0 && coverage <= 1
        ? coverage
        : INSIGHTS_DEFAULTS.coverageFloor,
  };
}

/**
 * Whether a given viewer may see another person's rank.
 *
 * Kept here, next to the setting, rather than in the page: three surfaces ask
 * this question (the leaderboard, the telecaller drill-down and the API's
 * `GET /v1/leaderboard`) and three copies of it would be three chances to get
 * a telecaller a view of the whole floor their owner switched off.
 *
 * A manager always sees their own teams - that is what the role is for - and
 * the row scoping that limits them to those teams is a separate, existing
 * mechanism (`owner-scope.ts`). This function answers visibility only.
 */
export function maySeeOthersRank(settings: InsightsSettings, persona: InsightsPersona): boolean {
  if (persona === "owner" || persona === "admin" || persona === "manager") return true;
  // A developer holds API keys, not people's rankings. §3 of the spec gives
  // them "no people-level pay data"; a ranking is the same class of thing.
  if (persona === "developer") return false;
  // `telecaller`, `viewer`, and the two staff personas this console already
  // has (`sales`, `marketing`) all answer to the owner's setting. Listing them
  // rather than defaulting is why the union below is explicit: a persona added
  // to `OwnerRole` later will fail to compile here, which is the right place
  // to be asked whether it may see the floor's rankings.
  return settings.leaderboardVisibility === "full";
}

/**
 * The personas this question can be asked about.
 *
 * The spec's §3 names six roles; this console has five `owner_role` values
 * plus the `memberships.role` tier. Rather than invent a parallel role system
 * - which would make "why can't Priya see this" a question with four answers,
 * the thing `permissions.ts` refuses - the spec's roles map onto what exists:
 * Owner and Admin are the `owner` persona, Manager is `manager`, Telecaller is
 * `telecaller`, Viewer is `memberships.role = 'viewer'`, and Developer is the
 * `org_admin` tier that already governs API keys. `admin`, `developer` and
 * `viewer` are accepted here so a caller that HAS resolved one of those can
 * ask without casting.
 */
export type InsightsPersona =
  | "owner"
  | "manager"
  | "telecaller"
  | "sales"
  | "marketing"
  | "admin"
  | "developer"
  | "viewer";
