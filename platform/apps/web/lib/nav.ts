import {
  Activity,
  AlertTriangle,
  BarChart3,
  ChartColumn,
  Bell,
  Building2,
  CalendarDays,
  ClipboardCheck,
  Contact,
  Copy,
  FileText,
  Funnel,
  Gauge,
  Handshake,
  House,
  Inbox,
  Languages,
  Layers,
  LayoutGrid,
  LineChart,
  ListFilter,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  Milestone,
  Package,
  Palette,
  Phone,
  PhoneForwarded,
  Plug,
  Receipt,
  Route,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  SquareCheck,
  Target,
  ToggleLeft,
  Undo2,
  Unlink,
  Upload,
  UserCog,
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
  /**
   * The name this page goes by for a given persona, where it differs - one
   * page, one rail entry, the word each reader uses for it. Replaces both
   * `label` and `title`, so the rail, the heading, the breadcrumb and the Back
   * button all say the same thing. Applied by `ownerNavSectionsFor`; read a
   * single page's name with `ownerNavLabel`.
   */
  roleLabels?: Partial<Record<OwnerRole, string>>;
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
  // One client's team, roles and API keys. These were three top-level entries
  // under an "Access" heading, which said they were platform entities; all three
  // are per-org rows behind RLS. See app/(platform)/client-config/page.tsx.
  {
    href: "/client-config",
    label: "Configuration",
    icon: UserCog,
    title: "Client Configuration",
    context: "Client",
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
    title: "Targets",
    context: "Platform",
  },
  {
    href: "/automations",
    label: "Automations",
    icon: Workflow,
    title: "Automations",
    context: "Platform",
  },
  { href: "/usage", label: "Usage", icon: BarChart3, title: "Usage & Billing" },
  // Visible to every operator, writable only by the root (migration 0089).
  // Deliberately not hidden from the rest: knowing who else administers the
  // platform is not a privilege, and a list nobody can see is a list nobody
  // audits.
  {
    href: "/operators",
    label: "Superadmins",
    icon: ShieldCheck,
    title: "Superadmins",
    context: "Platform",
  },
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
    label: "Lead board",
    icon: LayoutGrid,
    title: "Lead board",
    context: "Leads",
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
    label: "All leads",
    icon: ListFilter,
    title: "All leads",
    context: "Leads",
  },
  {
    href: "/owner/calls",
    label: "Calls",
    icon: Phone,
    title: "Calls",
    context: "Conversations",
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
    context: "Settings",
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
    context: "Sales",
    // Same persona restriction as the lead board (design doc §9) - a
    // telecaller's nav stays Dashboard + All Leads, not the full pipeline -
    // and sales joins for the same reason it joins the board.
    ownerRoles: ["owner", "manager", "sales"],
  },
  {
    href: "/owner/tasks",
    label: "Tasks",
    icon: SquareCheck,
    title: "Tasks",
    context: "Your work",
    // No persona restriction, unlike the boards: a telecaller's own follow-ups
    // are exactly the thing they need this console for.
  },
  {
    href: "/owner/review",
    label: "Needs review",
    icon: ClipboardCheck,
    title: "Needs review",
    context: "Leads",
    // No persona restriction on the entry: every persona can review at least
    // one source (lib/review-queue.ts), and the page shows each person only
    // the sources their role and the tenant's features already admit.
  },
  {
    href: "/owner/inbox",
    label: "Chats",
    icon: MessagesSquare,
    title: "Chats",
    context: "Conversations",
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
    label: "WhatsApp chats",
    icon: MessagesSquare,
    title: "WhatsApp chats",
    context: "Leads",
    // Same audience as the Inbox it feeds off, and for the same reason: the
    // person who answers a thread is the person who can tell whether it was a
    // buyer or a courier. Marketing is excluded as it is there - this is
    // one-to-one correspondence with named customers, not campaign material.
    ownerRoles: ["owner", "manager", "telecaller", "sales"],
  },
  {
    href: "/owner/outreach",
    label: "Follow-up sequences",
    icon: Milestone,
    title: "Follow-up sequences",
    context: "Conversations",
    // Unrestricted, like Tasks and Inbox: working the follow-up ladder is a
    // telecaller's core job, not a manager's oversight view.
  },
  {
    href: "/owner/contacts",
    label: "Contacts",
    icon: Contact,
    title: "Contacts",
    context: "Customers",
  },
  {
    href: "/owner/accounts",
    label: "Companies",
    icon: Building2,
    title: "Companies",
    context: "Customers",
  },
  {
    href: "/owner/products",
    label: "Price list",
    icon: Package,
    title: "Price list",
    context: "Sales",
    // Sales quotes from the catalogue, so it has to be able to read it.
    ownerRoles: ["owner", "manager", "sales"],
  },
  {
    href: "/owner/quotations",
    label: "Quotes",
    icon: FileText,
    title: "Quotes",
    context: "Sales",
    // Raising a quote is the sales job. Turning one into an INVOICE is not -
    // see the next entry, which deliberately stops at owner/manager.
    ownerRoles: ["owner", "manager", "sales"],
  },
  {
    href: "/owner/invoices",
    label: "Invoices",
    icon: Receipt,
    title: "Invoices",
    context: "Sales",
    // Owner/manager only, and the one place the sales persona stops short of
    // the quotation it raised: billing a customer is a financial commitment by
    // the business, and the person who negotiated the price should not also be
    // the one who invoices it.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/sops",
    label: "Call checklist",
    icon: ClipboardCheck,
    title: "Call checklist",
    context: "Settings",
    // Owner and manager only, unlike Productivity next door. That page shows a
    // person their own numbers, which every persona is entitled to; this one
    // DEFINES the measure, and a telecaller editing the rules they are scored
    // against is the one shape of access with no defensible reading. The API
    // enforces it - see call-sops.controller.ts - this just stops offering it.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/agents",
    label: "AI assistants",
    icon: Sparkles,
    title: "AI assistants",
    // "Conversations", not "Team": it is filed under that section (OWNER_SECTION_OF
    // below) and its page's own header says so.
    context: "Settings",
    // Owner and manager, for the Call procedure reason next door: an extractor
    // decides which of the floor's calls become leads, and the people whose
    // calls are counted should not be the ones setting the rule. The API
    // enforces it on every route of owner-agents.controller.ts.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/productivity",
    label: "Team activity",
    icon: Gauge,
    title: "Team activity",
    context: "Reports",
    // No `ownerRoles`, deliberately - every persona may open this, including a
    // telecaller. The route narrows the ROWS rather than refusing the page:
    // OwnerScopeGuard resolves a telecaller to their own record, so they see
    // their own talk time and idle gaps and nobody else's. Restricting the nav
    // item to owner/manager would hide a rep's own numbers from the rep, which
    // is the opposite of what a coaching surface is for.
  },
  {
    href: "/owner/reports",
    label: "Sales overview",
    icon: ChartColumn,
    title: "Sales overview",
    context: "Reports",
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
    label: "Response times",
    icon: Gauge,
    title: "Response times",
    context: "Reports",
    // Owner/manager only, and narrower than Reports on purpose. This is a
    // supervision surface: it names who answered slowly and who missed a
    // follow-up. Marketing has no floor to supervise, and a telecaller
    // reading the league table they are bottom of is a management decision,
    // not a default (design doc §9, same reasoning as Call Quality).
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/reports/builder",
    label: "Custom reports",
    icon: LineChart,
    title: "Custom reports",
    context: "Reports",
    // Same persona restriction as Reports, and for the same reason: a report
    // is a view over the whole team's pipeline, not a telecaller's view of
    // their own work (design doc §9). The API narrows it further per record
    // scope regardless of who reaches the page.
    ownerRoles: ["owner", "manager", "marketing"],
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
    label: "Possible duplicates",
    icon: Copy,
    title: "Possible duplicates",
    context: "Leads",
    // Marketing owns the intake that CREATES most duplicates - the same
    // person should be able to clean them up.
    ownerRoles: ["owner", "manager", "marketing"],
  },
  {
    href: "/owner/import",
    label: "Import",
    icon: Upload,
    title: "Import",
    context: "Leads",
    // A list bought from an event or an agency arrives as a CSV, and loading
    // it is marketing's job.
    ownerRoles: ["owner", "manager", "marketing"],
  },
  {
    href: "/owner/messaging-setup",
    label: "WhatsApp number",
    icon: MessageCircle,
    title: "WhatsApp number",
    context: "Settings",
    // Grouped under Lead connectors, and marketing owns lead connectors.
    ownerRoles: ["owner", "manager", "marketing"],
  },
  {
    href: "/owner/lead-sources",
    label: "Lead sources",
    icon: Inbox,
    // Sentence case, as the page's own header (and every other owner page) has it.
    title: "Lead sources",
    context: "Settings",
    // Not a telecaller's or a rep's decision: a source carries a credential
    // and decides who new business is assigned to. Marketing joins because
    // connecting the channels demand arrives on IS the marketing job - it is
    // the single most load-bearing page for that persona.
    ownerRoles: ["owner", "manager", "marketing"],
  },
  {
    href: "/owner/lead-routing",
    label: "Who gets new leads",
    icon: Route,
    title: "Who gets new leads",
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
    label: "Facebook & Instagram ads",
    icon: Megaphone,
    title: "Facebook & Instagram ads",
    context: "Settings",
    ownerRoles: ["owner", "manager", "marketing"],
  },
  {
    href: "/owner/devices",
    label: "Phones",
    icon: Smartphone,
    title: "Phones",
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
    label: "Deleted items",
    icon: Undo2,
    title: "Deleted items",
    context: "Settings",
    // Owner and manager, matching the API. Narrower than several of the delete
    // endpoints it undoes - a scoped rep can remove their own sales target -
    // because this is a cross-object view: one page listing the name of every
    // dataset, rule and target the org ever deleted, including ones that
    // person could not see while they were live.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/branding",
    label: "Logo & colours",
    icon: Palette,
    title: "Logo & colours",
    context: "Settings",
    // Marketing owns how the business presents itself, which is what this page
    // is - the logo and palette on every quote and invoice a customer receives.
    ownerRoles: ["owner", "manager", "marketing"],
  },
  {
    href: "/owner/call-quality",
    label: "Calls to check",
    icon: AlertTriangle,
    title: "Calls to check",
    context: "Conversations",
    // A manager's review queue over the whole floor's calls, same restriction
    // as Reports and the boards (design doc §9) - not a telecaller's own view.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/insights",
    label: "Call summary",
    icon: BarChart3,
    title: "Call summary",
    context: "Reports",
    // Owner/manager, matching the API: the page summarises the whole floor's
    // conversations and ranks named colleagues - the call log's restriction
    // and the staff scorecard's, for their reasons. A rep's own numbers are on
    // Productivity, which narrows rows instead of refusing the page.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/calls/triage",
    label: "Calls to link",
    icon: Unlink,
    title: "Calls to link",
    context: "Conversations",
    // Owner/manager only, matching the call log it hangs off: the queue is
    // every unmatched call on the floor and working it creates leads across
    // the whole team. Same `call_intel` entitlement, checked per request.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/features",
    label: "Turn features on/off",
    icon: ToggleLeft,
    title: "Turn features on/off",
    context: "Settings",
    // Owner and manager, and deliberately NOT in the feature catalogue itself:
    // a switchboard that could be switched off is one click from a workspace
    // that needs an operator with a SQL prompt to recover. Same reasoning as
    // the locked entries in features.ts.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/integrations",
    label: "Connected apps",
    icon: Plug,
    title: "Connected apps",
    context: "Settings",
    // Every persona (doc 28, Q7). It is the store now, not an admin board: a
    // telecaller links their own Gmail and WhatsApp here. What each persona
    // SEES in it is filtered by the API (canSeeApp), so a telecaller's store
    // holds their own accounts and nothing that administers the team.
  },
  {
    href: "/owner/staff",
    label: "Team & permissions",
    icon: Users,
    title: "Team & permissions",
    context: "Settings",
    // Was /owner/team, and that URL still resolves - it redirects here (see
    // that page). Renamed because the section now answers three questions
    // rather than one: who is here, what may they do, and how are they doing.
    //
    // Owner and manager, matching what the API allows: a manager reads the
    // roster, the permission grid and the scorecard, and only an owner changes
    // any of them. Every tab renders read-only for a manager rather than being
    // hidden - knowing who sits where is part of running the floor.
    ownerRoles: ["owner", "manager"],
    // One name for every reader. It used to be "Staff" to an owner and "Team"
    // to a manager; two words for one page is the kind of guessing the
    // navigation overhaul set out to remove, and "Team & permissions" is what
    // either of them came here to find.
  },
  {
    href: "/owner/superfone",
    label: "Office line (Superfone)",
    icon: PhoneForwarded,
    title: "Office line (Superfone)",
    context: "Conversations",
    // ── ITS OWN TAB, DELIBERATELY ──────────────────────────────────────────
    //
    // Superfone is one telephony provider among several and could have been a
    // filter on the call log. It is a separate tab beside Calls, rather than
    // rows mixed into that list, because the two logs answer
    // different questions and have different data behind them: the call log is
    // recordings the handsets uploaded, with transcripts and AI reads;
    // Superfone is a CDR feed from a cloud PBX, with no audio of ours and no
    // transcript. Merging them would produce a list where half the rows have
    // no "open the conversation" and no explanation of why.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/transcription",
    label: "Transcripts",
    icon: Languages,
    title: "Transcripts",
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
    href: "/owner/call-access",
    label: "Support access to calls",
    icon: ShieldCheck,
    title: "Support access to calls",
    context: "Settings",
    // Owner and manager may LOOK; only an owner may decide, which the API
    // enforces with `@RequireOwnerRole("owner")` rather than this list.
    //
    // Deliberately NOT behind a feature key or the `call_intel` module
    // (0122). Both are provisioning - what the vendor has switched on for
    // this tenant - and a control over whether the vendor may read the
    // tenant's recordings must not be something the vendor can hide. A
    // revocation the customer cannot reach is not a revocation.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/settings",
    label: "Settings",
    icon: Settings,
    title: "Settings",
    context: "Workspace",
    // The one door into every set-up page (see OWNER_SETTINGS_GROUPS). No
    // persona restriction and no feature key: the page lists only the settings
    // THIS reader can open, and every persona has at least their own phone and
    // their own connected apps.
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
const CALL_INTEL_GATED_HREFS = ["/owner/calls", "/owner/calls/triage", "/owner/insights"];

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
 * The owner console's sections, in rail order - one sidebar entry each.
 *
 * WHY SECTIONS AND NOT HEADINGS. The rail used to be six promoted pages and a
 * "More" holding seven headings over thirty-odd links, and a first-time user
 * had to read all of it and guess. Now every page belongs to exactly one
 * section, named for what somebody came to DO - find leads, look after
 * customers, sell, talk to people, see the numbers, set things up - and the
 * rail shows only the sections. A section's pages are tabs across the top of
 * the page (`ownerTabsFor`), so one click reaches the area, one more the page,
 * and every page's neighbours are visible on arrival instead of hidden behind
 * a disclosure.
 *
 * Settings is a section like the others but the rail pins it to the foot,
 * apart from the daily work: most people open it once. Its pages are grouped
 * again (OWNER_SETTINGS_GROUPS), because sixteen tabs is the same wall.
 *
 * `account` never reaches the rail. Notifications is each person's own
 * preference and is offered from the account menu; it is filed here so that
 * "every page is filed somewhere" stays a checkable property.
 *
 * Home has no section, on purpose: it sits above the first, which is what
 * makes it read as the start rather than a member of Tasks.
 */
export const OWNER_NAV_SECTIONS = [
  { key: "tasks", label: "Tasks" },
  { key: "leads", label: "Leads" },
  { key: "customers", label: "Customers" },
  { key: "sales", label: "Sales" },
  { key: "conversations", label: "Conversations" },
  { key: "reports", label: "Reports" },
  { key: "settings", label: "Settings" },
  { key: "account", label: "Your account" },
] as const;

export type NavSection = (typeof OWNER_NAV_SECTIONS)[number]["key"];

/**
 * Each section's rail icon - the most widely recognised glyph for the idea,
 * not the most specific one. A person scanning the rail matches shapes before
 * they read words, so a funnel has to mean leads and a gear has to mean
 * settings the way they do everywhere else.
 */
const OWNER_SECTION_ICONS: Record<NavSection, LucideIcon> = {
  tasks: SquareCheck,
  leads: Funnel,
  customers: Users,
  sales: Handshake,
  conversations: MessagesSquare,
  reports: ChartColumn,
  settings: Settings,
  account: Bell,
};

/** Pinned under the main list rather than in it. */
const OWNER_FOOTER_SECTIONS: readonly NavSection[] = ["settings"];
/** Reached from somewhere other than the rail (the account menu). */
const OWNER_OFF_RAIL_SECTIONS: readonly NavSection[] = ["account"];

/** The Settings landing page: every group below, as cards. */
export const OWNER_SETTINGS_HREF = "/owner/settings";

/**
 * The set-up pages, grouped the way somebody looks for them, with the one
 * line the Settings page prints under each.
 *
 * The groups answer questions, not code boundaries. "Who gets new leads" sits
 * with the lead sources because `lead_sources` already carries an "assign to"
 * field and the routing page is the generalisation of it - somebody who opens
 * one to answer "who gets these" needs the other. Phones sits with the team
 * because pairing a phone is a permission granted on the team page.
 *
 * ORDER IS TAB ORDER. OWNER_SECTION_OF is built from this list, so the Settings
 * cards, the tabs across a settings page and the section map cannot disagree.
 */
export const OWNER_SETTINGS_GROUPS: readonly {
  key: string;
  label: string;
  pages: readonly { href: string; blurb: string }[];
}[] = [
  {
    key: "team",
    label: "Team",
    pages: [
      { href: "/owner/staff", blurb: "Who works here, what each person can see and do, and how they are doing." },
      { href: "/owner/devices", blurb: "The phones that record calls, and whether each one has checked in." },
    ],
  },
  {
    key: "intake",
    label: "Getting leads in",
    pages: [
      { href: "/owner/lead-sources", blurb: "Web forms, email and other places new enquiries arrive from." },
      { href: "/owner/meta-ads", blurb: "Bring in leads from your Facebook and Instagram ad forms." },
      { href: "/owner/messaging-setup", blurb: "Connect the WhatsApp Business number customers message you on." },
      { href: "/owner/lead-routing", blurb: "Rules that decide which person each new lead goes to." },
    ],
  },
  {
    key: "calls",
    label: "Calls & AI",
    pages: [
      { href: "/owner/sops", blurb: "The steps a good call should follow, used to score every call." },
      { href: "/owner/agents", blurb: "AI helpers that read calls and chats and pick out leads and details." },
      { href: "/owner/transcription", blurb: "The language your calls are in, and how transcripts are written." },
      { href: "/owner/call-access", blurb: "Whether our support team may open your call recordings." },
    ],
  },
  {
    key: "business",
    label: "Your business",
    pages: [
      { href: "/owner/projects", blurb: "The projects or offerings leads ask about, used to label them." },
      { href: "/owner/branding", blurb: "Your logo and colours, on the console and on every quote and invoice." },
    ],
  },
  {
    key: "tools",
    label: "Apps & tools",
    pages: [
      { href: "/owner/integrations", blurb: "Connect Gmail, WhatsApp, calendars and other apps." },
      { href: "/owner/features", blurb: "Show or hide parts of the console your team does not use." },
      { href: "/owner/recycle-bin", blurb: "Things deleted recently, and a way to bring them back." },
    ],
  },
];

/**
 * Which section each owner page belongs to.
 *
 * A map here rather than a `section` field on each item, so the whole taxonomy
 * is readable in one screen - the question this file gets asked is "what is
 * next to what", and a property spread across forty object literals cannot
 * answer it. Key order within a section is TAB order (see `groupNav`), so the
 * page every persona can open goes first: a section's rail link is its first
 * visible page, and a telecaller clicking Leads must land on a page, not a 403.
 *
 * nav.test.ts pins both halves: no page is LOST in the grouping, and every page
 * is filed HERE rather than caught by `groupNav`'s fallback.
 *
 * Reports holds pages from two modules - the CRM reports and the call-log
 * reports (Call summary, Team activity) - and that is fine now in a way it was
 * not under the old headings: a section shows whichever of its pages this
 * tenant has, and `crmPrimary` no longer promotes it (CRM_PRIMARY_SECTIONS).
 */
const OWNER_SECTION_OF: Record<string, NavSection> = {
  "/owner/tasks": "tasks",

  // All leads first: every persona has it, the board is persona-limited.
  "/owner/leads": "leads",
  "/owner/board": "leads",
  // The queue and the two things it is made of. Needs review already
  // aggregates WhatsApp chats and duplicates (lib/review-queue.ts); the two
  // full pages sit beside it for working one source in bulk.
  "/owner/review": "leads",
  "/owner/whatsapp-leads": "leads",
  "/owner/duplicates": "leads",
  "/owner/import": "leads",

  "/owner/contacts": "customers",
  "/owner/accounts": "customers",

  // In the order a sale happens: deal, quote, invoice - then the price list
  // they all draw on, which is reference rather than work.
  "/owner/deals": "sales",
  "/owner/quotations": "sales",
  "/owner/invoices": "sales",
  "/owner/products": "sales",

  "/owner/inbox": "conversations",
  "/owner/outreach": "conversations",
  "/owner/calls": "conversations",
  "/owner/superfone": "conversations",
  // The two call queues, beside the log they hang off.
  "/owner/calls/triage": "conversations",
  "/owner/call-quality": "conversations",

  // Sales overview first for the personas that have it; a telecaller's first
  // visible page here is Team activity, which is scoped to their own numbers.
  "/owner/reports": "reports",
  "/owner/insights": "reports",
  "/owner/productivity": "reports",
  "/owner/reports/sla": "reports",
  "/owner/reports/builder": "reports",

  [OWNER_SETTINGS_HREF]: "settings",
  ...Object.fromEntries(
    OWNER_SETTINGS_GROUPS.flatMap((g) => g.pages.map((p) => [p.href, "settings" as const])),
  ),

  "/owner/notifications": "account",
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

/**
 * Sections carrying only the CRM object model - what `crmPrimary` promotes.
 * Reports is not among them any more: it also holds the call-log reports,
 * which a tenant without the CRM still has, and promoting a section for its
 * CRM half would move those too.
 */
const CRM_PRIMARY_SECTIONS: NavSection[] = ["customers", "sales"];

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
/** `item` under the name `role` knows it by (`NavItem.roleLabels`). */
function withRoleLabel(item: NavItem, role: OwnerRole): NavItem {
  const name = item.roleLabels?.[role];
  return name ? { ...item, label: name, title: name } : item;
}

/**
 * One owner page's name for one persona - for a page heading, which has to
 * say what the rail said. Falls back to `fallback` for an href with no entry.
 */
export function ownerNavLabel(href: string, role: OwnerRole, fallback: string): string {
  const item = OWNER_NAV_ITEMS.find((i) => i.href === href);
  return item ? withRoleLabel(item, role).title : fallback;
}

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
    .filter((item) => itemAllowedByFeatures(item.href, entitlement))
    .map((item) => withRoleLabel(item, role));

  const order = crmPrimary
    ? [
        ...OWNER_NAV_SECTIONS.filter((s) => CRM_PRIMARY_SECTIONS.includes(s.key)),
        ...OWNER_NAV_SECTIONS.filter((s) => !CRM_PRIMARY_SECTIONS.includes(s.key)),
      ]
    : [...OWNER_NAV_SECTIONS];

  return groupNav(visible, order, OWNER_SECTION_OF, "/owner");
}

/* ══ THE RAIL AND THE TABS ═════════════════════════════════════════════════════
 *
 * Two levels, and each does one job. The RAIL is where you are in the business:
 * Home plus at most six sections, with Settings pinned apart at the foot. The
 * TABS across the top of a page are where you are inside that section. Nothing
 * is behind a disclosure, so nothing has to be known about in advance to be
 * found.
 *
 * DERIVED, NOT LISTED AGAIN. Both are built from `ownerNavSectionsFor`, which
 * has already applied persona, module and feature rules - so a section appears
 * only if this reader can open at least one of its pages, its rail link goes to
 * the first of those, and its tabs are exactly those. A telecaller's Leads has
 * no Board tab and a recording-only tenant has no Sales entry at all, with no
 * second copy of the visibility rules to drift. nav.test.ts / owner-rail.test.ts
 * assert that every visible page is reachable exactly once.
 */

/** One rail entry: Home, or a section. */
export interface OwnerRailEntry {
  key: NavSection | "home";
  label: string;
  icon: LucideIcon;
  /** Where the entry goes: the section's first page this reader can open. */
  href: string;
  /** Every page in the section this reader can open, in tab order. */
  items: NavItem[];
}

export interface OwnerRail {
  primary: OwnerRailEntry[];
  /** Pinned under the main list - Settings. */
  footer: OwnerRailEntry[];
}

/** Home plus the daily-work sections; Settings is pinned apart and not counted. */
export const OWNER_RAIL_MAX_TOP_LEVEL = 7;

export function ownerRailFor(
  role: OwnerRole,
  crmPrimary = false,
  crmEnabled = true,
  callIntelEnabled = false,
  entitlement?: Entitlement,
): OwnerRail {
  const entries: OwnerRailEntry[] = ownerNavSectionsFor(
    role,
    crmPrimary,
    crmEnabled,
    callIntelEnabled,
    entitlement,
  ).map((group) => {
    const key = (group.key as NavSection | null) ?? "home";
    return {
      key,
      label: key === "home" ? "Home" : (group.label ?? key),
      icon: key === "home" ? House : OWNER_SECTION_ICONS[key],
      href: group.items[0].href,
      items: group.items,
    };
  });

  return {
    primary: entries.filter(
      (e) => e.key === "home" || (!OWNER_FOOTER_SECTIONS.includes(e.key) && !OWNER_OFF_RAIL_SECTIONS.includes(e.key)),
    ),
    footer: entries.filter((e) => e.key !== "home" && OWNER_FOOTER_SECTIONS.includes(e.key)),
  };
}

/**
 * Where the reader is: the page (`activeHref`, longest prefix, so
 * /owner/reports/sla is Response times and not Sales overview) and the rail
 * entry holding it (`activeKey`).
 *
 * Home is current only on /owner itself. "/owner" is every page's prefix, so a
 * plain longest-prefix match would light Home up on a page the rail does not
 * list - Notifications, the account pages - which says "you are on Home" to
 * somebody who is not.
 */
export function ownerRailState(
  pathname: string,
  rail: OwnerRail,
): { activeKey: OwnerRailEntry["key"] | null; activeHref: string | null } {
  const entries = [...rail.primary, ...rail.footer];
  const active = navItemFor(
    pathname,
    entries.flatMap((e) => e.items),
  );
  if (!active || (active.href === "/owner" && pathname.replace(/\/+$/, "") !== "/owner")) {
    return { activeKey: null, activeHref: null };
  }
  const entry = entries.find((e) => e.items.includes(active));
  return { activeKey: entry?.key ?? null, activeHref: active.href };
}

export interface OwnerTabs {
  /** The section (or, inside Settings, the settings group) the tabs belong to. */
  label: string;
  tabs: NavItem[];
  activeHref: string;
  /** Inside Settings: the way back to every setting, since the tabs show one group. */
  back?: { href: string; label: string };
}

/**
 * The tab strip for the page at `pathname`, or null where there is none.
 *
 * None on Home and on the Settings landing page, and none where a section has
 * a single page for this reader - a one-tab strip is a highlighted pill that
 * cannot be clicked off, which is furniture, not navigation. Inside Settings
 * the strip is the page's own group plus a link back to all of them, so it is
 * drawn even for a one-page group: the way back is the point there.
 *
 * And none BELOW a tab's own page - a contact, a quotation, a saved report.
 * Those pages carry breadcrumbs back to their list, and a strip of the list's
 * siblings above one record is a second, competing answer to "where am I".
 */
export function ownerTabsFor(pathname: string, rail: OwnerRail): OwnerTabs | null {
  const { activeKey, activeHref } = ownerRailState(pathname, rail);
  if (!activeKey || !activeHref || activeKey === "home") return null;
  if (pathname.replace(/\/+$/, "") !== activeHref) return null;
  const entry = [...rail.primary, ...rail.footer].find((e) => e.key === activeKey);
  if (!entry) return null;

  if (activeKey === "settings") {
    if (activeHref === OWNER_SETTINGS_HREF) return null;
    const group = OWNER_SETTINGS_GROUPS.find((g) => g.pages.some((p) => p.href === activeHref));
    const inGroup = new Set(group?.pages.map((p) => p.href) ?? [activeHref]);
    return {
      label: group?.label ?? entry.label,
      tabs: entry.items.filter((i) => inGroup.has(i.href)),
      activeHref,
      back: { href: OWNER_SETTINGS_HREF, label: "All settings" },
    };
  }

  if (entry.items.length < 2) return null;
  return { label: entry.label, tabs: entry.items, activeHref };
}

/**
 * The Settings landing page's cards: each group with the pages this reader
 * can open, and nothing for a group with none. `visible` is the reader's own
 * `ownerNavItemsFor`, so the page offers no card the rail would hide.
 */
export function ownerSettingsGroupsFor(
  visible: NavItem[],
): { key: string; label: string; pages: { item: NavItem; blurb: string }[] }[] {
  const byHref = new Map(visible.map((i) => [i.href, i]));
  return OWNER_SETTINGS_GROUPS.map((g) => ({
    key: g.key,
    label: g.label,
    pages: g.pages.flatMap((p) => {
      const item = byHref.get(p.href);
      return item ? [{ item, blurb: p.blurb }] : [];
    }),
  })).filter((g) => g.pages.length > 0);
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
 *   Clients             the tenants those enquiries became, what each uses, and
 *                       each one's own people, roles and keys
 *   CRM setup           how one tenant's CRM is wired and measured
 *   Access              who may administer the PLATFORM - one page, and the
 *                       distinction it draws is the point. A client's team and
 *                       credentials are theirs and live under Clients; this
 *                       section is our own staff.
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
  // A client's people, their roles and their API keys - all three `org_id`
  // columns, so all three are questions about a client. They used to be three
  // entries under Access, which read as platform administration and is what this
  // consolidation set right.
  "/client-config": "clients",
  // Beside Instances, not under Access: the page is one tenant's consumption and
  // bill, which is a question about a client, not a credential.
  "/usage": "clients",

  "/crm": "setup",
  "/custom-fields": "setup",
  "/automations": "setup",
  // A target is what that tenant's reports are measured against - configuring
  // the CRM, not using it, which the operator console never does.
  "/targets": "setup",

  // Filed explicitly, not left to the fallback. Superadmins is now the ONLY
  // member of this section, and an unfiled page silently joins the last group -
  // so with it unfiled, "Access" would have been a heading rendered entirely by
  // accident, and nav.test.ts's "none over nothing" case would have passed on
  // the fallback rather than on the map.
  "/operators": "access",
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
