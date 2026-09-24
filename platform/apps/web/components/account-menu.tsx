"use client";

import { useId, useState, useTransition } from "react";
import Link from "next/link";
import { Bell, Building2, ChevronsUpDown, Clock, History, LogOut, Receipt, User, type LucideIcon } from "lucide-react";
import { Popover, ProgressBar } from "@aura/ui";
import {
  OWNER_ROLE_LABELS,
  formatBytes,
  storagePercent,
  storageUsedBytes,
  type OwnerRole,
  type StorageSummary,
} from "@aura/shared";
import { signOutAction } from "@/app/login/actions";
import { LogOutEverywhereDialog } from "@/components/log-out-everywhere";
import {
  accountDisplayName,
  accountHref,
  accountInitials,
  accountMenuItemsFor,
  seesStorageInMenu,
  type AccountArea,
  type AccountMenuItemId,
} from "@/lib/account-menu";

const ICONS: Record<AccountMenuItemId, LucideIcon> = {
  profile: User,
  notifications: Bell,
  business: Building2,
  time: Clock,
  plan: Receipt,
  login_activity: History,
  sign_out_all: LogOut,
  sign_out: LogOut,
};

/**
 * Every row is grey. The screenshot this was modelled on paints its two
 * sign-out rows red; the console's palette keeps red for a missed call and
 * orange for an error, and signing out is neither (packages/ui/src/state.tsx).
 */
const ROW =
  "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-text transition-colors duration-150 ease-out hover:bg-surface-hover focus-visible:bg-surface-hover";

/**
 * The identity block at the foot of <Sidebar>/<MobileNav>, and the account
 * menu it opens (doc 27 §2).
 *
 * ── A POPOVER, NOT A DIALOG ANY MORE ──────────────────────────────────────
 *
 * This was a Dialog holding identity, Appearance and hints - a settings panel
 * with nowhere to link to, because no settings pages existed. Now there are
 * pages (Profile, Business profile, Plan & usage, Login activity), so it is a
 * menu of them: a kit Popover opening UPWARD, since the trigger sits at the
 * bottom of the viewport. Appearance and hints moved to Profile -> Preferences.
 *
 * ── SEMANTICS ──────────────────────────────────────────────────────────────
 *
 * A `<nav aria-label="Account">` of links and buttons, in tab order. NOT
 * `role="menu"`: the kit Popover deliberately has no roving tabindex or arrow
 * keys, and `role="menu"` without them is worse for a screen-reader user than
 * no role at all. Escape and an outside click close it, and focus returns to
 * the trigger - the Popover already does all three.
 *
 * ── WHAT IS NOT HERE ───────────────────────────────────────────────────────
 *
 * The standalone <SignOutButton> under this trigger in both shells stays. Its
 * comment in sidebar.tsx says why sign-out must never be more than one click
 * away, and a row inside a menu is two.
 */
export function AccountMenu({
  email,
  name,
  area,
  ownerRole,
  orgName,
  storage,
  compact = false,
}: {
  email?: string | null;
  /** users.name; the email's local part stands in when it is empty. */
  name?: string | null;
  area: AccountArea;
  /** The owner-console persona. Absent on the operator console. */
  ownerRole?: OwnerRole;
  orgName?: string | null;
  /** The worker's snapshot (0128), riding on /v1/auth/context. Null until measured. */
  storage?: StorageSummary | null;
  /**
   * The collapsed sidebar: the trigger is the avatar alone, and the panel opens
   * at its own width (w-72) overhanging the page instead of stretching to the
   * rail - an 80px-wide menu wraps every label a letter at a time. Possible
   * because the sidebar footer is outside its scroll container (sidebar.tsx).
   */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [everywhereOpen, setEverywhereOpen] = useState(false);
  const [signingOut, startSignOut] = useTransition();
  const panelId = useId();

  const display = accountDisplayName(name, email);
  const items = accountMenuItemsFor(area, ownerRole);
  const pages = items.filter((i) => i.group === "pages");
  const session = items.filter((i) => i.group === "session");
  const context =
    area === "owner" && ownerRole ? [OWNER_ROLE_LABELS[ownerRole], orgName].filter(Boolean).join(" · ") : null;
  const showStorage = Boolean(storage) && seesStorageInMenu(area, ownerRole);
  const planHref = accountHref(area, "plan");

  return (
    <>
      <Popover
        open={open}
        onDismiss={() => setOpen(false)}
        side="top"
        // The trigger's own width, not a fixed one. The sidebar and the mobile
        // drawer are both scroll containers (overflow-y-auto), and a scroll
        // container clips an absolutely positioned child on BOTH axes - a
        // w-72 panel in the 15rem rail was cut off at its right edge and gave
        // the rail a sideways scrollbar. Measured in a browser, 2026-09-22.
        align={compact ? "start" : "stretch"}
        className={compact ? "w-72 p-1.5" : "p-1.5"}
        trigger={
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            // Compact has no visible name, so it goes on the button itself.
            aria-label={compact ? `Account: ${email ? display : "Not signed in"}` : undefined}
            title={compact ? (email ? display : "Not signed in") : undefined}
            className={`flex w-full items-center rounded-lg p-1 text-left transition-colors duration-150 ease-out hover:bg-surface-hover ${
              compact ? "justify-center" : "gap-2.5"
            }`}
          >
            <Avatar initials={accountInitials(name, email)} />
            <span className={compact ? "hidden" : "min-w-0 flex-1"}>
              {/* `||` not `??` - an account with no email arrives as "". */}
              <span className="block truncate text-xs font-medium text-text">{email ? display : "Not signed in"}</span>
              <span className="block truncate text-xs text-text-muted">{email || "Session pending"}</span>
            </span>
            {compact ? null : (
              <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
            )}
          </button>
        }
      >
        <nav id={panelId} aria-label="Account">
          <div className="flex items-center gap-3 px-2.5 pt-2 pb-3">
            <Avatar initials={accountInitials(name, email)} large />
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-text">{email ? display : "Not signed in"}</p>
              {email ? <p className="truncate text-xs text-text-muted">{email}</p> : null}
              {context ? <p className="truncate text-xs text-text-muted">{context}</p> : null}
            </div>
          </div>

          {showStorage && storage ? (
            <div className="border-t border-border px-1 py-1.5">
              <StorageLine storage={storage} href={planHref} onNavigate={() => setOpen(false)} />
            </div>
          ) : null}

          <ul className="border-t border-border py-1.5">
            {pages.map((item) => {
              const Icon = ICONS[item.id];
              return (
                <li key={item.id}>
                  <Link href={item.href!} onClick={() => setOpen(false)} className={ROW}>
                    <Icon className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>

          <ul className="border-t border-border pt-1.5">
            {session.map((item) => {
              const Icon = ICONS[item.id];
              const onClick =
                item.id === "sign_out_all"
                  ? () => {
                      setOpen(false);
                      setEverywhereOpen(true);
                    }
                  : () => startSignOut(() => signOutAction());
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    onClick={onClick}
                    disabled={item.id === "sign_out" && signingOut}
                    className={ROW}
                  >
                    <Icon className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
                    {item.id === "sign_out" && signingOut ? "Signing out…" : item.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </Popover>

      {/* Outside the Popover, so closing the menu does not unmount it. */}
      <LogOutEverywhereDialog open={everywhereOpen} onClose={() => setEverywhereOpen(false)} />
    </>
  );
}

function Avatar({ initials, large = false }: { initials: string; large?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full bg-accent-subtle font-semibold text-accent-text ${
        large ? "h-10 w-10 text-sm" : "h-8 w-8 text-xs"
      }`}
    >
      {initials}
    </span>
  );
}

/**
 * "Storage · 3.2 GB used", or "3.2 GB of 10 GB" and a thin meter when there is
 * a quota. The meter is the accent below 100 % and the orange `danger` tone at
 * or over it - never red. Links to Plan & usage, where the full breakdown is.
 */
function StorageLine({
  storage,
  href,
  onNavigate,
}: {
  storage: StorageSummary;
  href: string | null;
  onNavigate: () => void;
}) {
  const used = formatBytes(storageUsedBytes(storage));
  const percent = storagePercent(storage);
  const body = (
    <>
      <span className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-text">Storage</span>
        <span className="text-text-muted">
          {storage.quotaBytes ? `${used} of ${formatBytes(storage.quotaBytes)}` : `${used} used`}
        </span>
      </span>
      {percent !== null ? (
        <ProgressBar percent={percent} tone={percent >= 100 ? "danger" : "solid"} className="mt-1.5" />
      ) : null}
    </>
  );
  return href ? (
    <Link href={href} onClick={onNavigate} className="block rounded-md px-1.5 py-1.5 hover:bg-surface-hover">
      {body}
    </Link>
  ) : (
    <div className="px-1.5 py-1.5">{body}</div>
  );
}
