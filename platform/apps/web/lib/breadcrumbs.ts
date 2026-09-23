import { REDIRECT_ONLY_HREFS, matchRouteRule } from "@/lib/route-parents";

/**
 * The breadcrumb trail for a console URL, derived from the nav rather than
 * declared per page.
 *
 * ── WHEN THERE IS A TRAIL AT ALL ────────────────────────────────────────────
 *
 * Only for NESTED views. A top-level page already says where you are twice -
 * the rail marks it and its PageHeader names it - and "Home › Contacts" above a
 * heading reading "Contacts" is a third copy of the same fact. A trail earns
 * its line when there is somewhere to go BACK to: a contact record under
 * Contacts, the SLA report under Reports.
 *
 * ── WHERE THE LABELS COME FROM ──────────────────────────────────────────────
 *
 * Every ancestor is a nav item the reader can see, found by segment prefix, so
 * a trail can never offer a link the rail would have hidden from that persona.
 * What the nav cannot know is a record's name - `/owner/contacts/<uuid>` - so
 * the deepest crumb takes `leafLabel` from the page (see <BreadcrumbLeaf>), and
 * falls back to a neutral word rather than printing an id.
 *
 * A page that sits under another RECORD rather than under a nav item - a
 * report's run history - climbs through lib/route-parents.ts first, so its
 * trail names the report instead of skipping straight to the list.
 *
 * ── ONE TRAIL, TWO READERS ──────────────────────────────────────────────────
 *
 * `trailFor` is the whole climb, unsuppressed. `breadcrumbsFor` draws it (and
 * hides a trail of two); `parentFrom` takes "up" from it for the header's Back
 * button. Neither re-derives anything, so Up is always the last link the trail
 * shows.
 */

export interface Crumb {
  label: string;
  /** Absent on the last crumb: it is the page you are on. */
  href?: string;
}

export interface CrumbSource {
  href: string;
  label: string;
}

export const OWNER_HOME: CrumbSource = { href: "/owner", label: "Home" };
export const PLATFORM_HOME: CrumbSource = { href: "/dashboard", label: "Platform Hub" };

const isUnder = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

const normalise = (pathname: string) => pathname.replace(/\/+$/, "") || "/";

/**
 * Home, every ancestor, and the page itself - each with its href, nothing
 * suppressed. The last entry is always `pathname`.
 */
export function trailFor(
  pathname: string,
  items: readonly CrumbSource[],
  leafLabel?: string | null,
  home: CrumbSource = OWNER_HOME,
): CrumbSource[] {
  const path = normalise(pathname);
  if (path === home.href) return [{ ...home }];
  const leaf = leafLabel?.trim() || null;

  // Up through the record-parent rules first, as far as they go.
  const chain: CrumbSource[] = [];
  let top = path;
  // Bounded: a rule table that ever pointed back at itself must not hang a render.
  for (let hops = 0; hops < 8; hops++) {
    const rule = matchRouteRule(top);
    if (!rule) break;
    chain.unshift({ href: top, label: top === path && leaf ? leaf : rule.label });
    top = rule.parent;
  }

  // Then the nav items above wherever the rules stopped.
  const ancestors = items
    .filter((item) => item.href !== home.href && isUnder(top, item.href))
    .sort((a, b) => a.href.length - b.href.length)
    .map((item) => ({ href: item.href, label: item.label }));

  const trail: CrumbSource[] = [{ ...home }, ...ancestors];
  if (chain.length > 0) {
    trail.push(...chain);
  } else if (ancestors[ancestors.length - 1]?.href !== path) {
    trail.push({ href: path, label: leaf ?? "Details" });
  }
  return trail;
}

export function breadcrumbsFor(
  pathname: string,
  items: readonly CrumbSource[],
  leafLabel?: string | null,
  home: CrumbSource = OWNER_HOME,
): Crumb[] {
  const trail = trailFor(pathname, items, leafLabel, home);

  // Home plus the page itself is not nesting - see the header.
  if (trail.length <= 2) return [];

  const crumbs: Crumb[] = trail.map((c) => ({ label: c.label, href: c.href }));
  crumbs[crumbs.length - 1] = { label: trail[trail.length - 1]!.label };
  return crumbs;
}

/**
 * "Up" from a trail: the nearest ancestor that is a real page. Null on Home.
 * A redirect-only page is stepped over (see REDIRECT_ONLY_HREFS).
 */
export function parentFrom(trail: readonly CrumbSource[]): CrumbSource | null {
  for (let i = trail.length - 2; i >= 0; i--) {
    const crumb = trail[i]!;
    if (!REDIRECT_ONLY_HREFS.has(crumb.href)) return crumb;
  }
  return null;
}

/** The screen Up goes to from `pathname`; null on Home. */
export function parentFor(
  pathname: string,
  items: readonly CrumbSource[],
  home: CrumbSource = OWNER_HOME,
): CrumbSource | null {
  return parentFrom(trailFor(pathname, items, null, home));
}
