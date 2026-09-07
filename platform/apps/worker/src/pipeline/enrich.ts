import { getAdminPool, type PoolClient, withOrgContext } from "@aura/db";
import { analyzeConversation } from "@aura/llm";
import type { PipelineMessage } from "@aura/queue";
import { computeTalkMetrics, upsertCallAnalytics } from "./call-analytics";
import { loadActiveSop, upsertSopResult, type ActiveSop } from "./call-sop";
import { enqueueDispatch } from "./outbox";
import { detectCallProjects } from "./projects";

/**
 * The enrichment lane (A4): everything a person reads, and nothing a lead needs.
 *
 * Conversation intelligence - Agent/Customer roles, per-turn intents, the
 * summary, sentiment, outcome, quality score and risk flags - used to run
 * alongside the tenant's extraction inside the analyze stage, and the call did
 * not reach SYNCING until BOTH had finished. Since only the extraction produces
 * the lead, every call waited the difference between the two before anybody
 * could see it: roughly another ninety seconds, for a read nobody was watching
 * for.
 *
 * Now the lead lane finishes and publishes here. This lane is slower, cheaper to
 * starve, and safe to fall behind during a burst.
 *
 * WHY DISPATCH LIVES HERE. The CRM payload carries `intelligence`
 * (crm-dispatch.ts), so dispatching from the lead lane would push leads with
 * empty summaries into a customer's own CRM - and a delivered record cannot be
 * recalled. So the send waits for enrichment to reach a TERMINAL state:
 * `done`, `failed` or `skipped`. Never `done` alone - a tenant whose enrichment
 * is permanently broken must still receive their leads, just without the
 * summary.
 */

/**
 * Enrichment gets fewer attempts than the pipeline does.
 *
 * A failure here costs a summary, not a lead, and every attempt is a full
 * conversation read against the provider. Three is enough to ride out a
 * rate-limit or a restart; beyond that it is throwing money at a call whose
 * lead is already safely on the board.
 */
const MAX_ENRICH_ATTEMPTS = Number(process.env.ENRICH_MAX_ATTEMPTS ?? 3);

/** 2m, 8m, 32m - slower than the pipeline's, because nothing is waiting. */
function enrichBackoffSeconds(attempt: number): number {
  return Math.min(120 * 4 ** Math.max(0, attempt - 1), 3600);
}

/**
 * Claim before working: `pending | failed` → `running`.
 *
 * The same optimistic claim every other stage uses, and it is what makes a
 * redelivered message - or the sweeper racing a queue consumer - a no-op rather
 * than a second paid conversation read.
 */
const CLAIM_SQL = `
  UPDATE calls
     SET enrichment_status = 'running',
         enrichment_attempts = enrichment_attempts + 1,
         next_enrichment_at = NULL
   WHERE id = $1
     AND enrichment_status IN ('pending', 'failed')
  RETURNING enrichment_attempts`;

interface EnrichInputs {
  /** Write-once attribution (0068), copied onto the SOP result so the per-person aggregate needs no join. */
  telecallerId: string | null;
  /** Copied onto the SOP result for the same reason - see 0091's call_started_at. */
  startedAt: Date | null;
  text: string | null;
  segments: unknown;
  diarized: boolean | null;
  direction: string | null;
  vocabulary: string[];
  leadId: string | null;
}

/**
 * Release the CRM send this call has been holding.
 *
 * Called on EVERY terminal outcome. `enqueueDispatch` is idempotent per
 * (call, integration) - it upserts crm_sync_log - so a call that somehow
 * reaches here twice queues one send, not two.
 */
async function releaseDispatch(client: PoolClient, orgId: string, callId: string): Promise<void> {
  const {
    rows: [lead],
  } = await client.query<{ id: string }>(
    "SELECT id FROM leads WHERE first_call_id = $1 OR last_call_id = $1 LIMIT 1",
    [callId],
  );
  // `qualified` drives the only_qualified filter on lead-only connectors, and
  // the lead's existence IS the qualification - the lead lane writes one only
  // when qualifyLead said so.
  await enqueueDispatch(client, orgId, callId, lead !== undefined);
}

/** Settle the lane and let the CRM send go. */
async function settle(
  orgId: string,
  callId: string,
  status: "done" | "skipped" | "failed",
): Promise<void> {
  await withOrgContext(orgId, async (client) => {
    await client.query(
      "UPDATE calls SET enrichment_status = $2, next_enrichment_at = NULL WHERE id = $1",
      [callId, status],
    );
    try {
      await releaseDispatch(client, orgId, callId);
    } catch (err) {
      // Dispatch has its own durable retry in crm_sync_log; a failure to even
      // queue it must not leave enrichment unsettled and the call re-swept.
      console.error(`call ${callId}: crm-dispatch enqueue error (non-blocking):`, err);
    }
  });
}

/** Record the failure and schedule another attempt, or give up and release. */
async function failEnrichment(
  orgId: string,
  callId: string,
  attempt: number,
  err: unknown,
): Promise<void> {
  if (attempt >= MAX_ENRICH_ATTEMPTS) {
    console.error(`call ${callId}: enrichment gave up after ${attempt} attempt(s):`, err);
    await settle(orgId, callId, "failed");
    return;
  }
  const backoff = enrichBackoffSeconds(attempt);
  console.error(
    `call ${callId}: enrichment failed (attempt ${attempt}), retrying in ${backoff}s:`,
    err,
  );
  await withOrgContext(orgId, async (client) => {
    await client.query(
      `UPDATE calls
          SET enrichment_status = 'failed',
              next_enrichment_at = now() + make_interval(secs => $2)
        WHERE id = $1`,
      [callId, backoff],
    );
  });
}

/**
 * Enrich one call. The consumer half of `aura.enrich`.
 *
 * Phased like the analyze stage (A1): read, compute with no connection held,
 * write. The provider call in the middle is minutes long, and this lane runs at
 * its own concurrency, so holding a transaction across it would put the pool
 * back in the way of throughput it no longer limits.
 */
export async function enrichCall({ callId, orgId }: PipelineMessage): Promise<void> {
  const attempt = await withOrgContext(orgId, async (client) => {
    const res = await client.query<{ enrichment_attempts: number }>(CLAIM_SQL, [callId]);
    return (res.rowCount ?? 0) > 0 ? Number(res.rows[0]!.enrichment_attempts) : null;
  });
  if (attempt === null) return;

  let loaded: { row: EnrichInputs | undefined; sop: ActiveSop | null } | undefined;
  try {
    loaded = await withOrgContext(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<EnrichInputs>(
        `SELECT t.text, t.segments, t.diarized, c.direction,
                c.telecaller_id AS "telecallerId", c.started_at AS "startedAt", o.vocabulary,
                (SELECT l.id FROM leads l
                  WHERE l.first_call_id = c.id OR l.last_call_id = c.id LIMIT 1) AS "leadId"
           FROM calls c
           JOIN organizations o ON o.id = c.org_id
           LEFT JOIN transcripts t ON t.call_id = c.id
          WHERE c.id = $1`,
        [callId],
      );
      /*
       * The SOP rides out of the SAME transaction as the inputs, and only when
       * ASR reported real acoustic separation.
       *
       * Gated for exactly the reason the talk metrics are (0083, and
       * talk-metrics-gate.test.ts): without diarization every segment maps to
       * the Agent, so a model asked "did the AGENT disclose recording" reads a
       * transcript in which the agent apparently said everything - including
       * the customer's words. That over-credits the agent, and it does so on
       * `consent_disclosure`, the one step with legal weight rather than
       * commercial weight. A false pass there is worse than no score.
       */
      const sop = row?.diarized === true ? await loadActiveSop(client, orgId) : null;
      return { row, sop };
    });
  } catch (err) {
    await failEnrichment(orgId, callId, attempt, err);
    return;
  }

  const input = loaded?.row;
  const sop = loaded?.sop ?? null;

  // No transcript means the call was gated as too short, transcription is off,
  // or ASR genuinely heard nothing. There is nothing to read, and running the
  // analyser over it could only invent one.
  if (!input?.text) {
    await settle(orgId, callId, "skipped");
    return;
  }

  // ── compute: the conversation read, with no connection held ──────────
  const asrSegments: Array<{ speaker?: string; text: string; startMs?: number; endMs?: number }> =
    Array.isArray(input.segments) ? input.segments : [];
  let intel: Awaited<ReturnType<typeof analyzeConversation>>;
  try {
    intel = await analyzeConversation(
      input.text,
      asrSegments,
      input.vocabulary ?? [],
      input.direction,
          // null for an org with no SOP, or a call with no real speaker
      // separation - in both cases the steps never enter the prompt.
      sop?.steps ?? null,
    );
  } catch (err) {
    await failEnrichment(orgId, callId, attempt, err);
    return;
  }

  // Hand ASR's segments to the analyzer so it labels them instead of
  // re-splitting the flat text: ASR owns the boundaries and timings, analyze
  // only adds the Agent/Customer role and the intent.
  const segments = intel.turns.map((turn) => {
    const src = turn.index === null ? undefined : asrSegments[turn.index];
    return {
      speaker: turn.speaker,
      text: turn.text,
      intent: turn.intent,
      // Keep ASR's real offsets; only a re-split turn has none.
      startMs: src?.startMs ?? 0,
      endMs: src?.endMs ?? 0,
    };
  });
  const speakers = new Set(segments.map((s) => s.speaker));
  const summary = {
    summary: intel.summary,
    overall_intent: intel.overall_intent,
    customer_intent: intel.customer_intent,
    agent_intent: intel.agent_intent,
    sentiment: intel.sentiment,
    outcome: intel.outcome,
    key_points: intel.key_points,
    action_items: intel.action_items,
  };

  // ── write ─────────────────────────────────────────────────────────────
  try {
    await withOrgContext(orgId, async (client) => {
      // Enrich, never destroy: if analyze produced no turns, the ASR segments
      // stay exactly as transcribed and only the call-level read is written.
      if (segments.length > 0) {
        await client.query(
          `UPDATE transcripts
             SET segments = $2::jsonb, diarized = $3, intelligence = $4::jsonb
           WHERE call_id = $1`,
          [
            callId,
            JSON.stringify(segments),
            speakers.size >= 2 || input.diarized === true,
            JSON.stringify(summary),
          ],
        );
      } else {
        await client.query(`UPDATE transcripts SET intelligence = $2::jsonb WHERE call_id = $1`, [
          callId,
          JSON.stringify(summary),
        ]);
      }

      if (intel.tokensIn || intel.tokensOut) {
        await client.query(
          `INSERT INTO usage_events (org_id, kind, quantity, unit, ref_id)
           VALUES ($1, 'llm_tokens_in', $2, 'tokens', $3),
                  ($1, 'llm_tokens_out', $4, 'tokens', $3)`,
          [orgId, intel.tokensIn, callId, intel.tokensOut],
        );
      }

      /*
       * The lead's summary is backfilled HERE, not written by the lead lane.
       *
       * `upsertLead` reads `transcripts.intelligence ->> 'summary'`, which by
       * construction is null when the lead is written now - the lane that
       * produces the summary is this one. Without this the board would show a
       * lead with an empty summary forever, which is exactly the regression the
       * split invites.
       *
       * COALESCE so a summary an owner has since edited by hand is not
       * overwritten by a re-run. It only ever fills a blank.
       */
      if (input.leadId) {
        await client.query(
          `UPDATE leads SET summary = COALESCE(NULLIF(summary, ''), $2) WHERE id = $1`,
          [input.leadId, intel.summary],
        );
      }

      /*
       * Talk metrics need REAL speaker separation, not inferred roles (0083).
       *
       * computeTalkMetrics already returns all-nulls when segments carry no
       * usable timing, which covers a transcript the analyzer re-split from
       * flat text. It does NOT cover the case this gate exists for: ASR
       * returning timestamped chunks that all carry the SAME acoustic tag.
       * Those have genuine offsets, so they pass every filter - and because
       * `roleOf` maps the single tag to the Agent, every segment is labelled
       * Agent and the call reports a talk ratio of 1.0 with the customer silent
       * for its entire duration. A confidently wrong coaching number is worse
       * than an absent one, so an undiarized call gets none.
       */
      try {
        await upsertCallAnalytics(client, orgId, callId, {
          talk: input.diarized === true ? computeTalkMetrics(segments) : computeTalkMetrics(null),
          qualityScore: intel.qualityScore,
          qualityCriteria: intel.qualityCriteria,
          riskFlags: intel.riskFlags,
          model: intel.model,
        });
      } catch (err) {
        console.error(`call ${callId}: call-analytics error (non-blocking):`, err);
      }

      /*
       * SOP adherence (0091). Non-blocking, like the analytics above: the lead
       * is already on the board by the time this lane runs, so a scoring
       * failure must not cost the call its enrichment.
       *
       * `sop` is null whenever the steps never went into the prompt - no active
       * SOP, or no acoustic separation - so this writes nothing rather than a
       * row of nulls. The console tells those two cases apart; a checklist of
       * inconclusive steps would look like a rep who failed every one.
       */
      if (sop) {
        try {
          await upsertSopResult(
            client,
            orgId,
            callId,
            input.telecallerId,
            sop,
            intel.sopResults,
            intel.model,
            input.startedAt,
          );
        } catch (err) {
          console.error(`call ${callId}: sop scoring error (non-blocking):`, err);
        }
      }

      // Which of the tenant's own projects this call was about (migration
      // 0073). It reads the summary as one of three evidence sources, so it
      // belongs in this lane, where the summary now exists - in the lead lane
      // it would have been running on two thirds of the evidence.
      try {
        const detected = await detectCallProjects(client, orgId, callId, input.leadId);
        if (detected.hits.length > 0) {
          console.log(
            `call ${callId}: projects ${detected.hits
              .map((h) => `${h.projectId}@${h.confidence}`)
              .join(", ")} (${detected.reason})`,
          );
        }
      } catch (err) {
        console.error(`call ${callId}: project detection error (non-blocking):`, err);
      }

      // Escalation alert (call.risk_flagged). Also this lane's job now, and it
      // is strictly better off here: a tenant's `notify` rule resolves its
      // target off the deal or contact owner, and by this point the lead lane
      // has certainly written both - where before this raced them.
      if (intel.riskFlags.length > 0) {
        try {
          const severityRank: Record<string, number> = { low: 0, medium: 1, high: 2 };
          const highest = intel.riskFlags.reduce((a, b) =>
            (severityRank[b.severity] ?? 0) > (severityRank[a.severity] ?? 0) ? b : a,
          );
          const {
            rows: [owners],
          } = await client.query(
            // `source_lead_id`, not `lead_id` - that is the column the
            // crm-object projection writes (deals_source_lead is unique on it).
            `SELECT d.id AS deal_id, d.owner_user_id AS deal_owner_user_id,
                    ct.id AS contact_id, ct.owner_user_id AS contact_owner_user_id
               FROM leads l
               LEFT JOIN deals d ON d.source_lead_id = l.id
               LEFT JOIN contacts ct ON ct.id = d.contact_id
              WHERE l.id = $1`,
            [input.leadId],
          );
          await client.query(
            `INSERT INTO automation_events (org_id, trigger, subject_type, subject_id, payload)
             VALUES ($1, 'call.risk_flagged', 'call', $2, $3::jsonb)`,
            [
              orgId,
              callId,
              JSON.stringify({
                dealId: owners?.deal_id ?? null,
                contactId: owners?.contact_id ?? null,
                dealOwnerUserId: owners?.deal_owner_user_id ?? null,
                contactOwnerUserId: owners?.contact_owner_user_id ?? null,
                riskSeverity: highest.severity,
              }),
            ],
          );
        } catch (err) {
          console.error(`call ${callId}: risk-flag automation enqueue error (non-blocking):`, err);
        }
      }
    });
  } catch (err) {
    await failEnrichment(orgId, callId, attempt, err);
    return;
  }

  await settle(orgId, callId, "done");
  console.log(`call ${callId}: enriched`);
}

/**
 * The durable half, on the same principle as every other sweep here: the calls
 * table is the queue, so a lost message, a purged broker or a worker killed
 * mid-enrichment is recovered without anybody noticing.
 *
 * It also covers the case a queue cannot: a call whose enrichment failed and is
 * now due for its retry.
 */
export async function sweepEnrichment(limit = 100): Promise<number> {
  const { rows } = await getAdminPool().query<{ id: string; org_id: string }>(
    `SELECT id, org_id
       FROM calls
      WHERE enrichment_status IN ('pending', 'failed')
        AND (next_enrichment_at IS NULL OR next_enrichment_at <= now())
        AND status IN ('COMPLETE', 'SYNCING')
        AND updated_at < now() - interval '5 minutes'
      ORDER BY updated_at
      LIMIT $1`,
    [limit],
  );
  if (rows.length === 0) return 0;

  for (const row of rows) {
    await enrichCall({ callId: row.id, orgId: row.org_id });
  }
  console.log(`enrichment sweep: picked up ${rows.length} call(s)`);
  return rows.length;
}

export function startEnrichmentSweep(): NodeJS.Timeout {
  const interval = Number(process.env.ENRICH_SWEEP_INTERVAL_MS ?? 5 * 60 * 1000);
  let running = false;
  return setInterval(() => {
    if (running) return;
    running = true;
    void sweepEnrichment()
      .catch((err) => console.error("enrichment sweep:", err))
      .finally(() => {
        running = false;
      });
  }, interval);
}
