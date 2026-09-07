/** One person's totals over the requested range. Shapes `GET /v1/owner/productivity`. */
export interface TelecallerProductivityRow {
  telecaller_id: string;
  display_name: string;
  status: string;

  calls_total: number;
  calls_connected: number;
  total_call_seconds: number;
  /** Days in the range on which this person made at least one call. */
  active_days: number;

  /**
   * Every field below is nullable and a null is meaningful, never a zero in
   * disguise - see migration 0090's header. The table renders each one as an
   * em dash with a reason, because a coaching number that is guessed is worse
   * than one that is absent.
   */
  median_gap_seconds: number | null;
  longest_gap_seconds: number | null;
  active_span_seconds: number | null;
  /** Null until the handset presence beacon ships. */
  presence_seconds: number | null;

  /** Null unless the org runs with diarization on (migration 0083). */
  agent_talk_seconds: number | null;
  customer_talk_seconds: number | null;
  mean_talk_ratio: string | number | null;
  interruption_count: number | null;
  /** How many calls actually contributed talk metrics. Read the talk figures against this. */
  talk_sample_calls: number;

  /** Mean SOP adherence 0-100 (migration 0091), or null when nothing was scored. */
  mean_adherence_pct: number | null;
  /** How many calls in the range carried an adherence score. */
  sop_scored_calls: number;
}

export interface ProductivityResponse {
  from: string;
  to: string;
  /** "own" when the viewer is a persona narrowed to their own row. */
  scope: "all" | "own";
  telecallers: TelecallerProductivityRow[];
  benchmarks: {
    calls_total: number | null;
    total_call_seconds: number | null;
    agent_talk_seconds: number | null;
    median_gap_seconds: number | null;
    mean_adherence_pct: number | null;
  };
  /** False when no call in the range carried talk metrics - a cost setting, not a fault. */
  talk_metrics_available: boolean;
  /** False when no SOP is defined, or none of the range's calls could be scored. */
  sop_scoring_available: boolean;
}
