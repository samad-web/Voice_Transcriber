import type { PoolClient } from "@aura/db";
import type { QualityCriteria, RiskFlag } from "@aura/llm";

/**
 * Talk-ratio / interruption coaching metrics - computed in plain TypeScript
 * over the diarized segments a call already has (see pipeline.ts's
 * conversation-intelligence step), not a second LLM call. Every field is
 * null when there is nothing usable to compute from, never a misleading 0.
 */
export interface TalkMetrics {
  agentTalkSeconds: number | null;
  customerTalkSeconds: number | null;
  /** agent seconds / total seconds, 0-1. */
  talkRatio: number | null;
  interruptionCount: number | null;
  longestMonologueSeconds: number | null;
}

interface RoleSegment {
  speaker?: string | null;
  startMs?: number | null;
  endMs?: number | null;
}

const NO_METRICS: TalkMetrics = {
  agentTalkSeconds: null,
  customerTalkSeconds: null,
  talkRatio: null,
  interruptionCount: null,
  longestMonologueSeconds: null,
};

/**
 * Requires role-labelled segments (`speaker: "Agent"|"Customer"`), which only
 * exist once the conversation-intelligence step has run - raw ASR segments
 * carry acoustic tags (S1/S2), not roles. Malformed or missing timing on a
 * segment drops that segment rather than throwing.
 */
export function computeTalkMetrics(segments: RoleSegment[] | null | undefined): TalkMetrics {
  const usable = (segments ?? []).filter(
    (s): s is { speaker: "Agent" | "Customer"; startMs: number; endMs: number } =>
      Boolean(s) &&
      (s.speaker === "Agent" || s.speaker === "Customer") &&
      typeof s.startMs === "number" &&
      typeof s.endMs === "number" &&
      s.endMs > s.startMs,
  );
  if (usable.length === 0) return NO_METRICS;

  // Segments normally arrive in speaking order already; sort defensively
  // since everything below assumes it.
  const sorted = [...usable].sort((a, b) => a.startMs - b.startMs);

  let agentMs = 0;
  let customerMs = 0;
  let interruptions = 0;
  let longestRunMs = 0;
  let runSpeaker: "Agent" | "Customer" | null = null;
  let runMs = 0;

  for (let i = 0; i < sorted.length; i++) {
    const seg = sorted[i];
    const durationMs = seg.endMs - seg.startMs;
    if (seg.speaker === "Agent") agentMs += durationMs;
    else customerMs += durationMs;

    // A monologue is a RUN of consecutive turns from the same speaker, not a
    // single segment - three quick turns from one side with no reply is one
    // monologue, not three.
    if (seg.speaker === runSpeaker) {
      runMs += durationMs;
    } else {
      longestRunMs = Math.max(longestRunMs, runMs);
      runSpeaker = seg.speaker;
      runMs = durationMs;
    }

    // Genuine interruption: the next speaker's turn started before this one
    // ended - overlapping speech, not just a fast back-and-forth. Diarized
    // ASR only reports this when it actually detected simultaneous speech,
    // so this degrades to 0 (not a false signal) on a system that never does.
    const next = sorted[i + 1];
    if (next && next.speaker !== seg.speaker && next.startMs < seg.endMs) {
      interruptions++;
    }
  }
  longestRunMs = Math.max(longestRunMs, runMs);

  const totalMs = agentMs + customerMs;
  return {
    agentTalkSeconds: Math.round(agentMs / 1000),
    customerTalkSeconds: Math.round(customerMs / 1000),
    talkRatio: totalMs > 0 ? Number((agentMs / totalMs).toFixed(3)) : null,
    interruptionCount: interruptions,
    longestMonologueSeconds: Math.round(longestRunMs / 1000),
  };
}

export interface CallAnalyticsWrite {
  talk?: TalkMetrics;
  qualityScore?: number | null;
  qualityCriteria?: QualityCriteria | null;
  riskFlags?: RiskFlag[];
  model?: string | null;
}

/**
 * One row per call, written independently of whether the LLM half or the
 * pure-computation half succeeded - COALESCE keeps whichever half a re-entry
 * (poller resume, manual reprocess) already wrote instead of overwriting it
 * with nulls, the same "enrich, never destroy" rule pipeline.ts's segment
 * merge already follows.
 */
export async function upsertCallAnalytics(
  client: PoolClient,
  orgId: string,
  callId: string,
  data: CallAnalyticsWrite,
): Promise<void> {
  const talk = data.talk ?? NO_METRICS;
  const riskFlags = data.riskFlags ?? [];
  await client.query(
    `INSERT INTO call_analytics (
       org_id, call_id, quality_score, quality_criteria,
       agent_talk_seconds, customer_talk_seconds, talk_ratio,
       interruption_count, longest_monologue_seconds,
       risk_flags, has_escalation_risk, model
     ) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10::jsonb, $11, $12)
     ON CONFLICT (call_id) DO UPDATE SET
       quality_score             = COALESCE(EXCLUDED.quality_score, call_analytics.quality_score),
       quality_criteria          = COALESCE(EXCLUDED.quality_criteria, call_analytics.quality_criteria),
       agent_talk_seconds        = COALESCE(EXCLUDED.agent_talk_seconds, call_analytics.agent_talk_seconds),
       customer_talk_seconds     = COALESCE(EXCLUDED.customer_talk_seconds, call_analytics.customer_talk_seconds),
       talk_ratio                = COALESCE(EXCLUDED.talk_ratio, call_analytics.talk_ratio),
       interruption_count        = COALESCE(EXCLUDED.interruption_count, call_analytics.interruption_count),
       longest_monologue_seconds = COALESCE(EXCLUDED.longest_monologue_seconds, call_analytics.longest_monologue_seconds),
       risk_flags                = CASE WHEN jsonb_array_length(EXCLUDED.risk_flags) > 0
                                         THEN EXCLUDED.risk_flags ELSE call_analytics.risk_flags END,
       has_escalation_risk       = EXCLUDED.has_escalation_risk OR call_analytics.has_escalation_risk,
       model                     = COALESCE(EXCLUDED.model, call_analytics.model),
       updated_at                = now()`,
    [
      orgId,
      callId,
      data.qualityScore ?? null,
      data.qualityCriteria ? JSON.stringify(data.qualityCriteria) : null,
      talk.agentTalkSeconds,
      talk.customerTalkSeconds,
      talk.talkRatio,
      talk.interruptionCount,
      talk.longestMonologueSeconds,
      JSON.stringify(riskFlags),
      riskFlags.length > 0,
      data.model ?? null,
    ],
  );
}
