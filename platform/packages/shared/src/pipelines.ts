import { DEFAULT_LEAD_STAGES, LeadStage, LeadStages, entryStage, statusForStage } from "./leads";

/**
 * A Deal pipeline's stage list (packages/db/migrations/0034).
 *
 * Reuses LeadStage's exact shape — {key,label,terminal?} — deliberately: a
 * pipeline stage and a lead board column are the same kind of thing (a
 * tenant-renameable board column with an optional won/lost marker), and
 * duplicating the shape under a new name would just be two definitions to
 * keep in sync by hand.
 */
export const PipelineStage = LeadStage;
export type PipelineStage = LeadStage;

export const PipelineStages = LeadStages;
export type PipelineStages = LeadStages;

/** Mirrors 0034's seed, which itself mirrors organizations.lead_stages. */
export const DEFAULT_PIPELINE_STAGES: PipelineStages = DEFAULT_LEAD_STAGES;

/** Same fallback-to-default tolerance as parseLeadStages — bad config must not take the board down. */
export function parsePipelineStages(raw: unknown): PipelineStages {
  const parsed = PipelineStages.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_PIPELINE_STAGES;
}

/** The status a deal takes when it lands in this stage — same rule as leads. */
export const statusForPipelineStage = statusForStage;

/** First non-terminal column — where a newly created deal enters the board. */
export const pipelineEntryStage = entryStage;
