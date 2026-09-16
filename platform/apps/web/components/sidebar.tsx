"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Lock, User } from "lucide-react";
import { Logo } from "@aura/ui";
import type { OwnerRole } from "@aura/shared";
import { navItemFor, ownerRailFor, platformNavSections, type Entitlement, type NavArea } from "@/lib/nav";
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
   *  resolved server-side by the owner layout. Hides CRM-object nav items
   *  entirely when false - see nav.ts's CRM_GATED_HREFS. */
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
}: {
  email?: string | null;
  area?: NavArea;
  ownerRole?: OwnerRole;
  crmPrimary?: boolean;
  crmEnabled?: boolean;
  callIntelEnabled?: boolean;
  entitlement?: Entitlement;
  title?: string;
  subtitle?: string;
  logoUrl?: string | null;
}) {
  const pathname = usePathname();
  // The owner console gets the capped top-level rail with a More disclosure
  // (nav.ts, "THE TOP-LEVEL RAIL"); the operator console keeps its grouped
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
    <aside className="print-hide sticky top-0 hidden h-dvh w-60 shrink-0 flex-col justify-between overflow-y-auto border-r border-border bg-surface p-4 md:flex lg:w-64">
      <div className="space-y-8">
        <div className="flex items-center gap-3 px-2">
          {/* Brand-register pass: the console now carries the real mark, matching
             the landing page - the old neutral-square reasoning (doc 16 §1.1,
             "accent is scarce, don't compete with the active-item signal") is
             superseded by the owner's decision to adopt the full landing
             register here. The active item below still gets its own gradient
             fill, which reads fine against a static mark two rows above it. */}
          <Logo size={32} priority src={logoUrl} />
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold leading-tight text-text">{title}</h1>
            <span className="mt-0.5 block truncate text-xs text-text-muted">{subtitle}</span>
          </div>
        </div>

        <nav aria-label="Main" className="space-y-4">
          {ownerRail ? <OwnerRailNav rail={ownerRail} pathname={pathname} variant="sidebar" /> : null}
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
              {group.label ? (
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
                    style={isActive ? { backgroundImage: "var(--brand-gradient)" } : undefined}
                    className={`flex w-full items-center gap-3 rounded-full px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out ${
                      isActive
                        ? // The gradient fill is the "you are here" signal now -
                          // white holds contrast against every stop (same pairing
                          // marketing's CTA already ships in production).
                          "text-white"
                        : "text-text-muted hover:bg-surface-hover hover:text-text"
                    }`}
                  >
                    <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">{item.label}</span>
                  </Link>
                );
              })}
            </section>
          ))}
        </nav>
      </div>

      <div className="mt-8 space-y-3 border-t border-border px-1 pt-4">
        <div className="flex items-center gap-2.5">
          <div
            aria-hidden="true"
            className="shrink-0 rounded-full bg-surface-hover p-2 text-text-muted"
          >
            <User className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <span className="block truncate text-xs font-medium text-text">
              {/* `||` not `??`. getSessionUser() returns `email: user.email ?? ""`,
                  so an account without an email address arrives as an empty
                  string, and `??` would render a blank line rather than the
                  fallback. */}
              {email || "Not signed in"}
            </span>
            <span className="block text-xs text-text-muted">
              {email ? "Signed in" : "Session pending"}
            </span>
          </div>
        </div>

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
        <SignOutButton />

        <div className="flex items-center gap-1.5 border-t border-border pt-3 text-xs text-text-muted">
          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>Secure session</span>
        </div>
      </div>
    </aside>
  );
}
