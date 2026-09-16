import { z } from "zod";

/**
 * The lead pipeline's domain rules: which calls become leads, and what the
 * board's columns are.
 *
 * Pure by design (no db, no fetch, no node builtins) for the same reason
 * crm-template is: the worker qualifies a call with these functions, the API
 * validates a stage move with them, and the web console renders columns from
 * them. One definition, three consumers - a board column the API rejects can
 * never appear in the UI.
 */

// ── stages ──────────────────────────────────────────────────────────────

/**
 * A board column. `terminal` marks the closed columns: dropping a card there is
 * what flips leads.status, so a tenant renaming "Won" to "Order Placed" keeps
 * working. Stages without it are open.
 */
export const LeadStage = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "snake_case identifier required")
    .max(40),
  label: z.string().min(1).max(60),
  terminal: z.enum(["won", "lost"]).optional(),
});
export type LeadStage = z.infer<typeof LeadStage>;

export const LeadStages = z.array(LeadStage).min(1).max(16);
export type LeadStages = z.infer<typeof LeadStages>;

/** Mirrors the organizations.lead_stages default in migration 0010. */
export const DEFAULT_LEAD_STAGES: LeadStages = [
  { key: "new", label: "New" },
  { key: "contacted", label: "Contacted" },
  { key: "qualified", label: "Qualified" },
  { key: "negotiation", label: "Negotiation" },
  { key: "won", label: "Won", terminal: "won" },
  { key: "lost", label: "Lost", terminal: "lost" },
];

export const LeadStatus = z.enum(["open", "won", "lost"]);
export type LeadStatus = z.infer<typeof LeadStatus>;

/**
 * Read a tenant's stage list, falling back to the defaults.
 *
 * A malformed column list must not take the board down - an owner would see an
 * error page instead of their pipeline, which is a worse failure than showing
 * the standard columns.
 */
export function parseLeadStages(raw: unknown): LeadStages {
  const parsed = LeadStages.safeParse(raw);
  return parsed.success ? parsed.data : DEFAULT_LEAD_STAGES;
}

/** The status a lead takes when it lands in this stage. */
export function statusForStage(stages: LeadStages, stageKey: string): LeadStatus {
  return stages.find((s) => s.key === stageKey)?.terminal ?? "open";
}

/** First non-terminal column - where a newly qualified lead enters the board. */
export function entryStage(stages: LeadStages): string {
  return (stages.find((s) => !s.terminal) ?? stages[0]).key;
}

/**
 * The next OPEN column after `key`, or null when there is none.
 *
 * Terminal columns are skipped rather than returned: advancing a lead is a
 * statement that the conversation progressed, and nothing automatic should
 * ever decide that a deal was won or lost. A tenant whose board is
 * [New, Won, Lost] therefore has nowhere to advance to, and gets null.
 */
export function stageAfter(stages: LeadStages, key: string): string | null {
  const index = stages.findIndex((s) => s.key === key);
  if (index < 0) return null;
  return stages.slice(index + 1).find((s) => !s.terminal)?.key ?? null;
}

// ── qualification ───────────────────────────────────────────────────────

/**
 * Which extractions become leads, and how the card is labelled.
 *
 * Stored per agent version (agents.lead_rules) because the field keys below
 * only mean anything against that agent's extraction schema.
 */
export const LeadRules = z.object({
  /** Every key must be filled. */
  requiredFields: z.array(z.string().max(64)).max(32).default([]),
  /** At least one of these must be filled. Empty = no such constraint. */
  anyFields: z.array(z.string().max(64)).max(32).default([]),
  /** Floor on the number of filled fields, whichever they are. */
  minFilled: z.number().int().min(0).max(64).default(1),
  /** Field to use as the card heading. */
  titleField: z.string().max(64).optional(),
  /** Numeric field to show as the deal value. */
  valueField: z.string().max(64).optional(),
  /**
   * Qualify even when the extraction failed validation. Off by default: a
   * failed extraction is a guess, and a board full of guesses is noise.
   */
  allowFailedValidation: z.boolean().default(false),
});
export type LeadRules = z.infer<typeof LeadRules>;

export const DEFAULT_LEAD_RULES: LeadRules = LeadRules.parse({});

/** Same tolerance as parseLeadStages: bad config falls back, never throws. */
export function parseLeadRules(raw: unknown): LeadRules {
  const parsed = LeadRules.safeParse(raw ?? {});
  return parsed.success ? parsed.data : DEFAULT_LEAD_RULES;
}

/**
 * Did the call actually say anything for this field?
 *
 * The LLM returns `null` for "not mentioned", and the call_facts projection
 * stores empty strings and empty arrays for the same thing, so all three have
 * to count as absent - otherwise every wrong number qualifies as a lead.
 */
export function isFilled(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "" && value.trim() !== "[]";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export interface LeadQualification {
  qualified: boolean;
  /** Why not - surfaced in worker logs, so a tenant can see why a call was skipped. */
  reason: string;
  /** facts[titleField], when the rules named one and the call filled it. */
  title: string | null;
  /** facts[valueField] as a number, when it parses as one. */
  valueNum: number | null;
  filled: number;
}

/**
 * Decide whether one call's extraction is a lead.
 *
 * The default rule (`{}`) is "validation didn't fail and something came back
 * filled". That is deliberately the loosest useful test: a wrong number or a
 * one-sided recording extracts nothing and is rejected, while a real enquiry
 * always fills at least one field. Tenants that want a stricter board set
 * requiredFields / anyFields / minFilled on the agent.
 */
export function qualifyLead(
  facts: Record<string, unknown>,
  validationStatus: string | null,
  rules: LeadRules = DEFAULT_LEAD_RULES,
): LeadQualification {
  const filled = Object.values(facts).filter(isFilled).length;
  const titleRaw = rules.titleField ? facts[rules.titleField] : null;
  const valueRaw = rules.valueField ? facts[rules.valueField] : null;
  const valueNum = Number(valueRaw);

  const result: Omit<LeadQualification, "qualified" | "reason"> = {
    title: isFilled(titleRaw) ? String(titleRaw).trim() : null,
    valueNum: isFilled(valueRaw) && Number.isFinite(valueNum) ? valueNum : null,
    filled,
  };
  const no = (reason: string): LeadQualification => ({ ...result, qualified: false, reason });

  if (validationStatus === "failed" && !rules.allowFailedValidation) {
    return no("extraction failed validation");
  }
  const missing = rules.requiredFields.filter((key) => !isFilled(facts[key]));
  if (missing.length > 0) return no(`missing required field(s): ${missing.join(", ")}`);

  if (rules.anyFields.length > 0 && !rules.anyFields.some((key) => isFilled(facts[key]))) {
    return no(`none of the qualifying fields were filled: ${rules.anyFields.join(", ")}`);
  }
  if (filled < rules.minFilled) {
    return no(`only ${filled} field(s) extracted, ${rules.minFilled} required`);
  }

  return { ...result, qualified: true, reason: "qualified" };
}

/**
 * Merge a follow-up call's extraction into the lead's existing facts.
 *
 * New values win, but only where the new call actually said something: a
 * follow-up about delivery dates must not blank the budget the first call
 * established.
 */
export function mergeFacts(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (isFilled(value)) out[key] = value;
  }
  return out;
}

// -- temperature ---------------------------------------------------------

/**
 * How warm a lead is, independent of where it sits in the funnel.
 *
 * Stage and temperature answer different questions and a board needs both:
 * stage is how far along the conversation has got, temperature is whether it
 * is worth having. A lead can sit in Negotiation and be going cold, and that
 * pairing is exactly the one a manager wants to see - which is why these are a
 * chip on the card and not three more columns. Columns would force each lead
 * into one or the other.
 */
export const LeadTemperature = z.enum(["hot", "medium", "cold"]);
export type LeadTemperature = z.infer<typeof LeadTemperature>;

export const LEAD_TEMPERATURE_LABELS: Record<LeadTemperature, string> = {
  hot: "Hot",
  medium: "Medium",
  cold: "Cold",
};

/** Hottest first - the order the console lists them in, everywhere. */
export const LEAD_TEMPERATURE_ORDER: LeadTemperature[] = ["hot", "medium", "cold"];

/** Who last set the rating. See migration 0083 for why this is tracked. */
export const LeadTemperatureSource = z.enum(["auto", "user"]);
export type LeadTemperatureSource = z.infer<typeof LeadTemperatureSource>;

/** What the call analysis heard, reduced to the parts that predict interest. */
export interface LeadTemperatureSignals {
  /** `transcripts.intelligence -> 'outcome'`. */
  outcome: string | null;
  /** `transcripts.intelligence -> 'sentiment'`. */
  sentiment: string | null;
  /** A money figure the extraction produced, if any. */
  valueNum: number | null;
}

/**
 * Outcomes that settle the question on their own, whatever else was said.
 *
 * Checked BEFORE any positive signal, deliberately. A customer can decline
 * warmly - "no thank you, that is very kind" reads as `not_interested` with
 * `positive` sentiment, and production has exactly that row. Reading the
 * sentiment first would file a polite refusal as Hot, which is the single most
 * expensive mistake this function can make: it puts a telecaller's next hour
 * into someone who already said no.
 */
const CLOSING_OUTCOMES = new Set(["not_interested", "wrong_number", "no_answer"]);

/** Outcomes where the customer asked for the conversation to continue. */
const ENGAGED_OUTCOMES = new Set(["interested", "follow_up", "callback"]);

/**
 * Rate a lead from one call.
 *
 * Only ever returns a rating from evidence. `null` means the call said nothing
 * either way - no analysis, or an outcome this build does not recognise - and
 * a null must not overwrite a rating an earlier call established, so callers
 * COALESCE rather than assign.
 */
export function deriveLeadTemperature(signals: LeadTemperatureSignals): LeadTemperature | null {
  const outcome = signals.outcome?.trim().toLowerCase() || null;
  const sentiment = signals.sentiment?.trim().toLowerCase() || null;

  if (outcome && CLOSING_OUTCOMES.has(outcome)) return "cold";
  if (sentiment === "negative") return "cold";

  // A figure on the table is the strongest signal available that is not the
  // model's own opinion: somebody quoted, and somebody asked what it costs.
  if (signals.valueNum !== null && signals.valueNum > 0) return "hot";

  if (outcome === "interested") return "hot";
  if (sentiment === "positive" && outcome && ENGAGED_OUTCOMES.has(outcome)) return "hot";

  if (outcome && ENGAGED_OUTCOMES.has(outcome)) return "medium";
  if (sentiment === "positive" || sentiment === "neutral") return "medium";

  return null;
}

/**
 * The card heading for a lead, and the display name of the contact and deal
 * projected from it.
 *
 * Falls back the same way the Call Explorer labels a call: extracted name →
 * the number's leading digits → nothing identifiable. An owner should never
 * see a raw uuid on a board card.
 *
 * Lives here, not in the worker, because the API writes the same projection
 * (doc 23, B3) and the two must name a record identically - UNMATCHABLE_DISPLAY_NAMES
 * in dedupe.ts is matched against exactly this output.
 */
export function leadTitle(
  extractedName: string | null,
  remoteName: string | null,
  numberPrefix: string | null,
  numberLast3: string | null,
): string {
  const name = extractedName?.trim() || remoteName?.trim();
  if (name) return name.slice(0, 200);
  if (numberPrefix) return `${numberPrefix}…`;
  if (numberLast3) return `…${numberLast3}`;
  return "Unknown caller";
}
