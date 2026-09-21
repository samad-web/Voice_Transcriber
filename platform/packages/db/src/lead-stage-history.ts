import type { DbClient } from "./crm-projection";

/**
 * Recording a LEAD's stage moves into `lead_stage_transitions` (0075).
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * 0075 created the ledger ("the ledger leads have never had") and 0093 hung a
 * trigger off it that marks a lead's first response when a PERSON moves it -
 * and then nothing ever wrote a row. Every reader downstream quietly read an
 * empty table: the Staff scorecard's "Leads won" and "Stage moves" were 0 for
 * everyone, always, and dragging a card out of New never counted as answering
 * the lead. Deals had a ledger writer (crm-objects/stage-history.ts); leads
 * only ever propagated their move onto the deal.
 *
 * One function, in @aura/db so the API and the worker share it, called from
 * every place a lead's stage is written: the console's PATCH (`console`) and
 * the worker's one automatic advance (`automation`). A second hand-rolled
 * INSERT is how two writers end up disagreeing about what a row means.
 *
 * ── THE SOURCE IS NOT DECORATION ────────────────────────────────────────────
 *
 * 0093's trigger treats `console` and `device` as a person answering the lead
 * and everything else as the machine. Label an automatic move `console` and
 * the worker starts answering leads on the floor's behalf, which makes the
 * response-time report a measure of the pipeline instead of of people. The
 * type below keeps the vocabulary closed for that reason.
 */

/** console | device are people; the rest are the system (0075's own list). */
export type LeadStageSource = "console" | "device" | "automation" | "reshape" | "backfill" | "pipeline";

export interface LeadStageMove {
  leadId: string;
  /** NULL only when the lead is entering the board for the first time. */
  fromStage: string | null;
  toStage: string;
  fromStatus: string | null;
  toStatus: string;
  source: LeadStageSource;
  /** The platform user who moved it, when a person did. */
  changedBy?: string | null;
  /** For actors that aren't users - "automation: second qualified call". */
  actorLabel?: string | null;
}

/** A "move" to where the lead already is, is not a move. */
export function isLeadStageMove(move: Pick<LeadStageMove, "fromStage" | "toStage" | "fromStatus" | "toStatus">): boolean {
  return move.fromStage !== move.toStage || move.fromStatus !== move.toStatus;
}

/**
 * Write one transition. Returns whether a row was written.
 *
 * `changed_by` goes through a lookup rather than straight in: it is a foreign
 * key to `users`, and the principal id a request carries is not guaranteed to
 * name a row there (a platform operator on the admin key, a local-dev
 * principal). An unknown id is recorded as nobody rather than failing the
 * move that is being recorded - the ledger exists to describe card moves, not
 * to veto them.
 */
export async function recordLeadStageTransition(
  client: DbClient,
  orgId: string,
  move: LeadStageMove,
): Promise<boolean> {
  if (!isLeadStageMove(move)) return false;

  await client.query(
    `INSERT INTO lead_stage_transitions
       (org_id, lead_id, from_stage, to_stage, from_status, to_status,
        changed_by, actor_label, source)
     VALUES ($1, $2, $3, $4, $5, $6,
             (SELECT u.id FROM users u WHERE u.id = $7::uuid), $8, $9)`,
    [
      orgId,
      move.leadId,
      move.fromStage,
      move.toStage,
      move.fromStatus,
      move.toStatus,
      move.changedBy ?? null,
      move.actorLabel ?? null,
      move.source,
    ],
  );
  return true;
}
