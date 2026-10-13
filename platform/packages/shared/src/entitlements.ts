import { z } from "zod";

/**
 * Plan entitlements for the API-only tier (`Build docs/no-crm-api-dashboard-
 * build-plan.md` §4, migration 0188).
 *
 * ── WHY THE KEYS ARE CODE AND THE NUMBERS ARE DATA ──────────────────────────
 *
 * The spec's §4 MUST is "plan definitions live in tables so product can change
 * limits without a release". That is about the *numbers*: how many telecallers
 * Growth includes is a commercial decision that should not need a deploy.
 *
 * The *keys* are a different object. `outgoing_webhooks` is a name a route
 * spells in a decorator; `history_retention` is a name a read path applies as a
 * date floor. A key that exists only as a database row is a key no test can
 * find and no `@RequireEntitlement` can be checked against, which is how a
 * typo'd entitlement silently grants everything. Same split the rest of this
 * package already makes: `org-modules.ts`, `features.ts` and
 * `connection-providers.ts` all hold the vocabulary in code and the per-tenant
 * state in tables.
 *
 * So: this file is the catalogue and the limit *shapes*. `plan_entitlements`
 * holds the values. `PLAN_SEED` below is the one place the two meet, and
 * `entitlements.test.ts` reads migration 0188 and fails if its seed has drifted
 * from it — the same drift check `org-features.test.ts` runs against 0093's
 * hardcoded feature/module pairs, and for the same reason: a migration cannot
 * import TypeScript.
 *
 * ── THREE LIMIT TYPES, AND WHAT EACH DOES AT ITS CEILING ────────────────────
 *
 * `hard`   — the feature is absent. Checked once, fails closed, returns the
 *            spec's §9.4 `entitlement_required` body.
 * `quota`  — a count or a volume. Warns at 80%, accepts into a 110% grace band,
 *            then refuses. Counts (users, telecallers) block *adding* and never
 *            remove what exists; volumes refuse the write.
 * `window` — retention. **Never deletes.** It is a floor on the date range a
 *            read may ask for, and an upgrade brings the older rows back,
 *            because they were never gone.
 */

export const PlanKey = z.enum([
  // The API-only Insights tier (migration 0192).
  "starter",
  "growth",
  "scale",
  "platform",
  // The published capture price list (migration 0197, pricing.ts). Both
  // families live in one catalogue because there is one `check()`, one
  // `org_subscriptions` row per tenant and one resolution path; the family
  // (`PLAN_FAMILY` in pricing.ts) is what keeps a Compare-plans page from
  // offering a capture tenant the API tier's Scale. The `capture_` prefix on
  // Starter and Growth is not cosmetic - both names already existed here.
  "record",
  "capture_starter",
  "capture_growth",
  "capture_enterprise",
]);
export type PlanKey = z.infer<typeof PlanKey>;

/**
 * Rail order within the Insights family, cheapest first.
 *
 * Kept as the INSIGHTS order rather than widened to every plan, because the
 * two consumers both mean that family: the Compare-plans page on the API-only
 * console, and `cheapestPlanWith()`, which answers "which plan would unlock
 * this" for a tenant who is already on an Insights plan. A capture tenant's
 * answer comes from `CAPTURE_PLAN_ORDER`.
 */
export const PLAN_ORDER: PlanKey[] = ["starter", "growth", "scale", "platform"];

/** Every plan in the catalogue, by family, cheapest first within each. */
export const PLAN_ORDER_BY_FAMILY: Record<"insights" | "capture", PlanKey[]> = {
  insights: ["starter", "growth", "scale", "platform"],
  capture: ["record", "capture_starter", "capture_growth", "capture_enterprise"],
};

export const ALL_PLAN_KEYS: PlanKey[] = [
  ...PLAN_ORDER_BY_FAMILY.insights,
  ...PLAN_ORDER_BY_FAMILY.capture,
];

/**
 * `sweep` is the fourth type and the one that breaks the "never deletes" rule
 * the others keep, so it is named rather than folded into `window`.
 *
 * `window` is a read-time FLOOR: it limits the date range a query may ask
 * about and an upgrade brings the older rows straight back, because they were
 * never gone. `sweep` is a day count a background job acts on, and what it
 * does is delete. Today there is exactly one: `audio_retention_days`, which
 * deletes the recording FILE and nothing else - not the transcript, not the
 * analysis, not a lead, deal or contact.
 *
 * Calling that a `window` would have been the dangerous shorthand. The whole
 * reason audio retention needed its own clock is that a single setting used to
 * govern both, and wiring "60 days on Starter" to it would have quietly
 * deleted a paying customer's CRM history - which is not a bug, it is a refund
 * and a reputation. The full purge is `organizations.data_retention_days`, it
 * stays off the price list, and no entitlement reaches it.
 */
export const EntitlementLimitType = z.enum(["hard", "quota", "window", "sweep"]);
export type EntitlementLimitType = z.infer<typeof EntitlementLimitType>;

export const EntitlementKey = z.enum([
  // ── Capacity ──
  "active_telecallers",
  "dashboard_logins",
  "ingest_events_monthly",
  "api_rate_per_min",
  "history_retention",
  // ── KPI ──
  "selectable_kpis",
  "custom_kpis",
  "team_structure",
  // ── Output ──
  "export_formats",
  "scheduled_reports",
  "threshold_alerts",
  "outgoing_webhooks",
  "import_center",
  "manual_quality_scoring",
  "revenue_summary",
  // ── Platform ──
  "audit_log_window",
  "sso",
  "ip_allowlist",
  "white_label",
  // The project owner's addition, 2026-10-10: an API-only tenant may also run
  // the Aura handset and have those calls counted. See INSIGHTS_TIER_DECISIONS §5.
  "handset_pairing",
  "paired_handsets",
  // ── The locked tiers above this one ──
  "crm",
  "ai_features",
  // ── The four capture meters (pricing.ts, migration 0197) ──
  //
  // Handsets are already metered above by `paired_handsets`, which the capture
  // price list reuses rather than adding a second handset key: two keys
  // counting the same phones is how a cap stops holding.
  "transcription_hours_monthly",
  "audio_retention_days",
  "storage_cap_gb",
  "speaker_separation",
]);
export type EntitlementKey = z.infer<typeof EntitlementKey>;

/**
 * A `hard` value. `variant` exists because three of the spec's §4 rows are not
 * on/off but graded — exports are "CSV, limited rows" then "CSV and Excel" then
 * "CSV, Excel, PDF"; the import centre is "single template" then "saved
 * mappings" then "advanced"; revenue is "none" then "basic" then "full".
 *
 * Modelling those as three separate boolean keys each would mean a route
 * asking "may this tenant export?" has to know which of three names to spell,
 * and a plan editor could set two of them at once. One key with an ordered
 * variant keeps the question single and the answer total.
 */
export const HardValue = z.object({
  enabled: z.boolean(),
  variant: z.string().max(40).nullish(),
});
export type HardValue = z.infer<typeof HardValue>;

/** A `quota` value. `limit: null` is unlimited, which is what Platform is. */
export const QuotaValue = z.object({
  limit: z.number().int().nonnegative().nullable(),
  /** `"month"` meters per calendar month; null meters a standing count. */
  per: z.enum(["month", "minute"]).nullish(),
});
export type QuotaValue = z.infer<typeof QuotaValue>;

/** A `window` value, in whole months or whole days. `null` is unlimited. */
export const WindowValue = z.object({
  months: z.number().int().positive().nullish(),
  days: z.number().int().positive().nullish(),
});
export type WindowValue = z.infer<typeof WindowValue>;

export const EntitlementValue = z.union([HardValue, QuotaValue, WindowValue]);
export type EntitlementValue = z.infer<typeof EntitlementValue>;

export interface EntitlementSpec {
  key: EntitlementKey;
  limitType: EntitlementLimitType;
  /** Shown to an owner on the Compare-plans page and in the 403's `message`. */
  label: string;
  /** One line, phrased as what the tenant can do with it. */
  blurb: string;
  /**
   * The ordered variants, lowest first, for a graded `hard` entitlement.
   * `atLeastVariant()` compares by this index, so a route asks for the variant
   * it needs rather than enumerating the plans that have it.
   */
  variants?: string[];
  /**
   * True when a tenant whose plan omits this must not even see the surface.
   * False for the ones that degrade instead — exports still work on Starter,
   * they just do fewer rows.
   */
  hidesSurface?: boolean;
}

export const ENTITLEMENTS: EntitlementSpec[] = [
  {
    key: "active_telecallers",
    limitType: "quota",
    label: "Active telecallers",
    blurb: "People whose performance is measured. Archiving one frees a slot.",
  },
  {
    key: "dashboard_logins",
    limitType: "quota",
    label: "Dashboard logins",
    blurb: "Owners, admins, managers, developers and viewers. Telecaller self-view is not counted.",
  },
  {
    key: "ingest_events_monthly",
    limitType: "quota",
    label: "Events per month",
    blurb: "Every item in every batch counts once. Replays of the same idempotency key do not.",
  },
  {
    key: "api_rate_per_min",
    limitType: "quota",
    label: "API requests per minute",
    blurb: "Per key and per org, with a 429 and Retry-After when exceeded.",
  },
  {
    key: "history_retention",
    limitType: "window",
    label: "History",
    blurb: "How far back dashboards and reports may look. Older data is kept, not deleted.",
  },
  {
    key: "selectable_kpis",
    limitType: "quota",
    label: "Selectable KPIs",
    blurb: "How many of the catalogue an owner may run at once.",
  },
  {
    key: "custom_kpis",
    limitType: "hard",
    label: "Custom KPIs",
    blurb: "A KPI defined from your own fields rather than chosen from the catalogue.",
    hidesSurface: true,
  },
  {
    key: "team_structure",
    limitType: "hard",
    label: "Teams",
    blurb: "A flat list of people, teams, or the full organization chart.",
    variants: ["flat", "teams", "org_chart"],
  },
  {
    key: "export_formats",
    limitType: "hard",
    label: "Exports",
    blurb: "What a download can be, and how many rows it may carry.",
    variants: ["csv_limited", "csv_excel", "csv_excel_pdf"],
  },
  {
    key: "scheduled_reports",
    limitType: "hard",
    label: "Scheduled reports",
    blurb: "A report that arrives by email every week or month without anyone asking.",
    variants: ["weekly_monthly", "unlimited_branded"],
    hidesSurface: true,
  },
  {
    key: "threshold_alerts",
    limitType: "hard",
    label: "Threshold alerts",
    blurb: "Tell me when somebody falls behind target, or when a feed stops.",
    variants: ["email", "email_whatsapp_escalation"],
    hidesSurface: true,
  },
  {
    key: "outgoing_webhooks",
    limitType: "hard",
    label: "Outgoing webhooks",
    blurb: "We call your endpoint when an alert fires or a report is ready.",
    hidesSurface: true,
  },
  {
    key: "import_center",
    limitType: "hard",
    label: "Excel import",
    blurb: "Send data as a spreadsheet when calling the API is not an option.",
    variants: ["single_template", "saved_mappings", "advanced"],
  },
  {
    key: "manual_quality_scoring",
    limitType: "hard",
    label: "Quality scoring",
    blurb: "Your own reviewers score calls against a rubric. No AI is involved.",
    hidesSurface: true,
  },
  {
    key: "revenue_summary",
    limitType: "hard",
    label: "Revenue & collections",
    blurb: "What each telecaller closed and what was actually collected.",
    variants: ["basic", "full"],
    hidesSurface: true,
  },
  {
    key: "audit_log_window",
    limitType: "window",
    label: "Audit log",
    blurb: "How far back the record of key, plan, KPI and export changes is visible.",
  },
  {
    key: "sso",
    limitType: "hard",
    label: "Single sign-on",
    blurb: "Staff sign in with your identity provider.",
    hidesSurface: true,
  },
  {
    key: "ip_allowlist",
    limitType: "hard",
    label: "IP allowlist",
    blurb: "An API key that only works from your own addresses.",
    hidesSurface: true,
  },
  {
    key: "white_label",
    limitType: "hard",
    label: "Your branding",
    blurb: "Your logo and colours on the console, exports and scheduled reports.",
    hidesSurface: true,
  },
  {
    key: "handset_pairing",
    limitType: "hard",
    label: "Handset capture",
    blurb:
      "Pair the Aura app on your telecallers' phones and have those calls counted alongside the API's.",
    hidesSurface: true,
  },
  {
    key: "paired_handsets",
    limitType: "quota",
    label: "Paired handsets",
    blurb: "How many phones may be paired at once.",
  },
  {
    key: "crm",
    limitType: "hard",
    label: "CRM",
    blurb: "Leads, pipelines, contacts, companies, deals, quotes and invoices.",
    hidesSurface: true,
  },
  {
    key: "ai_features",
    limitType: "hard",
    label: "AI",
    blurb: "Transcripts, call summaries, AI quality scoring, coaching and the call assistant.",
    hidesSurface: true,
  },
  {
    key: "transcription_hours_monthly",
    limitType: "quota",
    label: "Transcription hours",
    blurb:
      "Audio-hours sent to speech-to-text each month. At the ceiling calls are still recorded and kept - only transcription and analysis are skipped.",
  },
  {
    key: "audio_retention_days",
    limitType: "sweep",
    label: "Audio kept for",
    blurb:
      "How long a recording is playable before the file is deleted. Transcripts, analysis and CRM records are never touched by this.",
  },
  {
    key: "storage_cap_gb",
    limitType: "quota",
    label: "Storage",
    blurb: "A ceiling on stored recordings. The oldest audio is evicted; uploads never stop.",
  },
  {
    key: "speaker_separation",
    limitType: "hard",
    label: "Speaker separation",
    blurb:
      "Who said which line, and the talk-time ratio for every call. Without it the transcript is complete but unlabelled.",
    // Not hidden, degraded. A Starter tenant still gets every word of the
    // transcript; what they lose is the labels and the ratios. Hiding the
    // transcript would be hiding the thing they are paying for.
  },
];

const BY_KEY = new Map(ENTITLEMENTS.map((e) => [e.key, e]));

export function entitlementSpec(key: EntitlementKey): EntitlementSpec {
  const spec = BY_KEY.get(key);
  // Unreachable through the zod enum, but a thrown error beats `undefined`
  // flowing into a limit comparison and reading as "unlimited".
  if (!spec) throw new Error(`unknown entitlement: ${key}`);
  return spec;
}

/**
 * The §4 table, as data, and the single source the 0188 seed is checked
 * against.
 *
 * These are **editable defaults, not commitments** — the spec says so twice.
 * An operator changing Growth's telecaller limit edits the row; this constant
 * only decides what a tenant gets on the day the migration runs.
 *
 * Platform is deliberately sparse-free: every row is present, because a
 * *missing* row is how `check()` ends up deciding between "unlimited" and
 * "denied" from an absence, and those must never be the same value.
 */
export const PLAN_SEED: Record<PlanKey, Record<EntitlementKey, EntitlementValue>> = {
  starter: {
    active_telecallers: { limit: 10 },
    dashboard_logins: { limit: 3 },
    ingest_events_monthly: { limit: 50_000, per: "month" },
    api_rate_per_min: { limit: 60, per: "minute" },
    history_retention: { months: 3 },
    selectable_kpis: { limit: 4 },
    custom_kpis: { enabled: false },
    team_structure: { enabled: true, variant: "flat" },
    export_formats: { enabled: true, variant: "csv_limited" },
    scheduled_reports: { enabled: false },
    threshold_alerts: { enabled: false },
    outgoing_webhooks: { enabled: false },
    import_center: { enabled: true, variant: "single_template" },
    manual_quality_scoring: { enabled: false },
    revenue_summary: { enabled: false },
    audit_log_window: { days: 30 },
    sso: { enabled: false },
    ip_allowlist: { enabled: false },
    white_label: { enabled: false },
    handset_pairing: { enabled: true },
    paired_handsets: { limit: 10 },
    crm: { enabled: false },
    ai_features: { enabled: false },
    // An Insights tenant may pair handsets and have those calls counted, but
    // buys no transcription here: that is the capture family's product. A
    // limit of 0 is a real answer ("none of this plan") and `readQuota` keeps
    // it apart from `null`, which is unlimited.
    transcription_hours_monthly: { limit: 0, per: "month" },
    audio_retention_days: { days: 30 },
    storage_cap_gb: { limit: 5 },
    speaker_separation: { enabled: false },
  },
  growth: {
    active_telecallers: { limit: 50 },
    dashboard_logins: { limit: 10 },
    ingest_events_monthly: { limit: 500_000, per: "month" },
    api_rate_per_min: { limit: 300, per: "minute" },
    history_retention: { months: 12 },
    selectable_kpis: { limit: 6 },
    custom_kpis: { enabled: false },
    team_structure: { enabled: true, variant: "teams" },
    export_formats: { enabled: true, variant: "csv_excel" },
    scheduled_reports: { enabled: true, variant: "weekly_monthly" },
    threshold_alerts: { enabled: true, variant: "email" },
    outgoing_webhooks: { enabled: true },
    import_center: { enabled: true, variant: "saved_mappings" },
    manual_quality_scoring: { enabled: true },
    revenue_summary: { enabled: true, variant: "basic" },
    audit_log_window: { months: 12 },
    sso: { enabled: false },
    ip_allowlist: { enabled: false },
    white_label: { enabled: false },
    handset_pairing: { enabled: true },
    paired_handsets: { limit: 50 },
    crm: { enabled: false },
    ai_features: { enabled: false },
    transcription_hours_monthly: { limit: 0, per: "month" },
    audio_retention_days: { days: 60 },
    storage_cap_gb: { limit: 15 },
    speaker_separation: { enabled: false },
  },
  scale: {
    active_telecallers: { limit: 200 },
    dashboard_logins: { limit: 50 },
    ingest_events_monthly: { limit: 5_000_000, per: "month" },
    api_rate_per_min: { limit: 1_500, per: "minute" },
    history_retention: { months: 36 },
    selectable_kpis: { limit: 6 },
    custom_kpis: { enabled: true },
    team_structure: { enabled: true, variant: "org_chart" },
    export_formats: { enabled: true, variant: "csv_excel_pdf" },
    scheduled_reports: { enabled: true, variant: "unlimited_branded" },
    threshold_alerts: { enabled: true, variant: "email_whatsapp_escalation" },
    outgoing_webhooks: { enabled: true },
    import_center: { enabled: true, variant: "advanced" },
    manual_quality_scoring: { enabled: true },
    revenue_summary: { enabled: true, variant: "full" },
    audit_log_window: { months: null },
    sso: { enabled: true },
    ip_allowlist: { enabled: true },
    white_label: { enabled: true },
    handset_pairing: { enabled: true },
    paired_handsets: { limit: 200 },
    crm: { enabled: false },
    ai_features: { enabled: false },
    transcription_hours_monthly: { limit: 0, per: "month" },
    audio_retention_days: { days: 90 },
    storage_cap_gb: { limit: 50 },
    speaker_separation: { enabled: false },
  },
  platform: {
    active_telecallers: { limit: null },
    dashboard_logins: { limit: null },
    ingest_events_monthly: { limit: null, per: "month" },
    api_rate_per_min: { limit: null, per: "minute" },
    history_retention: { months: null },
    selectable_kpis: { limit: 6 },
    custom_kpis: { enabled: true },
    team_structure: { enabled: true, variant: "org_chart" },
    export_formats: { enabled: true, variant: "csv_excel_pdf" },
    scheduled_reports: { enabled: true, variant: "unlimited_branded" },
    threshold_alerts: { enabled: true, variant: "email_whatsapp_escalation" },
    outgoing_webhooks: { enabled: true },
    import_center: { enabled: true, variant: "advanced" },
    manual_quality_scoring: { enabled: true },
    revenue_summary: { enabled: true, variant: "full" },
    audit_log_window: { months: null },
    sso: { enabled: true },
    ip_allowlist: { enabled: true },
    white_label: { enabled: true },
    handset_pairing: { enabled: true },
    paired_handsets: { limit: null },
    crm: { enabled: true },
    ai_features: { enabled: true },
    transcription_hours_monthly: { limit: null, per: "month" },
    audio_retention_days: { days: 180 },
    storage_cap_gb: { limit: null },
    speaker_separation: { enabled: true },
  },

  // ── The capture family (pricing.ts, migration 0197) ───────────────────────
  //
  // The published price list, as limits. The four meters the customer is sold
  // on are `paired_handsets`, `transcription_hours_monthly`,
  // `audio_retention_days` and `storage_cap_gb`; everything else below is the
  // same 23 keys the Insights family carries, because a plan missing a key is
  // how `check()` ends up deciding between "unlimited" and "denied" from an
  // absence.
  //
  // NOTHING IS METERED PER SEAT. `active_telecallers` and `dashboard_logins`
  // are `null` on every capture plan, deliberately and permanently: the cost
  // of running this product follows audio, not logins, and the product wants
  // MORE people inside the CRM reading what the calls revealed. See
  // pricing.ts's header.
  //
  // `ingest_events_monthly: 0` is also deliberate - the ingestion API is the
  // Insights family's product and a capture plan does not include it. Capture
  // calls arrive from a handset and are not ingest events, so this ceiling is
  // never on their path.
  record: {
    active_telecallers: { limit: null },
    dashboard_logins: { limit: null },
    ingest_events_monthly: { limit: 0, per: "month" },
    api_rate_per_min: { limit: 60, per: "minute" },
    // No read-time floor. Audio expires on its own clock and the transcript,
    // the lead and the dashboard outlive it; hiding a customer's own history
    // behind a plan tier is the one thing the `window` type must not do here.
    history_retention: { months: null },
    selectable_kpis: { limit: 6 },
    custom_kpis: { enabled: false },
    team_structure: { enabled: true, variant: "flat" },
    export_formats: { enabled: true, variant: "csv_limited" },
    scheduled_reports: { enabled: false },
    threshold_alerts: { enabled: false },
    outgoing_webhooks: { enabled: false },
    import_center: { enabled: true, variant: "single_template" },
    manual_quality_scoring: { enabled: false },
    revenue_summary: { enabled: false },
    audit_log_window: { days: 30 },
    sso: { enabled: false },
    ip_allowlist: { enabled: false },
    white_label: { enabled: false },
    handset_pairing: { enabled: true },
    paired_handsets: { limit: 2 },
    crm: { enabled: true },
    // Record sells the archive, not the intelligence. Zero hours AND no AI,
    // which together are what make this tier cost us nothing per call: with
    // transcription off the audio is never sent to a provider at all.
    ai_features: { enabled: false },
    transcription_hours_monthly: { limit: 0, per: "month" },
    audio_retention_days: { days: 30 },
    storage_cap_gb: { limit: 5 },
    speaker_separation: { enabled: false },
  },
  capture_starter: {
    active_telecallers: { limit: null },
    dashboard_logins: { limit: null },
    ingest_events_monthly: { limit: 0, per: "month" },
    api_rate_per_min: { limit: 60, per: "minute" },
    history_retention: { months: null },
    selectable_kpis: { limit: 6 },
    custom_kpis: { enabled: false },
    team_structure: { enabled: true, variant: "teams" },
    export_formats: { enabled: true, variant: "csv_excel" },
    scheduled_reports: { enabled: true, variant: "weekly_monthly" },
    threshold_alerts: { enabled: true, variant: "email" },
    outgoing_webhooks: { enabled: false },
    import_center: { enabled: true, variant: "saved_mappings" },
    manual_quality_scoring: { enabled: true },
    revenue_summary: { enabled: true, variant: "basic" },
    audit_log_window: { months: 12 },
    sso: { enabled: false },
    ip_allowlist: { enabled: false },
    white_label: { enabled: false },
    handset_pairing: { enabled: true },
    paired_handsets: { limit: 2 },
    crm: { enabled: true },
    ai_features: { enabled: true },
    transcription_hours_monthly: { limit: 100, per: "month" },
    audio_retention_days: { days: 60 },
    storage_cap_gb: { limit: 5 },
    // Starter loses the LABELS, not the words. Speaker separation costs us
    // almost nothing on Gemini and about ₹2/hr on AssemblyAI; only Sarvam
    // charges a real premium (₹45 against ₹30), and Sarvam is what Growth
    // runs on. So gating it here costs the customer no transcript quality -
    // the same model transcribes with and without it.
    speaker_separation: { enabled: false },
  },
  capture_growth: {
    active_telecallers: { limit: null },
    dashboard_logins: { limit: null },
    ingest_events_monthly: { limit: 0, per: "month" },
    api_rate_per_min: { limit: 300, per: "minute" },
    history_retention: { months: null },
    selectable_kpis: { limit: 6 },
    custom_kpis: { enabled: true },
    team_structure: { enabled: true, variant: "teams" },
    export_formats: { enabled: true, variant: "csv_excel_pdf" },
    scheduled_reports: { enabled: true, variant: "unlimited_branded" },
    threshold_alerts: { enabled: true, variant: "email_whatsapp_escalation" },
    outgoing_webhooks: { enabled: true },
    import_center: { enabled: true, variant: "advanced" },
    manual_quality_scoring: { enabled: true },
    revenue_summary: { enabled: true, variant: "full" },
    audit_log_window: { months: 12 },
    sso: { enabled: false },
    ip_allowlist: { enabled: false },
    white_label: { enabled: false },
    handset_pairing: { enabled: true },
    paired_handsets: { limit: 4 },
    crm: { enabled: true },
    ai_features: { enabled: true },
    transcription_hours_monthly: { limit: 200, per: "month" },
    audio_retention_days: { days: 90 },
    storage_cap_gb: { limit: 15 },
    speaker_separation: { enabled: true },
  },
  capture_enterprise: {
    active_telecallers: { limit: null },
    dashboard_logins: { limit: null },
    ingest_events_monthly: { limit: null, per: "month" },
    api_rate_per_min: { limit: null, per: "minute" },
    history_retention: { months: null },
    selectable_kpis: { limit: 6 },
    custom_kpis: { enabled: true },
    team_structure: { enabled: true, variant: "org_chart" },
    export_formats: { enabled: true, variant: "csv_excel_pdf" },
    scheduled_reports: { enabled: true, variant: "unlimited_branded" },
    threshold_alerts: { enabled: true, variant: "email_whatsapp_escalation" },
    outgoing_webhooks: { enabled: true },
    import_center: { enabled: true, variant: "advanced" },
    manual_quality_scoring: { enabled: true },
    revenue_summary: { enabled: true, variant: "full" },
    audit_log_window: { months: null },
    sso: { enabled: true },
    ip_allowlist: { enabled: true },
    white_label: { enabled: true },
    handset_pairing: { enabled: true },
    // A FLOOR, not a cap. Enterprise starts at ten handsets and the number is
    // negotiated upward per contract, which an operator does by editing this
    // tenant's `plan_entitlements` row - the whole reason the numbers live in
    // a table. Ten is what the price list's floor price is built on.
    paired_handsets: { limit: 10 },
    crm: { enabled: true },
    ai_features: { enabled: true },
    // Custom. Quoted in advance, because at this size the hours are known
    // before the contract is signed and the ASR cost can be priced rather
    // than guessed. `null` here means the ceiling does not bind until an
    // operator writes the negotiated number.
    transcription_hours_monthly: { limit: null, per: "month" },
    // 180 days, configurable. Anything beyond it is held back for this tier
    // on purpose: past six months storage stops being rounding and starts
    // being a line item.
    audio_retention_days: { days: 180 },
    storage_cap_gb: { limit: null },
    speaker_separation: { enabled: true },
  },
};

/**
 * The modules a plan resolves to (`organizations.enabled_modules`, 0072).
 *
 * This is the whole of "assigning a plan": write `plan_id`, write this set.
 * `plans.ts`'s header describes exactly this operation as the thing it was
 * waiting for, and keeping it here rather than in the admin controller means
 * the operator screen, the trial revert and a future provider webhook all
 * resolve a plan the same way.
 *
 * Note that no plan below Platform grants `crm` or `call_intel`: the API-only
 * tier's exclusions in §5 are these absences, and they are what make a CRM
 * route 403 for this tenant with no new code.
 */
export const PLAN_MODULES: Record<PlanKey, string[]> = {
  starter: ["aura", "api_insights"],
  growth: ["aura", "api_insights"],
  scale: ["aura", "api_insights", "finance"],
  platform: ["aura", "api_insights", "crm", "call_intel", "finance"],

  // The capture family is the mirror image: every tier gets the CRM, because
  // "every call recorded and searchable in the CRM" is what Record sells, and
  // none of them gets `api_insights`, because that is the other product.
  //
  // `call_intel` is the module that decides whether a tenant sees the AI read
  // of their own calls - intent, sentiment, outcome and the transcript itself.
  // Record does not have it and must not: with transcription off there is no
  // transcript to show, and a module granting access to an empty surface reads
  // as a broken product rather than an absent tier.
  record: ["aura", "crm"],
  capture_starter: ["aura", "crm", "call_intel"],
  capture_growth: ["aura", "crm", "call_intel"],
  capture_enterprise: ["aura", "crm", "call_intel", "finance"],
};

// ── Quota arithmetic ────────────────────────────────────────────────────────

/** §4: warn the owner here. */
export const QUOTA_WARN_AT = 0.8;
/** §4/§16: accepted past the limit, up to this multiple, then refused. */
export const QUOTA_GRACE_BAND = 1.1;

export const QuotaState = z.enum(["ok", "warning", "grace", "blocked"]);
export type QuotaState = z.infer<typeof QuotaState>;

export interface QuotaReading {
  state: QuotaState;
  /** Fraction of the limit consumed. `null` when the limit is unlimited. */
  fraction: number | null;
  limit: number | null;
  used: number;
  /** How many more may be consumed before `blocked`. `null` when unlimited. */
  remaining: number | null;
}

/**
 * Where a meter stands.
 *
 * `blocked` is at the grace ceiling, not at the limit — so the caller that
 * refuses a write and the banner that warns about it read the same function and
 * cannot disagree about where the line is. A `limit` of 0 is a real answer
 * ("none of this plan") and must not be confused with `null`, which is
 * unlimited; the early return keeps those apart.
 */
export function readQuota(limit: number | null, used: number): QuotaReading {
  if (limit === null) {
    return { state: "ok", fraction: null, limit: null, used, remaining: null };
  }
  if (limit === 0) {
    return { state: "blocked", fraction: 1, limit: 0, used, remaining: 0 };
  }
  const fraction = used / limit;
  const ceiling = Math.floor(limit * QUOTA_GRACE_BAND);
  const state: QuotaState =
    used >= ceiling ? "blocked" : fraction >= 1 ? "grace" : fraction >= QUOTA_WARN_AT ? "warning" : "ok";
  return { state, fraction, limit, used, remaining: Math.max(0, ceiling - used) };
}

/**
 * Whether a graded `hard` entitlement reaches at least `wanted`.
 *
 * A route asks `atLeastVariant("export_formats", value, "csv_excel")` rather
 * than listing the plans that qualify, which is the §4 MUST about not
 * scattering plan-name checks. An unknown variant on either side answers
 * false: a value that is not in the catalogue is not a value this code can
 * reason about, and guessing upward would grant.
 */
export function atLeastVariant(
  key: EntitlementKey,
  value: HardValue | null | undefined,
  wanted: string,
): boolean {
  if (!value?.enabled) return false;
  const order = entitlementSpec(key).variants;
  if (!order) return value.enabled;
  const have = value.variant ? order.indexOf(value.variant) : -1;
  const need = order.indexOf(wanted);
  if (have < 0 || need < 0) return false;
  return have >= need;
}

/**
 * The retention floor: the earliest instant a read may ask about.
 *
 * `null` means no floor — and note that **a plan-check failure must also
 * produce `null`**, not an epoch. The spec's §4 asks for "fail closed for
 * features, fail open for already-ingested data visibility", and this is the
 * function that half of that promise lives in: if the entitlement service is
 * unreachable, the customer sees their own dashboard rather than three months
 * of it.
 */
export function retentionFloor(value: WindowValue | null | undefined, now: Date): Date | null {
  if (!value) return null;
  if (value.months) {
    const floor = new Date(now);
    floor.setUTCMonth(floor.getUTCMonth() - value.months);
    return floor;
  }
  if (value.days) {
    return new Date(now.getTime() - value.days * 24 * 60 * 60 * 1000);
  }
  return null;
}

/**
 * The spec's §9.4 body, built in one place so the API's shape and the
 * documentation's example cannot drift.
 *
 * `required_plan` is the cheapest plan whose seed satisfies the key, worked out
 * from `PLAN_SEED` rather than written down — a hand-maintained "this needs
 * Growth" string goes stale the first time product moves a feature down a tier.
 */
export function cheapestPlanWith(
  key: EntitlementKey,
  wantedVariant?: string,
  /**
   * Which family to search. A capture tenant told to buy "Scale" to unlock a
   * feature would be told to change products, so the answer has to come from
   * the rail they are actually on; the caller passes the family resolved from
   * their own plan. Defaults to `insights`, which is what every existing
   * caller means.
   */
  family: "insights" | "capture" = "insights",
): PlanKey | null {
  for (const plan of PLAN_ORDER_BY_FAMILY[family]) {
    const value = PLAN_SEED[plan][key];
    const spec = entitlementSpec(key);
    if (spec.limitType === "hard") {
      const hard = value as HardValue;
      if (wantedVariant ? atLeastVariant(key, hard, wantedVariant) : hard.enabled) return plan;
    } else if (spec.limitType === "quota") {
      const quota = value as QuotaValue;
      if (quota.limit === null || quota.limit > 0) return plan;
    } else {
      return plan;
    }
  }
  return null;
}

/**
 * The day count a `sweep` entitlement names, or `null` for no sweep.
 *
 * Its own accessor rather than `retentionFloor`, because the two answer
 * different questions and must not be confused: `retentionFloor` returns the
 * earliest instant a READ may ask about, and this returns the age at which a
 * background job DELETES something. Handing a sweep a floor date, or a read a
 * day count, is how the single-clock bug comes back.
 *
 * `null` on anything missing or malformed, and the one caller (the reaper)
 * treats `null` as "sweep nothing" - so a plan whose row an operator cleared
 * stops deleting audio rather than deleting it immediately.
 */
export function sweepDays(value: WindowValue | null | undefined): number | null {
  if (!value) return null;
  if (typeof value.days === "number" && value.days > 0) return value.days;
  if (typeof value.months === "number" && value.months > 0) return value.months * 30;
  return null;
}
