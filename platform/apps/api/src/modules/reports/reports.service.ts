import { Injectable } from "@nestjs/common";
import { parsePipelineStages, type PipelineStage } from "@aura/shared";
import { DbService } from "../../db/db.service";

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
  async pipeline(orgId: string, pipelineId?: string) {
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
          WHERE pipeline_id = $1 AND status = 'open'
          GROUP BY stage`,
        [target.id],
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
          WHERE pipeline_id = $1 AND status = 'won'`,
        [target.id],
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
  async performance(orgId: string, from: string, to: string) {
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
            GROUP BY d.telecaller_id
         )
         SELECT ds.rep_id,
                COALESCE(t.display_name, 'Unassigned') AS rep,
                ds.open_deals, ds.won_deals, ds.lost_deals, ds.open_value, ds.won_value
           FROM deal_stats ds
           LEFT JOIN telecallers t ON t.id = ds.rep_id
          ORDER BY ds.won_value DESC, ds.open_value DESC`,
        [from, to],
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
  async conversion(orgId: string, from: string, to: string, pipelineId?: string) {
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

      const { rows: deals } = await client.query<{ stage: string; status: string; n: string }>(
        `SELECT stage, status, count(*) AS n
           FROM deals
          WHERE pipeline_id = $1 AND created_at >= $2::date AND created_at < ($3::date + 1)
          GROUP BY stage, status`,
        [target.id, from, to],
      );

      const reached = new Array(open.length).fill(0);
      let total = 0;
      let won = 0;
      let lost = 0;
      for (const row of deals) {
        const n = Number(row.n);
        total += n;
        if (row.status === "won") won += n;
        if (row.status === "lost") lost += n;

        // How far this deal got, as an index into the open stages.
        //
        // A won deal passed all of them. A LOST one has had its stage
        // overwritten with the terminal 'lost', which is not in `order` — so
        // the only thing still knowable about it is that it entered the
        // pipeline at all, which every created deal did. Floor it at the
        // entry stage rather than letting it fall out of the funnel
        // entirely: dropping it would make the top of the funnel smaller
        // than the number of deals created, shrinking every denominator and
        // flattering every conversion rate below it.
        //
        // The invariant this preserves — rows[0].reached === summary.created
        // — is asserted in reports.service.test.ts.
        const current = order.get(row.stage);
        const upTo = row.status === "won" ? open.length - 1 : (current ?? 0);
        for (let i = 0; i <= upTo; i++) reached[i] += n;
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
