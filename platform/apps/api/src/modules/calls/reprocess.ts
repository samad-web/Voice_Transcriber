import { ConflictException, NotFoundException } from "@nestjs/common";
import type { AuditActor } from "../../common/audit-actor";

type Queryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

/**
 * Rewind one finished call so the pipeline picks it up again.
 *
 * ── WHY THIS IS A FUNCTION AND NOT TWO COPIES ───────────────────────────────
 *
 * Two routes press this now: the operator's `POST /calls/:id/reprocess` and the
 * escalation queue's `POST /admin/call-issues/:id/reprocess` (0147, doc 36).
 * They disagree about almost everything - one is tenant-scoped and takes the org
 * from a header, the other is cross-tenant and takes it from the ticket - but
 * they must never disagree about WHICH STATES ARE TERMINAL. Two copies of that
 * list is how the two call explorers once disagreed about whether a call had
 * failed, and it is the kind of drift no test notices until a customer does.
 *
 * The caller publishes to the queue afterwards, deliberately: the DB flip is the
 * source of truth and the queue is only a wake-up, so it must happen AFTER the
 * transaction commits rather than inside it.
 *
 * Returns the status the call was in, which is the one fact the caller needs for
 * its own record of what it did.
 */
export async function rewindForReprocess(
  client: Queryable,
  input: {
    orgId: string;
    callId: string;
    actor: AuditActor;
    /** Merged into the audit row's meta, beside `from`. */
    meta?: Record<string, unknown>;
  },
): Promise<{ from: string }> {
  const {
    rows: [call],
  } = await client.query(`SELECT status FROM calls WHERE id = $1`, [input.callId]);
  if (!call) throw new NotFoundException("call not found");

  const status = String(call.status);
  // TRANSCRIPTION_OFF is reprocessable on purpose: turning transcription back on
  // and pressing Reprocess is how a customer's backlog gets picked up, so it must
  // be rewindable like any other terminal state.
  const terminal =
    status === "COMPLETE" || status === "TRANSCRIPTION_OFF" || status.startsWith("FAILED_");
  if (!terminal) {
    throw new ConflictException(
      `call is ${status}; only COMPLETE, TRANSCRIPTION_OFF or FAILED_* calls can be reprocessed`,
    );
  }

  // A person deciding to retry resets the automatic budget: they may well have
  // fixed the cause, and inheriting the attempt count from the old problem would
  // let one more failure permanently retire the call.
  //
  // The WHERE repeats the status test so two operators pressing at once cannot
  // both claim the call - the second UPDATE matches nothing.
  await client.query(
    `UPDATE calls
        SET status = 'UPLOADED', pipeline_attempts = 0, next_attempt_at = NULL
      WHERE id = $1
        AND (status IN ('COMPLETE', 'TRANSCRIPTION_OFF') OR status LIKE 'FAILED_%')`,
    [input.callId],
  );

  await client.query(
    `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
     VALUES ($1, $2, $3, 'call.reprocess', 'call', $4, $5::jsonb)`,
    [
      input.orgId,
      input.actor.type,
      input.actor.id,
      input.callId,
      JSON.stringify({ from: status, ...(input.meta ?? {}) }),
    ],
  );

  return { from: status };
}
