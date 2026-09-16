import type { PoolClient } from "@aura/db";
import { SopSteps, scoreSop, type SopStep, type SopStepResult } from "@aura/shared";

/**
 * SOP adherence (migration 0089): load the tenant's active procedure, and store
 * how one call scored against it.
 *
 * The scoring itself is not here - it rides on the `analyzeConversation` call
 * the enrichment lane already makes, which is the rule 0069 set when it added
 * quality scoring and risk spotting ("no second LLM round trip"). This module
 * is the two ends: what goes into that prompt, and what comes out of it.
 */

export interface ActiveSop {
  id: string;
  version: number;
  steps: SopStep[];
}

/**
 * The org's active SOP, or null.
 *
 * Parsed through the same zod schema the API validates writes with, rather than
 * cast. A row written before a step-shape change - or by hand during an
 * incident - would otherwise reach the prompt malformed and produce verdicts
 * keyed on nothing. A malformed SOP is treated as no SOP: the call still gets
 * its full conversation read, it just is not scored.
 */
export async function loadActiveSop(client: PoolClient, orgId: string): Promise<ActiveSop | null> {
  const {
    rows: [row],
  } = await client.query<{ id: string; version: number; steps: unknown }>(
    `SELECT id, version, steps
       FROM call_sops
      WHERE org_id = $1 AND is_active
      ORDER BY version DESC
      LIMIT 1`,
    [orgId],
  );
  if (!row) return null;

  const parsed = SopSteps.safeParse(row.steps);
  if (!parsed.success) {
    console.error(
      `org ${orgId}: active SOP ${row.id} v${row.version} has invalid steps, not scoring:`,
      parsed.error.issues,
    );
    return null;
  }
  return { id: row.id, version: row.version, steps: parsed.data };
}

/**
 * Store one call's verdicts.
 *
 * UPSERT on (call_id, sop_id) so reprocessing a call replaces its score rather
 * than appending a second, contradictory one. `sop_version` is written every
 * time, so a call rescored after an SOP edit records the version that actually
 * judged it.
 */
export async function upsertSopResult(
  client: PoolClient,
  orgId: string,
  callId: string,
  telecallerId: string | null,
  sop: ActiveSop,
  results: SopStepResult[],
  model: string | null,
  /** The CALL's own clock - see 0089. A reprocessed backlog must not land on today. */
  callStartedAt: Date | string | null,
): Promise<void> {
  const { stepsMet, stepsTotal, adherencePct } = scoreSop(sop.steps, results);
  await client.query(
    `INSERT INTO call_sop_results
       (org_id, call_id, telecaller_id, sop_id, sop_version,
        step_results, steps_met, steps_total, adherence_pct, model, call_started_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11)
     ON CONFLICT (call_id, sop_id) DO UPDATE SET
       sop_version   = EXCLUDED.sop_version,
       telecaller_id = COALESCE(EXCLUDED.telecaller_id, call_sop_results.telecaller_id),
       step_results  = EXCLUDED.step_results,
       steps_met     = EXCLUDED.steps_met,
       steps_total   = EXCLUDED.steps_total,
       adherence_pct = EXCLUDED.adherence_pct,
       model         = EXCLUDED.model,
       -- COALESCE so a rescore that somehow lacks the call's timestamp keeps
       -- the one already recorded rather than nulling it and dropping the row
       -- out of every range filter.
       call_started_at = COALESCE(EXCLUDED.call_started_at, call_sop_results.call_started_at)`,
    [
      orgId,
      callId,
      telecallerId,
      sop.id,
      sop.version,
      JSON.stringify(results),
      stepsMet,
      stepsTotal,
      adherencePct,
      model,
      callStartedAt,
    ],
  );
}
