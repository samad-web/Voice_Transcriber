import {
  Activity,
  AlertTriangle,
  BarChart3,
  Building2,
  CalendarDays,
  ClipboardCheck,
  Contact,
  Copy,
  FileText,
  Gauge,
  Handshake,
  Inbox,
  KeyRound,
  Languages,
  Layers,
  LayoutGrid,
  LineChart,
  Link2,
  ListChecks,
  ListFilter,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  Milestone,
  Package,
  Palette,
  Phone,
  PhoneForwarded,
  PieChart,
  Plug,
  Receipt,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Target,
  ToggleLeft,
  Unlink,
  Upload,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import {
  type FeatureOverrides,
  type OwnerRole,
  enabledFeatures,
  featureForHref,
} from "@aura/shared";

/** The two consoles: the platform operator's, and one customer's own. */
export type NavArea = "platform" | "owner";

export interface NavItem {
  href: string;
  /** Sidebar label - short, fits the 16rem rail. */
  label: string;
  icon: LucideIcon;
  /** The page's own <PageHeader> title. Kept here so the loading skeleton can
   *  render the real heading immediately instead of a placeholder that swaps
   *  to different text when the data lands. */
  title: string;
  /** PageHeader eyebrow; defaults to "Workspace" like PageHeader itself. */
  context?: string;
  /** Owner-console personas (design doc §9) that may see this item. Omitted = every persona. */
  ownerRoles?: OwnerRole[];
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Platform Hub", icon: Activity, title: "Platform Hub" },
  { href: "/calls", label: "Call Log Explorer", icon: Phone, title: "Call Log Explorer" },
  { href: "/search", label: "Search", icon: Search, title: "Transcript Search" },
  { href: "/agents", label: "AI Agent Studio", icon: Sparkles, title: "AI Agent Studio" },
  {
    href: "/slots",
    label: "Booking Slots",
    icon: CalendarDays,
    title: "Booking Slots",
    context: "Platform",
  },
  {
    href: "/leads",
    label: "Funnel Leads",
    icon: ListFilter,
    title: "Funnel Leads",
    context: "Platform",
  },
  {
    href: "/instances",
    label: "Instances",
    icon: Building2,
    title: "Instances",
    context: "Platform",
  },
  { href: "/crm", label: "CRM Integrations", icon: Plug, title: "CRM Integrations" },
  {
    href: "/custom-fields",
    label: "Custom Fields",
    icon: SlidersHorizontal,
    title: "Custom Fields",
    context: "Platform",
  },
  {
    href: "/targets",
    label: "Targets",
    icon: Target,
    title: "Sales Targets",
    context: "Platform",
  },
  {
    href: "/automations",
    label: "Automations",
    icon: Workflow,
    title: "Automations",
    context: "Platform",
  },
  {
    href: "/roles",
    label: "Roles",
    icon: ShieldCheck,
    title: "Roles",
    context: "Platform",
  },
  { href: "/team", label: "Team", icon: Users, title: "Team Management" },
  // Visible to every operator, writable only by the root (migration 0089).
  // Deliberately not hidden from the rest: knowing who else administers the
  // platform is not a privilege, and a list nobody can see is a list nobody
  // audits.
  { href: "/operators", label: "Superadmins", icon: ShieldCheck, title: "Superadmins" },
  { href: "/api-keys", label: "API Keys", icon: KeyRound, title: "API Keys" },
  { href: "/usage", label: "Usage", icon: BarChart3, title: "Usage & Billing" },
];

/**
 * The customer owner's console. Three pages, no operator surface: an owner can
 * never reach Instances, API keys or another tenant's data, because those
 * routes are not in their nav and the layout redirects them away besides.
 */
export const OWNER_NAV_ITEMS: NavItem[] = [
  { href: "/owner", label: "Dashboard", icon: Activity, title: "Dashboard", context: "Instance" },
  {
    href: "/owner/board",
    label: "Lead Board",
    icon: LayoutGrid,
    title: "Lead Board",
    context: "Pipeline",
    // Telecaller's nav is Dashboard + All Leads (self-filtered) + their own
    // team profile once that route lands (design doc §9) - not the full board.
    //
    // Sales joins them (0079) because working a pipeline IS the sales job -
    // and the board they get is their own, since the API scopes every card to
    // records assigned to them (owner-scope.ts). Marketing does not: a
    // marketer generates demand and hands it over, and a board of deals
    // nobody has assigned to them would be empty by construction.
    ownerRoles: ["owner", "manager", "sales"],
  },
  {
    href: "/owner/leads",
    label: "All Leads",
    icon: ListFilter,
    title: "All Leads",
    context: "Pipeline",
  },
  {
    href: "/owner/calls",
    label: "Calls",
    icon: Phone,
    title: "Calls",
    context: "Pipeline",
    // Owner/manager only, like Call Quality: a call log is a view over the
    // whole floor's conversations, not a telecaller's view of their own work
    // (design doc §9). The API enforces the same pair - the nav is the
    // convenience, not the control.
    //
    // Sales and marketing stay out for a reason that is not seniority: this
    // page carries verbatim transcripts of customers' phone calls, the most
    // sensitive artefact in the product. The set of people who may read them
    // should grow one deliberate decision at a time, not by inheriting from a
    // persona added for another purpose.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/projects",
    label: "Projects",
    icon: Layers,
    title: "Projects",
    context: "Pipeline",
    // Deliberately NOT in CRM_GATED_HREFS, alongside Lead Board and All
    // Leads: the catalogue labels `leads`, which are core Aura, so a tenant
    // without the CRM module still sees project chips on their board and
    // still needs somewhere to edit the list behind them.
    //
    // Marketing reads it because a campaign is aimed at a PROJECT - "which
    // offering is this ad for" is the question the catalogue answers, and
    // running attribution without it means reporting on labels whose
    // definition you cannot see.
    ownerRoles: ["owner", "manager", "sales", "marketing"],
  },
  {
    href: "/owner/deals",
    label: "Deals",
    icon: Handshake,
    title: "Deals",
    context: "Pipeline",
    // Same persona restriction as the lead board (design doc §9) - a
    // telecaller's nav stays Dashboard + All Leads, not the full pipeline -
    // and sales joins for the same reason it joins the board.
    ownerRoles: ["owner", "manager", "sales"],
  },
  {
    href: "/owner/tasks",
    label: "Follow-ups",
    icon: ListChecks,
    title: "Follow-ups",
    context: "Pipeline",
    // Renamed, not moved (migration 0095). The URL stays /owner/tasks because
    // every bookmark, notification link_path and deal-page link points at it -
    // and because the table really is `tasks`. What changed is what the page
    // is FOR: a queue of promises with a due date and an overdue count, rather
    // than a list of open work.
    // No persona restriction, unlike the boards: a telecaller's own follow-ups
    // are exactly the thing they need this console for.
  },
  {
    href: "/owner/inbox",
    label: "Inbox",
    icon: MessagesSquare,
    title: "Inbox",
    context: "Pipeline",
    // Everyone who works a customer, for the same reason Tasks is: a
    // telecaller answering replies is the whole job, and routing
    // correspondence to a persona who cannot see it is how an enquiry goes
    // unanswered.
    //
    // Marketing is the exception (0079). This is one-to-one correspondence
    // with named customers, not campaign material; a marketer has no thread
    // assigned to them, and the shared queue is not a broadcast channel.
    ownerRoles: ["owner", "manager", "telecaller", "sales"],
  },
  {
    href: "/owner/whatsapp-leads",
    label: "WhatsApp leads",
    icon: MessagesSquare,
    title: "WhatsApp leads",
    context: "Pipeline",
    // Same audience as the Inbox it feeds off, and for the same reason: the
    // person who answers a thread is the person who can tell whether it was a
    // buyer or a courier. Marketing is excluded as it is there - this is
    // one-to-one correspondence with named customers, not campaign material.
    ownerRoles: ["owner", "manager", "telecaller", "sales"],
  },
  {
    href: "/owner/outreach",
    label: "Outreach",
    icon: Milestone,
    title: "Outreach",
    context: "Pipeline",
    // Unrestricted, like Tasks and Inbox: working the follow-up ladder is a
    // telecaller's core job, not a manager's oversight view.
  },
  {
    href: "/owner/contacts",
    label: "Contacts",
    icon: Contact,
    title: "Contacts",
    context: "Pipeline",
  },
  {
    href: "/owner/accounts",
    label: "Accounts",
    icon: Building2,
    title: "Accounts",
    context: "Pipeline",
  },
  {
    href: "/owner/products",
    label: "Products",
    icon: Package,
    title: "Products",
    context: "Pipeline",
    // Sales quotes from the catalogue, so it has to be able to read it.
    ownerRoles: ["owner", "manager", "sales"],
  },
  {
    href: "/owner/quotations",
    label: "Quotations",
    icon: FileText,
    title: "Quotations",
    context: "Pipeline",
    // Raising a quote is the sales job. Turning one into an INVOICE is not -
    // see the next entry, which deliberately stops at owner/manager.
    ownerRoles: ["owner", "manager", "sales"],
  },
  {
    href: "/owner/invoices",
    label: "Invoices",
    icon: Receipt,
    title: "Invoices",
    context: "Pipeline",
    // Owner/manager only, and the one place the sales persona stops short of
    // the quotation it raised: billing a customer is a financial commitment by
    // the business, and the person who negotiated the price should not also be
    // the one who invoices it.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/sops",
    label: "Call procedure",
    icon: ClipboardCheck,
    title: "Call procedure",
    context: "Team",
    // Owner and manager only, unlike Productivity below. That page shows a
    // person their own numbers, which every persona is entitled to; this one
    // DEFINES the measure, and a telecaller editing the rules they are scored
    // against is the one shape of access with no defensible reading. The API
    // enforces it (call-sops.controller.ts) - this just stops offering it.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/productivity",
    label: "Productivity",
    icon: Gauge,
    title: "Productivity",
    context: "Team",
    // No `ownerRoles`, deliberately - every persona may open this, including a
    // telecaller. The route narrows the ROWS rather than refusing the page, so
    // a rep sees their own talk time and idle gaps and nobody else's.
    // Restricting the nav item would hide a rep's own numbers from the rep.
  },
  {
    href: "/owner/reports",
    label: "Reports",
    icon: PieChart,
    title: "Reports",
    context: "Pipeline",
    // Pipeline value and per-rep win rates are a manager's view of the team,
    // not a telecaller's or a rep's view of their own work - same restriction
    // the boards carry (design doc §9). A rep's own numbers are on their
    // dashboard, which is scoped to them.
    //
    // Marketing joins (0079): source and campaign attribution lives here, and
    // "which channel produced revenue" is unanswerable without the revenue
    // half. That is a deliberate disclosure of deal values to the marketing
    // persona - narrower than the whole console, wider than nothing.
    ownerRoles: ["owner", "manager", "marketing"],
  },
  {
    href: "/owner/reports/sla",
    label: "Response & Follow-ups",
    icon: Gauge,
    title: "Response & Follow-ups",
    context: "Pipeline",
    // Owner/manager only, and narrower than Reports on purpose. This is a
    // supervision surface: it names who answered slowly and who missed a
    // follow-up. Marketing has no floor to supervise, and a telecaller
    // reading the league table they are bottom of is a management decision,
    // not a default (same reasoning as Call Quality).
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/reports/builder",
    label: "Report Builder",
    icon: LineChart,
    title: "Report builder",
    context: "Pipeline",
    // Same persona restriction as Reports, and for the same reason: a report
    // is a view over the whole team's pipeline, not a telecaller's view of
    // their own work (design doc §9). The API narrows it further per record
    // scope regardless of who reaches the page.
    ownerRoles: ["owner", "manager", "marketing"],
  },
  {
    href: "/owner/connections",
    label: "Connections",
    icon: Link2,
    title: "Connections",
    context: "Your account",
    // No persona restriction: this is a person's own mailbox and calendar,
    // not a team setting. A telecaller connecting their own email is exactly
    // the point.
  },
  {
    href: "/owner/duplicates",
    label: "Duplicates",
    icon: Copy,
    title: "Duplicates",
    context: "Pipeline",
    // Marketing owns the intake that CREATES most duplicates - the same
    // person should be able to clean them up.
    ownerRoles: ["owner", "manager", "marketing"],
  },
  {
    href: "/owner/import",
    label: "Import",
    icon: Upload,
    title: "Bulk Import",
    context: "Pipeline",
    // A list bought from an event or an agency arrives as a CSV, and loading
    // it is marketing's job.
    ownerRoles: ["owner", "manager", "marketing"],
  },
  {
    href: "/owner/messaging-setup",
    label: "WhatsApp Setup",
    icon: MessageCircle,
    title: "WhatsApp Setup",
    context: "Settings",
    // Grouped under Lead connectors, and marketing owns lead connectors.
    ownerRoles: ["owner", "manager", "marketing"],
  },
  {
    href: "/owner/lead-sources",
    label: "Lead Sources",
    icon: Inbox,
    title: "Lead Sources",
    context: "Pipeline",
    // Not a telecaller's or a rep's decision: a source carries a credential
    // and decides who new business is assigned to. Marketing joins because
    // connecting the channels demand arrives on IS the marketing job - it is
    // the single most load-bearing page for that persona.
    ownerRoles: ["owner", "manager", "marketing"],
  },
  {
    href: "/owner/meta-ads",
    label: "Meta Lead Ads",
    icon: Megaphone,
    title: "Meta Lead Ads",
    context: "Settings",
    ownerRoles: ["owner", "manager", "marketing"],
  },
  {
    href: "/owner/transcription",
    label: "Transcription",
    icon: Languages,
    title: "Transcription",
    context: "Settings",
    // Owner and manager, matching the persona check in the page's own server
    // action - which is the real control here, because the API route behind it
    // cannot tell one console persona from another (see that action's header).
    //
    // Marketing is deliberately out despite owning brand names elsewhere:
    // changing the spoken LANGUAGE or the transcript style re-shapes every
    // transcript the floor produces, and that is a decision about how the
    // business runs, not about how it presents itself.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/handsets",
    label: "Handsets",
    icon: Smartphone,
    title: "Handsets",
    context: "Settings",
    // Read-only here on purpose: provisioning a key, remote-wiping or
    // removing a phone from the fleet stays an operator action on the other
    // console (Instances -> <instance> -> Devices), the same asymmetry the
    // rest of Settings already draws (Transcription lets an owner edit their
    // own glossary; nothing here lets them re-enroll a handset). Owner and
    // manager, matching Transcription and Team - the two personas who run
    // the floor, not the two who sell on it.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/staff",
    label: "Staff",
    icon: Users,
    title: "Staff",
    context: "Workspace",
    // Was /owner/team, and that URL still resolves - it redirects here (see
    // that page). Renamed because the section now answers three questions
    // rather than one: who is here, what may they do, and how are they doing.
    //
    // Owner and manager, matching what the API allows: a manager reads the
    // roster, the permission grid and the scorecard, and only an owner changes
    // any of them. Every tab renders read-only for a manager rather than being
    // hidden - knowing who sits where is part of running the floor.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/features",
    label: "Features",
    icon: ToggleLeft,
    title: "Features",
    context: "Workspace",
    // Owner and manager, and deliberately NOT in the feature catalogue itself:
    // a switchboard that could be switched off is one click from a workspace
    // that needs an operator with a SQL prompt to recover. Same reasoning as
    // the locked entries in features.ts.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/integrations",
    label: "Integrations",
    icon: Plug,
    title: "Integrations",
    context: "Workspace",
    // Owner/manager, matching the API. This page names which of the tenant's
    // outside accounts are joined up and which are failing, which is
    // administration rather than day-to-day work - and it is a directory of
    // Connections and Messaging setup, both of which carry the same tier.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/superfone",
    label: "Superfone calls",
    icon: PhoneForwarded,
    title: "Superfone",
    context: "Superfone",
    // ── ITS OWN SECTION, DELIBERATELY ────────────────────────────────────
    //
    // Superfone is one telephony provider among several and could have been a
    // filter on the call log. It is separated because the two logs answer
    // different questions and have different data behind them: the call log is
    // recordings the handsets uploaded, with transcripts and AI reads;
    // Superfone is a CDR feed from a cloud PBX, with no audio of ours and no
    // transcript. Merging them would produce a list where half the rows have
    // no "open the conversation" and no explanation of why.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/branding",
    label: "Branding",
    icon: Palette,
    title: "Branding",
    context: "Settings",
    // Marketing owns how the business presents itself, which is what this page
    // is - the logo and palette on every quote and invoice a customer receives.
    ownerRoles: ["owner", "manager", "marketing"],
  },
  {
    href: "/owner/calls/triage",
    label: "Unmatched calls",
    icon: Unlink,
    title: "Unmatched calls",
    context: "Conversations",
    // Owner/manager only, matching the call log it hangs off: the queue is
    // every unmatched call on the floor and working it creates leads across
    // the whole team. Same `call_intel` entitlement, checked per request.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/call-quality",
    label: "Call Quality",
    icon: AlertTriangle,
    title: "Call Quality",
    context: "Pipeline",
    // A manager's review queue over the whole floor's calls, same restriction
    // as Reports and the boards (design doc §9) - not a telecaller's own view.
    ownerRoles: ["owner", "manager"],
  },
];

/**
 * ── MODULE GATING MOVED TO THE FEATURE CATALOGUE ───────────────────────────
 *
 * `CRM_GATED_HREFS` and `CALL_INTEL_GATED_HREFS` used to live here: two hand-
 * maintained lists of pages to hide when the org lacked a module (0072). They
 * are gone, and the same answers now come from `FEATURES` in @aura/shared,
 * where each page's module sits beside the page.
 *
 * Not a tidy-up - a correctness change. Those lists and the client's own
 * feature switches (0101) would otherwise be two independent reasons to hide
 * the same row, and the first time they disagreed the sidebar would show a
 * link the API refuses. One catalogue answers both, and the API, the worker
 * and this file all read it.
 *
 * `nav.test.ts` pins the module behaviour unchanged across the move.
 */

/**
 * The owner console's sidebar groups, in render order.
 *
 * WHY THIS EXISTS. The customer console grew to two dozen destinations, and a
 * flat rail of two dozen is not a menu - it is a list you read top to bottom
 * every time because nothing tells you where to look. Grouping is what turns
 * "somewhere in there" into "under Lead connectors".
 *
 * The grouping is by WHAT SOMEBODY CAME TO DO, not by what the code is. Meta
 * Lead Ads and WhatsApp Setup sit beside Lead Sources under Lead connectors
 * because all three answer "where do new leads arrive from" - even though one
 * is an ad platform, one is a messaging provider and one is a CSV/webhook
 * catalogue. Filing them under Settings, where they were, meant the person
 * connecting a lead source had to already know that.
 *
 * Dashboard has no section on purpose: it sits above the first heading, which
 * is what makes the first heading read as a heading rather than a label for
 * everything under it.
 */
export const OWNER_NAV_SECTIONS = [
  { key: "pipeline", label: "Pipeline" },
  { key: "crm", label: "Customers" },
  { key: "conversations", label: "Conversations" },
  { key: "sales", label: "Sales" },
  { key: "insights", label: "Insights" },
  { key: "connectors", label: "Lead connectors" },
  // Superfone gets a heading of its own rather than a row under Conversations.
  // A section with one entry looks odd until the second one lands, and the
  // reason it exists is that this is a SEPARATE telephony product with its own
  // numbers, its own log and no audio of ours - not a view of the call log.
  { key: "superfone", label: "Superfone" },
  { key: "workspace", label: "Workspace" },
] as const;

export type NavSection = (typeof OWNER_NAV_SECTIONS)[number]["key"];

/**
 * Which group each owner page belongs to.
 *
 * A map here rather than a `section` field on each item, so the whole taxonomy
 * is readable in one screen - the question this file gets asked is "what is
 * next to what", and a property spread across two dozen object literals cannot
 * answer it. `ownerNavSectionsFor` is tested to leave nothing unfiled.
 *
 * Keys for pages that do not exist on every branch are harmless and
 * deliberate: a page lands in one commit and its nav entry in another, and an
 * entry with nowhere to go would otherwise disappear from the rail with no
 * error anywhere.
 */
const OWNER_SECTION_OF: Record<string, NavSection> = {
  "/owner/board": "pipeline",
  "/owner/leads": "pipeline",
  "/owner/tasks": "pipeline",
  "/owner/outreach": "pipeline",

  "/owner/deals": "crm",
  "/owner/contacts": "crm",
  "/owner/accounts": "crm",

  "/owner/calls": "conversations",
  "/owner/calls/triage": "conversations",
  "/owner/call-quality": "conversations",
  // Beside the call log, NOT under Insights: that section is CRM-gated,
  // and productivity is computed from `calls`, belongs to the `aura`
  // module, and must stay visible to a recording-only tenant with no CRM.
  "/owner/productivity": "conversations",
  "/owner/sops": "conversations",
  "/owner/inbox": "conversations",
  "/owner/whatsapp-leads": "conversations",

  "/owner/products": "sales",
  "/owner/quotations": "sales",
  "/owner/invoices": "sales",

  "/owner/reports": "insights",
  "/owner/reports/builder": "insights",
  "/owner/reports/sla": "insights",

  "/owner/superfone": "superfone",

  "/owner/lead-sources": "connectors",
  "/owner/meta-ads": "connectors",
  "/owner/messaging-setup": "connectors",

  "/owner/projects": "workspace",
  "/owner/import": "workspace",
  "/owner/duplicates": "workspace",
  "/owner/transcription": "workspace",
  "/owner/staff": "workspace",
  "/owner/features": "workspace",
  "/owner/branding": "workspace",
  "/owner/connections": "workspace",
  "/owner/integrations": "workspace",
};

/** Sections carrying the CRM object model - what `crmPrimary` promotes. */
const CRM_PRIMARY_SECTIONS: NavSection[] = ["crm", "insights"];

export interface NavGroup {
  /** null for the ungrouped items above the first heading (Dashboard). */
  key: NavSection | null;
  label: string | null;
  items: NavItem[];
}

/**
 * The owner nav as the sidebar renders it: grouped, in section order, with
 * empty groups dropped.
 *
 * `crmPrimary` (CRM_SHADOW_READ_ENABLED) keeps the job it had before there
 * were sections - putting the CRM object pages first - but now moves whole
 * SECTIONS rather than individual items. Reordering items inside a grouped
 * rail would have produced the same list in a different order under headings
 * that no longer described it.
 *
 * An unfiled page falls into the last group rather than vanishing: a rail
 * missing a page is a page nobody can reach, which is worse than one filed
 * under the wrong heading.
 */
export function ownerNavSectionsFor(
  role: OwnerRole,
  crmPrimary = false,
  crmEnabled = true,
  // Defaults OFF, unlike crmEnabled: call intelligence is an opt-in disclosure
  // of what was said on a customer's phone call, so a caller that forgets to
  // pass it must hide the page, not reveal it.
  callIntelEnabled = false,
  /**
   * The org's own feature switches (migration 0101), sparse. Absent means the
   * catalogue's defaults, which are every feature on - so an existing caller
   * that has not been updated renders exactly the rail it rendered before.
   */
  featureOverrides: FeatureOverrides = {},
): NavGroup[] {
  // The two module booleans become a module LIST, which is what they always
  // were, and the catalogue answers both questions at once: is the tenant
  // entitled to this page, and has the client switched it off. Deriving them
  // separately is what would let the sidebar and the API disagree.
  const modules = ["aura"];
  if (crmEnabled) modules.push("crm");
  if (callIntelEnabled) modules.push("call_intel");
  const on = enabledFeatures(modules, featureOverrides);

  const visible = OWNER_NAV_ITEMS.filter(
    (item) => !item.ownerRoles || item.ownerRoles.includes(role),
  ).filter((item) => {
    // A page with no catalogue entry is always shown. That is deliberate and
    // it is what keeps the switchboard itself, and the dashboard, reachable
    // from a console whose owner has switched off everything they can.
    const feature = featureForHref(item.href);
    return !feature || on.has(feature);
  });

  const ungrouped = visible.filter((item) => !OWNER_SECTION_OF[item.href]);
  const order = crmPrimary
    ? [
        ...OWNER_NAV_SECTIONS.filter((s) => CRM_PRIMARY_SECTIONS.includes(s.key)),
        ...OWNER_NAV_SECTIONS.filter((s) => !CRM_PRIMARY_SECTIONS.includes(s.key)),
      ]
    : [...OWNER_NAV_SECTIONS];

  // Order INSIDE a group comes from the map above too, not from the order the
  // items happen to be declared in: the map is where someone reasons about
  // what sits next to what, and having half the answer there and half of it
  // three hundred lines up is how a group ends up reading in an order nobody
  // chose. Object key order is insertion order for string keys.
  const filed = Object.keys(OWNER_SECTION_OF);
  const groups: NavGroup[] = order.map(({ key, label }) => ({
    key,
    label,
    items: visible
      .filter((item) => OWNER_SECTION_OF[item.href] === key)
      .sort((a, b) => filed.indexOf(a.href) - filed.indexOf(b.href)),
  }));

  // Unfiled pages join the final group, keeping their declared order.
  const unfiled = ungrouped.filter((item) => item.href !== "/owner");
  if (unfiled.length > 0) groups[groups.length - 1].items.push(...unfiled);

  return [
    { key: null, label: null, items: ungrouped.filter((item) => item.href === "/owner") },
    ...groups,
  ].filter((group) => group.items.length > 0);
}

/**
 * Which of `OWNER_NAV_ITEMS` a given owner-console persona may see, in what
 * order - the same rail `ownerNavSectionsFor` builds, flattened, for the
 * callers that want a plain list (`navItemFor`'s longest-prefix match, and
 * anything counting pages rather than drawing them).
 *
 * `crmPrimary` (CRM_SHADOW_READ_ENABLED, resolved server-side and passed down
 * - see the owner layout) promotes the CRM sections; nothing is added or
 * removed by it, only the order changes. `crmEnabled` (the org's own
 * `enabled_modules`, also resolved server-side) is different: it removes
 * `CRM_GATED_HREFS` when the org doesn't have the CRM module, since those
 * pages would otherwise 403 or show data that doesn't exist for that tenant.
 * `callIntelEnabled` does the same for the call log, from the same column -
 * and defaults to false rather than true, because the thing behind it is a
 * disclosure.
 */
export function ownerNavItemsFor(
  role: OwnerRole,
  crmPrimary = false,
  crmEnabled = true,
  callIntelEnabled = false,
  featureOverrides: FeatureOverrides = {},
): NavItem[] {
  return ownerNavSectionsFor(
    role,
    crmPrimary,
    crmEnabled,
    callIntelEnabled,
    featureOverrides,
  ).flatMap((g) => g.items);
}

/** Longest-prefix match, so /instances/<id> still resolves to the Instances item. */
export function navItemFor(pathname: string, items: NavItem[] = NAV_ITEMS): NavItem | undefined {
  return items
    .filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}
