import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { withOrgContext } from "@aura/db";
import { analyzeConversation, analyzeTranscript } from "@aura/llm";
import type { PipelineMessage } from "@aura/queue";
import { ExtractionSchema } from "@aura/shared";
import { transcribe } from "./asr";

const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: process.env.S3_REGION ?? "ap-south-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "aura_minio",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "aura_minio_password",
  },
});
const BUCKET = process.env.S3_BUCKET ?? "aura-recordings";

/**
 * Pipeline stages (design doc §6.2). Each stage advances the Postgres state
 * machine under an optimistic status check, so replays are idempotent and the
 * queue is only a wake-up signal. Terminal states: COMPLETE or FAILED_{STAGE}.
 */
export async function processCall({ callId, orgId }: PipelineMessage): Promise<void> {
  await withOrgContext(orgId, async (client) => {
    const advance = async (from: string, to: string) => {
      const res = await client.query(
        "UPDATE calls SET status = $3 WHERE id = $1 AND status = $2 RETURNING id",
        [callId, from, to],
      );
      return (res.rowCount ?? 0) > 0;
    };

    const fail = async (stage: string, err: unknown) => {
      await client.query("UPDATE calls SET status = $2 WHERE id = $1", [
        callId,
        `FAILED_${stage}`,
      ]);
      console.error(`call ${callId} failed at ${stage}:`, err);
    };

    // ── transcode ────────────────────────────────────────────────────────
    // TODO (checklist §2.3): ffmpeg → 16 kHz mono Opus + device-envelope
    // decrypt. The client already records 16 kHz mono AAC, so pass-through
    // is acceptable until encryption-at-rest lands.
    if (!(await advance("UPLOADED", "TRANSCODING"))) {
      console.log(`call ${callId}: not in UPLOADED, skipping (idempotent replay)`);
      return;
    }

    // ── asr (Gemini) ─────────────────────────────────────────────────────
    if (!(await advance("TRANSCODING", "TRANSCRIBING"))) return;
    try {
      const {
        rows: [rec],
      } = await client.query("SELECT s3_key FROM recordings WHERE call_id = $1", [callId]);
      const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: rec.s3_key }));
      const audio = Buffer.from(await object.Body!.transformToByteArray());

      const result = await transcribe(audio, "audio/mp4");
      // Reprocess re-runs this stage; replace any prior transcript so a call keeps
      // exactly one (otherwise the drawer can show a stale duplicate).
      await client.query("DELETE FROM transcripts WHERE call_id = $1", [callId]);
      await client.query(
        `INSERT INTO transcripts (org_id, call_id, language, engine, text, segments, diarized)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          orgId,
          callId,
          result.language,
          result.engine,
          result.text,
          JSON.stringify(result.segments),
          result.diarized,
        ],
      );
      await client.query(
        `INSERT INTO usage_events (org_id, kind, quantity, unit, ref_id)
         VALUES ($1, 'asr_seconds', (SELECT duration_s FROM calls WHERE id = $2), 'seconds', $2)`,
        [orgId, callId],
      );
    } catch (err) {
      await fail("ASR", err);
      return;
    }

    // ── analyze ──────────────────────────────────────────────────────────
    if (!(await advance("TRANSCRIBING", "ANALYZING"))) return;
    try {
      // Conversation intelligence: diarize (Agent/Customer) + per-turn intent +
      // call-level intent/sentiment/outcome. Always on, non-blocking — a failure
      // here must never fail the whole call (the tenant extraction still runs).
      try {
        const {
          rows: [t],
        } = await client.query(
          "SELECT text, segments, diarized FROM transcripts WHERE call_id = $1",
          [callId],
        );
        if (t?.text) {
          // Hand ASR's segments to the analyzer so it labels them instead of
          // re-splitting the flat text: ASR owns the boundaries and timings,
          // analyze only adds the Agent/Customer role and the intent.
          const asrSegments: Array<{
            speaker?: string;
            text: string;
            startMs?: number;
            endMs?: number;
          }> = Array.isArray(t.segments) ? t.segments : [];
          const intel = await analyzeConversation(t.text, asrSegments);
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
          // Enrich, never destroy: if analyze produced no turns, the ASR
          // segments stay exactly as transcribed and only the call-level
          // intelligence is written.
          if (segments.length > 0) {
            await client.query(
              `UPDATE transcripts
                 SET segments = $2::jsonb, diarized = $3, intelligence = $4::jsonb
               WHERE call_id = $1`,
              [
                callId,
                JSON.stringify(segments),
                speakers.size >= 2 || t.diarized === true,
                JSON.stringify(summary),
              ],
            );
          } else {
            await client.query(
              `UPDATE transcripts SET intelligence = $2::jsonb WHERE call_id = $1`,
              [callId, JSON.stringify(summary)],
            );
          }
          if (intel.tokensIn || intel.tokensOut) {
            await client.query(
              `INSERT INTO usage_events (org_id, kind, quantity, unit, ref_id)
               VALUES ($1, 'llm_tokens_in', $2, 'tokens', $3),
                      ($1, 'llm_tokens_out', $4, 'tokens', $3)`,
              [orgId, intel.tokensIn, callId, intel.tokensOut],
            );
          }
        }
      } catch (err) {
        console.error(`call ${callId}: conversation-intelligence error (non-blocking):`, err);
      }

      const {
        rows: [agent],
      } = await client.query(
        `SELECT a.id, a.version, a.system_prompt, a.field_schema FROM agents a
          JOIN calls c ON c.workspace_id = a.workspace_id
         WHERE c.id = $1 AND a.is_active = true
         ORDER BY a.version DESC LIMIT 1`,
        [callId],
      );
      if (agent) {
        const {
          rows: [transcript],
        } = await client.query("SELECT text FROM transcripts WHERE call_id = $1", [callId]);
        const schema = ExtractionSchema.parse(agent.field_schema);
        const result = await analyzeTranscript(agent.system_prompt, schema, transcript.text);

        await client.query(
          `INSERT INTO ai_outputs
             (org_id, call_id, agent_id, agent_version, output, provider, model,
              tokens_in, tokens_out, validation_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            orgId,
            callId,
            agent.id,
            agent.version,
            JSON.stringify(result.output),
            result.provider,
            result.model,
            result.tokensIn,
            result.tokensOut,
            result.validationStatus,
          ],
        );
        await client.query(
          `UPDATE calls SET agent_id = $2, agent_version = $3 WHERE id = $1`,
          [callId, agent.id, agent.version],
        );

        // call_facts projection — consumer (c) of the single field definition
        if (result.validationStatus !== "failed") {
          for (const field of schema.fields) {
            const value = result.output[field.key];
            if (value === undefined || value === null) continue;
            await client.query(
              `INSERT INTO call_facts (org_id, call_id, field_key, value_text, value_num, value_bool)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (call_id, field_key) DO UPDATE
                 SET value_text = EXCLUDED.value_text,
                     value_num = EXCLUDED.value_num,
                     value_bool = EXCLUDED.value_bool`,
              [
                orgId,
                callId,
                field.key,
                field.type === "number" || field.type === "boolean"
                  ? null
                  : Array.isArray(value)
                    ? JSON.stringify(value)
                    : String(value),
                field.type === "number" ? (value as number) : null,
                field.type === "boolean" ? (value as boolean) : null,
              ],
            );
          }
        }

        await client.query(
          `INSERT INTO usage_events (org_id, kind, quantity, unit, ref_id)
           VALUES ($1, 'llm_tokens_in', $2, 'tokens', $3), ($1, 'llm_tokens_out', $4, 'tokens', $3)`,
          [orgId, result.tokensIn, callId, result.tokensOut],
        );
      }
    } catch (err) {
      await fail("ANALYZE", err);
      return;
    }

    // ── crm-dispatch ─────────────────────────────────────────────────────
    if (!(await advance("ANALYZING", "SYNCING"))) return;
    // Generic webhook connector: POST call summary + facts to the tenant URL.
    // Failures are logged in crm_sync_log and NEVER block completion (§6.2).
    // TODO (checklist §2.3): HubSpot connector with field mapping + backoff retries.
    try {
      const {
        rows: [integration],
      } = await client.query(
        `SELECT ci.id, ci.auth FROM crm_integrations ci
          JOIN calls c ON c.workspace_id = ci.workspace_id
         WHERE c.id = $1 AND ci.provider = 'generic_webhook' AND ci.status = 'connected'
         LIMIT 1`,
        [callId],
      );
      if (integration) {
        const {
          rows: [payload],
        } = await client.query(
          `SELECT c.id, c.direction, c.started_at, c.duration_s, c.status,
                  t.text AS transcript,
                  (SELECT jsonb_object_agg(f.field_key,
                            COALESCE(to_jsonb(f.value_num), to_jsonb(f.value_bool), to_jsonb(f.value_text)))
                     FROM call_facts f WHERE f.call_id = c.id) AS facts
             FROM calls c LEFT JOIN transcripts t ON t.call_id = c.id
            WHERE c.id = $1`,
          [callId],
        );
        const url = (integration.auth as { url?: string }).url;
        let status = "failed";
        let error: string | null = null;
        let httpStatus: number | null = null;
        try {
          const res = await fetch(url!, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ event: "call.completed", call: payload }),
            signal: AbortSignal.timeout(10_000),
          });
          httpStatus = res.status;
          status = res.ok ? "synced" : "failed";
          if (!res.ok) error = `webhook returned ${res.status}`;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
        }
        await client.query(
          `INSERT INTO crm_sync_log (org_id, call_id, integration_id, status, external_id, error, attempts)
           VALUES ($1, $2, $3, $4, $5, $6, 1)`,
          [orgId, callId, integration.id, status, httpStatus ? String(httpStatus) : null, error],
        );
      }
    } catch (err) {
      console.error(`call ${callId}: crm-dispatch error (non-blocking):`, err);
    }

    await advance("SYNCING", "COMPLETE");
    console.log(`call ${callId}: COMPLETE`);
  });
}
