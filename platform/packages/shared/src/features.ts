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
 * ── A DEFAULT PRESERVES THE STATUS QUO, WHICHEVER WAY IT POINTS ─────────────
 *
 * The rule is not "everything defaults on". It is that `resolveFeatures(modules,
 * {})` reproduces the console EXACTLY as it renders today, so the deploy itself
 * is never a product change. The first bug report from a catalogue whose
 * defaults were an opinion would be "half our pages vanished" from a tenant who
 * never asked for a switchboard.
 *
 * For the 38 features that shipped with the switchboard, every page already
 * existed, so preserving the status quo meant `defaultEnabled: true`.
 *
 * For a feature whose surface has NEVER been reachable, the same rule points the
 * other way: `defaultEnabled: false`. Doc 39 built five of these - the dialer,
 * web forms, appointments, resources and the partner portal - and defaulting
 * them on would hand every existing tenant five consoles they never asked for,
 * which is the exact failure this section exists to prevent. Build docs/40 §A1.
 *
 * `features.test.ts` pins the property per flag rather than trusting that they
 * all point the same way.
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
  "appointments",
  "resources",
  // ── Customers (CRM objects) ──
  "deals",
  "contacts",
  "duplicates",
  "import",
  // ── Conversations ──
  "call_log",
  "call_triage",
  "call_insights",
  "call_quality",
  "call_sops",
  "agent_studio",
  "productivity",
  "attendance",
  "dialer",
  "inbox",
  "whatsapp_leads",
  // ── Sales ──
  "products",
  "quotations",
  "invoices",
  // The finance back office. TWO keys, both on the `finance` module - see
  // their specs below for why it is two and not one or three.
  "finance_collections",
  "finance_advisor",
  // ── Insights ──
  "reports",
  "report_builder",
  "sla_reports",
  // ── Lead connectors ──
  "web_forms",
  "lead_sources",
  "lead_routing",
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
  "suppression",
  "handsets",
  "branding",
  "partner_portal",
  "org_chart",
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
  {
    key: "appointments",
    label: "Appointments",
    blurb: "The diary: slots booked against a resource, rescheduled, and marked attended.",
    // `crm`, following `PERMISSION_OBJECT_MODULE.appointment` rather than the
    // feature's own feel. That map is the authority because it is what the
    // routes actually enforce: an appointment is a CRM record with an assignee,
    // and a recorder-only tenant has no diary to put one in. Filing this under
    // `aura` would offer the page to a tenant whose every request to it the
    // grid refuses - the `followups` mistake, which `suppression` avoids by the
    // same rule in the opposite direction.
    module: "crm",
    // "customers", matching the rail section it is filed under - these groups
    // are deliberately the sidebar's, so the switchboard reads in the order
    // somebody already knows. An appointment is time booked with a PERSON, so
    // it sits beside Contacts and Accounts rather than under Pipeline, where a
    // reader would expect something that moves a deal along.
    group: "customers",
    // Landed with the page and the nav item (Build docs/40 §B2), which is the
    // rule the remaining empty lists record: `feature-gating.test.ts` and
    // `owner-features.guard.test.ts` both assert that every href here has a
    // real page file AND a nav entry, so a switch can never govern a 404.
    hrefs: ["/owner/appointments"],
    // OFF. Migration 0166 built the table, the RLS, the booking API, calendar
    // sync and the reschedule tokens; no console ever reached them, so "off"
    // IS the status quo and defaulting on would hand every tenant a diary they
    // did not ask for. Build docs/40 §A1.
    defaultEnabled: false,
  },
  {
    key: "resources",
    label: "Bookable resources",
    blurb: "The chairs, rooms, bays or people an appointment is booked against.",
    // `crm`, for the reason `appointments` gives above:
    // `PERMISSION_OBJECT_MODULE.resource` is `crm`, because a resource hangs
    // off projects, deals and quotations.
    module: "crm",
    // "sales", beside Products. A resource is reference data about what the
    // business offers - the stock an appointment draws on - which is exactly
    // what the price list is to a quotation.
    group: "sales",
    // Landed with the page and the nav item (Build docs/40 §B3).
    hrefs: ["/owner/resources"],
    // A resource exists to be booked. Without the diary it is a list of chairs
    // nobody can reserve, so this is `blocked` rather than merely useless when
    // somebody switches it on alone - and the switchboard names the blocker.
    requires: ["appointments"],
    defaultEnabled: false,
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
    key: "call_insights",
    label: "Call insights",
    blurb: "The floor-wide read of every call - volume, missed calls, outcomes, quality - with a PDF report.",
    // `call_intel`, like the call log: the page is an aggregate of the AI read
    // of each call (sentiment, outcome, intent), which is exactly what that
    // module entitles a tenant to see. No `requires`: the report stands on its
    // own, and its links into the call log simply vanish with that page.
    module: "call_intel",
    group: "conversations",
    hrefs: ["/owner/insights"],
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
    key: "agent_studio",
    label: "AI agent studio",
    blurb:
      "Building your own AI agents: what calls are read for, how WhatsApp enquiries are judged, and drafted replies.",
    // `aura`: the extractor it edits is what turns every recorder tenant's
    // calls into leads, which is core. Switching the studio OFF hides the page
    // and refuses its routes; it does not stop an agent that is already running
    // - a tidied sidebar must not quietly stop calls becoming leads.
    module: "aura",
    group: "conversations",
    hrefs: ["/owner/agents"],
    defaultEnabled: true,
  },
  {
    key: "productivity",
    label: "Productivity",
    blurb:
      "Talk time, call volume and the idle gap between calls, per person - and each " +
      "person's own scorecard, where that output sits beside the quality of it.",
    module: "aura",
    group: "conversations",
    // Both pages, one key. They are two views of one thing: the list is the
    // floor read by whoever supervises it, the scorecard is one column of that
    // list read by the person it is about. A tenant that switched the list off
    // and left the scorecard on would be running an appraisal surface nobody
    // with the authority to act on it can see, and the reverse leaves reps
    // measured by a page they cannot open.
    hrefs: ["/owner/productivity", "/owner/my-performance"],
    defaultEnabled: true,
  },
  {
    key: "attendance",
    label: "Attendance",
    blurb: "Shifts, breaks, leave requests and the live board of who is working (doc 33).",
    // Visible by default like every entry here; the workspace's own
    // `attendance_enabled` switch (0140, default off) is what decides whether
    // any handset tracks anything. Switching the FEATURE off hides the pages
    // and refuses the routes, but does not stop a phone mid-shift - it simply
    // stops receiving the config block on its next refresh.
    module: "aura",
    group: "conversations",
    hrefs: ["/owner/attendance", "/owner/settings/attendance"],
    defaultEnabled: true,
  },
  {
    key: "dialer",
    label: "Dialer",
    blurb: "Call campaigns a handset works through, with the reason any record cannot be rung.",
    // `aura`, for the same reason `suppression` is: this gates CALLING, which
    // is the recorder product. The console assigns and reports; the HANDSET
    // dials. There is no softphone, no bridging and no carrier here, by
    // standing decision.
    module: "aura",
    group: "conversations",
    // Landed in the same change as the page and the nav item (Build docs/40
    // §B1), which is the rule the empty lists on the other three record.
    hrefs: ["/owner/dialer"],
    // THE LOAD-BEARING DEPENDENCY. A tenant who switched do-not-call lists off
    // would otherwise keep a working dialer and no way to maintain the list
    // that stops it ringing a registered number - the precise hazard doc 39's
    // P0 exists to prevent. Being `blocked` with the blocker named is the right
    // answer; being silently dialable is not.
    requires: ["suppression"],
    // OFF. 0159-0162 built the queue, the lease/claim protocol and the eight
    // block reasons; no console ever reached them.
    defaultEnabled: false,
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
  /**
   * The finance back office (Build docs/finance-section-build-plan, migrations
   * 0172-0176). TWO keys, and the count is the catalogue's own rule talking.
   *
   * ── WHY NOT ONE ──────────────────────────────────────────────────────────
   *
   * The Advisor is the half that NOTIFIES people. A floor that wants the
   * numbers without the nagging should be able to have them, and a client who
   * switches off "Finance" to stop the alerts would lose their collections
   * list with it.
   *
   * ── AND WHY NOT THREE ────────────────────────────────────────────────────
   *
   * It was three - collections, costs, Advisor - and `feature-gating.test.ts`
   * refused it, correctly. The catalogue requires a feature's hrefs to be ALL
   * navigable or none, and `finance_costs` governed one page
   * (`/owner/finance/expenses`) that has no rail entry of its own: the finance
   * module has six pages, the rail's seven top-level entries are already full
   * (`OWNER_RAIL_MAX_TOP_LEVEL`), and six more tabs would make the Sales strip
   * eleven long.
   *
   * So the two keys name the two pages that ARE in the rail, and the other
   * four are governed by prefix - `featureForPath` resolves
   * `/owner/finance/expenses` to `/owner/finance` and therefore to
   * `finance_collections`. Switching collections off takes the whole back
   * office with it, which is the honest reading of that switch anyway.
   */
  {
    key: "finance_collections",
    label: "Finance & collections",
    blurb:
      "Instalment plans, every payment in one place whatever it arrived by, the dues list, " +
      "expenses and the margin left after them.",
    module: "finance",
    group: "sales",
    // The rail entry. Dues, payments, expenses and the forecast all sit under
    // this path and are governed by it through `featureForPath`'s prefix
    // match, so they are reached from the Finance page rather than from four
    // more tabs.
    hrefs: ["/owner/finance"],
    defaultEnabled: true,
  },
  {
    key: "finance_advisor",
    label: "Finance Advisor",
    blurb:
      "The money-leak inbox and the cash forecast. It tells your own people what needs " +
      "chasing; it never messages a customer.",
    module: "finance",
    group: "sales",
    hrefs: ["/owner/finance/advisor"],
    requires: ["finance_collections"],
    defaultEnabled: true,
  },

  // ── Insights ──────────────────────────────────────────────────────────────
  {
    key: "reports",
    label: "Reports",
    blurb:
      "Pipeline value, win rates, source attribution and per-rep results - and the " +
      "command centre, where those sit beside campaign spend and the floor's activity.",
    module: "crm",
    group: "insights",
    // Both, one key. The command centre is a reading of the same pipeline the
    // Sales overview reports on, and a tenant with one switched off and the
    // other on would be running two views of the same quarter that disagree
    // about whether anybody may see it.
    hrefs: ["/owner/reports", "/owner/performance"],
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
    key: "web_forms",
    label: "Web forms",
    blurb: "Hosted forms on your own slug, whose submissions land on a board as leads.",
    module: "aura",
    group: "connectors",
    // Landed with the page and the nav item (Build docs/40 §B4).
    hrefs: ["/owner/forms"],
    // NOT the same thing as `lead_sources`, whose blurb also says "web forms".
    // That feature is the CATALOGUE of places leads arrive from - a form, an
    // inbox, a CSV, telephony. This one is migration 0161's BUILDER: it creates
    // a hosted page at a platform-wide-unique slug. A tenant can have lead
    // sources with no builder (their own site posts to the API) and the two
    // switch independently, so neither requires the other.
    defaultEnabled: false,
  },
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
    key: "lead_routing",
    label: "Lead routing",
    blurb:
      "Rules that decide who works each new lead, instead of somebody assigning them by hand.",
    // `aura`, not `crm`: routing acts on `leads`, which every recorder tenant
    // has. The page is owner/manager by persona (nav.ts), which is the tighter
    // control and the one that matters here.
    module: "aura",
    group: "connectors",
    hrefs: ["/owner/lead-routing"],
    // On like every other catalogued feature - the page being visible routes
    // nothing. A rule has to be written before a lead moves, so the opt-in
    // that matters is creating the rule, not finding the page.
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
    // No page of its own any more (doc 28, Q8): the mailbox apps live in the
    // Integrations store, which hides each app whose feature is off
    // (integrations.ts, `feature`). /owner/connections is a bare redirect.
    hrefs: [],
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
    key: "suppression",
    label: "Do-not-call lists",
    blurb: "The uploaded registries and your own list of numbers nobody here may ring.",
    // `aura`, and unlike `followups` that is the answer the routes give rather
    // than the one the feature feels like. Suppression gates CALLING, which is
    // the recorder product: `PERMISSION_OBJECT_MODULE.dnc` is `aura`, so the
    // lists' routes carry `@RequireCrmPermission("dnc", ...)` over the `aura`
    // module plus the ordinary tenant guards. Filing the feature under `crm`
    // would be the `followups` mistake inverted - hiding a page from every
    // recorder-only tenant whose every request to it would have succeeded.
    module: "aura",
    group: "workspace",
    hrefs: ["/owner/settings/suppression"],
    defaultEnabled: true,
  },
  {
    key: "handsets",
    label: "Handsets",
    blurb: "The phones in the fleet, what each one last reported, and pairing a new one.",
    module: "aura",
    group: "workspace",
    // `/owner/devices`, not `/owner/handsets`. Both existed for one release -
    // a read-only fleet view here and the pairing surface migration 0107 gave
    // the client - and the rail carried BOTH under the label "Handsets", which
    // is the duplicate this entry resolves. `/owner/devices` won because it is
    // the superset (it shows the fleet AND pairs), because the setup checklist
    // already sends people there (onboarding.ts), and because
    // operator-only.guard.ts names it as the client's pairing route. The old
    // path still resolves - it redirects - so live links keep working.
    hrefs: ["/owner/devices"],
    // LOCKED, and that is a change in kind from the read-only page this
    // replaced. A switchable feature has to be safe to switch off; this one is
    // not. A tenant who turned Handsets off could no longer pair a phone, and
    // an Aura tenant with no phone has no calls, no transcripts and no leads -
    // the switch would brick the product from inside the product. Same
    // reasoning as `leads` and `staff`: it stays on the board so an owner can
    // see it exists, wearing "always on" instead of a toggle.
    locked: true,
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
  {
    key: "partner_portal",
    label: "Partner portal",
    blurb: "A sign-in for brokers and referrers to submit leads and see their commissions.",
    module: "aura",
    group: "workspace",
    // NO hrefs, and that is not an oversight. Every other entry governs a page
    // on the OWNER rail; this one governs `app/(portal)`, a separate route group
    // for a different persona who never sees the console. `sheets_sync` carries
    // the same empty list for the adjacent reason - it is a panel, not a
    // destination. An href here would put a partner-only page on the owner's
    // sidebar, where it would 404 for the only people who can see it.
    hrefs: [],
    // OFF, and this one is a fix rather than a precaution: 0163 shipped the
    // portal with no gate at all, so until now ANY org with a partner row had a
    // live portal. The decision was to hide it and bring it back later on its
    // own hostname. The 0163 RESTRICTIVE partner wall is untouched and stays the
    // security boundary; this key is reachability. Build docs/40 §A2.
    defaultEnabled: false,
  },
  {
    key: "org_chart",
    label: "Organization chart",
    blurb:
      "Who reports to whom, what each role is responsible for and what it may approve - plus employment contracts.",
    // `aura`, following `PERMISSION_OBJECT_MODULE.position` rather than the
    // feature's own feel, because that map is what the routes actually enforce.
    // Every business has a team and a reporting line, CRM or not - filing this
    // under `crm` would offer the page to a recorder-only tenant whose every
    // request to it the grid refuses, which is the `followups` mistake.
    module: "aura",
    group: "workspace",
    hrefs: ["/owner/org-chart"],
    // ── ON BY DEFAULT, WHICH IS A DECISION WORTH DEFENDING ──────────────────
    //
    // It means every existing tenant gains a Settings entry on deploy day,
    // opening onto an empty chart. That is deliberate, and §5.3 is why: the
    // first-run state is a guided "create your first position (the owner)"
    // action, not a blank canvas. A feature that arrives switched off is a
    // feature nobody discovers, and this one has nothing to configure before
    // it is useful.
    //
    // The restricted half is NOT gated by this switch and must not be: a
    // telecaller is kept out of contracts by having no `employment_contract`
    // grant (0178), which is security. This key is reachability - doc 40's
    // distinction, and the reason a feature is the right axis here and a
    // module is not.
    defaultEnabled: true,
  },
];

/**
 * Where each switch is actually enforced (Build docs/40 §A4).
 *
 * ── THE OVERCLAIM THIS EXISTS TO RETIRE ─────────────────────────────────────
 *
 * The switchboard renders 42 switches that look alike. 13 of them refuse at the
 * API; the other 29 are enforced only by the web tier's page guard, so "off"
 * hides the page and leaves the routes answering to anyone with a direct link or
 * a server action the page already shipped.
 *
 * That is a deliberate trade-off, not an oversight - `org-feature.guard.ts` sets
 * out why a gate on a SHARED read is worse than no gate: `GET /v1/leads` is read
 * by the board, the dashboard and three reports, so gating it on one feature
 * would take out surfaces the client never switched off. The rule is "gate a
 * route only when the whole route belongs to the feature", and for 29 features
 * that condition is genuinely not met.
 *
 * What was wrong was not the trade-off but the silence about it. A switch that
 * hides a page and a switch that refuses a request are different promises, and
 * an owner turning one off deserves to know which they got. So this is stated,
 * rendered on the page, and pinned in a test rather than left to be rediscovered
 * by whoever next audits the product.
 *
 * ── WHY A LIST AND NOT A FIELD ON FeatureSpec ───────────────────────────────
 *
 * 42 hand-written `enforcement:` values are 42 chances to be wrong, and nothing
 * in this package can check one: the decorators live in the API. One list can be
 * compared against the API's actual decorators in a single assertion, which
 * `org-feature-enforcement.spec.ts` does - so this cannot drift from the code it
 * describes without a red test.
 */
const API_ENFORCED: ReadonlySet<FeatureKey> = new Set([
  // Each of these carries `@RequireFeature(...)` on a controller whose whole
  // surface belongs to the feature.
  "agent_studio",
  "attendance",
  "call_insights",
  "call_quality",
  "call_sops",
  "call_triage",
  "integrations",
  "lead_sources",
  "meta_ads",
  "productivity",
  "reports",
  "suppression",
  // The exception: enforced in `withPartnerContext` rather than by a decorator,
  // because the portal's chokepoint covers routes nobody has written yet. Build
  // docs/40 §A2 gives the full argument.
  "partner_portal",
]);

/**
 * `"api"` - the routes refuse when this is off.
 * `"page"` - the console hides the page; the routes still answer.
 */
export function featureEnforcement(key: FeatureKey): "api" | "page" {
  return API_ENFORCED.has(key) ? "api" : "page";
}

/** The api-enforced keys, for the spec that compares them to the decorators. */
export const API_ENFORCED_FEATURES: readonly FeatureKey[] = [...API_ENFORCED].sort();

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
