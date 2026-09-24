"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Lock, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { Logo } from "@aura/ui";
import type { OwnerRole, StorageSummary } from "@aura/shared";
import { navItemFor, ownerRailFor, platformNavSections, type Entitlement, type NavArea } from "@/lib/nav";
import { AccountMenu } from "@/components/account-menu";
import { SetupProgress } from "@/components/setup-progress";
import { OwnerRailNav } from "@/components/owner-rail-nav";
import { SignOutButton } from "@/components/sign-out-button";

export function Sidebar({
  email,
  /** Which nav to render. The array itself cannot be passed in: its `icon`
   *  entries are components, and a server layout cannot serialise those. */
  area = "platform",
  /** Owner-console persona (design doc §9); ignored when area !== "owner". */
  ownerRole,
  /** A6's shadow-read flag (CRM_SHADOW_READ_ENABLED), resolved server-side by
   *  the owner layout - a client component cannot read that env var itself. */
  crmPrimary = false,
  /** Whether this org has the CRM module (enabled_modules, migration 0072),
   *  resolved server-side by the owner layout. Hides the CRM-object nav items
   *  entirely when false - see features.ts, which now holds the mapping. */
  crmEnabled = true,
  /** Whether this org has the call-intelligence module - hides the call log. */
  callIntelEnabled = false,
  /** The org's modules + per-feature toggles (migration 0093), resolved by the
   *  owner layout. Omitted on the operator rail, which has no tenant. */
  entitlement,
  /** Rail heading. The owner console shows their company name here. */
  title = "Aura Platform",
  subtitle = "Call Intelligence",
  /** This org's own mark (`branding.logoUrl`, migration 0065). Resolved by the
   *  owner layout; the operator rail leaves it unset and keeps the Aura mark,
   *  which is correct for a console that spans every tenant. */
  logoUrl,
  /** `branding.sidebarIconUrl` - shown instead of `logoUrl` once the rail is
   *  collapsed. Falls back to `logoUrl`, then to the stock mark, when unset. */
  sidebarIconUrl,
  /** users.name, for the account menu (doc 27 §2.3). */
  name,
  /** Storage used (0128), for the account menu. Owner console only. */
  storage,
  /** The setup guide's "X of N" (doc 27 §7); null while the guide is closed. */
  setupProgress,
}: {
  email?: string | null;
  name?: string | null;
  storage?: StorageSummary | null;
  setupProgress?: { done: number; total: number } | null;
  area?: NavArea;
  ownerRole?: OwnerRole;
  crmPrimary?: boolean;
  crmEnabled?: boolean;
  callIntelEnabled?: boolean;
  entitlement?: Entitlement;
  title?: string;
  subtitle?: string;
  logoUrl?: string | null;
  sidebarIconUrl?: string | null;
}) {
  const pathname = usePathname();
  // A per-viewer convenience (which rail width someone left it at), not
  // workspace state - localStorage, not the branding jsonb. Starts expanded on
  // the server and every first client render, so there is nothing to hydrate
  // against; it only ever narrows AFTER mount, once the stored value is known.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem("aura.sidebar.collapsed") === "1");
    } catch {
      // Private window / blocked storage: stay expanded.
    }
  }, []);
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("aura.sidebar.collapsed", next ? "1" : "0");
      } catch {
        // Nothing to persist to - the toggle still works for this render.
      }
      return next;
    });
  };
  // The owner console gets one entry per section, Settings pinned apart
  // (nav.ts, "THE RAIL AND THE TABS"); the operator console keeps its grouped
  // rail, which is fifteen links and reads fine under five headings.
  const ownerRail =
    area === "owner"
      ? ownerRailFor(ownerRole ?? "owner", crmPrimary, crmEnabled, callIntelEnabled, entitlement)
      : null;
  const groups = platformNavSections();
  // Longest-prefix match against every item at once, not each item tested
  // independently - otherwise Dashboard (href "/owner") matches the prefix
  // test on every other owner route too, and both it and the real current
  // item render as active together.
  const active = navItemFor(
    pathname,
    groups.flatMap((group) => group.items),
  );

  return (
    <aside
      // ONLY THE TOP SCROLLS. The rail used to be one overflow-y-auto box, and a
      // scroll container clips absolutely positioned children on BOTH axes - so
      // the account menu at its foot could never open wider than the rail. At
      // icon width (w-20) that squeezed every label into a letter-wide column
      // and gave the rail a sideways scrollbar. The footer now sits outside the
      // scroller, where its popover may overhang the page; z-30 keeps that
      // overhang above the page column's sticky header (z-20), since a sticky
      // element is its own stacking context.
      className={`print-hide sticky top-0 z-30 hidden h-dvh shrink-0 flex-col border-r border-border bg-surface transition-[width] duration-150 ease-out md:flex ${
        collapsed ? "w-20" : "w-60 lg:w-64"
      }`}
    >
      <div className="min-h-0 flex-1 space-y-8 overflow-x-hidden overflow-y-auto p-4">
        {/* The brand row carries the sidebar toggle at its right end, where
            the panel it controls begins - the same place Gemini, ChatGPT and
            VS Code put it, so it is found without looking. Collapsed, the
            row cannot fit both, so the toggle stacks under the mark. */}
        <div className={`flex items-center px-2 ${collapsed ? "flex-col gap-3" : "gap-3"}`}>
          {/* Brand-register pass: the console now carries the real mark, matching
             the landing page - the old neutral-square reasoning (doc 16 §1.1,
             "accent is scarce, don't compete with the active-item signal") is
             superseded by the owner's decision to adopt the full landing
             register here. The active item below still gets its own gradient
             fill, which reads fine against a static mark two rows above it. */}
          <Logo size={32} priority src={collapsed ? (sidebarIconUrl ?? logoUrl) : logoUrl} />
          {collapsed ? null : (
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-sm font-semibold leading-tight text-text">{title}</h1>
              <span className="mt-0.5 block truncate text-xs text-text-muted">{subtitle}</span>
            </div>
          )}
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-label={collapsed ? "Open sidebar" : "Close sidebar"}
            aria-expanded={!collapsed}
            title={collapsed ? "Open sidebar" : "Close sidebar"}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-muted transition-colors duration-150 ease-out hover:bg-surface-hover hover:text-text"
          >
            {collapsed ? (
              <PanelLeftOpen className="h-[18px] w-[18px]" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="h-[18px] w-[18px]" aria-hidden="true" />
            )}
          </button>
        </div>

        <nav aria-label="Main" className="space-y-4">
          {ownerRail ? (
            <OwnerRailNav rail={ownerRail} pathname={pathname} variant="sidebar" collapsed={collapsed} />
          ) : null}
          {ownerRail ? null : groups.map((group) => (
            // A <section> per group with its heading as the accessible name,
            // so a screen reader can move between them the way a sighted
            // reader skims the headings - a flat list of links with visual
            // separators only would announce as one run of two dozen.
            <section
              key={group.key ?? "top"}
              aria-label={group.label ?? undefined}
              className="space-y-0.5"
            >
              {group.label && !collapsed ? (
                <h2 className="px-3 pb-1 text-[11px] font-semibold tracking-wide text-text-subtle uppercase">
                  {group.label}
                </h2>
              ) : null}
              {group.items.map((item) => {
                const Icon = item.icon;
                const isActive = item === active;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={isActive ? "page" : undefined}
                    title={collapsed ? item.label : undefined}
                    style={isActive ? { backgroundImage: "var(--brand-gradient)" } : undefined}
                    className={`flex w-full items-center rounded-full px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out ${
                      collapsed ? "justify-center" : "gap-3"
                    } ${
                      isActive
                        ? // The gradient fill is the "you are here" signal now -
                          // white holds contrast against every stop (same pairing
                          // marketing's CTA already ships in production).
                          "text-white"
                        : "text-text-muted hover:bg-surface-hover hover:text-text"
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    {collapsed ? null : <span className="truncate">{item.label}</span>}
                  </Link>
                );
              })}
            </section>
          ))}
        </nav>
      </div>

      <div className="mx-4 mb-4 space-y-3 border-t border-border px-1 pt-4">
        {/* Owner and manager only, while the guide is open - the layout
            decides both and passes null otherwise. Hidden collapsed: its "X of
            N" label has nowhere to go at icon-rail width, and the guide itself
            is one click away either way. */}
        {area === "owner" && setupProgress && !collapsed ? (
          <SetupProgress done={setupProgress.done} total={setupProgress.total} />
        ) : null}

        <AccountMenu
          email={email}
          name={name}
          area={area === "owner" ? "owner" : "platform"}
          ownerRole={area === "owner" ? (ownerRole ?? "owner") : undefined}
          orgName={area === "owner" ? title : undefined}
          storage={area === "owner" ? storage : null}
          compact={collapsed}
        />

        {/* ALWAYS RENDERED. This used to be `{email ? <SignOutButton /> : null}`,
            which hid the only way out of the console in exactly the cases where
            someone needs it most:

              · `AUTH_ENABLED` false (Supabase env unset) → getSessionUser()
                returns null → no button, on a console you are nonetheless
                looking at;
              · a Supabase account with no email → `""` → no button, with a
                perfectly real session running.

            Signing out with no session is harmless - signOutAction clears what
            is there and redirects to /login. Being unable to sign out on a
            shared machine is not. A button that occasionally does nothing
            beats a missing one. */}
        <SignOutButton iconOnly={collapsed} />

        <div
          className={`flex items-center border-t border-border pt-3 text-xs text-text-muted ${
            collapsed ? "justify-center" : "gap-1.5"
          }`}
          title={collapsed ? "Secure session" : undefined}
        >
          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          {collapsed ? null : <span>Secure session</span>}
        </div>
      </div>
    </aside>
  );
}
