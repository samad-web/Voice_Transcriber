/**
 * Recording a deal's stage moves (migration 0046).
 *
 * One function, called from every place a stage is written, so the ledger
 * cannot drift from the column it describes. Kept out of the controller
 * because the automation engine writes moves too, and a second hand-rolled
 * INSERT is exactly how two writers end up disagreeing about what a
 * transition row means.
 */

export interface StageTransition {
  dealId: string;
  /** NULL only when the deal is entering the pipeline for the first time. */
  fromStage: string | null;
  toStage: string;
  fromStatus: string | null;
  toStatus: string;
  /** A platform user, when a person did it. */
  changedBy?: string | null;
  /** console | pipeline | automation | backfill */
  source?: string;
  /** For actors that aren't users - "automation: stale deal sweep". */
  actorLabel?: string | null;
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

export async function recordStageTransition(
  client: Queryable,
  orgId: string,
  move: StageTransition,
): Promise<void> {
  // A "move" to the stage it is already in is not a move. Guarded here rather
  // than at each call site, because the caller that forgets is the one that
  // fills the ledger with noise nobody can filter back out.
  if (move.fromStage === move.toStage && move.fromStatus === move.toStatus) return;

  await client.query(
    `INSERT INTO deal_stage_transitions
       (org_id, deal_id, from_stage, to_stage, from_status, to_status,
        changed_by, actor_label, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      orgId,
      move.dealId,
      move.fromStage,
      move.toStage,
      move.fromStatus,
      move.toStatus,
      move.changedBy ?? null,
      move.actorLabel ?? null,
      move.source ?? "console",
    ],
  );
}

/**
 * How far a deal got, as an index into the pipeline's OPEN stages.
 *
 * The funnel's central question, and the reason this table earns its keep. A
 * deal's `stage` column answers "where is it now", which for a lost deal is
 * the useless answer 'lost' - every trace of how far it progressed having
 * been overwritten by the move that killed it. The transition ledger still
 * has it.
 *
 * Returns -1 for a deal with no recognisable open stage in its history at
 * all, which the caller floors at the entry stage: every deal that exists
 * entered the pipeline, whatever else is unknown about it.
 */
export function furthestOpenStage(
  stageOrder: Map<string, number>,
  visited: string[],
  status: string,
  openStageCount: number,
): number {
  // A won deal passed everything, by definition - the win is the last step,
  // and its own transition rows stop at whichever stage it was in when it
  // closed.
  if (status === "won") return openStageCount - 1;

  let furthest = -1;
  for (const stage of visited) {
    const position = stageOrder.get(stage);
    if (position !== undefined && position > furthest) furthest = position;
  }
  return furthest;
}
