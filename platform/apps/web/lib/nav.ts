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
  /** Sidebar label — short, fits the 16rem rail. */
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
    // team profile once that route lands (design doc §9) — not the full board.
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/leads",
    label: "All Leads",
    icon: ListFilter,
    title: "All Leads",
    context: "Pipeline",
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
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/deals",
    label: "Deals",
    icon: Handshake,
    title: "Deals",
    context: "Pipeline",
    // Same persona restriction as the lead board (design doc §9) — a
    // telecaller's nav stays Dashboard + All Leads, not the full pipeline.
    ownerRoles: ["owner", "manager"],
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
    // Unrestricted for the same reason Tasks is: a telecaller answering
    // replies is the whole job, and routing correspondence to a persona who
    // cannot see it is how an enquiry goes unanswered.
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
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/quotations",
    label: "Quotations",
    icon: FileText,
    title: "Quotations",
    context: "Pipeline",
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/invoices",
    label: "Invoices",
    icon: Receipt,
    title: "Invoices",
    context: "Pipeline",
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/reports",
    label: "Reports",
    icon: PieChart,
    title: "Reports",
    context: "Pipeline",
    // Pipeline value and per-rep win rates are a manager's view of the team,
    // not a telecaller's view of their own work — same restriction the boards
    // carry (design doc §9).
    ownerRoles: ["owner", "manager"],
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
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/import",
    label: "Import",
    icon: Upload,
    title: "Bulk Import",
    context: "Pipeline",
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/messaging-setup",
    label: "WhatsApp Setup",
    icon: MessageCircle,
    title: "WhatsApp Setup",
    context: "Settings",
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/meta-ads",
    label: "Meta Lead Ads",
    icon: Megaphone,
    title: "Meta Lead Ads",
    context: "Settings",
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/branding",
    label: "Branding",
    icon: Palette,
    title: "Branding",
    context: "Settings",
    ownerRoles: ["owner", "manager"],
  },
  {
    href: "/owner/call-quality",
    label: "Call Quality",
    icon: AlertTriangle,
    title: "Call Quality",
    context: "Pipeline",
    // A manager's review queue over the whole floor's calls, same restriction
    // as Reports and the boards (design doc §9) — not a telecaller's own view.
    ownerRoles: ["owner", "manager"],
  },
];

/**
 * The CRM object pages — what A6's shadow-read flag promotes to sit right
 * after Dashboard, above the legacy Board/All Leads pair, once it's on.
 * Neither page group is ever hidden by this: the legacy pair stays exactly
 * where it is, one click away, for the whole burn-in period.
 */
const CRM_PRIMARY_HREFS = ["/owner/deals", "/owner/contacts", "/owner/accounts", "/owner/reports"];

/**
 * The CRM-object nav items — hidden entirely (not just reordered) when the
 * org's `enabled_modules` (migration 0072) doesn't include 'crm'. Matched
 * against what `CrmPermissionsGuard`'s `@RequireCrmPermission` actually
 * gates on the API side (contact/account/deal/task/conversation/product/
 * quotation/invoice — see the crm-objects, tasks, conversations, products,
 * quotations and invoices controllers), plus Duplicates and Import, which
 * are pure-CRM features not yet backend-gated
 * but meaningless without CRM data. `/owner/board` and `/owner/leads` (the
 * legacy `leads`-table pages) are deliberately NOT here — those are core
 * Aura, independent of the CRM toggle.
 */
const CRM_GATED_HREFS = [
  "/owner/deals",
  "/owner/contacts",
  "/owner/accounts",
  "/owner/tasks",
  "/owner/inbox",
  "/owner/products",
  "/owner/quotations",
  "/owner/invoices",
  "/owner/reports",
  "/owner/duplicates",
  "/owner/import",
];

/**
 * Which of `OWNER_NAV_ITEMS` a given owner-console persona may see, in what
 * order. `crmPrimary` (CRM_SHADOW_READ_ENABLED, resolved server-side and
 * passed down — see the owner layout) moves the CRM object pages to sit
 * right after Dashboard rather than after the legacy Board/All Leads pair —
 * nothing is added or removed by it, only the order changes. `crmEnabled`
 * (the org's own `enabled_modules`, also resolved server-side) is different:
 * it actually removes `CRM_GATED_HREFS` when the org doesn't have the CRM
 * module, since those pages would otherwise 403 or show data that doesn't
 * exist for that tenant.
 */
export function ownerNavItemsFor(role: OwnerRole, crmPrimary = false, crmEnabled = true): NavItem[] {
  const visible = OWNER_NAV_ITEMS.filter((item) => !item.ownerRoles || item.ownerRoles.includes(role)).filter(
    (item) => crmEnabled || !CRM_GATED_HREFS.includes(item.href),
  );
  if (!crmPrimary) return visible;

  const crmGroup = visible.filter((item) => CRM_PRIMARY_HREFS.includes(item.href));
  const rest = visible.filter((item) => !CRM_PRIMARY_HREFS.includes(item.href));
  const afterDashboard = rest.findIndex((item) => item.href === "/owner") + 1;
  return [...rest.slice(0, afterDashboard), ...crmGroup, ...rest.slice(afterDashboard)];
}

/** Longest-prefix match, so /instances/<id> still resolves to the Instances item. */
export function navItemFor(pathname: string, items: NavItem[] = NAV_ITEMS): NavItem | undefined {
  return items
    .filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}
