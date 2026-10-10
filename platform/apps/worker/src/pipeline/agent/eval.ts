import { gateFor, getAdminPool, type PoolClient, withOrgContext } from "@aura/db";
import {
  AUTONOMY_MIN_CASES,
  AUTONOMY_PRECISION_GATE,
  DRIFT_MIN_RUNS,
  type DriftSample,
  autonomyDecision,
  driftReport,
  intentSpec,
  type AgentIntentType,
  type GateSubject,
} from "@aura/shared";

/**
 * §13.3's AUTONOMY GATE AND §13.4's DRIFT MONITOR, AS A SWEEP
 * (Build docs/transcript-agent-build-plan §13.3, §13.4, §16).
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS IS AND WHAT IT IS NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §13 has two halves and they live in different places on purpose:
 *
 *   The RELEASE GATE (§13.2) runs in CI, over repo fixtures, in
 *   `agent-eval.test.ts`. A release gate that needs a database is a release
 *   gate that does not run on a pull request.
 *
 *   The RUNNING MEASUREMENT (§13.3/§13.4) runs here, over each tenant's own
 *   reviewed decisions. It cannot be a test: the data is a tenant's customer
 *   conversations and the question is "is this still accurate ON THIS FLOOR".
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  DEMOTION IS AUTOMATIC; PROMOTION NEEDS A PERSON
 * ══════════════════════════════════════════════════════════════════════════
 *
 * §13.3: "accuracy dropping below the gate AUTOMATICALLY DEMOTES the intent
 * back to review and raises an alert."
 *
 * So this sweep writes `auto_execute = false` on its own, and never writes
 * `true`. `autonomyDecision` is the shared rule and its own header explains
 * the asymmetry: nothing may make the product more autonomous without the
 * owner having asked, and everything may make it less.
 *
 * A measurement that STOPS ARRIVING demotes too. A live autonomous action with
 * no accuracy signal behind it is exactly what the gate exists to prevent.
 */

/**
 * The window §13.3's "recent real data" means.
 *
 * Ninety days, and it is a trade-off worth stating: shorter and a quiet intent
 * never accumulates the 200 cases the gate needs; longer and a prompt change
 * from the spring keeps propping up a build that has since got worse. Ninety
 * days is roughly a quarter of a floor's conversations, which is the shortest
 * window in which 200 reviewed cases is realistic for anything but a booking.
 */
const WINDOW_DAYS = Number(process.env.AGENT_ACCURACY_WINDOW_DAYS ?? 90);

export interface AccuracySweepResult {
  orgsMeasured: number;
  orgsSkippedGateOff: number;
  intentsMeasured: number;
  demoted: number;
  alerts: number;
  driftFindings: number;
}

/**
 * The org-wide half of §3A.4's "scheduled jobs skip users without the feature".
 *
 * ── WHY THE SUBJECT IS EMPTY, AND WHY ONLY THREE REASONS SKIP ─────────────
 *
 * This sweep measures a WHOLE ORG's reviewed decisions, so there is no one
 * person to ask about: the subject is deliberately blank and the only useful
 * question is "could this feature be on for anybody here".
 *
 * `resolveGate` treats an org row as a CEILING, not a grant, so a blank
 * subject comes back denied with `no_decision` even on a floor where every
 * telecaller is switched on. Skipping on that would skip EVERY org and the
 * accuracy gate would quietly stop running - the exact failure §13 calls out,
 * since an autonomous intent with no measurement behind it keeps executing.
 *
 * So only the three ORG-WIDE refusals skip: the plan does not include the
 * module, the platform kill switch names the feature, or an owner switched it
 * off for the workspace. In all three nothing may run, nothing new can be
 * reviewed, and a demotion would be writing to a feature nobody is using.
 */
const GATE_OFF_FOR_WHOLE_ORG: readonly string[] = [
  "plan_missing",
  "platform_kill_switch",
  "org_off",
];

const ORG_WIDE_SUBJECT: GateSubject = {
  userId: null,
  telecallerId: null,
  teamId: null,
  ownerRole: null,
};

export async function sweepAgentAccuracy(): Promise<AccuracySweepResult> {
  const pool = getAdminPool();
  const result: AccuracySweepResult = {
    orgsMeasured: 0,
    orgsSkippedGateOff: 0,
    intentsMeasured: 0,
    demoted: 0,
    alerts: 0,
    driftFindings: 0,
  };

  // Only orgs that have produced a reviewable decision. An org with the
  // feature on and no reviewed actions has nothing to measure, and writing a
  // `measured_precision` of null over a null is a round trip for nothing.
  const { rows: orgs } = await pool.query<{ org_id: string }>(
    `SELECT DISTINCT org_id FROM agent_actions
      WHERE created_at > now() - interval '120 days'`,
  );

  for (const { org_id: orgId } of orgs) {
    try {
      await withOrgContext(orgId, async (client) => {
        const gate = await gateFor(client, "transcript_agent", ORG_WIDE_SUBJECT);
        if (!gate.enabled && GATE_OFF_FOR_WHOLE_ORG.includes(gate.reason)) {
          result.orgsSkippedGateOff += 1;
          return;
        }
        const measured = await measureAndGate(client, orgId);
        result.intentsMeasured += measured.measured;
        result.demoted += measured.demoted;
        result.alerts += measured.alerts;
        result.driftFindings += await snapshotAndCompareDrift(client, orgId);
        result.orgsMeasured += 1;
      });
    } catch (error) {
      console.error(`agent accuracy sweep failed for org ${orgId}:`, error);
    }
  }

  return result;
}

/**
 * §13.3, per intent.
 *
 * ── AN EDIT COUNTS AGAINST PRECISION AS MUCH AS A REJECTION ──────────────
 *
 * A reviewer who had to change the time was handed the wrong time. Scoring an
 * edit as a success is how a measured 98% becomes a floor that corrects
 * everything - and it is the single easiest way to make this whole gate
 * meaningless, because `approved` is the cheap button and `edited` is the one
 * people actually press when the suggestion was nearly right.
 */
async function measureAndGate(
  client: PoolClient,
  orgId: string,
): Promise<{ measured: number; demoted: number; alerts: number }> {
  const { rows } = await client.query<{
    type: string;
    reviewed: string;
    approved: string;
    auto_execute: boolean | null;
    was_auto: boolean | null;
  }>(
    `SELECT i.type,
            count(*) FILTER (WHERE a.review_decision IS NOT NULL) AS reviewed,
            count(*) FILTER (WHERE a.review_decision = 'approved')  AS approved,
            bool_or(cfg.auto_execute) AS auto_execute,
            bool_or(cfg.auto_execute) AS was_auto
       FROM agent_actions a
       JOIN agent_intents i ON i.id = a.intent_id
       LEFT JOIN agent_intent_config cfg ON cfg.intent_type = i.type
      WHERE a.created_at > now() - ($1 || ' days')::interval
      GROUP BY i.type`,
    [String(WINDOW_DAYS)],
  );

  let measured = 0;
  let demoted = 0;
  let alerts = 0;

  for (const row of rows) {
    const reviewed = Number(row.reviewed);
    const approved = Number(row.approved);
    const precision = reviewed > 0 ? approved / reviewed : null;

    let eligible = true;
    try {
      const spec = intentSpec(row.type as AgentIntentType);
      eligible = spec.autoEligible && spec.tier !== "T3";
    } catch {
      // A custom intent. §6 bounds it to T0/T1 by the tool CHECK in 0185, so
      // it is eligible in principle; its eval-coverage requirement is checked
      // at the API when the switch is thrown.
      eligible = true;
    }

    const decision = autonomyDecision({
      precision,
      reviewedCases: reviewed,
      currentlyAuto: Boolean(row.auto_execute),
      // Read from the stored flag: the owner's own wish IS the flag, and this
      // sweep only ever clears it. Passing `true` here would let the sweep
      // promote, which `autonomyDecision`'s asymmetry exists to prevent.
      orgWantsAuto: Boolean(row.auto_execute),
      eligible,
    });

    await client.query(
      `INSERT INTO agent_intent_config
         (org_id, intent_type, enabled, measured_precision, reviewed_cases, measured_at)
       VALUES ($1, $2, true, $3, $4, now())
       ON CONFLICT (org_id, intent_type) DO UPDATE
         SET measured_precision = EXCLUDED.measured_precision,
             reviewed_cases = EXCLUDED.reviewed_cases,
             measured_at = now(),
             updated_at = now()`,
      [orgId, row.type, precision, reviewed],
    );
    measured += 1;

    if (decision.action !== "demote") continue;

    const { rowCount } = await client.query(
      `UPDATE agent_intent_config
          SET auto_execute = false,
              demoted_at = now(),
              demoted_reason = $3,
              updated_at = now()
        WHERE org_id = $1 AND intent_type = $2 AND auto_execute`,
      [orgId, row.type, decision.reason],
    );
    if ((rowCount ?? 0) === 0) continue;
    demoted += 1;

    if (!decision.alert) continue;

    // §16: "accuracy below gate... become alerts with the same routing and
    // escalation." Owners only - a telecaller cannot act on it and should not
    // learn from a bell that their work is being measured.
    const { rows: owners } = await client.query<{ user_id: string }>(
      `SELECT m.user_id FROM memberships m
        -- The NULL guard (0153): a member added through the operator's Members
        -- screen has no persona, and resolveOwnerRole reads an absent one as
        -- owner. A bare equality reaches nobody in those orgs.
        WHERE m.owner_role = 'owner' OR m.owner_role IS NULL
        LIMIT 5`,
    );
    for (const owner of owners) {
      await client.query(
        `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path, dedupe_key)
         VALUES ($1, $2, 'agent_alert', $3, $4, '/owner/settings/transcript-agent', $5)
         ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
        [
          orgId,
          owner.user_id,
          `"${row.type.replace(/_/g, " ")}" is waiting for a person again`,
          `${decision.reason}. Nothing has been lost - these suggestions now go to the review queue instead of running on their own.`,
          // The DAY is in the key, not the hour: a daily sweep must not ring
          // daily about the same demotion.
          `agent_demoted:${row.type}:${new Date().toISOString().slice(0, 10)}`,
        ],
      );
      alerts += 1;
    }
  }

  return { measured, demoted, alerts };
}

/**
 * §13.4: "track confidence distributions, STT confidence, intent mix and
 * correction rates over time; alert on shifts."
 *
 * ── A DAILY SNAPSHOT, NOT A QUERY OVER EVERY RUN ─────────────────────────
 *
 * The comparison is "this week against last week" over four aggregates. Computed
 * from raw rows that is four scans over a growing table on every tick; from a
 * daily row it is a two-row read. 0185 carries `agent_drift_snapshots` for
 * exactly this.
 */
async function snapshotAndCompareDrift(client: PoolClient, orgId: string): Promise<number> {
  await client.query(
    `INSERT INTO agent_drift_snapshots
       (org_id, day, runs, mean_score, mean_stt_confidence, correction_rate, intent_mix)
     SELECT $1,
            (now() - interval '1 day')::date,
            count(DISTINCT r.id),
            avg(i.final_score),
            avg(t.stt_confidence),
            -- The CORRECTION rate, not the rejection rate: an edit is a
            -- correction with the right answer attached, and counting only
            -- rejections would make a floor that fixes everything look happy.
            CASE WHEN count(a.id) FILTER (WHERE a.review_decision IS NOT NULL) > 0
                 THEN count(a.id) FILTER (WHERE a.review_decision IN ('rejected', 'edited'))::numeric
                      / count(a.id) FILTER (WHERE a.review_decision IS NOT NULL)
                 ELSE NULL END,
            COALESCE(
              (SELECT jsonb_object_agg(mix.type, mix.share)
                 FROM (
                   SELECT i2.type,
                          count(DISTINCT i2.run_id)::numeric
                            / GREATEST(1, (SELECT count(*) FROM agent_runs r2
                                            WHERE r2.created_at::date = (now() - interval '1 day')::date))
                            AS share
                     FROM agent_intents i2
                     JOIN agent_runs r3 ON r3.id = i2.run_id
                    WHERE r3.created_at::date = (now() - interval '1 day')::date
                    GROUP BY i2.type
                 ) mix),
              '{}'::jsonb)
       FROM agent_runs r
       JOIN agent_transcripts t ON t.id = r.transcript_id
       LEFT JOIN agent_intents i ON i.run_id = r.id
       LEFT JOIN agent_actions a ON a.run_id = r.id
      WHERE r.created_at::date = (now() - interval '1 day')::date
     -- Idempotent: the sweep runs hourly and yesterday's numbers do not
     -- change, so a re-run overwrites with the same values rather than
     -- erroring or appending.
     ON CONFLICT (org_id, day) DO UPDATE
       SET runs = EXCLUDED.runs,
           mean_score = EXCLUDED.mean_score,
           mean_stt_confidence = EXCLUDED.mean_stt_confidence,
           correction_rate = EXCLUDED.correction_rate,
           intent_mix = EXCLUDED.intent_mix`,
    [orgId],
  );

  /**
   * §13.4's comparison: the last seven days against the seven before them.
   *
   * ── ONE CTE PER QUESTION, NOT A CORRELATED SUBQUERY ────────────────────
   *
   * The first version computed the intent mix with a subquery that referenced
   * the OUTER query's `day` from inside its own `GROUP BY key`, and Postgres
   * refused it outright: "subquery uses ungrouped column
   * `agent_drift_snapshots.day` from outer query". It was a genuine logic
   * error, not a syntax quibble - the subquery was trying to be per-window
   * while being evaluated per-group, and there is no reading of it that means
   * what was intended.
   *
   * Written as two CTEs that each aggregate over their own window and are then
   * joined, which is both correct and readable. Caught by preparing every
   * statement in this file against a real database; `tsc` sees a string.
   */
  const { rows } = await client.query<{
    window: string;
    runs: string;
    mean_score: string | null;
    mean_stt: string | null;
    correction_rate: string | null;
    intent_mix: Record<string, number> | null;
  }>(
    `WITH windowed AS (
       SELECT CASE WHEN day > current_date - 7 THEN 'current' ELSE 'baseline' END AS span,
              runs, mean_score, mean_stt_confidence, correction_rate, intent_mix
         FROM agent_drift_snapshots
        WHERE day > current_date - 14
     ),
     totals AS (
       SELECT span,
              sum(runs) AS runs,
              -- Weighted by RUNS, not a mean of means: a day with four calls
              -- must not count as much as a day with four hundred.
              sum(mean_score * runs) / NULLIF(sum(runs), 0) AS mean_score,
              sum(mean_stt_confidence * runs) / NULLIF(sum(runs), 0) AS mean_stt,
              sum(correction_rate * runs) / NULLIF(sum(runs), 0) AS correction_rate
         FROM windowed
        GROUP BY span
     ),
     mixes AS (
       SELECT w.span, j.key, avg(j.value::numeric) AS share
         FROM windowed w, jsonb_each_text(w.intent_mix) j
        GROUP BY w.span, j.key
     ),
     mix_by_window AS (
       SELECT span, jsonb_object_agg(key, share) AS intent_mix
         FROM mixes GROUP BY span
     )
     SELECT t.span AS window,
            t.runs::text AS runs,
            t.mean_score::text AS mean_score,
            t.mean_stt::text AS mean_stt,
            t.correction_rate::text AS correction_rate,
            COALESCE(m.intent_mix, '{}'::jsonb) AS intent_mix
       FROM totals t
       LEFT JOIN mix_by_window m ON m.span = t.span`,
  );

  const toSample = (window: string): DriftSample => {
    const row = rows.find((r) => r.window === window);
    return {
      runs: Number(row?.runs ?? 0),
      meanScore: row?.mean_score === null || row?.mean_score === undefined ? null : Number(row.mean_score),
      meanSttConfidence:
        row?.mean_stt === null || row?.mean_stt === undefined ? null : Number(row.mean_stt),
      correctionRate:
        row?.correction_rate === null || row?.correction_rate === undefined
          ? null
          : Number(row.correction_rate),
      intentMix: row?.intent_mix ?? {},
    };
  };

  const findings = driftReport(toSample("baseline"), toSample("current"));
  const alerting = findings.filter((finding) => finding.severity === "alert");
  if (alerting.length === 0) return findings.length;

  const { rows: owners } = await client.query<{ user_id: string }>(
    `SELECT m.user_id FROM memberships m
      WHERE m.owner_role = 'owner' OR m.owner_role IS NULL
      LIMIT 5`,
  );
  for (const owner of owners) {
    await client.query(
      `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path, dedupe_key)
       VALUES ($1, $2, 'agent_alert', $3, $4, '/owner/settings/transcript-agent', $5)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [
        orgId,
        owner.user_id,
        "The assistant's readings have changed this week",
        alerting.map((finding) => finding.message).join(" "),
        // The WEEK is in the key: a drift that persists is one alert, not
        // seven.
        `agent_drift:${isoWeek(new Date())}`,
      ],
    );
  }

  return findings.length;
}

/** `2026-W41`. The dedupe key's granularity, so a persisting drift rings once. */
function isoWeek(date: Date): string {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function startAgentAccuracySweep(): NodeJS.Timeout {
  // Hourly. §13.3's gate is about a trend over hundreds of cases, so a faster
  // clock would buy nothing - and a demotion arriving within the hour is well
  // inside the window in which an inaccurate intent could do harm, because
  // T2 autonomy also needs the owner's own switch and a 0.92+ score per
  // action.
  const intervalMs = Number(process.env.AGENT_ACCURACY_INTERVAL_MS ?? 3_600_000);
  return setInterval(() => {
    sweepAgentAccuracy().catch((error) => console.error("agent accuracy sweep failed:", error));
  }, intervalMs);
}

/** Exported for the console's "what would the gate do" read. */
export { AUTONOMY_MIN_CASES, AUTONOMY_PRECISION_GATE, DRIFT_MIN_RUNS };
