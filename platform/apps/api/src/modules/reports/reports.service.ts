import { Injectable } from "@nestjs/common";
import { parsePipelineStages, type PipelineStage } from "@aura/shared";
import { DbService } from "../../db/db.service";
import { furthestOpenStage } from "../crm-objects/stage-history";
import { UNSCOPED, scopeClause, type CrmRecordScope } from "../../common/crm-scope";

/**
 * The three Layer 3 reports, as data. Split out of the controller because
 * each one is rendered twice — as JSON and as CSV — and the two must never
 * be allowed to disagree about what the numbers are.
 */

export interface PipelineRow {
  stage: string;
  label: string;
  probability: number;
  deals: number;
  amount: number;
  weightedAmount: number;
  avgDaysInStage: number | null;
}

/**
 * Deliberately carries no per-rep task or interaction counts.
 *
 * A rep is a `telecallers` row (what the call pipeline stamps on a deal); a
 * task assignee and an interaction actor are `users` rows (who acted in the
 * console). Nothing maps between the two today. Columns joining them would
 * have to be either invented or always zero, and an always-zero "Tasks
 * completed" column against a real person's name reads as "this rep did
 * nothing" — worse than not answering. Those totals are reported at workspace
 * level, where they are true.
 */
export interface PerformanceRow {
  repId: string | null;
  rep: string;
  openDeals: number;
  wonDeals: number;
  lostDeals: number;
  openValue: number;
  wonValue: number;
  winRate: number | null;
}

export interface ConversionRow {
  stage: string;
  label: string;
  reached: number;
  conversionFromPrevious: number | null;
}

/**
 * One (plan, rep) pair — a plan applies org-wide, so a rep with activity
 * under more than one active plan gets one row per plan rather than a single
 * blended number nobody could audit back to a rate.
 *
 * `metricTotal` is read off the SAME identity axis `performance()` uses:
 * `deals.telecaller_id` for `won_value`/`won_count`, `calls.telecaller_id`
 * for `calls` — never `devices.telecaller_id` (today's holder, wrong for a
 * commission a person earned while they held the phone) or `owner_user_id`
 * (a different axis entirely, belonging to `sales_targets`).
 */
export interface CommissionRow {
  planId: string;
  planName: string;
  metric: CommissionMetric;
  rateType: CommissionRateType;
  rate: number;
  repId: string | null;
  rep: string;
  metricTotal: number;
  commission: number;
}

export type CommissionMetric = "won_value" | "won_count" | "calls";
export type CommissionRateType = "percent" | "flat_per_unit";

/**
 * How likely a deal in this stage is to close, 0-1.
 *
 * Derived from the stage's POSITION rather than configured per stage: the
 * `stages` jsonb (shared with organizations.lead_stages) has no probability
 * field today, and adding one is a schema change to a structure the legacy
 * lead board also reads. Positional weighting is the standard default anyway
 * — a deal one step from the close is worth more than one that just arrived —
 * and a `probability` key can be honoured here later without a migration,
 * because the column is jsonb.
 *
 * Terminal stages are certainties, not estimates: won is 1, lost is 0.
 */
export function stageProbability(stages: PipelineStage[], index: number): number {
  const stage = stages[index];
  if (stage?.terminal === "won") return 1;
  if (stage?.terminal === "lost") return 0;

  const open = stages.filter((s) => !s.terminal);
  const position = open.findIndex((s) => s.key === stage?.key);
  if (position < 0) return 0;
  return Number(((position + 1) / (open.length + 1)).toFixed(4));
}

@Injectable()
export class ReportsService {
  constructor(private readonly db: DbService) {}

  /**
   * Current pipeline snapshot: what is open, what it is worth, and what it is
   * worth once discounted by how likely each stage is to close.
   *
   * A snapshot of NOW, deliberately un-windowed — "my pipeline over the last
   * 30 days" is not a thing anyone means. The time-bounded questions are
   * `conversion` and `performance`.
   */
  async pipeline(orgId: string, pipelineId?: string, recordScope: CrmRecordScope = UNSCOPED) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows: pipelines } = await client.query<{ id: string; name: string; stages: unknown }>(
        `SELECT id, name, stages FROM deal_pipelines
          WHERE status = 'active' AND ($1::uuid IS NULL OR id = $1::uuid)
          ORDER BY is_default DESC, created_at ASC`,
        [pipelineId ?? null],
      );
      if (pipelines.length === 0) return { pipeline: null, rows: [], totals: emptyTotals() };

      const target = pipelines[0];
      const stages = parsePipelineStages(target.stages);

      const { rows: counts } = await client.query<{
        stage: string;
        deals: string;
        amount: string | null;
        avg_days: string | null;
      }>(
        `SELECT stage,
                count(*)                                              AS deals,
                COALESCE(sum(amount), 0)                              AS amount,
                avg(EXTRACT(EPOCH FROM (now() - stage_changed_at)) / 86400) AS avg_days
           FROM deals
          WHERE pipeline_id = $1 AND status = 'open' ${ownedDeals(recordScope, 2)}
          GROUP BY stage`,
        scopedParams([target.id], recordScope),
      );
      const byStage = new Map(counts.map((c) => [c.stage, c]));

      // Driven by the pipeline's stage LIST, not by what the deals table
      // happens to contain, so an empty stage renders as a real zero rather
      // than vanishing from the board's forecast.
      const rows: PipelineRow[] = stages
        .filter((s) => !s.terminal)
        .map((stage) => {
          const hit = byStage.get(stage.key);
          const amount = Number(hit?.amount ?? 0);
          const probability = stageProbability(stages, stages.indexOf(stage));
          return {
            stage: stage.key,
            label: stage.label,
            probability,
            deals: Number(hit?.deals ?? 0),
            amount,
            weightedAmount: Number((amount * probability).toFixed(2)),
            avgDaysInStage: hit?.avg_days ? Number(Number(hit.avg_days).toFixed(1)) : null,
          };
        });

      const {
        rows: [velocity],
      } = await client.query<{ avg_days: string | null; won: string }>(
        `SELECT avg(EXTRACT(EPOCH FROM (stage_changed_at - created_at)) / 86400) AS avg_days,
                count(*) AS won
           FROM deals
          WHERE pipeline_id = $1 AND status = 'won' ${ownedDeals(recordScope, 2)}`,
        scopedParams([target.id], recordScope),
      );

      return {
        pipeline: { id: target.id, name: target.name },
        rows,
        totals: {
          deals: rows.reduce((sum, r) => sum + r.deals, 0),
          amount: Number(rows.reduce((sum, r) => sum + r.amount, 0).toFixed(2)),
          weightedAmount: Number(rows.reduce((sum, r) => sum + r.weightedAmount, 0).toFixed(2)),
          wonDeals: Number(velocity?.won ?? 0),
          avgDaysToWin: velocity?.avg_days ? Number(Number(velocity.avg_days).toFixed(1)) : null,
        },
      };
    });
  }

  /**
   * Per-rep activity and outcomes over a window.
   *
   * Attributed on `deals.telecaller_id` — the write-once field the pipeline
   * already stamps — rather than `owner_user_id`, which is nullable and which
   * nothing currently sets. Tasks and interactions attribute to the platform
   * user instead, because those are console actions rather than call activity;
   * the two are reported side by side rather than being forced into one
   * identity the data does not actually share.
   */
  async performance(
    orgId: string,
    from: string,
    to: string,
    recordScope: CrmRecordScope = UNSCOPED,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<Record<string, string | null>>(
        `WITH deal_stats AS (
           SELECT d.telecaller_id AS rep_id,
                  count(*) FILTER (WHERE d.status = 'open')  AS open_deals,
                  count(*) FILTER (WHERE d.status = 'won')   AS won_deals,
                  count(*) FILTER (WHERE d.status = 'lost')  AS lost_deals,
                  COALESCE(sum(d.amount) FILTER (WHERE d.status = 'open'), 0) AS open_value,
                  COALESCE(sum(d.amount) FILTER (WHERE d.status = 'won'), 0)  AS won_value
             FROM deals d
            WHERE d.created_at >= $1::date AND d.created_at < ($2::date + 1)
                  ${ownedDeals(recordScope, 3, "d")}
            GROUP BY d.telecaller_id
         )
         SELECT ds.rep_id,
                COALESCE(t.display_name, 'Unassigned') AS rep,
                ds.open_deals, ds.won_deals, ds.lost_deals, ds.open_value, ds.won_value
           FROM deal_stats ds
           LEFT JOIN telecallers t ON t.id = ds.rep_id
          ORDER BY ds.won_value DESC, ds.open_value DESC`,
        scopedParams([from, to], recordScope),
      );

      // Console activity, keyed on the platform user. Kept as separate
      // queries rather than joined in: a rep is a telecaller id, a console
      // user is a user id, and there is no mapping between them today —
      // pretending otherwise would silently mis-attribute.
      const {
        rows: [taskStats],
      } = await client.query<{ completed: string; overdue: string }>(
        `SELECT count(*) FILTER (WHERE status = 'done'
                                   AND completed_at >= $1::date
                                   AND completed_at < ($2::date + 1)) AS completed,
                count(*) FILTER (WHERE status = 'open'
                                   AND due_on IS NOT NULL
                                   AND due_on < current_date)         AS overdue
           FROM tasks`,
        [from, to],
      );
      const {
        rows: [interactionStats],
      } = await client.query<{ total: string }>(
        `SELECT count(*) AS total FROM interactions
          WHERE occurred_at >= $1::date AND occurred_at < ($2::date + 1)`,
        [from, to],
      );

      const reps: PerformanceRow[] = rows.map((r) => {
        const won = Number(r.won_deals ?? 0);
        const lost = Number(r.lost_deals ?? 0);
        const decided = won + lost;
        return {
          repId: r.rep_id,
          rep: String(r.rep),
          openDeals: Number(r.open_deals ?? 0),
          wonDeals: won,
          lostDeals: lost,
          openValue: Number(r.open_value ?? 0),
          wonValue: Number(r.won_value ?? 0),
          // Undefined rather than 0 when nothing has been decided — a rep with
          // no closed deals has no win rate, and showing 0% would read as
          // "loses everything".
          winRate: decided === 0 ? null : Number((won / decided).toFixed(4)),
        };
      });

      return {
        from,
        to,
        reps,
        workspace: {
          tasksCompleted: Number(taskStats?.completed ?? 0),
          tasksOverdue: Number(taskStats?.overdue ?? 0),
          interactions: Number(interactionStats?.total ?? 0),
        },
      };
    });
  }

  /**
   * Rate × attainment for a window — a calculator, not payroll. See 0071's
   * header for the boundary this deliberately stays behind: no accrual, no
   * claw-back, no approval trail. Every active `commission_plans` row is
   * recomputed fresh against the window on every call; nothing here is
   * stored per-run, so there is nothing to reconcile when a deal unwinds —
   * the next export simply reflects the deal's current state.
   *
   * One row per (plan, rep): a plan applies org-wide, so a rep active under
   * two plans (say, a value plan and a call-volume plan) earns two rows
   * rather than one blended figure nobody could trace back to a rate.
   *
   * ── IDENTITY AXIS, SAME AS `performance()` ────────────────────────────
   *
   * `won_value`/`won_count` come off `deals.telecaller_id`, scoped by
   * `ownedDeals()` on `deals.owner_user_id` exactly as `performance()`'s
   * `deal_stats` CTE does — the permission column and the attribution
   * column are different columns on the same table, and both matter: get
   * either one wrong and this either leaks another rep's commission or pays
   * it to whoever currently holds their phone.
   *
   * `calls` comes off `calls.telecaller_id` (write-once as of 0068). It is
   * deliberately NOT filtered by `ownedDeals()` / record scope: `calls` has
   * no `owner_user_id` column, the same disconnect `performance()`'s own doc
   * comment names for tasks and interactions ("a rep is a telecaller id, a
   * console user is a user id, and there is no mapping between them
   * today"). Inventing a filter here would either fabricate a join or hide
   * every call-based plan from a scoped viewer; reporting it plainly, as
   * `performance()` does for its workspace totals, is the honest reading —
   * for a workspace-wide TOTAL, which carries no individual's number.
   *
   * This method's output is per-rep rows, not a total, and that changes the
   * calculus: with no telecaller_id-to-userId mapping there is no way to pick
   * out "the scoped viewer's own" row from a `calls`-metric plan, only
   * "every rep's" or "none" — so a scoped (`owned`) viewer gets none for that
   * metric rather than every colleague's commission amount. `won_value`/
   * `won_count` need no such carve-out; `ownedDeals()` already narrows those
   * to the viewer's own deals.
   */
  async commission(
    orgId: string,
    from: string,
    to: string,
    recordScope: CrmRecordScope = UNSCOPED,
  ): Promise<{ from: string; to: string; rows: CommissionRow[] }> {
    return this.db.withOrg(orgId, async (client) => {
      const { rows: plans } = await client.query<{
        id: string;
        name: string;
        metric: CommissionMetric;
        rate_type: CommissionRateType;
        rate: string;
      }>(
        `SELECT id, name, metric, rate_type, rate
           FROM commission_plans
          WHERE active = true
          ORDER BY name ASC`,
      );
      if (plans.length === 0) return { from, to, rows: [] };

      // Same shape as performance()'s deal_stats CTE — same ownedDeals()
      // scoping on the same owner_user_id column, same telecaller_id
      // attribution — but windowed on stage_changed_at rather than
      // created_at: performance() asks "what was created in this window",
      // while a commission window asks "what closed in it", the same
      // question targets.controller.ts's attainment query answers the same
      // way for the identical reason (a deal opened in March and won in
      // July is July's number).
      const { rows: dealStats } = await client.query<{
        rep_id: string | null;
        won_value: string;
        won_count: string;
      }>(
        `SELECT d.telecaller_id AS rep_id,
                COALESCE(sum(d.amount), 0) AS won_value,
                count(*)                   AS won_count
           FROM deals d
          WHERE d.status = 'won'
            AND d.stage_changed_at >= $1::date AND d.stage_changed_at < ($2::date + 1)
                ${ownedDeals(recordScope, 3, "d")}
          GROUP BY d.telecaller_id`,
        scopedParams([from, to], recordScope),
      );

      // Deliberately unscoped — see the doc comment above.
      const { rows: callStats } = await client.query<{ rep_id: string | null; calls: string }>(
        `SELECT c.telecaller_id AS rep_id, count(*) AS calls
           FROM calls c
          WHERE c.started_at >= $1::date AND c.started_at < ($2::date + 1)
          GROUP BY c.telecaller_id`,
        [from, to],
      );

      const dealById = new Map(dealStats.map((r) => [r.rep_id, r]));
      const callById = new Map(callStats.map((r) => [r.rep_id, r]));
      const repIds = new Set<string | null>([...dealById.keys(), ...callById.keys()]);

      // Names resolved once, for every rep id either stat touched.
      const ids = [...repIds].filter((id): id is string => id !== null);
      const { rows: telecallers } = await client.query<{ id: string; display_name: string }>(
        ids.length
          ? `SELECT id, display_name FROM telecallers WHERE id = ANY($1::uuid[])`
          : `SELECT id, display_name FROM telecallers WHERE false`,
        ids.length ? [ids] : [],
      );
      const nameById = new Map(telecallers.map((t) => [t.id, t.display_name]));
      const repName = (id: string | null) => (id === null ? "Unassigned" : (nameById.get(id) ?? "Unassigned"));

      const metricTotal = (metric: CommissionMetric, repId: string | null): number => {
        if (metric === "won_value") return Number(dealById.get(repId)?.won_value ?? 0);
        if (metric === "won_count") return Number(dealById.get(repId)?.won_count ?? 0);
        return Number(callById.get(repId)?.calls ?? 0);
      };

      const rows: CommissionRow[] = [];
      for (const plan of plans) {
        // See the class doc comment: a `calls`-metric plan has no per-rep
        // filter to apply for a scoped viewer, only "everyone" or "no one" —
        // an empty result beats handing a rep their colleagues' compensation.
        if (plan.metric === "calls" && recordScope.scope === "owned") continue;

        const rate = Number(plan.rate);
        // A rep only appears under a plan if they have SOME activity on that
        // plan's metric — the deal-based and call-based rep sets rarely
        // coincide, and a plan should not manufacture a zero row for every
        // rep in the org regardless of which metric it pays on.
        const candidates = plan.metric === "calls" ? callById.keys() : dealById.keys();
        for (const repId of candidates) {
          const total = metricTotal(plan.metric, repId);
          const commission =
            plan.rate_type === "percent" ? (total * rate) / 100 : total * rate;
          rows.push({
            planId: plan.id,
            planName: plan.name,
            metric: plan.metric,
            rateType: plan.rate_type,
            rate,
            repId,
            rep: repName(repId),
            metricTotal: total,
            commission: Number(commission.toFixed(2)),
          });
        }
      }

      rows.sort((a, b) => a.planName.localeCompare(b.planName) || b.commission - a.commission);
      return { from, to, rows };
    });
  }

  /**
   * How far deals get, and where they stop.
   *
   * "Reached" counts a deal as having reached every stage AT OR BEFORE its
   * current one, in pipeline order — a deal sitting in Negotiation obviously
   * passed Contacted, and counting only the current stage would draw a funnel
   * with holes in it. Won deals count as having reached everything.
   *
   * This is an inference from current position, not history: no per-stage
   * transition log exists yet, so a deal that skipped a stage still counts as
   * having passed it, and a LOST deal — whose stage was overwritten with the
   * terminal value — can only be credited with having entered the pipeline.
   * Both are stated on the report itself rather than left for a reader to
   * discover. A `deal_stage_transitions` table would remove the guesswork
   * entirely and is the natural next step if these numbers start driving
   * decisions.
   */
  async conversion(
    orgId: string,
    from: string,
    to: string,
    pipelineId?: string,
    recordScope: CrmRecordScope = UNSCOPED,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows: pipelines } = await client.query<{ id: string; name: string; stages: unknown }>(
        `SELECT id, name, stages FROM deal_pipelines
          WHERE status = 'active' AND ($1::uuid IS NULL OR id = $1::uuid)
          ORDER BY is_default DESC, created_at ASC`,
        [pipelineId ?? null],
      );
      if (pipelines.length === 0) return { pipeline: null, from, to, rows: [], summary: null };

      const target = pipelines[0];
      const stages = parsePipelineStages(target.stages);
      const open = stages.filter((s) => !s.terminal);
      const order = new Map(open.map((s, i) => [s.key, i]));

      /**
       * One row per deal, carrying every stage it was EVER in — read from the
       * transition ledger (migration 0046), not from the `stage` column.
       *
       * This is the whole reason that table exists. A lost deal's `stage` has
       * been overwritten with the terminal 'lost', erasing how far it got, so
       * the previous version of this report had to floor every loss at the
       * entry stage — making a deal that died in Negotiation
       * indistinguishable from one that died on first contact. The ledger
       * still knows, and `visited` is that knowledge.
       *
       * The LEFT JOIN matters: a deal with no transitions at all (created
       * before 0046 and somehow missed by its backfill) still appears, with
       * an empty `visited`, and is floored at the entry stage below rather
       * than dropped from the funnel.
       */
      const { rows: deals } = await client.query<{
        status: string;
        visited: string[] | null;
      }>(
        `SELECT d.status,
                array_remove(array_agg(DISTINCT t.to_stage), NULL) AS visited
           FROM deals d
           LEFT JOIN deal_stage_transitions t ON t.deal_id = d.id
          WHERE d.pipeline_id = $1
            AND d.created_at >= $2::date AND d.created_at < ($3::date + 1)
                ${ownedDeals(recordScope, 4, "d")}
          GROUP BY d.id, d.status`,
        scopedParams([target.id, from, to], recordScope),
      );

      const reached = new Array(open.length).fill(0);
      let total = 0;
      let won = 0;
      let lost = 0;
      for (const row of deals) {
        total += 1;
        if (row.status === "won") won += 1;
        if (row.status === "lost") lost += 1;

        // The FURTHEST open stage this deal reached. Counting furthest-reached
        // rather than summing individual entries is what keeps the funnel
        // monotonic — a deal that was moved backwards, or one whose history
        // was reconstructed by 0046's backfill and so has gaps, still counts
        // once at every stage up to its high-water mark.
        const furthest = furthestOpenStage(order, row.visited ?? [], row.status, open.length);

        // Floored at the entry stage: every deal that exists entered the
        // pipeline, whatever else is unknown about it. Dropping the unknowns
        // would make the top of the funnel smaller than the number of deals
        // created, shrinking every denominator below it and flattering every
        // conversion rate.
        //
        // The invariant this preserves — rows[0].reached === summary.created
        // — is asserted in reports.service.test.ts.
        for (let i = 0; i <= Math.max(furthest, 0); i++) reached[i] += 1;
      }

      const rows: ConversionRow[] = open.map((stage, i) => ({
        stage: stage.key,
        label: stage.label,
        reached: reached[i],
        conversionFromPrevious:
          i === 0 || reached[i - 1] === 0 ? null : Number((reached[i] / reached[i - 1]).toFixed(4)),
      }));

      return {
        pipeline: { id: target.id, name: target.name },
        from,
        to,
        rows,
        summary: {
          created: total,
          won,
          lost,
          open: total - won - lost,
          winRate: won + lost === 0 ? null : Number((won / (won + lost)).toFixed(4)),
        },
      };
    });
  }
}

function emptyTotals() {
  return { deals: 0, amount: 0, weightedAmount: 0, wonDeals: 0, avgDaysToWin: null };
}

/**
 * The `owned` scope, as an extra AND on a report's WHERE clause.
 *
 * Reports aggregate, so this is the one place a scope leak would be silent
 * rather than obvious: a role restricted to its own deals could otherwise read
 * the org's total pipeline value off the forecast without ever seeing a single
 * row it was not allowed to see. `""` when unscoped, so the SQL is unchanged
 * for every role granted `all`.
 */
function ownedDeals(scope: CrmRecordScope, paramIndex: number, alias = ""): string {
  const clause = scopeClause("deal", scope, paramIndex, alias);
  return clause ? `AND ${clause}` : "";
}

/** The caller's own uuid appended, but only when the scope actually uses one. */
function scopedParams(params: unknown[], scope: CrmRecordScope): unknown[] {
  return scope.scope === "owned" ? [...params, scope.userId] : params;
}
