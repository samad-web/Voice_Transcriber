import {
  Activity,
  AlertTriangle,
  CalendarDays,
  BarChart3,
  Building2,
  Contact,
  Copy,
  FileText,
  Handshake,
  Inbox,
  KeyRound,
  LayoutGrid,
  ListFilter,
  ListChecks,
  Layers,
  Megaphone,
  MessageCircle,
  MessagesSquare,
  Milestone,
  PieChart,
  LineChart,
  Link2,
  Package,
  Palette,
  Phone,
  Plug,
  Receipt,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Target,
  Upload,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import type { OwnerRole } from "@aura/shared";

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
const CALL_INTEL_GATED_HREFS = ["/owner/calls"];

const CRM_GATED_HREFS = [
  "/owner/deals",
  "/owner/contacts",
  "/owner/accounts",
  "/owner/tasks",
  "/owner/inbox",
  "/owner/whatsapp-leads",
  "/owner/products",
  "/owner/quotations",
  "/owner/invoices",
  "/owner/reports",
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
  "/owner/call-quality": "conversations",
  "/owner/inbox": "conversations",
  "/owner/whatsapp-leads": "conversations",

  "/owner/products": "sales",
  "/owner/quotations": "sales",
  "/owner/invoices": "sales",

  "/owner/reports": "insights",
  "/owner/reports/builder": "insights",

  "/owner/lead-sources": "connectors",
  "/owner/meta-ads": "connectors",
  "/owner/messaging-setup": "connectors",

  "/owner/projects": "workspace",
  "/owner/import": "workspace",
  "/owner/duplicates": "workspace",
  "/owner/team": "workspace",
  "/owner/branding": "workspace",
  "/owner/connections": "workspace",
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
  callIntelEnabled = false,
): NavGroup[] {
  const visible = OWNER_NAV_ITEMS.filter(
    (item) => !item.ownerRoles || item.ownerRoles.includes(role),
  )
    .filter((item) => crmEnabled || !CRM_GATED_HREFS.includes(item.href))
    // Defaults OFF, unlike crmEnabled: call intelligence is an opt-in
    // disclosure of what was said on a customer's phone call, so a caller that
    // forgets to pass it must hide the page, not reveal it.
    .filter((item) => callIntelEnabled || !CALL_INTEL_GATED_HREFS.includes(item.href));

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
): NavItem[] {
  return ownerNavSectionsFor(role, crmPrimary, crmEnabled, callIntelEnabled).flatMap(
    (g) => g.items,
  );
}

/** Longest-prefix match, so /instances/<id> still resolves to the Instances item. */
export function navItemFor(pathname: string, items: NavItem[] = NAV_ITEMS): NavItem | undefined {
  return items
    .filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}
