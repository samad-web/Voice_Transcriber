import type { PoolClient } from "pg";
import {
  CALL_ISSUE_CATEGORIES,
  PLATFORM_REASON_SEVERITY,
  PLATFORM_REASON_TITLE,
  SYSTEM_REPORTER_NAME,
  type ClassifiedFailure,
} from "@aura/shared";

/**
 * Raise - or fold into - the operator's ticket for a failure that was ours.
 *
 * ── WHY THE PIPELINE FILES ITS OWN TICKETS ──────────────────────────────────
 *
 * 0147 built the escalation queue for a CLIENT reporting a bad transcript: a
 * person notices, states the problem, we triage it at /support. That design is
 * sound and unchanged. It has one gap, and on 2026-10-14 the gap was measured:
 *
 *   2,792 calls over 30 days failed with HTTP 402 "No credits available." from
 *   the ASR vendor, unbroken since 2026-08-13. Not one ticket was filed,
 *   because the queue waits for a person to complain and the people best
 *   placed to complain were being told their recordings were unreadable.
 *
 * A queue that only fills when a customer notices cannot surface an outage
 * that makes the product look like it is working badly rather than not at all.
 * So the pipeline files its own.
 *
 * ── THE DE-DUPLICATION IS THE WHOLE DESIGN ──────────────────────────────────
 *
 * The naive version - one ticket per failed call - would have put 2,792 rows on
 * that board, which is not surfacing the problem, it is the same burial with
 * extra steps. Migration 0201's partial unique index allows at most ONE live
 * system ticket per (org_id, platform_reason), so:
 *
 *   * the first failing call OPENS the ticket;
 *   * every later call with the same reason BUMPS `occurrence_count` and
 *     appends one internal `system_recurrence` event;
 *   * the operator reads one row that says "provider out of credit, 2,792
 *     calls, first seen 62 days ago", which is a sentence somebody can act on.
 *
 * ── WHAT THE CLIENT CAN AND CANNOT SEE ──────────────────────────────────────
 *
 * `call_issue_reports` is org-scoped and the owner console already renders a
 * client's tickets on the call row, so a system ticket IS visible to that
 * tenant. That is deliberate and it is the half of this the client should get:
 * "we spotted it, it is logged, here is the reference". It is also why the
 * description is written in the client's language and carries no vendor detail.
 *
 * The vendor's actual words - the 402, the quota code, the request id - go in a
 * SEPARATE `internal` event. 0147 built `call_issue_events.visibility` for
 * exactly this separation and its existing CHECK already permits a non-user
 * actor to write an internal row, so nothing here widens anybody's access.
 *
 * ── WHAT THIS MUST NEVER BECOME ─────────────────────────────────────────────
 *
 * A side channel around 0122, the same warning 0147 carries. No column written
 * here holds call content: not a transcript, not a segment, not a summary, not
 * a presigned URL. `operatorSummary` is a classifier verdict about a VENDOR
 * RESPONSE, and the only call-specific values are the ids and the frozen
 * snapshot 0147 already defined.
 */

/** Never let a diagnostic string grow without bound in a ticket body. */
const MAX_OPERATOR_DETAIL = 1800;

export interface EscalationOutcome {
  /** 'opened' on the first occurrence, 'folded' on every later one. */
  action: "opened" | "folded" | "skipped";
  /** `call_issue_reports.ref`, for the log line. Null when skipped. */
  ref: number | null;
  occurrences: number;
}

/**
 * @param client  MUST already be inside `withOrgContext(orgId, …)`. The insert
 *                goes through this table's FORCE'd RLS `org_isolation` policy,
 *                so a bare pool connection writes nothing and the failure is
 *                silent-looking. Every call site in this repo is already
 *                inside that wrapper; this comment is for the next one.
 */
export async function escalatePlatformFailure(
  client: PoolClient,
  args: {
    orgId: string;
    callId: string;
    stage: string;
    classified: ClassifiedFailure;
  },
): Promise<EscalationOutcome> {
  const { orgId, callId, stage, classified } = args;

  // Only a platform failure escalates. A content failure is the recording's
  // own problem and a config failure is the tenant's own setting - raising
  // either on our queue would train whoever reads it to ignore the board,
  // which is the one outcome worse than not having it.
  if (classified.failureClass !== "platform" || classified.reason === null) {
    return { action: "skipped", ref: null, occurrences: 0 };
  }

  const reason = classified.reason;
  const detail = classified.operatorSummary.slice(0, MAX_OPERATOR_DETAIL);

  // ── 1. Fold into the live ticket if there is one ──────────────────────────
  //
  // Tried first, and as an UPDATE rather than a SELECT-then-INSERT, because two
  // workers failing two calls in the same second is the normal case under an
  // outage: by definition every call is failing. The unique index would catch
  // the race, but catching it as a 23505 that has to be swallowed is worse than
  // not racing - the swallow is where a real constraint violation hides.
  const folded = await client.query<{ ref: string; occurrence_count: number; id: string }>(
    `UPDATE call_issue_reports
        SET occurrence_count = occurrence_count + 1,
            last_occurred_at = now(),
            updated_at = now()
      WHERE org_id = $1
        AND source = 'system'
        AND platform_reason = $2
        AND status IN ('open', 'acknowledged', 'in_progress', 'awaiting_client')
      RETURNING id, ref, occurrence_count`,
    [orgId, reason],
  );

  if (folded.rows[0]) {
    const row = folded.rows[0];
    // Internal, and one row per recurrence. A client does not need a timeline
    // entry per failed call; `occurrence_count` is what the operator reads.
    await client.query(
      // `actor_id` is NOT NULL and 'pipeline' is this repo's established value
      // for a system actor - the same one call-issue-followup.ts and the audit
      // log use. Omitting it threw 23502 on this exact statement the first time
      // the migration was executed against a real database, and because an
      // escalation error is swallowed on purpose, the symptom would have been
      // an escalation path that silently reported nothing.
      `INSERT INTO call_issue_events
         (org_id, report_id, kind, actor_type, actor_id, actor_name, visibility, body)
       VALUES ($1, $2, 'system_recurrence', 'system', 'pipeline', $3, 'internal', $4)`,
      [
        orgId,
        row.id,
        SYSTEM_REPORTER_NAME,
        `Call ${callId} hit the same failure at ${stage}. ${detail}`,
      ],
    );
    return {
      action: "folded",
      ref: Number(row.ref),
      occurrences: Number(row.occurrence_count),
    };
  }

  // ── 2. Otherwise open one, snapshot and all ───────────────────────────────
  //
  // The snapshot columns are taken in the SAME statement that inserts the row,
  // which is 0147's rule and worth restating: a snapshot taken by a second
  // query can disagree with the row it claims to describe, and here the second
  // query would race the retry sweep rewinding this very call.
  //
  // The description is CLIENT-FACING - the tenant sees this ticket on their
  // call row - so it is the category's own client wording plus the reference,
  // and nothing else. The vendor detail goes in the internal event below.
  const opened = await client.query<{ id: string; ref: string }>(
    `INSERT INTO call_issue_reports (
         org_id, call_id, category, severity, description,
         source, platform_reason,
         reported_by_user_id, reported_by_name, reported_by_role,
         occurrence_count, last_occurred_at,
         snap_call_status, snap_pipeline_attempts, snap_call_started_at,
         snap_duration_s, snap_direction, snap_device_id,
         snap_audio_source_used, snap_agent_id, snap_agent_version,
         snap_recording_s3_key, snap_recording_bytes, snap_recording_sha256,
         snap_recording_codec, snap_recording_sample_rate,
         snap_asr_engine, snap_asr_language, snap_asr_diarized, snap_asr_confidence,
         snap_transcript_chars, snap_transcript_md5
       )
       SELECT
         c.org_id, c.id, 'processing_failed', $3, $4,
         'system', $5,
         NULL, $6, 'system',
         1, now(),
         c.status, c.pipeline_attempts, c.started_at,
         c.duration_s, c.direction, c.device_id,
         c.audio_source_used, c.agent_id, c.agent_version,
         r.s3_key, r.bytes, r.sha256, r.codec, r.sample_rate,
         t.engine, t.language, t.diarized, t.confidence,
         char_length(t.text), md5(coalesce(t.text, ''))
       FROM calls c
       LEFT JOIN recordings r ON r.call_id = c.id
       LEFT JOIN transcripts t ON t.call_id = c.id
       WHERE c.id = $2 AND c.org_id = $1
     RETURNING id, ref`,
    [
      orgId,
      callId,
      PLATFORM_REASON_SEVERITY[reason],
      CALL_ISSUE_CATEGORIES.processing_failed.client,
      reason,
      SYSTEM_REPORTER_NAME,
    ],
  );

  const row = opened.rows[0];
  if (!row) {
    // The call vanished between failing and this insert - a GDPR erasure or
    // the retention sweeper. Not an error worth throwing: the thing the ticket
    // would have described no longer exists.
    return { action: "skipped", ref: null, occurrences: 0 };
  }

  await client.query(
    `INSERT INTO call_issue_events
       (org_id, report_id, kind, actor_type, actor_id, actor_name, visibility, body)
     VALUES
       ($1, $2, 'system_opened', 'system', 'pipeline', $3, 'internal', $4),
       ($1, $2, 'system_opened', 'system', 'pipeline', $3, 'client',   $5)`,
    [
      orgId,
      row.id,
      SYSTEM_REPORTER_NAME,
      // Internal: the whole truth, named vendor and all.
      `${PLATFORM_REASON_TITLE[reason]} at ${stage}. ${detail}`,
      // Client-visible: what we are doing about it, and nothing they cannot use.
      "We detected this automatically and raised it with our technical team. " +
        "You do not need to do anything; we will update this ticket as it progresses.",
    ],
  );

  return { action: "opened", ref: Number(row.ref), occurrences: 1 };
}
