import { z } from "zod";
import { OrgModule } from "./org-modules";

/**
 * The per-tenant FEATURE catalogue - one level finer than `enabled_modules`.
 *
 * ── WHY A SECOND AXIS AND NOT MORE MODULES ──────────────────────────────────
 *
 * A module is a commercial entitlement: "this client bought the CRM". A
 * feature is a provisioning decision inside one: "this client bought the CRM
 * but does not raise invoices, so do not put Invoices in their sidebar". Those
 * are different questions asked by different people at different times, and
 * collapsing them into one list would mean a 25-entry module enum where four
 * entries are contracts and twenty-one are preferences - and where turning off
 * "Invoices" would look, to every gate that reads modules, exactly like
 * cancelling a subscription.
 *
 * So modules stay the coarse entitlement and features refine them. Every
 * feature names its parent module and is meaningless without it: switching the
 * CRM module off hides all fourteen CRM features whatever their own flags say,
 * which is `featureEnabled()` below, not a rule anyone has to remember.
 *
 * ── WHAT A FEATURE FLAG IS AND IS NOT ───────────────────────────────────────
 *
 * It is a VISIBILITY control. A feature turned off disappears from the
 * client's navigation and its pages refuse to render.
 *
 * It is NOT a security boundary, and the console says so where an operator
 * turns one off. The boundary is the module gate (CrmPermissionsGuard reads
 * `enabled_modules` in the same query as the grant lookup) plus the role
 * permission grid, both enforced in the API against every request. Features
 * are enforced in the console only. That distinction is deliberate rather than
 * a shortcut: an operator tidying a sidebar should not be able to accidentally
 * revoke an integration's API access, and a client who is entitled to their
 * own deal data should not lose it because someone hid the Deals page.
 *
 * ── EVERY FEATURE POINTS AT A REAL PAGE ─────────────────────────────────────
 *
 * `hrefs` is the enforcement surface, and the reason this catalogue cannot
 * quietly grow entries that do nothing: `apps/web`'s nav test asserts that
 * every href here exists in the owner navigation, so a feature added without a
 * page - or a page renamed without updating this - fails the build rather than
 * becoming a toggle with no effect. A switch that does nothing is worse than a
 * missing switch: somebody will flip it, believe it worked, and bill for it.
 */
export const OrgFeature = z.enum([
  // ── crm ──────────────────────────────────────────────────────────────────
  "deals",
  "contacts",
  "tasks",
  "inbox",
  "whatsapp_leads",
  "outreach",
  "products",
  "quotations",
  "invoices",
  "reports",
  "report_builder",
  "duplicates",
  "import",
  "projects",
  // ── aura ─────────────────────────────────────────────────────────────────
  "call_quality",
  "productivity",
  "sops",
  "lead_sources",
  "lead_routing",
  "meta_ads",
  // ── wasi ─────────────────────────────────────────────────────────────────
  "messaging_setup",
]);
export type OrgFeature = z.infer<typeof OrgFeature>;

export interface OrgFeatureSpec {
  id: OrgFeature;
  /** The module this refines. Off with the module, whatever the feature says. */
  module: OrgModule;
  label: string;
  blurb: string;
  /**
   * Console routes this feature governs. Empty is not allowed - see the
   * header. Longest-prefix matching, so `/owner/reports/builder` belongs to
   * `report_builder` and not to `reports`.
   */
  hrefs: string[];
  /**
   * Off unless an operator turns it on, even when its module is enabled.
   *
   * Only for features that disclose something extra or cost money on their
   * own. Everything else defaults ON, because the alternative is provisioning
   * a CRM and handing the client an empty console.
   */
  optIn?: boolean;
}

export const ORG_FEATURES: OrgFeatureSpec[] = [
  {
    id: "deals",
    module: "crm",
    label: "Deals & pipeline",
    blurb: "The deals board, pipeline stages and stage history.",
    hrefs: ["/owner/deals"],
  },
  {
    id: "contacts",
    module: "crm",
    label: "Contacts & accounts",
    blurb: "The customer record - people and the companies they belong to.",
    hrefs: ["/owner/contacts", "/owner/accounts"],
  },
  {
    id: "tasks",
    module: "crm",
    label: "Tasks",
    blurb: "Follow-ups with a due date, assigned to a person.",
    hrefs: ["/owner/tasks"],
  },
  {
    id: "inbox",
    module: "crm",
    label: "Conversations inbox",
    blurb: "Incoming threads from every messaging channel, in one queue.",
    hrefs: ["/owner/inbox"],
  },
  {
    id: "whatsapp_leads",
    module: "crm",
    label: "WhatsApp lead review",
    blurb: "Unclaimed WhatsApp threads read and scored, waiting for a person to approve them.",
    hrefs: ["/owner/whatsapp-leads"],
  },
  {
    id: "outreach",
    module: "crm",
    label: "Outreach ladder",
    blurb: "Scheduled follow-up steps - who is due a nudge and what the next one is.",
    hrefs: ["/owner/outreach"],
  },
  {
    id: "products",
    module: "crm",
    label: "Product catalogue",
    blurb: "What this client sells, with prices - what a quotation is built from.",
    hrefs: ["/owner/products"],
  },
  {
    id: "quotations",
    module: "crm",
    label: "Quotations",
    blurb: "Priced proposals raised against a deal.",
    hrefs: ["/owner/quotations"],
  },
  {
    id: "invoices",
    module: "crm",
    label: "Invoices",
    blurb: "Billing a customer, and recording what they paid.",
    hrefs: ["/owner/invoices"],
  },
  {
    id: "reports",
    module: "crm",
    label: "Reports",
    blurb: "Pipeline, source attribution, and the response/follow-up SLA view.",
    hrefs: ["/owner/reports", "/owner/reports/sla"],
  },
  {
    id: "report_builder",
    module: "crm",
    label: "Report builder",
    blurb: "The client builds their own reports on a canvas, and schedules them.",
    hrefs: ["/owner/reports/builder"],
    // Runs tenant-authored queries on a schedule. Worth a deliberate decision
    // per client rather than arriving with the CRM.
    optIn: true,
  },
  {
    id: "duplicates",
    module: "crm",
    label: "Duplicate review",
    blurb: "Merging records the intake created twice.",
    hrefs: ["/owner/duplicates"],
  },
  {
    id: "import",
    module: "crm",
    label: "Bulk import",
    blurb: "Loading contacts, accounts or deals from a CSV.",
    hrefs: ["/owner/import"],
  },
  {
    id: "projects",
    module: "crm",
    label: "Project catalogue",
    blurb: "The client's own offerings, used to label leads and calls.",
    hrefs: ["/owner/projects"],
  },

  {
    id: "call_quality",
    module: "aura",
    label: "Call quality review",
    blurb: "The integrity review queue - calls flagged as mismatched or incomplete.",
    hrefs: ["/owner/call-quality"],
  },
  {
    id: "productivity",
    module: "aura",
    label: "Telecaller productivity",
    blurb: "Talk time, idle gaps and per-rep activity.",
    hrefs: ["/owner/productivity"],
  },
  {
    id: "sops",
    module: "aura",
    label: "Call procedure",
    blurb: "The script steps a call is scored against.",
    hrefs: ["/owner/sops"],
  },
  {
    id: "lead_sources",
    module: "aura",
    label: "Lead sources",
    blurb: "Web forms, telephony and webhook connectors that create leads.",
    hrefs: ["/owner/lead-sources"],
  },
  {
    id: "lead_routing",
    module: "aura",
    label: "Lead routing",
    blurb: "Rules that hand each incoming lead to a telecaller - round robin, or a percentage split.",
    hrefs: ["/owner/lead-routing"],
  },
  {
    id: "meta_ads",
    module: "aura",
    label: "Meta lead ads",
    blurb: "Facebook and Instagram lead-form connections.",
    hrefs: ["/owner/meta-ads"],
  },

  {
    id: "messaging_setup",
    module: "wasi",
    label: "WhatsApp setup",
    blurb: "Connecting the client's WhatsApp Business number.",
    hrefs: ["/owner/messaging-setup"],
  },
];

const BY_ID = new Map(ORG_FEATURES.map((f) => [f.id, f]));

export function featureSpec(id: OrgFeature): OrgFeatureSpec | undefined {
  return BY_ID.get(id);
}

/** The features that arrive switched on when a module is provisioned. */
export function defaultFeaturesFor(modules: OrgModule[]): OrgFeature[] {
  return ORG_FEATURES.filter((f) => modules.includes(f.module) && !f.optIn).map((f) => f.id);
}

/**
 * Is this feature live for a tenant?
 *
 * BOTH axes, always. The module is the entitlement and the feature is the
 * refinement, so a feature flag left set from a previous plan cannot resurrect
 * a page whose module has since been switched off - which is the failure mode
 * two independent arrays invite, and the reason this is a function rather than
 * an `includes` at each call site.
 */
export function featureEnabled(
  feature: OrgFeature,
  modules: readonly string[],
  features: readonly string[],
): boolean {
  const spec = BY_ID.get(feature);
  if (!spec) return false;
  return modules.includes(spec.module) && features.includes(feature);
}

/**
 * Which feature governs a console route, if any.
 *
 * Longest-prefix, for the same reason `navItemFor` is: `/owner/reports/builder`
 * has to resolve to `report_builder` rather than to `reports`, and a plain
 * `startsWith` over an unordered catalogue would return whichever happened to
 * be declared first.
 */
export function featureForHref(href: string): OrgFeatureSpec | undefined {
  let best: OrgFeatureSpec | undefined;
  let bestLength = -1;
  for (const spec of ORG_FEATURES) {
    for (const candidate of spec.hrefs) {
      const matches = href === candidate || href.startsWith(`${candidate}/`);
      if (matches && candidate.length > bestLength) {
        best = spec;
        bestLength = candidate.length;
      }
    }
  }
  return best;
}

/**
 * Drop features whose module is not enabled, and de-duplicate.
 *
 * Applied on write rather than on read so the stored array is always
 * self-consistent: an operator who turns the CRM off and its features on in
 * one request gets a row that says what actually happens, instead of one that
 * needs `featureEnabled` to keep lying about it forever.
 */
export function reconcileFeatures(
  modules: readonly string[],
  features: readonly string[],
): OrgFeature[] {
  const wanted = new Set(features);
  return ORG_FEATURES.filter((f) => modules.includes(f.module) && wanted.has(f.id)).map((f) => f.id);
}

/**
 * ── WhatsApp provider ───────────────────────────────────────────────────────
 *
 * Which platform a tenant's WhatsApp Business number is connected through.
 *
 * `none` is not "no WhatsApp" as a product decision - it is the honest state
 * of a tenant nobody has provisioned yet, and it is the default, because a
 * tenant with a provider set but no channel behind it looks configured and is
 * not. `wasi` is the only real value today: Aura is a Hub API client of Wasi
 * and never talks to Meta's Graph API itself.
 *
 * A `meta` member is deliberately NOT catalogued yet. Adding the name before
 * the integration exists would put a selectable option in an operator's dropdown
 * that silently does nothing - the same failure the branding page's
 * `loginBackgroundUrl` was deleted for.
 */
export const WhatsAppProvider = z.enum(["none", "wasi"]);
export type WhatsAppProvider = z.infer<typeof WhatsAppProvider>;

export interface WhatsAppProviderSpec {
  id: WhatsAppProvider;
  label: string;
  blurb: string;
  /** Does choosing this offer the client an in-app connect flow? */
  embeddedSignup: boolean;
}

export const WHATSAPP_PROVIDERS: WhatsAppProviderSpec[] = [
  {
    id: "none",
    label: "Not connected",
    blurb: "No WhatsApp provider. The client's WhatsApp Setup page explains that and offers nothing.",
    embeddedSignup: false,
  },
  {
    id: "wasi",
    label: "Wasi",
    blurb:
      "Sirah's own WhatsApp Business Solution Provider platform. The client connects their Facebook Business account in-app; Aura never touches Meta's Graph API itself.",
    embeddedSignup: true,
  },
];

export function whatsAppProviderSpec(id: string): WhatsAppProviderSpec | undefined {
  return WHATSAPP_PROVIDERS.find((p) => p.id === id);
}
