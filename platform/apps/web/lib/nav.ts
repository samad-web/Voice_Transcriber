import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
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
  Route,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Target,
  ToggleLeft,
  Undo2,
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
  { href: "/api-keys", label: "API Keys", icon: KeyRound, title: "API Keys" },
  { href: "/usage", label: "Usage", icon: BarChart3, title: "Usage & Billing" },
  // Visible to every operator, writable only by the root (migration 0089).
  // Deliberately not hidden from the rest: knowing who else administers the
  // platform is not a privilege, and a list nobody can see is a list nobody
  // audits.
  { href: "/operators", label: "Superadmins", icon: ShieldCheck, title: "Superadmins", context: "Platform" },
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
    label: "Tasks",
    icon: ListChecks,
    title: "Tasks",
    context: "Pipeline",
    // No persona restriction, unlike the boards: a telecaller's own follow-ups
    // are exactly the thing they need this console for.
  },
  {
    href: "/owner/review",
    label: "Review queue",
    icon: ClipboardCheck,
    title: "Review queue",
    context: "Pipeline",
    // No persona restriction on the entry: every persona can review at least
    // one source (lib/review-queue.ts), and the page shows each person only
    // the sources their role and the tenant's features already admit.
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
    // Owner and manager only, unlike Productivity next door. That page shows a
    // person their own numbers, which every persona is entitled to; this one
    // DEFINES the measure, and a telecaller editing the rules they are scored
    // against is the one shape of access with no defensible reading. The API
    // enforces it - see call-sops.controller.ts - this just stops offering it.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/productivity",
    label: "Productivity",
    icon: Gauge,
    title: "Productivity",
    context: "Team",
    // No `ownerRoles`, deliberately - every persona may open this, including a
    // telecaller. The route narrows the ROWS rather than refusing the page:
    // OwnerScopeGuard resolves a telecaller to their own record, so they see
    // their own talk time and idle gaps and nobody else's. Restricting the nav
    // item to owner/manager would hide a rep's own numbers from the rep, which
    // is the opposite of what a coaching surface is for.
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
    // not a default (design doc §9, same reasoning as Call Quality).
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
    href: "/owner/notifications",
    label: "Notifications",
    icon: Bell,
    title: "Notifications",
    context: "Your account",
    // No persona restriction, like Connections: everyone has a bell, and
    // instant-or-digest is each person's own choice.
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
    href: "/owner/lead-routing",
    label: "Lead Routing",
    icon: Route,
    title: "Lead routing",
    context: "Settings",
    // Owner and manager only, and narrower than Lead Sources next door, which
    // marketing shares. Marketing connects the channels demand arrives on;
    // deciding WHO on the floor works each lead is running the floor. A rule
    // here also decides who earns commission on it (0071), which is not a
    // marketing decision under any reading. The API enforces the same pair -
    // see lead-routing.controller.ts.
    ownerRoles: ["owner", "manager"],
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
    href: "/owner/devices",
    label: "Handsets",
    icon: Smartphone,
    title: "Handsets",
    context: "Settings",
    // No `ownerRoles`, deliberately, and it is the only Settings page without
    // one. Every persona may SEE the fleet - a telecaller checking whether
    // their own phone has checked in is support-desk information, not a
    // privileged view - while pairing is a per-person capability an owner
    // grants (migration 0096) and retiring stays owner/manager. Both are
    // enforced in the API and returned on the payload, so the page renders the
    // buttons the caller actually has.
    //
    // Restricting the nav item to owner/manager would hide the fleet from the
    // people holding the phones, and would hide it from a telecaller an owner
    // had deliberately granted pairing to.
  },
  {
    href: "/owner/recycle-bin",
    label: "Recycle Bin",
    icon: Undo2,
    title: "Recycle bin",
    context: "Settings",
    // Owner and manager, matching the API. Narrower than several of the delete
    // endpoints it undoes - a scoped rep can remove their own sales target -
    // because this is a cross-object view: one page listing the name of every
    // dataset, rule and target the org ever deleted, including ones that
    // person could not see while they were live.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/team",
    label: "Team",
    icon: Users,
    title: "Team",
    context: "Settings",
    // Owner and manager, matching what the API allows: a manager reads the
    // roster, only an owner changes a persona (owner-team.controller.ts). The
    // page renders read-only for a manager rather than being hidden from
    // them - knowing who sits where is part of running the floor.
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
    href: "/owner/call-quality",
    label: "Call Quality",
    icon: AlertTriangle,
    title: "Call Quality",
    context: "Pipeline",
    // A manager's review queue over the whole floor's calls, same restriction
    // as Reports and the boards (design doc §9) - not a telecaller's own view.
    ownerRoles: ["owner", "manager"],
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
    href: "/owner/superfone",
    label: "Superfone calls",
    icon: PhoneForwarded,
    title: "Superfone",
    context: "Superfone",
    // â”€â”€ ITS OWN SECTION, DELIBERATELY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
];

/**
 * The CRM-object nav items - hidden entirely (not just reordered) when the
 * org's `enabled_modules` (migration 0072) doesn't include 'crm'. Matched
 * against what `CrmPermissionsGuard`'s `@RequireCrmPermission` actually
 * gates on the API side (contact/account/deal/task/conversation/product/
 * quotation/invoice - see the crm-objects, tasks, conversations, products,
 * quotations and invoices controllers), plus Duplicates and Import, which
 * are pure-CRM features not yet backend-gated
 * but meaningless without CRM data. `/owner/board` and `/owner/leads` (the
 * legacy `leads`-table pages) are deliberately NOT here - those are core
 * Aura, independent of the CRM toggle.
 */
/**
 * Hidden without the `call_intel` module, the way CRM_GATED_HREFS is hidden
 * without CRM. Separate list because it is a separate entitlement: a tenant
 * can have the whole CRM and still not have bought the right to read its own
 * call transcripts, and the page 403s rather than rendering empty.
 */
// The triage queue reads the same calls the log does, so it goes with it: a
// recorder-only tenant offered "unmatched calls" would open an empty page.
const CALL_INTEL_GATED_HREFS = ["/owner/calls", "/owner/calls/triage"];

const CRM_GATED_HREFS = [
  "/owner/deals",
  "/owner/contacts",
  "/owner/accounts",
  "/owner/tasks",
  // Every source it aggregates is a CRM page (WhatsApp leads, Duplicates) or
  // CRM messaging; without the module it would be a page of empty tabs.
  "/owner/review",
  "/owner/inbox",
  "/owner/whatsapp-leads",
  "/owner/products",
  "/owner/quotations",
  "/owner/invoices",
  "/owner/reports",
  // Response & Follow-ups (migration 0090) reads `leads` and `tasks` behind the
  // same `deal:view` gate, so it belongs on this list for the same reason the
  // builder does.
  "/owner/reports/sla",
  // The Report Builder (migration 0077) reads the same records - it is gated
  // on `deal:view` server-side, so a tenant without the CRM module would get a
  // page of 403s.
  "/owner/reports/builder",
  "/owner/duplicates",
  "/owner/import",
];

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
  { key: "workspace", label: "Workspace" },
] as const;

export type NavSection = (typeof OWNER_NAV_SECTIONS)[number]["key"];

/**
 * Which group each owner page belongs to.
 *
 * A map here rather than a `section` field on each item, so the whole taxonomy
 * is readable in one screen - the question this file gets asked is "what is
 * next to what", and a property spread across two dozen object literals cannot
 * answer it. nav.test.ts pins both halves: no page is LOST in the grouping, and
 * every page is filed HERE rather than caught by `groupNav`'s fallback - the
 * first alone let two pages sit under the wrong heading unnoticed.
 *
 * Keys for pages that do not exist on every branch are harmless and
 * deliberate: a page lands in one commit and its nav entry in another, and an
 * entry with nowhere to go would otherwise disappear from the rail with no
 * error anywhere.
 */
const OWNER_SECTION_OF: Record<string, NavSection> = {
  "/owner/calls/triage": "conversations",
  "/owner/features": "workspace",
  "/owner/handsets": "workspace",
  "/owner/integrations": "workspace",
  "/owner/staff": "workspace",
  "/owner/superfone": "conversations",
  "/owner/transcription": "workspace",
  "/owner/board": "pipeline",
  "/owner/leads": "pipeline",
  "/owner/tasks": "pipeline",
  "/owner/review": "pipeline",
  "/owner/outreach": "pipeline",

  "/owner/deals": "crm",
  "/owner/contacts": "crm",
  "/owner/accounts": "crm",

  "/owner/calls": "conversations",
  "/owner/call-quality": "conversations",
  // Beside the call log, NOT under Insights with Reports - and the nav test is
  // what forced the question. Insights is a CRM_PRIMARY_SECTION whose every
  // member is CRM-gated, so filing an ungated page there made "the promoted
  // sections are empty once crmEnabled=false" false and broke the ordering
  // invariant. That was the test catching a real error rather than a
  // bookkeeping one: productivity is computed from `calls`, belongs to the
  // `aura` module, and a recording-only tenant with no CRM must still see it.
  "/owner/productivity": "conversations",
  "/owner/sops": "conversations",
  "/owner/inbox": "conversations",
  "/owner/whatsapp-leads": "conversations",

  "/owner/products": "sales",
  "/owner/quotations": "sales",
  "/owner/invoices": "sales",

  "/owner/reports": "insights",
  "/owner/reports/builder": "insights",
  // Was unfiled and fell into the last group, Workspace (plan 23 §G2).
  "/owner/reports/sla": "insights",

  "/owner/lead-sources": "connectors",
  // Beside Lead Sources rather than under Workspace with Team. `lead_sources`
  // already carries an "assign to" field, and this page is the generalisation
  // of exactly that field - somebody who opens Lead Sources to answer "who
  // gets these" is the person who needs this. Filing it with the team roster
  // would mean knowing to look for a routing rule under Workspace.
  "/owner/lead-routing": "connectors",
  "/owner/meta-ads": "connectors",
  "/owner/messaging-setup": "connectors",

  "/owner/projects": "workspace",
  "/owner/import": "workspace",
  "/owner/duplicates": "workspace",
  // Beside Team, not under Lead connectors: this is who and what is on the
  // floor, and the pairing permission is granted on the Team page next to it.
  "/owner/devices": "workspace",
  "/owner/team": "workspace",
  "/owner/branding": "workspace",
  "/owner/connections": "workspace",
  "/owner/notifications": "workspace",
  // Workspace housekeeping, beside Team. Filed explicitly: it used to land here
  // only because the fallback appends unfiled pages to the last group.
  "/owner/recycle-bin": "workspace",
};

/**
 * The heading an owner page was deliberately filed under, or undefined when it
 * is not in the map. Exported for nav.test.ts, which asserts every page has
 * one - `groupNav`'s fallback would otherwise hide a missing entry by quietly
 * appending the page to the last group.
 */
export function ownerSectionOf(href: string): NavSection | undefined {
  return OWNER_SECTION_OF[href];
}

/** Sections carrying the CRM object model - what `crmPrimary` promotes. */
const CRM_PRIMARY_SECTIONS: NavSection[] = ["crm", "insights"];

/**
 * One tenant's provisioning state, as the nav needs to see it.
 *
 * OPTIONAL at every call site, and that is deliberate rather than lazy. Omitted
 * means "do not filter by feature", which is exactly what every caller did
 * before migration 0093 existed and exactly what the nav tests assert about
 * personas and modules - so adding this parameter changed no existing
 * behaviour and no existing test. A caller that has the entitlement passes it;
 * one that does not gets the module-only answer it always got.
 *
 * The alternative - defaulting to "no features, hide everything" - would be
 * the safer-looking choice and the wrong one: a console that renders an empty
 * rail because somebody forgot an argument is indistinguishable, to the person
 * looking at it, from a product that has been switched off.
 */
export interface Entitlement {
  modules: readonly string[];
  /** The org's own switches (migration 0101), sparse and raw - resolved by
   *  `enabledFeatures`, the one resolver the API and worker also call. */
  features: FeatureOverrides;
}

/**
 * Is this nav item's feature switched on?
 *
 * An href with no catalogued feature is always allowed - the Dashboard, the
 * lead board, Calls, Team, Branding, Connections. Those are either core to
 * every tenant or governed by a module and a persona already, and inventing a
 * feature flag for each of them would mean twenty more toggles that an
 * operator has to leave alone for the product to work.
 */
function itemAllowedByFeatures(href: string, entitlement?: Entitlement): boolean {
  if (!entitlement) return true;
  const feature = featureForHref(href);
  if (!feature) return true;
  return enabledFeatures(entitlement.modules, entitlement.features).has(feature);
}

export interface NavGroup {
  /** null for the ungrouped item above the first heading (Dashboard / Platform Hub). */
  key: NavSection | PlatformNavSection | null;
  label: string | null;
  items: NavItem[];
}

/**
 * Files `visible` under `sections`, in the order given, with the `topHref` page
 * above the first heading and empty groups dropped. Both consoles build their
 * rail through this, so they can differ in WHAT they group but not in HOW.
 *
 * Order INSIDE a group comes from `sectionOf`'s key order, not from the order
 * the items happen to be declared in: the map is where someone reasons about
 * what sits next to what, and having half the answer there and half of it
 * hundreds of lines up is how a group ends up reading in an order nobody
 * chose. Object key order is insertion order for string keys.
 *
 * An unfiled page falls into the last group rather than vanishing: a rail
 * missing a page is a page nobody can reach, which is worse than one filed
 * under the wrong heading.
 */
function groupNav(
  visible: NavItem[],
  sections: readonly { key: NavSection | PlatformNavSection; label: string }[],
  sectionOf: Record<string, NavSection | PlatformNavSection>,
  topHref: string,
): NavGroup[] {
  const filed = Object.keys(sectionOf);
  const groups: NavGroup[] = sections.map(({ key, label }) => ({
    key,
    label,
    items: visible
      .filter((item) => sectionOf[item.href] === key)
      .sort((a, b) => filed.indexOf(a.href) - filed.indexOf(b.href)),
  }));

  const ungrouped = visible.filter((item) => !sectionOf[item.href]);
  // Unfiled pages join the final group, keeping their declared order.
  const unfiled = ungrouped.filter((item) => item.href !== topHref);
  if (unfiled.length > 0) {
    groups[groups.length - 1].items.push(...unfiled);
    // Say so while developing. The fallback keeps the page reachable, which is
    // right, but it also hides the missing map entry - two pages sat under the
    // wrong heading that way (doc 23, G2). nav.test.ts fails on it too; this is
    // for the person looking at the rail before the tests run.
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        `nav: ${unfiled.map((i) => i.href).join(", ")} not in the section map - shown under "${
          groups[groups.length - 1].label
        }" by fallback`,
      );
    }
  }

  return [
    { key: null, label: null, items: ungrouped.filter((item) => item.href === topHref) },
    ...groups,
  ].filter((group) => group.items.length > 0);
}

/**
 * The owner nav as the sidebar renders it: grouped, in section order, with
 * empty groups dropped (see `groupNav`).
 *
 * `crmPrimary` (CRM_SHADOW_READ_ENABLED) keeps the job it had before there
 * were sections - putting the CRM object pages first - but now moves whole
 * SECTIONS rather than individual items. Reordering items inside a grouped
 * rail would have produced the same list in a different order under headings
 * that no longer described it.
 */
export function ownerNavSectionsFor(
  role: OwnerRole,
  crmPrimary = false,
  crmEnabled = true,
  callIntelEnabled = false,
  entitlement?: Entitlement,
): NavGroup[] {
  const visible = OWNER_NAV_ITEMS.filter(
    (item) => !item.ownerRoles || item.ownerRoles.includes(role),
  )
    .filter((item) => crmEnabled || !CRM_GATED_HREFS.includes(item.href))
    // Defaults OFF, unlike crmEnabled: call intelligence is an opt-in
    // disclosure of what was said on a customer's phone call, so a caller that
    // forgets to pass it must hide the page, not reveal it.
    .filter((item) => callIntelEnabled || !CALL_INTEL_GATED_HREFS.includes(item.href))
    .filter((item) => itemAllowedByFeatures(item.href, entitlement));

  const order = crmPrimary
    ? [
        ...OWNER_NAV_SECTIONS.filter((s) => CRM_PRIMARY_SECTIONS.includes(s.key)),
        ...OWNER_NAV_SECTIONS.filter((s) => !CRM_PRIMARY_SECTIONS.includes(s.key)),
      ]
    : [...OWNER_NAV_SECTIONS];

  return groupNav(visible, order, OWNER_SECTION_OF, "/owner");
}

/* ══ THE TOP-LEVEL RAIL ════════════════════════════════════════════════════════
 *
 * Grouping turned two dozen links into seven headings, but seven headings over
 * thirty links is still a menu you read. The pages somebody opens every hour -
 * the pipeline, the people, the follow-ups, the numbers - are a handful, and
 * they should be one glance and one click from anywhere, with everything else
 * one disclosure further away.
 *
 * So the rail has at most OWNER_RAIL_MAX_TOP_LEVEL entries: the primary pages
 * below, in this order, plus a single "More" that holds the grouped sections
 * exactly as `ownerNavSectionsFor` builds them, minus what was promoted.
 *
 * DERIVED, NOT LISTED AGAIN - same rule as the messaging switcher. A primary
 * entry only appears if `ownerNavSectionsFor` already let this reader see that
 * page, so a telecaller gets Home / Leads / Contacts / Tasks and never a Deals
 * link that would 403, and a recording-only tenant without the CRM module gets
 * Home / Leads. Nothing is added by promotion and nothing is lost: every
 * visible page is in exactly one of `primary` and `more`, which nav.test.ts
 * asserts for every persona and module combination.
 */

/** The promoted pages, in rail order. `label` overrides the item's own where the rail wants the short form. */
export const OWNER_PRIMARY_NAV: readonly { href: string; label: string }[] = [
  { href: "/owner", label: "Home" },
  { href: "/owner/leads", label: "Leads" },
  { href: "/owner/deals", label: "Deals" },
  { href: "/owner/contacts", label: "Contacts" },
  { href: "/owner/tasks", label: "Tasks" },
  { href: "/owner/reports", label: "Reports" },
];

/** Primary entries plus the "More" disclosure. */
export const OWNER_RAIL_MAX_TOP_LEVEL = 7;

export interface OwnerRail {
  primary: NavItem[];
  /** The rest, grouped as before. Empty when every visible page was promoted. */
  more: NavGroup[];
}

export function ownerRailFor(
  role: OwnerRole,
  crmPrimary = false,
  crmEnabled = true,
  callIntelEnabled = false,
  entitlement?: Entitlement,
): OwnerRail {
  const groups = ownerNavSectionsFor(role, crmPrimary, crmEnabled, callIntelEnabled, entitlement);
  const visible = new Map(groups.flatMap((g) => g.items).map((item) => [item.href, item]));
  const promoted = new Set(OWNER_PRIMARY_NAV.map((p) => p.href));

  const primary = OWNER_PRIMARY_NAV.flatMap(({ href, label }) => {
    const item = visible.get(href);
    return item ? [{ ...item, label }] : [];
  });
  const more = groups
    .map((group) => ({ ...group, items: group.items.filter((item) => !promoted.has(item.href)) }))
    .filter((group) => group.items.length > 0);

  return { primary, more };
}

/**
 * Where the reader is, as the rail needs to show it.
 *
 * `activeHref` is the one page that renders as current - longest prefix over
 * EVERY visible item, so /owner/reports/sla is Response & Follow-ups, not
 * Reports. `primaryParentHref` is the promoted page that current page sits
 * underneath (Reports, there), which the rail marks more quietly so a person
 * three levels deep can still see which top-level area they are in.
 * `inMore` says whether the current page is behind the disclosure, which is
 * what opens it on arrival.
 */
export function ownerRailState(
  pathname: string,
  rail: OwnerRail,
): { activeHref: string | null; primaryParentHref: string | null; inMore: boolean } {
  const all = [...rail.primary, ...rail.more.flatMap((g) => g.items)];
  const active = navItemFor(pathname, all) ?? null;
  const inMore = active ? !rail.primary.some((p) => p.href === active.href) : false;
  const parent = inMore
    ? rail.primary
        // "/owner" is everything's prefix; only an exact match makes Home current.
        .filter((p) => p.href !== "/owner" && pathname.startsWith(`${p.href}/`))
        .sort((a, b) => b.href.length - a.href.length)[0]
    : undefined;
  return {
    activeHref: active?.href ?? null,
    primaryParentHref: parent?.href ?? null,
    inMore,
  };
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
  entitlement?: Entitlement,
): NavItem[] {
  return ownerNavSectionsFor(role, crmPrimary, crmEnabled, callIntelEnabled, entitlement).flatMap(
    (g) => g.items,
  );
}

/**
 * The operator console's sidebar groups, in render order.
 *
 * Fifteen links in one column was the same wall the owner console had, just
 * shorter. Grouped by what the operator came to do, as that rail is:
 *
 *   Call intelligence   the product itself - the calls, what was said, and
 *                       the agent that reads them
 *   Growth              Aura's OWN sales: marketing-site enquiries and the
 *                       diary their demo calls are booked into
 *   Clients             the tenants those enquiries became, and what each uses
 *   CRM setup           how one tenant's CRM is wired and measured
 *   Access              who and what may get in
 *
 * Growth and Clients are separate on purpose even though one feeds the other:
 * a funnel lead is not a tenant yet, and every page under Clients spans
 * tenants that exist. Filing an enquiry beside Instances would read as a
 * client that is merely unprovisioned.
 */
export const PLATFORM_NAV_SECTIONS = [
  { key: "calls", label: "Call intelligence" },
  { key: "growth", label: "Growth" },
  { key: "clients", label: "Clients" },
  { key: "setup", label: "CRM setup" },
  { key: "access", label: "Access" },
] as const;

export type PlatformNavSection = (typeof PLATFORM_NAV_SECTIONS)[number]["key"];

/** Which group each operator page belongs to - same shape as OWNER_SECTION_OF. */
const PLATFORM_SECTION_OF: Record<string, PlatformNavSection> = {
  "/calls": "calls",
  "/search": "calls",
  "/agents": "calls",

  "/leads": "growth",
  "/slots": "growth",

  "/instances": "clients",
  // Beside Instances, not under Access with API Keys: the page is one tenant's
  // consumption and bill, which is a question about a client, not a credential.
  "/usage": "clients",

  "/crm": "setup",
  "/custom-fields": "setup",
  "/automations": "setup",
  // A target is what that tenant's reports are measured against - configuring
  // the CRM, not using it, which the operator console never does.
  "/targets": "setup",

  "/team": "access",
  "/roles": "access",
  "/api-keys": "access",
};

/** The operator nav as the sidebar renders it, Platform Hub above the first heading. */
export function platformNavSections(): NavGroup[] {
  return groupNav(NAV_ITEMS, PLATFORM_NAV_SECTIONS, PLATFORM_SECTION_OF, "/dashboard");
}

/** Longest-prefix match, so /instances/<id> still resolves to the Instances item. */
export function navItemFor(pathname: string, items: NavItem[] = NAV_ITEMS): NavItem | undefined {
  return items
    .filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}

/* ══ THE MESSAGING CHANNEL SWITCHER ═══════════════════════════════════════════
 *
 * A second level of navigation, across the top of five pages, replacing the
 * rail as the way you move between them while you are in there.
 *
 * ── WHY THESE FIVE, AND WHY A SWITCHER ──────────────────────────────────────
 *
 * "Talking to customers" is one job in this product and five pages in this
 * console, and the rail files them under four different headings - Inbox and
 * WhatsApp leads under Conversations, Outreach under Pipeline, WhatsApp Setup
 * under Lead connectors, Import under Workspace. Each of those filings is
 * defensible on its own terms and the aggregate is not: somebody who has just
 * connected a WABA number and wants to see what arrived has to know that the
 * connecting and the seeing live in different sections of a two-dozen-item rail.
 *
 * A switcher is the right shape rather than a sixth rail section because these
 * five are ONE STACK SEEN FROM FIVE ANGLES, not five destinations. The
 * question is never "where is Outreach", it is "what is happening in messaging"
 * - and the answer moves between the setup, the queue and the ladder several
 * times in a sitting. Tabs make that movement one click and, more importantly,
 * make the set VISIBLE: you cannot discover a page you did not know to look
 * for, and a person who has only ever opened the Inbox now sees that a
 * WhatsApp queue and a workflow ladder exist at all.
 *
 * ── WHY IT IS DERIVED FROM THE RAIL AND NOT LISTED AGAIN ────────────────────
 *
 * Every channel below is an `href` that must already exist in OWNER_NAV_ITEMS,
 * and `messagingChannelsFor` filters through `ownerNavItemsFor` rather than
 * re-implementing the persona and module rules. Two lists of the same pages
 * with two copies of the visibility logic is how a marketing user ends up with
 * a tab that 403s: the rail would hide it and a hand-maintained tab strip
 * would not. There is a test asserting the containment both ways.
 *
 * That is also what makes it DYNAMIC. A recording-only tenant with no CRM
 * module keeps Workflows and loses the rest; a telecaller keeps the Inbox,
 * the WhatsApp queue and Workflows and never sees the WABA credentials or the
 * bulk importer. The strip re-skins itself per reader, and collapses to
 * nothing at all when only one channel survives - a one-tab tab strip is
 * furniture, not navigation.
 */
export interface MessagingChannel {
  key: string;
  /** Short - the strip has to fit five of these on a phone. */
  label: string;
  href: string;
  /** The one-line explanation under the strip when this channel is active. */
  blurb: string;
}

export const MESSAGING_CHANNELS: MessagingChannel[] = [
  {
    key: "overview",
    label: "Overview",
    href: "/owner/inbox",
    blurb: "Every thread with a customer, whichever channel it arrived on.",
  },
  {
    key: "workflows",
    label: "Workflows",
    href: "/owner/outreach",
    blurb: "The follow-up ladder - who is due a nudge, and what the next step is.",
  },
  {
    key: "whatsapp",
    label: "WhatsApp",
    href: "/owner/whatsapp-leads",
    blurb: "WhatsApp conversations waiting for someone to say whether they are a lead.",
  },
  {
    key: "waba",
    label: "WABA",
    href: "/owner/messaging-setup",
    blurb: "The WhatsApp Business Account behind the channel - numbers, provider and templates.",
  },
  {
    key: "uploads",
    label: "Uploads",
    href: "/owner/import",
    blurb: "Bring a list in from a CSV - contacts, accounts or deals.",
  },
];

/**
 * The channels this reader may actually open, in strip order.
 *
 * Takes the same four arguments the rail does and applies them the same way,
 * because it applies them BY CALLING the rail. `callIntelEnabled` is passed
 * through for completeness even though no channel is gated on it today - a
 * future "Calls" channel would be, and a signature that already carries it
 * will not need every call site edited on the day that lands.
 */
export function messagingChannelsFor(
  role: OwnerRole,
  crmPrimary = false,
  crmEnabled = true,
  callIntelEnabled = false,
  entitlement?: Entitlement,
): MessagingChannel[] {
  const allowed = new Set(
    ownerNavItemsFor(role, crmPrimary, crmEnabled, callIntelEnabled, entitlement).map((i) => i.href),
  );
  return MESSAGING_CHANNELS.filter((c) => allowed.has(c.href));
}

/**
 * Which channel a URL is inside, or undefined when it is nowhere near the
 * messaging stack.
 *
 * Longest-prefix, for the same reason `navItemFor` is: a thread at
 * `/owner/inbox/<id>` is still the Overview channel, and a plain `startsWith`
 * on the shortest href would be right by accident here and wrong the first
 * time two channel hrefs share a prefix.
 */
export function activeChannelFor(
  pathname: string,
  channels: MessagingChannel[] = MESSAGING_CHANNELS,
): MessagingChannel | undefined {
  return channels
    .filter((c) => pathname === c.href || pathname.startsWith(`${c.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}
