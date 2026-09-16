import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FEATURES, featureForHref } from "@aura/shared";
import { OWNER_NAV_ITEMS } from "./nav";

/**
 * Is every switchable page actually gated?
 *
 * ── WHY THIS IS A FILESYSTEM TEST ─────────────────────────────────────────
 *
 * Hiding a nav entry is not enforcement. A page whose feature is switched off
 * is still reachable by bookmark, by a link in an older notification, and by a
 * colleague pasting a URL into chat - so each gated page calls
 * `requireFeature()` for itself.
 *
 * Per-page calls are greppable and cheap, and they have exactly one failure
 * mode: somebody adds a page, adds it to the catalogue, and forgets the call.
 * That page then quietly ignores the switch, and nothing anywhere fails. This
 * test is what turns that into a red build - the same job
 * `guard-mounting.spec.ts` does for the API's guards, and for the same reason:
 * an unmounted gate is indistinguishable from no gate at all.
 *
 * LOCKED features are exempt by construction. `leads` and `staff` cannot be
 * switched off, so a gate on them could only ever refuse a page nobody can
 * turn off - and the Staff page in particular is where the switches live.
 */

const OWNER_PAGES = join(__dirname, "..", "app", "(owner)", "owner");

/** `/owner/reports/sla` -> `<app>/(owner)/owner/reports/sla/page.tsx` */
function pageFileFor(href: string): string {
  return join(OWNER_PAGES, href.replace(/^\/owner\/?/, ""), "page.tsx");
}

const GATED = FEATURES.filter((f) => !f.locked).flatMap((f) =>
  f.hrefs.map((href) => [f.key, href] as const),
);

describe("every switchable page enforces its own feature", () => {
  it.each(GATED)("%s gates %s", (key, href) => {
    const source = readFileSync(pageFileFor(href), "utf8");
    // Two gate helpers, one resolver. `requireFeature` is keyed by PATH
    // (owner-context.ts) and `requireOwnerFeature` by FEATURE
    // (owner-features.ts); both run the shared `enabledFeatures`, so a page
    // may use whichever reads better - but it must use one.
    const gated =
      source.includes(`requireFeature("${href}")`) ||
      source.includes(`requireOwnerFeature("${key}")`);
    expect([href, gated]).toEqual([href, true]);
  });

  it("covers something - a silently empty list would pass every case above", () => {
    // `it.each([])` is a green suite with no assertions, which is exactly how
    // this file would rot if the catalogue moved or `hrefs` were renamed.
    expect(GATED.length).toBeGreaterThan(20);
  });
});

describe("the catalogue and the sidebar agree", () => {
  it("gives every catalogue href a nav entry, or none at all", () => {
    // A catalogue href that matches no nav item is a switch that hides nothing.
    // `/owner/team` is the deliberate exception: it is a redirect into the
    // Staff section, kept so old bookmarks resolve, and it has no rail entry of
    // its own by design.
    const navHrefs = new Set(OWNER_NAV_ITEMS.map((i) => i.href));
    const orphans = FEATURES.flatMap((f) => f.hrefs)
      .filter((href) => href !== "/owner/team")
      .filter((href) => !navHrefs.has(href));
    expect(orphans).toEqual([]);
  });

  it("leaves the switchboard and the dashboard ungoverned", () => {
    // Both must survive a workspace that has switched off everything it can.
    expect(featureForHref("/owner/features")).toBeUndefined();
    expect(featureForHref("/owner")).toBeUndefined();
  });
});
