import type { LeadTemperature } from "@aura/shared";

/** Shapes returned by /v1/owner/* and /v1/leads - shared by all three pages. */

export interface Stage {
  key: string;
  label: string;
  terminal?: "won" | "lost";
}

export interface Lead {
  id: string;
  title: string;
  stage: string;
  status: "open" | "won" | "lost";
  score: string | number | null;
  value_num: string | number | null;
  summary: string | null;
  next_action: string | null;
  notes: string | null;
  facts: Record<string, unknown>;
  contact_name: string | null;
  contact_number_prefix: string | null;
  contact_number_last3: string | null;
  call_count: number;
  last_activity_at: string;
  stage_changed_at: string;
  created_at: string;
  telecaller_device_id: string | null;
  last_call_id: string | null;
  telecaller: string | null;
  /**
   * How warm the lead is (migration 0083), independent of its stage - a card
   * can be in Negotiation and going cold, which is the pairing worth seeing.
   *
   * `temperature_source` rides along for the same reason `project_source`
   * does: "the call analysis rated this" and "a colleague rated this" are not
   * the same claim, and the card says which.
   */
  temperature: LeadTemperature | null;
  temperature_source: "auto" | "user";
  /**
   * Which of the tenant's offerings this lead is for (migration 0073),
   * joined from crm_projects so a card can render without a second lookup.
   *
   * `project_source` is deliberately on the wire rather than internal, for
   * the same reason RecordCustomField.source is: "the detector guessed this
   * from the call" and "a colleague set this" carry very different weight
   * when someone is deciding whether to act on the label.
   */
  project_id: string | null;
  project_source: "extraction" | "human" | "automation" | "import" | null;
  project_key: string | null;
  project_name: string | null;
  project_color: string | null;
  /**
   * The AI read of the call that most recently touched this lead.
   *
   * OPTIONAL BECAUSE THE KEYS ARE ABSENT, NOT NULL, for a tenant without the
   * `call_intel` module - the API leaves the columns out of the query entirely
   * (owner/leads.controller.ts). That distinction is load-bearing: `undefined`
   * means "this client is not entitled to call intelligence" and `null` means
   * "this lead has no read yet", and the list uses the first to decide whether
   * the column exists at all. Reading it as a plain nullable would put an
   * always-empty column in front of every other tenant.
   */
  call_intent?: string | null;
  call_sentiment?: string | null;
  call_outcome?: string | null;
}

/** One row of the tenant's project catalogue - `GET /v1/projects`. */
export interface Project {
  id: string;
  key: string;
  name: string;
  description: string | null;
  color: string | null;
  aliases: string[];
  active: boolean;
  sort_order: number;
  lead_count: number;
  open_count: number;
  won_value: string | number | null;
  call_count: number;
  created_at: string;
  updated_at: string;
}

export interface BoardColumn extends Stage {
  count: number;
  value: number;
  leads: Lead[];
}

export interface LeadCall {
  id: string;
  direction: string;
  started_at: string;
  duration_s: number;
  status: string;
  telecaller: string | null;
  /**
   * Per-call read, present only with the `call_intel` module - same
   * absent-vs-null contract as the lead-level fields above.
   *
   * `has_transcript` is separate from the read on purpose: a call can be
   * analysed and still have no text stored, and offering "read transcript" on
   * one of those opens an empty panel.
   */
  intent?: string | null;
  sentiment?: string | null;
  outcome?: string | null;
  has_transcript?: boolean | null;
  quality_score?: string | number | null;
}

/** One line of a diarized transcript - the shape the ASR pipeline stores. */
/**
 * The coaching breakdown behind `quality_score` - the same four criteria the
 * operator drawer shows, because a manager reading "74/100" needs to know
 * which part of the call earned it.
 */
export interface QualityCriteria {
  consentDisclosed: boolean;
  /** 0-10: did the agent follow the pitch/script. */
  scriptAdherence: number;
  /** 0-10: tone, courtesy, no talking over the customer. */
  professionalism: number;
  /** 0-10: did the agent ask for the sale/next step, handle objections. */
  conversionSignal: number;
  /** One short sentence - why this score. */
  rationale: string | null;
}

/** One compliance/escalation-worthy moment the model noticed in the call. */
export interface RiskFlag {
  category: string;
  snippet: string;
  severity: "low" | "medium" | "high";
}

/**
 * `call_analytics` for one call, as both call-shaped endpoints return it.
 *
 * ONE type rather than a copy per response. `quality_score` and the talk
 * metrics are what the console shows a manager about their own floor, and the
 * lead drawer and the call log are read side by side - a shape that drifted
 * between them would let the same conversation score differently depending on
 * which screen it was opened from.
 *
 * Numeric columns arrive as strings from `pg` for the NUMERIC ones and as
 * numbers for the INTEGER ones, hence the union - run them through `num()`
 * rather than trusting either.
 */
export interface CallAnalytics {
  quality_score: string | number | null;
  quality_criteria: QualityCriteria | null;
  talk_ratio: string | number | null;
  agent_talk_seconds: number | null;
  customer_talk_seconds: number | null;
  interruption_count: number | null;
  risk_flags: RiskFlag[] | null;
  has_escalation_risk: boolean | null;
}

/** A reviewer note on a call (`call_notes`), newest first. */
export interface CallNote {
  id: string;
  body: string;
  author: string | null;
  created_at: string;
}

export interface CallSegment {
  speaker?: string | null;
  text: string;
  intent?: string | null;
  startMs?: number | null;
  endMs?: number | null;
}

/** The LLM's read of a whole call (`transcripts.intelligence`). */
export interface CallIntelligence {
  summary?: string;
  overall_intent?: string;
  customer_intent?: string;
  agent_intent?: string;
  sentiment?: string;
  outcome?: string;
  key_points?: string[];
  action_items?: string[];
}

/**
 * `GET /v1/leads/:id/calls/:callId` - one call in full.
 *
 * `transcriptRedacted` is the API telling the console that the text was
 * withheld for THIS reader (their membership's `recordings_listen`), not that
 * there is none - the two look identical on the wire otherwise, and rendering
 * "no transcript" over a withheld one would be a lie about the record.
 */
export interface LeadCallDetail {
  call: LeadCall;
  transcript: {
    language: string | null;
    engine: string | null;
    diarized: boolean | null;
    text: string | null;
    segments: CallSegment[] | null;
    intelligence: CallIntelligence | null;
  } | null;
  analytics: CallAnalytics | null;
  transcriptRedacted: boolean;
}

/**
 * A row of the client's own call log - `GET /v1/owner/calls`.
 *
 * Deliberately NOT the operator explorer's row shape. That one carries the
 * pipeline's internals (attempt counts, next_attempt_at, error_message, the
 * instance it belongs to) because the operator acts on them; a client is shown
 * what the call was about and which lead it produced.
 */
export interface OwnerCall {
  id: string;
  direction: string;
  started_at: string;
  duration_s: number;
  status: string;
  remote_name: string | null;
  remote_number_prefix: string | null;
  remote_number_last3: string | null;
  device_id: string | null;
  telecaller: string | null;
  intent: string | null;
  sentiment: string | null;
  outcome: string | null;
  summary: string | null;
  has_transcript: boolean | null;
  quality_score: string | number | null;
  /** The lead this call produced or advanced, for the link back. */
  lead_id: string | null;
  lead_title: string | null;
}

/**
 * How one call scored against the tenant's SOP (migration 0091).
 *
 * `sop_steps` is the step list from the VERSION that judged this call, not the
 * active one - so a step renamed since is still shown under the wording it was
 * scored against.
 */
export interface CallSopResult {
  sop_id: string;
  sop_version: number;
  sop_name: string | null;
  /** Null when that SOP version has since been deleted; the checklist then renders by key. */
  sop_steps: Array<{ key: string; label: string; description: string; required: boolean }> | null;
  step_results: Array<{
    key: string;
    /** true / false / null - null is "the call did not settle it", never a miss. */
    met: boolean | null;
    /** A verbatim quote. Null when absent, or withheld - see evidence_redacted. */
    evidence: string | null;
  }>;
  steps_met: number | null;
  steps_total: number | null;
  adherence_pct: number | null;
  /** True when the quotes were stripped because this reader may not read the transcript. */
  evidence_redacted?: boolean;
}

/** `GET /v1/owner/calls/:id` - see LeadCallDetail for `transcriptRedacted`. */
export interface OwnerCallDetail {
  call: OwnerCall;
  transcript: {
    language: string | null;
    engine: string | null;
    diarized: boolean | null;
    text: string | null;
    segments: CallSegment[] | null;
    intelligence: CallIntelligence | null;
  } | null;
  analytics: CallAnalytics | null;
  /** What the AI pulled out of the conversation, as key/value pairs. */
  facts: Array<{
    field_key: string;
    value_text: string | null;
    value_num: string | number | null;
    value_bool: boolean | null;
  }>;
  /** Null when no SOP is active, or the call had no speaker separation to score from. */
  sop: CallSopResult | null;
  transcriptRedacted: boolean;
}

export interface Telecaller {
  id: string;
  label: string | null;
  telecaller_name: string | null;
  status: string;
  last_seen_at: string | null;
  calls: number;
  talk_seconds: number;
  last_call_at: string | null;
  leads: number;
  won: number;
  pipeline_value: number;
}

export interface Overview {
  org: { id: string; name: string };
  window: { days: number };
  leads: {
    total: number;
    open: number;
    won: number;
    lost: number;
    created_in_window: number;
    pipeline_value: number;
    won_value: number;
  };
  calls: { total: number; complete: number; total_seconds: number };
  funnel: Array<Stage & { count: number; value: number }>;
  stages: Stage[];
  telecallers: Telecaller[];
  byDay: Array<{ day: string; calls: number; leads: number }>;
  recent: Array<{
    id: string;
    title: string;
    stage: string;
    status: string;
    value_num: string | number | null;
    last_activity_at: string;
    telecaller: string | null;
  }>;
  /**
   * Where demand arrived from (migration 0078's `source_channel`), rolled up
   * for the marketing dashboard. Present on EVERY response regardless of who
   * asked - see the API's own note on why the shape does not vary by persona.
   */
  bySource: Array<{ channel: string; leads: number; won: number; won_value: number }>;
  /** The same, per campaign (`marketing_sources`). Top 8 by lead count. */
  byCampaign: Array<{ id: string; name: string; leads: number; won: number; won_value: number }>;
  /**
   * Open follow-ups for whoever is asking. NOT windowed by `?days=` - a task
   * three months overdue is more urgent than one due tomorrow, so the API
   * deliberately ignores the reporting window here.
   */
  tasks: { open: number; overdue: number; due_today: number; undated: number };
}

/** numeric columns arrive from pg as strings; one place to make them numbers. */
export function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Compact money formatting - a board card has no room for "1,250,000". */
export function formatValue(value: string | number | null | undefined): string {
  const n = num(value);
  if (n === null) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

export function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** "3 days ago" without pulling in a date library. */
export function relativeTime(iso: string | null): string {
  if (!iso) return "-";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "-";
  const diff = Date.now() - then;
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function contactLabel(lead: Lead): string {
  if (lead.contact_number_prefix) return `${lead.contact_number_prefix}…`;
  if (lead.contact_number_last3) return `…${lead.contact_number_last3}`;
  return "no number";
}

/**
 * CRM Phase 1 foundation (E0.1) - Account/Contact/Deal, alongside the Lead
 * shapes above rather than instead of them. See the Phase 1 plan.
 */

export interface Deal {
  id: string;
  pipeline_id: string;
  workspace_id: string | null;
  account_id: string | null;
  contact_id: string | null;
  name: string;
  stage: string;
  status: "open" | "won" | "lost";
  amount: string | number | null;
  expected_close_date: string | null;
  summary: string | null;
  next_action: string | null;
  notes: string | null;
  owner_user_id: string | null;
  telecaller_id: string | null;
  source_lead_id: string | null;
  facts: Record<string, unknown>;
  call_count: number;
  last_activity_at: string;
  stage_changed_at: string;
  created_at: string;
  updated_at: string;
  contact_name: string | null;
  account_name: string | null;
}

export interface DealBoardColumn extends Stage {
  count: number;
  value: number;
  deals: Deal[];
}

export interface Contact {
  id: string;
  workspace_id: string | null;
  account_id: string | null;
  first_name: string | null;
  last_name: string | null;
  display_name: string;
  email: string | null;
  phone_prefix: string | null;
  phone_last3: string | null;
  title: string | null;
  owner_user_id: string | null;
  facts: Record<string, unknown>;
  status: "active" | "archived" | "merged";
  call_count: number;
  /** Kailash gap Milestone 4 - a point ledger scored by a worker sweep, not stored elsewhere. */
  lead_score: number;
  last_activity_at: string;
  created_at: string;
}

export interface Account {
  id: string;
  workspace_id: string | null;
  name: string;
  domain: string | null;
  phone_prefix: string | null;
  phone_last3: string | null;
  owner_user_id: string | null;
  facts: Record<string, unknown>;
  status: "active" | "archived" | "merged";
  last_activity_at: string;
  created_at: string;
}

export interface CustomFieldOption {
  value: string;
  label: string;
}

/**
 * A follow-up task (Track A3). `due_on` is a plain `YYYY-MM-DD` string, never
 * a timestamp - see tasks.controller.ts for why that distinction is load-
 * bearing rather than cosmetic.
 */
export interface Task {
  id: string;
  title: string;
  notes: string | null;
  contact_id: string | null;
  account_id: string | null;
  deal_id: string | null;
  assignee_user_id: string | null;
  assignee_name?: string | null;
  deal_name?: string | null;
  contact_name?: string | null;
  due_on: string | null;
  status: "open" | "done" | "cancelled";
  priority: "low" | "normal" | "high";
  completed_at: string | null;
  created_at: string;
}

/**
 * One row on a contact/account/deal timeline (Track A2). `actor` is already
 * resolved API-side to the user's name or the device label, so the UI never
 * needs a second lookup to render "who".
 */
export interface Interaction {
  id: string;
  type: "call" | "email" | "sms" | "whatsapp" | "meeting" | "note";
  direction: "incoming" | "outgoing" | null;
  contact_id: string | null;
  account_id: string | null;
  deal_id: string | null;
  call_id: string | null;
  subject: string | null;
  body: string | null;
  occurred_at: string;
  duration_s: number | null;
  actor_user_id: string | null;
  actor: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface DuplicateMatch {
  id: string;
  object_type: "contact" | "account";
  record_a_id: string;
  record_b_id: string;
  record_a_label: string | null;
  record_a_detail: string | null;
  record_b_label: string | null;
  record_b_detail: string | null;
  match_reason: "phone" | "email" | "external_id" | "fuzzy_name_company";
  score: string | number | null;
  status: "pending" | "dismissed" | "merged";
  created_at: string;
}

/**
 * One custom field AS IT APPLIES TO A RECORD - the definition and this
 * record's value in a single shape, which is what the API returns.
 *
 * `source` is the provenance from migration 0045 and it is deliberately on
 * the wire rather than internal: "the AI put this here" and "a colleague
 * typed this" carry very different weight when a rep is deciding whether to
 * quote a number back to a customer.
 */
export interface RecordCustomField {
  id: string;
  key: string;
  label: string;
  type: CustomFieldDefinition["type"];
  description: string | null;
  required: boolean;
  options: CustomFieldOption[];
  lookupObjectType: string | null;
  validation: { min?: number; max?: number } | null;
  status: "active" | "archived";
  value: unknown;
  source: "extraction" | "human" | "automation" | "import" | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface CustomFieldDefinition {
  id: string;
  object_type: "contact" | "account" | "deal";
  key: string;
  label: string;
  type: "text" | "number" | "date" | "boolean" | "picklist" | "multiselect" | "lookup";
  description: string | null;
  required: boolean;
  options: CustomFieldOption[];
  lookup_object_type: string | null;
  sort_order: number;
  status: "active" | "archived";
  created_at: string;
}
