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

const isUnder = (pathname: string, href: string) =>
  pathname === href || pathname.startsWith(`${href}/`);

export function breadcrumbsFor(
  pathname: string,
  items: readonly CrumbSource[],
  leafLabel?: string | null,
  home: CrumbSource = { href: "/owner", label: "Home" },
): Crumb[] {
  const path = pathname.replace(/\/+$/, "") || "/";

  const ancestors = items
    .filter((item) => item.href !== home.href && isUnder(path, item.href))
    .sort((a, b) => a.href.length - b.href.length);

  const trail: Crumb[] = [
    { label: home.label, href: home.href },
    ...ancestors.map((item) => ({ label: item.label, href: item.href })),
  ];

  const deepest = ancestors[ancestors.length - 1];
  if (deepest && path !== deepest.href) {
    trail.push({ label: leafLabel?.trim() || "Details" });
  }

  // Home plus the page itself is not nesting - see the header.
  if (trail.length <= 2) return [];

  const last = trail[trail.length - 1];
  trail[trail.length - 1] = { label: last.label };
  return trail;
}
