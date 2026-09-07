import { z } from "zod";
import type { OrgModule } from "./org-modules";

/**
 * The console's feature catalogue - what a client can switch on and off in
 * their own workspace (migration 0101).
 *
 * ── THE ONE INVARIANT ───────────────────────────────────────────────────────
 *
 * A client switch NARROWS. It can never widen.
 *
 * `organizations.enabled_modules` (0072) is the provider's entitlement and the
 * ceiling: turning a feature "on" whose module the tenant does not hold is not
 * an error, it is simply `unavailable` and stays off. That is what makes this
 * table safe to hand a customer - the worst an owner can do with the whole
 * page is hide their own console from themselves, and even that is bounded by
 * the locked features below.
 *
 * ── EVERYTHING DEFAULTS ON, DELIBERATELY ────────────────────────────────────
 *
 * Every entry here is `defaultEnabled: true`, so `resolveFeatures(modules, {})`
 * reproduces the console EXACTLY as it renders today. The day this ships,
 * nobody's sidebar changes. A catalogue whose defaults were an opinion would
 * make the deploy itself a product change, and the first bug report would be
 * "half our pages vanished" from a tenant who never asked for a switchboard.
 *
 * `features.test.ts` pins that property rather than trusting the flags.
 *
 * ── WHY THE CATALOGUE IS HERE AND NOT IN THE DATABASE ───────────────────────
 *
 * Same argument `org-modules.ts` makes for modules and `connection-providers
 * .ts` for providers: one exported table, imported by the API (to gate a
 * request), by the web tier (to draw the sidebar) and by the worker (to decide
 * whether to sweep). Those three answers drifting apart is precisely how a page
 * renders a link the API will not serve. A CHECK constraint listing the keys
 * would be a fourth copy that fails at write time in production - see 0101's
 * header for why the column is deliberately unconstrained.
 */
export const FeatureKey = z.enum([
  // ── Pipeline ──
  "leads",
  "followups",
  "outreach",
  "projects",
  // ── Customers (CRM objects) ──
  "deals",
  "contacts",
  "duplicates",
  "import",
  // ── Conversations ──
  "call_log",
  "call_triage",
  "call_quality",
  "call_sops",
  "productivity",
  "inbox",
  "whatsapp_leads",
  // ── Sales ──
  "products",
  "quotations",
  "invoices",
  // ── Insights ──
  "reports",
  "report_builder",
  "sla_reports",
  // ── Lead connectors ──
  "lead_sources",
  "sheets_sync",
  "messaging_setup",
  "meta_ads",
  // ── Superfone ──
  "superfone",
  // ── Workspace ──
  "staff",
  "integrations",
  "connections",
  "transcription",
  "handsets",
  "branding",
]);
export type FeatureKey = z.infer<typeof FeatureKey>;

/** The switchboard's own grouping - deliberately the sidebar's, so the page
 *  reads in the order somebody already knows. */
export const FEATURE_GROUPS = [
  { key: "pipeline", label: "Pipeline" },
  { key: "customers", label: "Customers" },
  { key: "conversations", label: "Conversations" },
  { key: "sales", label: "Sales" },
  { key: "insights", label: "Insights" },
  { key: "connectors", label: "Lead connectors" },
  { key: "workspace", label: "Workspace" },
] as const;

export type FeatureGroup = (typeof FEATURE_GROUPS)[number]["key"];

export interface FeatureSpec {
  key: FeatureKey;
  label: string;
  /** One line, phrased as what the client LOSES by switching it off. */
  blurb: string;
  /** The entitlement that must be present. Absent module = `unavailable`. */
  module: OrgModule;
  group: FeatureGroup;
  /**
   * The console pages this feature governs, as nav hrefs. Empty for features
   * that are a panel on somebody else's page rather than a destination of
   * their own (`sheets_sync`).
   */
  hrefs: string[];
  /**
   * Other features this one is meaningless without. Enforced transitively -
   * see `resolveFeatures`.
   */
  requires?: FeatureKey[];
  /**
   * Cannot be switched off. Two of them, and both are the same argument: a
   * switchboard that can disable the page holding the switchboard, or the page
   * holding the person who may use it, is a workspace one click from needing
   * an operator with a SQL prompt to recover. Same class of refusal as
   * `guardLastOwner`.
   */
  locked?: boolean;
  defaultEnabled: boolean;
}

export const FEATURES: FeatureSpec[] = [
  // ── Pipeline ──────────────────────────────────────────────────────────────
  {
    key: "leads",
    label: "Leads & board",
    blurb: "The lead board and the full lead list. The console's reason to exist.",
    module: "aura",
    group: "pipeline",
    hrefs: ["/owner/board", "/owner/leads"],
    locked: true,
    defaultEnabled: true,
  },
  {
    key: "followups",
    label: "Follow-ups",
    blurb: "Promises to contact somebody at a time, with an overdue queue and daily reminders.",
    // `crm`, because `tasks` is a CRM object (0041) and its routes are gated by
    // `@RequireCrmPermission("task", ...)`. Filing it under `aura` would have
    // offered the page to a recorder-only tenant whose every request to it 403s.
    module: "crm",
    group: "pipeline",
    hrefs: ["/owner/tasks"],
    defaultEnabled: true,
  },
  {
    key: "outreach",
    label: "Outreach",
    blurb: "The staged follow-up ladder across a whole cohort of leads.",
    module: "aura",
    group: "pipeline",
    hrefs: ["/owner/outreach"],
    defaultEnabled: true,
  },
  {
    key: "projects",
    label: "Projects",
    blurb: "The catalogue of offerings calls and leads are labelled against.",
    module: "aura",
    group: "pipeline",
    hrefs: ["/owner/projects"],
    defaultEnabled: true,
  },

  // ── Customers ─────────────────────────────────────────────────────────────
  {
    key: "deals",
    label: "Deals",
    blurb: "The CRM pipeline of opportunities, separate from the lead board.",
    module: "crm",
    group: "customers",
    hrefs: ["/owner/deals"],
    defaultEnabled: true,
  },
  {
    key: "contacts",
    label: "Contacts & accounts",
    blurb: "People and the companies they belong to, as records in their own right.",
    module: "crm",
    group: "customers",
    hrefs: ["/owner/contacts", "/owner/accounts"],
    defaultEnabled: true,
  },
  {
    key: "duplicates",
    label: "Duplicates",
    blurb: "Finding and merging the same customer entered twice.",
    module: "crm",
    group: "customers",
    hrefs: ["/owner/duplicates"],
    defaultEnabled: true,
  },
  {
    key: "import",
    label: "Bulk import",
    blurb: "Loading a spreadsheet of contacts or leads in one go.",
    module: "crm",
    group: "customers",
    hrefs: ["/owner/import"],
    defaultEnabled: true,
  },

  // ── Conversations ─────────────────────────────────────────────────────────
  {
    key: "call_log",
    label: "Call log",
    blurb: "Recorded calls with their transcripts and the AI read of each one.",
    module: "call_intel",
    group: "conversations",
    hrefs: ["/owner/calls"],
    defaultEnabled: true,
  },
  {
    key: "call_triage",
    label: "Unmatched calls",
    blurb: "The queue of calls that matched no lead, with create / link / dismiss.",
    module: "call_intel",
    group: "conversations",
    hrefs: ["/owner/calls/triage"],
    requires: ["call_log"],
    defaultEnabled: true,
  },
  {
    key: "call_quality",
    label: "Call quality",
    blurb: "The review queue, call dispositions and what the floor is getting wrong.",
    // `aura`, NOT `call_intel`, and this is the one entry where the module is
    // chosen to preserve behaviour rather than to describe the feature. Call
    // Quality has never been in the console's `call_intel` gate, so filing it
    // under that module would take the page away from every tenant who has the
    // recorder but not the transcript entitlement - a removal nobody asked
    // for, arriving as a side effect of adding a switchboard.
    module: "aura",
    group: "conversations",
    hrefs: ["/owner/call-quality"],
    defaultEnabled: true,
  },
  {
    key: "call_sops",
    label: "Call procedure",
    blurb: "The steps a call should follow, and each rep's adherence to them.",
    module: "aura",
    group: "conversations",
    hrefs: ["/owner/sops"],
    defaultEnabled: true,
  },
  {
    key: "productivity",
    label: "Productivity",
    blurb: "Talk time, call volume and the idle gap between calls, per person.",
    module: "aura",
    group: "conversations",
    hrefs: ["/owner/productivity"],
    defaultEnabled: true,
  },
  {
    key: "inbox",
    label: "Inbox",
    blurb: "WhatsApp, Instagram, Messenger and email threads with named customers.",
    // The threads are `conversation` objects, which `CrmPermissionsGuard`
    // gates - so the inbox is CRM-module territory even though the CHANNEL it
    // arrives on is not. See `messaging_setup` below, which is the other half
    // and correctly sits under `aura`.
    module: "crm",
    group: "conversations",
    hrefs: ["/owner/inbox"],
    defaultEnabled: true,
  },
  {
    key: "whatsapp_leads",
    label: "WhatsApp lead qualification",
    blurb: "Turning a WhatsApp thread into a lead, once a person approves it.",
    module: "crm",
    group: "conversations",
    hrefs: ["/owner/whatsapp-leads"],
    requires: ["inbox"],
    defaultEnabled: true,
  },

  // ── Sales ─────────────────────────────────────────────────────────────────
  {
    key: "products",
    label: "Products",
    blurb: "The priced catalogue quotations and invoices draw their lines from.",
    module: "crm",
    group: "sales",
    hrefs: ["/owner/products"],
    defaultEnabled: true,
  },
  {
    key: "quotations",
    label: "Quotations",
    blurb: "Priced proposals sent to a customer before the money moves.",
    module: "crm",
    group: "sales",
    hrefs: ["/owner/quotations"],
    requires: ["products"],
    defaultEnabled: true,
  },
  {
    key: "invoices",
    label: "Invoices & payments",
    blurb: "Billing a customer, and the Razorpay or Stripe link that collects it.",
    module: "crm",
    group: "sales",
    hrefs: ["/owner/invoices"],
    requires: ["quotations"],
    defaultEnabled: true,
  },

  // ── Insights ──────────────────────────────────────────────────────────────
  {
    key: "reports",
    label: "Reports",
    blurb: "Pipeline value, win rates, source attribution and per-rep results.",
    module: "crm",
    group: "insights",
    hrefs: ["/owner/reports"],
    defaultEnabled: true,
  },
  {
    key: "report_builder",
    label: "Report builder",
    blurb: "Building and sharing a report of your own rather than using the canned ones.",
    module: "crm",
    group: "insights",
    hrefs: ["/owner/reports/builder"],
    requires: ["reports"],
    defaultEnabled: true,
  },
  {
    key: "sla_reports",
    label: "Response & follow-up compliance",
    blurb: "How fast enquiries are answered, and who is keeping their promises.",
    module: "crm",
    group: "insights",
    hrefs: ["/owner/reports/sla"],
    // Across modules on purpose. Half this report IS follow-up compliance, and
    // a compliance percentage over a feature the business has switched off is
    // a number with no meaning rather than a number that happens to be zero.
    requires: ["followups"],
    defaultEnabled: true,
  },

  // ── Lead connectors ───────────────────────────────────────────────────────
  {
    key: "lead_sources",
    label: "Lead sources",
    blurb: "Web forms, email intake, telephony and CSV - where new leads arrive from.",
    module: "aura",
    group: "connectors",
    hrefs: ["/owner/lead-sources"],
    defaultEnabled: true,
  },
  {
    key: "sheets_sync",
    label: "Google Sheets sync",
    blurb: "Polling a spreadsheet for new rows and turning each into a lead.",
    module: "aura",
    group: "connectors",
    // A panel on Lead sources, not a page. The reason it is a feature at all is
    // that switching it off must stop the WORKER, which no amount of hiding a
    // panel would do - see sheets-sync.ts.
    hrefs: [],
    requires: ["lead_sources"],
    defaultEnabled: true,
  },
  {
    key: "messaging_setup",
    label: "WhatsApp & Meta channels",
    blurb: "Connecting the numbers and accounts customers message you on.",
    module: "aura",
    group: "connectors",
    hrefs: ["/owner/messaging-setup"],
    defaultEnabled: true,
  },
  {
    key: "meta_ads",
    label: "Meta lead ads",
    blurb: "Facebook and Instagram lead forms delivered straight onto the board.",
    module: "aura",
    group: "connectors",
    hrefs: ["/owner/meta-ads"],
    defaultEnabled: true,
  },

  // ── Superfone ─────────────────────────────────────────────────────────────
  {
    key: "superfone",
    label: "Superfone calls",
    blurb: "The cloud PBX call log, separate from recordings the handsets upload.",
    module: "aura",
    // Filed under Workspace on the switchboard rather than given a group of one.
    // The SIDEBAR keeps its own Superfone heading (nav.ts explains why); a
    // settings page with a single-row section is just a row with extra spacing.
    group: "workspace",
    hrefs: ["/owner/superfone"],
    defaultEnabled: true,
  },

  // ── Workspace ─────────────────────────────────────────────────────────────
  {
    key: "staff",
    label: "Staff",
    blurb: "Your team, their permissions and their performance.",
    module: "aura",
    group: "workspace",
    hrefs: ["/owner/staff", "/owner/team"],
    locked: true,
    defaultEnabled: true,
  },
  {
    key: "integrations",
    label: "Integrations",
    blurb: "Which outside accounts are joined up, and which are failing.",
    module: "aura",
    group: "workspace",
    hrefs: ["/owner/integrations"],
    defaultEnabled: true,
  },
  {
    key: "connections",
    label: "Personal connections",
    blurb: "Each person's own mailbox and calendar, connected by them.",
    module: "aura",
    group: "workspace",
    hrefs: ["/owner/connections"],
    defaultEnabled: true,
  },
  {
    key: "transcription",
    label: "Transcription settings",
    blurb: "Spoken language, transcript style and the names & terms glossary.",
    module: "aura",
    group: "workspace",
    hrefs: ["/owner/transcription"],
    defaultEnabled: true,
  },
  {
    key: "handsets",
    label: "Handsets",
    blurb: "The phones in the fleet and what each one last reported.",
    module: "aura",
    group: "workspace",
    hrefs: ["/owner/handsets"],
    defaultEnabled: true,
  },
  {
    key: "branding",
    label: "Branding",
    blurb: "The logo and palette on every quote and invoice a customer receives.",
    module: "aura",
    group: "workspace",
    hrefs: ["/owner/branding"],
    defaultEnabled: true,
  },
];

const FEATURE_BY_KEY = new Map<FeatureKey, FeatureSpec>(FEATURES.map((f) => [f.key, f]));

export function featureSpec(key: FeatureKey): FeatureSpec {
  const spec = FEATURE_BY_KEY.get(key);
  if (!spec) throw new Error(`unknown feature: ${key}`);
  return spec;
}

/**
 * Why a feature is in the state it is in. The console shows this rather than a
 * bare switch, because "off" and "you have not bought this" and "you turned off
 * the thing it needs" are three different conversations and only one of them is
 * with the provider.
 */
export const FeatureState = z.enum(["on", "off", "unavailable", "blocked"]);
export type FeatureState = z.infer<typeof FeatureState>;

export interface ResolvedFeature {
  key: FeatureKey;
  state: FeatureState;
  /** Set when `state` is "blocked" - the requirement that is not met. */
  blockedBy?: FeatureKey;
}

/**
 * The client's stored overrides: sparse, keyed by feature. Anything absent
 * takes the catalogue default; anything unrecognised is ignored, which is what
 * lets a feature be REMOVED from the catalogue without stranding rows in
 * `org_feature_settings`.
 */
export type FeatureOverrides = Record<string, boolean>;

/**
 * Resolve the whole catalogue for one org.
 *
 * ── THE ORDER OF THE THREE RULES MATTERS ────────────────────────────────────
 *
 *   1. Entitlement. No module, no feature - and no client switch reaches this,
 *      which is the invariant at the top of this file.
 *   2. Locked. On, always, provided the module is there. An owner cannot
 *      remove their own way back.
 *   3. Choice. The override, or the catalogue default.
 *
 * Then, and only then, dependencies. A feature whose requirement did not
 * survive the three rules is `blocked` rather than `off`: the client did not
 * turn it off, and telling them they did would send them to a switch that is
 * already in the position they want.
 *
 * ── WHY THE DEPENDENCY PASS IS A FIXPOINT ───────────────────────────────────
 *
 * Requirements chain: `invoices` needs `quotations`, which needs `products`.
 * Switching off Products must take all three down, and a single pass in
 * declaration order only does that by luck - it happens to work here because
 * the catalogue is written parent-first, and it would stop working the first
 * time somebody adds an entry in the wrong place. Iterating until nothing
 * changes costs three passes over thirty rows and removes the ordering
 * requirement from a file people edit by hand.
 *
 * A cycle cannot hang this: each pass only ever turns things OFF, so the set
 * shrinks monotonically and the loop is bounded by the catalogue's size. A
 * cycle simply switches every member off, which is the fail-closed answer to a
 * catalogue that contradicts itself.
 */
export function resolveFeatures(
  enabledModules: readonly string[],
  overrides: FeatureOverrides = {},
): Map<FeatureKey, ResolvedFeature> {
  const modules = new Set(enabledModules);
  const resolved = new Map<FeatureKey, ResolvedFeature>();

  for (const spec of FEATURES) {
    if (!modules.has(spec.module)) {
      resolved.set(spec.key, { key: spec.key, state: "unavailable" });
      continue;
    }
    if (spec.locked) {
      resolved.set(spec.key, { key: spec.key, state: "on" });
      continue;
    }
    const chosen = overrides[spec.key] ?? spec.defaultEnabled;
    resolved.set(spec.key, { key: spec.key, state: chosen ? "on" : "off" });
  }

  for (let pass = 0; pass <= FEATURES.length; pass += 1) {
    let changed = false;
    for (const spec of FEATURES) {
      const current = resolved.get(spec.key)!;
      if (current.state !== "on") continue;
      const missing = (spec.requires ?? []).find((req) => resolved.get(req)?.state !== "on");
      if (!missing) continue;
      // A LOCKED feature is never blocked - it would defeat the whole point of
      // locking it. The catalogue must not give one a requirement, and this is
      // where that would show up; `features.test.ts` asserts it directly so the
      // failure is a red test rather than a silently un-lockable lock.
      if (spec.locked) continue;
      resolved.set(spec.key, { key: spec.key, state: "blocked", blockedBy: missing });
      changed = true;
    }
    if (!changed) break;
  }

  return resolved;
}

/** The plain set of features that are on - what a guard or a nav filter wants. */
export function enabledFeatures(
  enabledModules: readonly string[],
  overrides: FeatureOverrides = {},
): Set<FeatureKey> {
  const resolved = resolveFeatures(enabledModules, overrides);
  return new Set([...resolved.values()].filter((f) => f.state === "on").map((f) => f.key));
}

const FEATURE_BY_HREF = new Map<string, FeatureKey>(
  FEATURES.flatMap((f) => f.hrefs.map((href) => [href, f.key] as const)),
);

/** The feature governing an exact nav href, if any. */
export function featureForHref(href: string): FeatureKey | undefined {
  return FEATURE_BY_HREF.get(href);
}

/**
 * The feature governing a console PATH, by longest prefix.
 *
 * Distinct from `featureForHref` because a page guard is asked about the URL
 * somebody actually opened - `/owner/leads/9f3c…` - not about a nav entry.
 * Longest prefix, so `/owner/calls/triage` resolves to `call_triage` and not to
 * `call_log`, which is the whole reason a plain `startsWith` scan would be
 * wrong here.
 */
export function featureForPath(pathname: string): FeatureKey | undefined {
  let best: { href: string; key: FeatureKey } | undefined;
  for (const [href, key] of FEATURE_BY_HREF) {
    if (pathname !== href && !pathname.startsWith(`${href}/`)) continue;
    if (!best || href.length > best.href.length) best = { href, key };
  }
  return best?.key;
}

/**
 * The features a set of overrides should actually be STORED as.
 *
 * Sparse, per 0101: a value equal to the catalogue default is dropped rather
 * than written. Two reasons, and the second is the one that matters. The table
 * stays small and honest - a row means "this business made a decision" - and a
 * default that the product later changes its mind about then reaches every
 * tenant who never expressed a preference, instead of only the ones provisioned
 * after the change.
 */
export function sparseOverrides(desired: FeatureOverrides): FeatureOverrides {
  const out: FeatureOverrides = {};
  for (const spec of FEATURES) {
    const value = desired[spec.key];
    if (value === undefined) continue;
    if (spec.locked) continue;
    if (value === spec.defaultEnabled) continue;
    out[spec.key] = value;
  }
  return out;
}
