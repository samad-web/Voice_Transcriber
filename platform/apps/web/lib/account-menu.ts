import { OWNER_ROLE_ADMINS, type OwnerRole } from "@aura/shared";
import type { Crumb } from "@/lib/breadcrumbs";

/**
 * The account menu (doc 27 §2) - what the identity block at the foot of the
 * sidebar opens - and the pages behind it, decided in one place.
 *
 * ── ONE PURE FUNCTION PER QUESTION ────────────────────────────────────────
 *
 * `accountMenuItemsFor` decides what the menu OFFERS, `canOpenAccountPage`
 * what a page ALLOWS. They read the same table (`PAGE_ROLES`), so the menu can
 * never offer a page that then redirects its reader home. Neither is the
 * boundary: every page repeats the check server-side before it fetches, and
 * the API's `@RequireOwnerRole` is what actually refuses.
 *
 * ── NOT NAV, NOT FEATURES ─────────────────────────────────────────────────
 *
 * These pages are reached from the menu and the setup widget, never from the
 * rail, so they are deliberately absent from OWNER_NAV_ITEMS. And they are
 * core, not features: an operator tidying a tenant's feature switches must
 * never be able to hide a person's password page.
 */

export type AccountArea = "owner" | "platform";

export type AccountPage =
  | "profile"
  | "notifications"
  | "business"
  | "time"
  | "plan"
  | "login_activity"
  | "get_started";

export type AccountMenuItemId =
  | "profile"
  | "notifications"
  | "business"
  | "time"
  | "plan"
  | "login_activity"
  | "sign_out_all"
  | "sign_out";

export interface AccountMenuItem {
  id: AccountMenuItemId;
  label: string;
  /** A page to link to. Absent on the two sign-out rows, which are buttons. */
  href?: string;
  /** Rendered as two groups with a divider between them. */
  group: "pages" | "session";
}

const OWNER_HREFS: Record<AccountPage, string> = {
  profile: "/owner/account/profile",
  // A person's own bell - instant or digest is each person's choice, which is
  // why it sits here beside Profile and not in the Settings pages the whole
  // workspace shares. The page kept its URL when it left the rail.
  notifications: "/owner/notifications",
  business: "/owner/account/business",
  time: "/owner/account/time",
  plan: "/owner/account/plan",
  login_activity: "/owner/account/login-activity",
  get_started: "/owner/get-started",
};

/** The operator console has only these two - an operator belongs to no org. */
const PLATFORM_HREFS: Partial<Record<AccountPage, string>> = {
  profile: "/account/profile",
  login_activity: "/account/login-activity",
};

/** Who may open each owner-console page. Absent = every persona. */
const PAGE_ROLES: Partial<Record<AccountPage, readonly OwnerRole[]>> = {
  // Owner edits; manager reads (the form is disabled for them).
  business: OWNER_ROLE_ADMINS,
  // Owner AND manager edit this one (Build docs/30): a manager runs the floor
  // whose "today" it decides. The API gate is time-settings.controller.ts.
  time: OWNER_ROLE_ADMINS,
  plan: OWNER_ROLE_ADMINS,
  get_started: OWNER_ROLE_ADMINS,
};

/** The personas allowed on a page, or null for "everyone". */
export function accountPageRoles(page: AccountPage): readonly OwnerRole[] | null {
  return PAGE_ROLES[page] ?? null;
}

export function canOpenAccountPage(page: AccountPage, ownerRole: OwnerRole): boolean {
  const roles = PAGE_ROLES[page];
  return !roles || roles.includes(ownerRole);
}

export function accountHref(area: AccountArea, page: AccountPage): string | null {
  return area === "owner" ? OWNER_HREFS[page] : (PLATFORM_HREFS[page] ?? null);
}

/**
 * The menu's rows, top to bottom, for one console and persona (doc 27 §2.2).
 *
 * "Plan & usage", not "Billing": Aura does not bill tenants, and a Billing link
 * that opens a page with no bills is a dead end. Rename it the day Aura issues
 * its first invoice to a tenant.
 */
export function accountMenuItemsFor(area: AccountArea, ownerRole?: OwnerRole | null): AccountMenuItem[] {
  const role: OwnerRole = ownerRole ?? "owner";
  const items: AccountMenuItem[] = [];
  const page = (id: AccountMenuItemId, p: AccountPage, label: string) => {
    const href = accountHref(area, p);
    if (!href) return;
    if (area === "owner" && !canOpenAccountPage(p, role)) return;
    items.push({ id, label, href, group: "pages" });
  };

  page("profile", "profile", "Profile");
  page("notifications", "notifications", "My notifications");
  page("business", "business", "Business profile");
  page("time", "time", "Time & location");
  page("plan", "plan", "Plan & usage");
  page("login_activity", "login_activity", "Login activity");
  items.push({ id: "sign_out_all", label: "Log out from all devices", group: "session" });
  items.push({ id: "sign_out", label: "Sign out", group: "session" });
  return items;
}

/**
 * Whether the menu shows the storage line. Owner and manager of a workspace
 * (the people who can do anything about it); never the operator console,
 * which has no single workspace to measure.
 */
export function seesStorageInMenu(area: AccountArea, ownerRole?: OwnerRole | null): boolean {
  return area === "owner" && OWNER_ROLE_ADMINS.includes(ownerRole ?? "owner");
}

/** Initials for the avatar: "Abdul Samad" -> "AS"; no name -> the email's first two letters. */
export function accountInitials(name: string | null | undefined, email: string | null | undefined): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  const local = (email ?? "").split("@")[0];
  return local ? local.slice(0, 2).toUpperCase() : "?";
}

/** What the menu calls the person: their name, else their email's local part. */
export function accountDisplayName(name: string | null | undefined, email: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (trimmed) return trimmed;
  const local = (email ?? "").split("@")[0];
  return local || "Not signed in";
}

/**
 * Breadcrumbs for pages the nav does not know (doc 27 §8.2).
 *
 * `breadcrumbsFor` builds trails from nav items and suppresses a trail of one
 * level ("Home > Contacts" above a heading reading Contacts). These pages are
 * not in the rail, so the rail cannot mark where you are - which is exactly
 * the case a one-level trail DOES earn its line for. Null means "not an
 * account page; ask the nav".
 */
const ACCOUNT_CRUMBS: ReadonlyArray<{ href: string; trail: string[] }> = [
  { href: OWNER_HREFS.profile, trail: ["Account", "Profile"] },
  { href: OWNER_HREFS.business, trail: ["Account", "Business profile"] },
  { href: OWNER_HREFS.time, trail: ["Account", "Time & location"] },
  { href: OWNER_HREFS.plan, trail: ["Account", "Plan & usage"] },
  { href: OWNER_HREFS.login_activity, trail: ["Account", "Login activity"] },
  { href: OWNER_HREFS.get_started, trail: ["Get started"] },
];

export function accountCrumbsFor(pathname: string): Crumb[] | null {
  const path = pathname.replace(/\/+$/, "");
  const match = ACCOUNT_CRUMBS.find((c) => c.href === path);
  if (!match) return null;
  // Every crumb but the last is a link: <Breadcrumbs> marks any crumb without
  // an href as aria-current="page", so an unlinked "Account" would announce two
  // current pages. /owner/account redirects to Profile, the section everyone has.
  const crumbs = match.trail.map((label, i) =>
    i < match.trail.length - 1 && label === "Account" ? { label, href: "/owner/account" } : { label },
  );
  return [{ label: "Home", href: "/owner" }, ...crumbs];
}
