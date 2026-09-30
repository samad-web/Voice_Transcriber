import { withOrgContext } from "@aura/db";
import { CALL_ISSUE_LIVE_STATUSES } from "@aura/shared";

/**
 * Close the loop on a re-run (migration 0147, doc 36 §10.3).
 *
 * ── WHY THIS EXISTS, AND WHY IT IS WORTH THE THIRTY LINES ───────────────────
 *
 * When an operator presses "Re-run the call" from the escalation queue, the ticket
 * records that it happened. What it cannot record is whether it made any
 * DIFFERENCE, because the answer only exists once the pipeline has finished -
 * possibly minutes later, in another process.
 *
 * Without this, every ticket is closed on a guess. The operator re-runs, sees a
 * fresh transcript, and has no way to tell "the words changed and the complaint
 * is fixed" from "the same engine produced the same output and re-running it a
 * third time will also produce the same output". That second case is the
 * expensive one: each attempt bills Sarvam and the analyzer for a call already
 * paid for once, and it is the exact waste taking the button off the client was
 * meant to stop. Doing it to ourselves instead would be no better.
 *
 * So: one event per re-run, carrying whether the transcript's digest moved and
 * whether the engine did. The queue can then say "transcript unchanged, engine
 * unchanged" in as many words, and the person reading it can stop pressing.
 *
 * ── WHAT IT COMPARES ────────────────────────────────────────────────────────
 *
 * `md5(transcript.text)` now against `snap_transcript_md5` as it was when the
 * client complained. Both digests, never the text - a ticket that carried the
 * transcript would be a side channel around 0122's call-access gate, which is the
 * one rule the whole feature is built around. The comparison happens IN the
 * database for the same reason the snapshot's digest is taken there.
 *
 * ── WHY IT CANNOT BREAK A CALL ──────────────────────────────────────────────
 *
 * Called last, outside every transaction the pipeline needs, and its own failure
 * is logged and swallowed by the caller. A ticket that never learns its re-run
 * finished is a cosmetic loss; a call that fails to reach COMPLETE because a
 * support-ticket write threw is a real one.
 */
export async function recordReprocessOutcome(orgId: string, callId: string): Promise<void> {
  await withOrgContext(orgId, async (client) => {
    /*
     * The reports still waiting to hear. `NOT EXISTS` is what makes this
     * idempotent and what makes it one event PER RE-RUN rather than one ever: a
     * finish already recorded since `last_reprocess_at` means this pipeline pass
     * belongs to something else - a later edit, a sweep, a second re-run whose
     * own finish will land on its own newer timestamp.
     */
    const { rows } = await client.query<{
      id: string;
      ref: string;
      snap_transcript_md5: string | null;
      snap_asr_engine: string | null;
      now_md5: string | null;
      now_engine: string | null;
    }>(
      `SELECT r.id, r.ref::text AS ref, r.snap_transcript_md5, r.snap_asr_engine,
              t.now_md5, t.now_engine
         FROM call_issue_reports r
         LEFT JOIN LATERAL (
           SELECT md5(tr.text) AS now_md5, tr.engine AS now_engine
             FROM transcripts tr
            WHERE tr.call_id = r.call_id
            ORDER BY tr.created_at DESC
            LIMIT 1
         ) t ON true
        WHERE r.call_id = $1
          AND r.status = ANY($2::text[])
          AND r.last_reprocess_at IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM call_issue_events e
             WHERE e.report_id = r.id
               AND e.kind = 'reprocess_finished'
               AND e.created_at >= r.last_reprocess_at
          )`,
      [callId, [...CALL_ISSUE_LIVE_STATUSES]],
    );

    for (const report of rows) {
      // Unknown, not "unchanged", when either digest is missing: a call with no
      // transcript on one side of the re-run tells us nothing about the words,
      // and saying "unchanged" would be a claim the data does not support.
      const transcriptChanged =
        report.snap_transcript_md5 && report.now_md5
          ? report.snap_transcript_md5 !== report.now_md5
          : null;
      const engineChanged =
        report.snap_asr_engine && report.now_engine
          ? report.snap_asr_engine !== report.now_engine
          : null;

      await client.query(
        `INSERT INTO call_issue_events
           (org_id, report_id, kind, visibility, actor_type, actor_id, actor_name, meta)
         VALUES ($1, $2, 'reprocess_finished', 'client', 'system', 'pipeline', 'Aura', $3::jsonb)`,
        [
          orgId,
          report.id,
          JSON.stringify({
            transcriptChanged,
            engineChanged,
            fromEngine: report.snap_asr_engine,
            toEngine: report.now_engine,
            transcriptDigestBefore: report.snap_transcript_md5?.slice(0, 8) ?? null,
            transcriptDigestAfter: report.now_md5?.slice(0, 8) ?? null,
          }),
        ],
      );
      console.log(
        `call ${callId}: report AUR-${report.ref.padStart(6, "0")} re-run finished` +
          ` (transcript ${transcriptChanged === null ? "unknown" : transcriptChanged ? "CHANGED" : "unchanged"})`,
      );
    }
  });
}
