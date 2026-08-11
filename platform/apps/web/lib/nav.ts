import {
  Activity,
  CalendarDays,
  BarChart3,
  Building2,
  Contact,
  Copy,
  Handshake,
  KeyRound,
  LayoutGrid,
  ListFilter,
  Phone,
  Plug,
  Search,
  SlidersHorizontal,
  Sparkles,
  Users,
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
    href: "/owner/duplicates",
    label: "Duplicates",
    icon: Copy,
    title: "Duplicates",
    context: "Pipeline",
    ownerRoles: ["owner", "manager"],
  },
];

/** Which of `OWNER_NAV_ITEMS` a given owner-console persona may see. */
export function ownerNavItemsFor(role: OwnerRole): NavItem[] {
  return OWNER_NAV_ITEMS.filter((item) => !item.ownerRoles || item.ownerRoles.includes(role));
}

/** Longest-prefix match, so /instances/<id> still resolves to the Instances item. */
export function navItemFor(pathname: string, items: NavItem[] = NAV_ITEMS): NavItem | undefined {
  return items
    .filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];
}
