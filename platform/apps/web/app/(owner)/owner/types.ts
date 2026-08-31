/** Shapes returned by /v1/owner/* and /v1/leads — shared by all three pages. */

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
}

/** One row of the tenant's project catalogue — `GET /v1/projects`. */
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
}

/** numeric columns arrive from pg as strings; one place to make them numbers. */
export function num(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Compact money formatting — a board card has no room for "1,250,000". */
export function formatValue(value: string | number | null | undefined): string {
  const n = num(value);
  if (n === null) return "—";
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
  if (!iso) return "—";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
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
 * CRM Phase 1 foundation (E0.1) — Account/Contact/Deal, alongside the Lead
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
  /** Kailash gap Milestone 4 — a point ledger scored by a worker sweep, not stored elsewhere. */
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
 * a timestamp — see tasks.controller.ts for why that distinction is load-
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
 * One custom field AS IT APPLIES TO A RECORD — the definition and this
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
