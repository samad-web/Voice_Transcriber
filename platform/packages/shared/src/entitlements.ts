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

export const PlanKey = z.enum(["starter", "growth", "scale", "platform"]);
export type PlanKey = z.infer<typeof PlanKey>;

/** Rail order, cheapest first. The Compare-plans page renders them in this order. */
export const PLAN_ORDER: PlanKey[] = ["starter", "growth", "scale", "platform"];

export const EntitlementLimitType = z.enum(["hard", "quota", "window"]);
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
export function cheapestPlanWith(key: EntitlementKey, wantedVariant?: string): PlanKey | null {
  for (const plan of PLAN_ORDER) {
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
