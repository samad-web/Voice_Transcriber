import { DEFAULT_TIME_ZONE, formatRelative, type LeadTemperature } from "@aura/shared";

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
  /** First-touch channel (0078/0080). */
  source_channel?: string | null;
  /**
   * Whose lead it is - a TELECALLER identity set by routing or a bulk
   * reassign - as opposed to `telecaller` above, the handset that took the
   * call. Optional: absent from an API older than CRM dashboard Phase 5.
   */
  assigned_telecaller_id?: string | null;
  assigned_telecaller_name?: string | null;
  /**
   * The "Callback" column (migration 0134): the last time a call to or from
   * this lead went unanswered, and the last time anybody reached them - off
   * calls already linked to this lead (`calls.lead_id`), not a live query.
   * Feed both into `leadCallbackState` (@aura/shared) rather than reading them
   * directly; `null` on both means the lead has never had a missed call, which
   * is not the same as "waiting".
   */
  last_missed_at?: string | null;
  last_reached_at?: string | null;
}

/** A tag as the contact and deal lists return it (migration 0057). */
export interface RecordTag {
  id: string;
  name: string;
  color: string | null;
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
  /** What a PERSON said this call was (0097), or null if nobody has. */
  disposition_key?: string | null;
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
  /**
   * Missed calls only (0133). Why it was missed, per the handset's call log -
   * null on a zero-second call that predates that. Optional so an older API
   * that does not send them still type-checks as "not a missed call".
   */
  missed_reason?: string | null;
  /** Whether the call carries a number anybody could ring back. */
  has_number?: boolean;
  /** The first later call that reached them, if any - see missed-callback-sql.ts. */
  returned_at?: string | null;
  return_direction?: string | null;
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
  /**
   * A reply drafter is switched on AND this reader may read the transcript it
   * would recap (migration 0121) - the drawer offers "Draft a follow-up" only then.
   */
  replyDrafterActive?: boolean;
}

export interface Telecaller {
  id: string;
  label: string | null;
  telecaller_name: string | null;
  status: string;
  last_seen_at: string | null;
  calls: number;
  /** Inbound, zero-duration calls on this handset in the window (Build docs/29 G7). */
  missed?: number;
  talk_seconds: number;
  last_call_at: string | null;
  leads: number;
  won: number;
  pipeline_value: number;
}

/** One calendar day of the dashboard window, in the org's zone (Build docs/29 §6). */
export interface OverviewDay {
  /** `YYYY-MM-DD` - a calendar date, never parsed through a zone. */
  day: string;
  calls: number;
  outgoing: number;
  answered: number;
  missed: number;
  leads: number;
}

/** Inbound calls in one weekday × hour cell, org-local. Only non-empty cells arrive. */
export interface CallHeatCell {
  /** ISO weekday, 1 = Monday. */
  dow: number;
  hour: number;
  inbound: number;
  missed: number;
}

/** Open records in one stage, by whole days since they entered it (AGING_BUCKETS). */
export interface StageAgingRow {
  stage: string;
  d0_3: number;
  d4_7: number;
  d8_15: number;
  d16_30: number;
  d30_plus: number;
}

export type AgingBucketKey = "d0_3" | "d4_7" | "d8_15" | "d16_30" | "d30_plus";

export type ResponseBucketKey = "under_5m" | "under_30m" | "under_1h" | "under_4h" | "under_24h" | "over_24h" | "never";

export interface Overview {
  org: { id: string; name: string };
  /**
   * The window the numbers were counted over, echoed by the API from the org's
   * own calendar: the last `days` days, today included, in `timezone`.
   * Optional so an older API still type-checks; the page falls back to days.
   */
  /** `custom`: a From/To pair rather than "the last N days" (`days` is then its length). */
  window: { days: number; custom?: boolean; from?: string; to?: string; timezone?: string };
  /** Closes IN the window (terminal status, stage_changed_at inside it) - docs/29 A4. */
  closed?: { won: number; lost: number; won_value: number };
  /** The equal-length window before this one, for the KPI deltas. */
  previous?: {
    calls: number;
    outgoing: number;
    answered: number;
    missed: number;
    leads_created: number;
    won: number;
    lost: number;
    won_value: number;
  };
  callHeat?: CallHeatCell[];
  stageAging?: StageAgingRow[];
  /** AGING_BUCKETS' keys and labels, in order, as the API defines them. */
  agingBuckets?: Array<{ key: AgingBucketKey; label: string }>;
  /** Speed to first response vs the org's SLA. Null on the CRM read (deals have no first response). */
  response?: {
    sla_minutes: number;
    leads: number;
    responded: number;
    within_sla: number;
    median_minutes: number | null;
    /** In order, with the bounds sla.ts owns - the console draws from these, never a copy. */
    buckets: Array<{
      key: ResponseBucketKey;
      label: string;
      /** Exclusive lower bound; null for the first bucket and for never. */
      min_minutes: number | null;
      /** Inclusive upper bound; null when open-ended (over 24 h) or never. */
      max_minutes: number | null;
      never: boolean;
      count: number;
    }>;
    prev_leads: number;
    prev_within_sla: number;
  } | null;
  leads: {
    total: number;
    open: number;
    won: number;
    lost: number;
    created_in_window: number;
    pipeline_value: number;
    won_value: number;
  };
  /**
   * The call window, broken out by the four states the console paints
   * (@aura/ui's state.tsx).
   *
   * `outgoing + answered + missed === total` - `calls.direction` carries a
   * CHECK constraint admitting only 'incoming' and 'outgoing', so the three
   * partition the window exactly.
   *
   * `failed` OVERLAPS all three rather than being a fourth slice: a call whose
   * transcode fell over still happened, still went one way or the other, and
   * still lasted as long as it lasted. It counts how many of the window's
   * calls the pipeline could not process. See the API's own note on why the
   * missed-call number must never shrink because a worker had a bad afternoon.
   */
  calls: {
    total: number;
    complete: number;
    outgoing: number;
    answered: number;
    missed: number;
    failed: number;
    total_seconds: number;
  };
  funnel: Array<Stage & { count: number; value: number }>;
  stages: Stage[];
  telecallers: Telecaller[];
  /** Every calendar day of the window, zeros included (docs/29 A1/A2). */
  byDay: OverviewDay[];
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
  tasks: {
    open: number;
    overdue: number;
    due_today: number;
    upcoming: number;
    undated: number;
  };
  /**
   * The triage block: open leads by age, and how many have never been
   * answered. Also not windowed - the whole point of the 30+ bucket is the
   * leads that fell out of the reporting window and are still sitting there.
   *
   * NULL on the CRM read (`/v1/owner/crm-overview`), which is over deals and
   * contacts and has no first_responded_at. Absent means "this view cannot
   * answer that", which is why it is null rather than zeroes.
   */
  triage: {
    open_total: number;
    never_responded: number;
    d0_3: number;
    d4_7: number;
    d8_15: number;
    d16_30: number;
    d30_plus: number;
    /** The same buckets, only leads nobody has ever answered (docs/29 §3.7). */
    never_d0_3?: number;
    never_d4_7?: number;
    never_d8_15?: number;
    never_d16_30?: number;
    never_d30_plus?: number;
  } | null;
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

/**
 * "3h ago" / "2d ago", then "8 Aug 2026" once it is a month old.
 *
 * `zone` is the workspace's (Build docs/30): `useOrgTimeZone()` in a Client
 * Component, `await getOrgTimeZone()` in a Server Component. It only decides
 * the absolute fallback's date - "3h ago" is the same everywhere - but that
 * date used to be hard-coded to Asia/Kolkata, which was wrong for any
 * workspace outside India. The wording and the fixed month table come from
 * @aura/shared's formatRelative, so server and browser print the same text.
 */
export function relativeTime(iso: string | null, zone: string = DEFAULT_TIME_ZONE): string {
  if (!iso) return "-";
  return formatRelative(iso, zone);
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
  /** List endpoint only (CRM dashboard Phase 5) - absent on board and detail. */
  owner_name?: string | null;
  contact_email?: string | null;
  tags?: RecordTag[];
}

export interface DealBoardColumn extends Stage {
  count: number;
  value: number;
  /** Open deals in the whole column past the pipeline's stale threshold (0106). */
  staleCount?: number;
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
  /** The lead this contact was first created from, if any. */
  source_lead_id?: string | null;
  /** First-touch channel (0078/0080) - how this person first reached the business. */
  source_channel?: string | null;
  /** Set when a person chose the name (0107); the call projection then never overwrites it. */
  display_name_set_by_human_at?: string | null;
  facts: Record<string, unknown>;
  status: "active" | "archived" | "merged";
  call_count: number;
  /** Kailash gap Milestone 4 - a point ledger scored by a worker sweep, not stored elsewhere. */
  lead_score: number;
  last_activity_at: string;
  created_at: string;
  /** List endpoint only (CRM dashboard Phase 5). */
  owner_name?: string | null;
  tags?: RecordTag[];
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
  /** The lead this is a promise about (0095). What makes a task a follow-up. */
  lead_id: string | null;
  lead_title?: string | null;
  lead_stage?: string | null;
  assignee_user_id: string | null;
  assignee_name?: string | null;
  deal_name?: string | null;
  contact_name?: string | null;
  due_on: string | null;
  /** The promised TIME, when the promise has one. Null means the day is all. */
  due_at: string | null;
  status: "open" | "done" | "cancelled";
  priority: "low" | "normal" | "high";
  completed_at: string | null;
  /** Who ticked it off - not always who owed it. Null on pre-0095 rows. */
  completed_by: string | null;
  /** How many times the ladder has had to say it is late (0095). */
  reminders_sent: number;
  created_at: string;
}

/** The five tab counts on the follow-up queue, from `GET /v1/tasks/counts`. */
export interface FollowupCounts {
  all: number;
  overdue: number;
  today: number;
  upcoming: number;
  completed: number;
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
  /** 'automation' for a rule's row, a telecaller for a recorded call - see lib/activity.ts. */
  actor_label?: string | null;
  /** Set when a mailbox/calendar sync wrote the row. */
  connection_id?: string | null;
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
