import { JsonLd } from "@/components/json-ld";
import { BRAND, SITE_URL } from "@/lib/site";

/**
 * `BreadcrumbList` structured data. Renders NOTHING on the page.
 *
 * ── THE VISIBLE TRAIL WAS REMOVED 2026-10-13, AT THE OWNER'S REQUEST ───────
 *
 * This component used to render both halves: the "Auratel / Call tracking
 * dashboard" line under the header, and the markup describing it. The owner
 * asked for that line off the pages. The markup is kept because it is the half
 * that was asked for in the first place: in a search result it replaces the
 * bare URL under the title with a readable path, which costs the page nothing
 * and is the only reason breadcrumbs came up.
 *
 * ── THE HONEST CAVEAT, SINCE THIS FILE PREVIOUSLY ARGUED THE OPPOSITE ──────
 *
 * Google's guidance is that structured data should describe what is on the
 * page, and this file's own header used to say so - /compatibility was
 * emitting a BreadcrumbList naming "Home" while rendering no trail at all, and
 * fixing that was the reason the component exists.
 *
 * What makes keeping it defensible now, where that was not: the hierarchy it
 * describes is real and navigable. The header carries a link to every page
 * named here, and each of these pages links back to the root, so a crawler
 * following the markup finds exactly the structure it claims. What was wrong
 * before was a trail that pointed at a "Home" nothing linked to in a nav that
 * was empty by design.
 *
 * If a stricter reading is ever preferred, deleting the four call sites is the
 * whole change - nothing else reads this.
 */

export interface Crumb {
  label: string;
  /** Path from the site root, e.g. "/compatibility". */
  href: string;
}

export function BreadcrumbSchema({
  trail,
  current,
}: {
  /** Ancestors, nearest-root first. The brand root is added automatically. */
  trail?: Crumb[];
  /** The page itself. The schema expects the full path including the page. */
  current: Crumb;
}) {
  const items = [{ label: BRAND, href: "/" }, ...(trail ?? []), current];

  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        itemListElement: items.map((c, i) => ({
          "@type": "ListItem",
          position: i + 1,
          name: c.label,
          item: `${SITE_URL}${c.href === "/" ? "" : c.href}`,
        })),
      }}
    />
  );
}
