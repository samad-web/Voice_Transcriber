import {
  Activity,
  BarChart3,
  Building2,
  KeyRound,
  Phone,
  Plug,
  Search,
  Sparkles,
  Users,
  type LucideIcon,
} from "lucide-react";

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
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "Platform Hub", icon: Activity, title: "Platform Hub" },
  { href: "/calls", label: "Call Log Explorer", icon: Phone, title: "Call Log Explorer" },
  { href: "/search", label: "Search", icon: Search, title: "Transcript Search" },
  { href: "/agents", label: "AI Agent Studio", icon: Sparkles, title: "AI Agent Studio" },
  {
    href: "/instances",
    label: "Instances",
    icon: Building2,
    title: "Instances",
    context: "Platform",
  },
  { href: "/crm", label: "CRM Integrations", icon: Plug, title: "CRM Integrations" },
  { href: "/team", label: "Team", icon: Users, title: "Team Management" },
  { href: "/api-keys", label: "API Keys", icon: KeyRound, title: "API Keys" },
  { href: "/usage", label: "Usage", icon: BarChart3, title: "Usage & Billing" },
];

/** Longest-prefix match, so /instances/<id> still resolves to the Instances item. */
export function navItemFor(pathname: string): NavItem | undefined {
  return NAV_ITEMS.filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`)).sort(
    (a, b) => b.href.length - a.href.length,
  )[0];
}
