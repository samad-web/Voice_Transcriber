"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Lock, User } from "lucide-react";
import type { OwnerRole } from "@aura/shared";
import { NAV_ITEMS, ownerNavItemsFor, type NavArea } from "@/lib/nav";
import { SignOutButton } from "@/components/sign-out-button";

export function Sidebar({
  email,
  /** Which nav to render. The array itself cannot be passed in: its `icon`
   *  entries are components, and a server layout cannot serialise those. */
  area = "platform",
  /** Owner-console persona (design doc §9); ignored when area !== "owner". */
  ownerRole,
  /** A6's shadow-read flag (CRM_SHADOW_READ_ENABLED), resolved server-side by
   *  the owner layout — a client component cannot read that env var itself. */
  crmPrimary = false,
  /** Rail heading. The owner console shows their company name here. */
  title = "Aura Platform",
  subtitle = "Call Intelligence",
}: {
  email?: string | null;
  area?: NavArea;
  ownerRole?: OwnerRole;
  crmPrimary?: boolean;
  title?: string;
  subtitle?: string;
}) {
  const pathname = usePathname();
  const items = area === "owner" ? ownerNavItemsFor(ownerRole ?? "owner", crmPrimary) : NAV_ITEMS;

  return (
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col justify-between overflow-y-auto border-r border-border bg-surface p-4 md:flex lg:w-64">
      <div className="space-y-8">
        <div className="flex items-center gap-3 px-2">
          {/* The brand mark stays neutral on purpose. Accent is a scarce signal
              in v2 (doc 16 §1.1) and the one thing it has to mean in this rail
              is "you are here" — a permanently-accented logo two rows above the
              active item would compete with exactly that. */}
          <div className="flex h-9 w-9 shrink-0 select-none items-center justify-center rounded-md bg-text text-lg font-semibold text-bg">
            A
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold leading-tight text-text">{title}</h1>
            <span className="mt-0.5 block truncate text-xs text-text-muted">{subtitle}</span>
          </div>
        </div>

        <nav aria-label="Main" className="space-y-0.5">
          {items.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors duration-150 ease-out ${
                  isActive
                    ? // Active nav is one of the four sanctioned accent uses.
                      // The tinted fill + accent-text pair is 8.01:1 light and
                      // 8.64:1 dark, so it reads as selected without the fill
                      // shouting louder than the page it labels.
                      "bg-accent-subtle text-accent-text"
                    : "text-text-muted hover:bg-surface-hover hover:text-text"
                }`}
              >
                <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{item.label}</span>
              </Link>
            );
          })}
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

            Signing out with no session is harmless — signOutAction clears what
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
