import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OWNER_HOME,
  PLATFORM_HOME,
  breadcrumbsFor,
  parentFor,
  parentFrom,
  type CrumbSource,
} from "./breadcrumbs";
import { NAV_ITEMS, OWNER_NAV_ITEMS } from "./nav";
import { ROUTE_PARENTS, matchRouteRule } from "./route-parents";

const OWNER = OWNER_NAV_ITEMS.map(({ href, label }) => ({ href, label }));
const PLATFORM = NAV_ITEMS.map(({ href, label }) => ({ href, label }));

/**
 * Every page route in a console group, with `[param]` segments filled by a
 * stand-in value - the inventory the lock-step property is checked over.
 */
function pageRoutes(group: "(owner)" | "(platform)"): string[] {
  const root = join(__dirname, "..", "app", group);
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "page.tsx") {
        const rel = relative(root, dir).split(sep).join("/");
        out.push(`/${rel.replace(/\[([^\]]+)\]/g, "x-$1")}`.replace(/\/$/, "") || "/");
      }
    }
  };
  walk(root);
  return out;
}

describe("matchRouteRule", () => {
  it("fills the parent from the matched params", () => {
    expect(matchRouteRule("/owner/reports/builder/r1/runs/q9")).toEqual({
      label: "Report run",
      parent: "/owner/reports/builder/r1/runs",
    });
    expect(matchRouteRule("/instances/abc/calls")).toEqual({ label: "Calls", parent: "/instances/abc" });
  });

  it("names an app page from the catalogue, so its crumb needs no fetch", () => {
    expect(matchRouteRule("/owner/integrations/google_sheets")?.label).toBe("Google Sheets");
    expect(matchRouteRule("/owner/integrations/nope")?.label).toBe("App");
  });

  it("matches whole segments only", () => {
    expect(matchRouteRule("/owner/reports/builder")).toBeNull();
    expect(matchRouteRule("/owner/reports/builder/r1/runs/q9/extra")).toBeNull();
  });

  it("lists every literal before a parameter that could swallow it", () => {
    ROUTE_PARENTS.forEach((rule, i) => {
      const segs = rule.pattern.split("/");
      ROUTE_PARENTS.slice(0, i).forEach((earlier) => {
        const e = earlier.pattern.split("/");
        const shadows =
          e.length === segs.length && e.every((seg, j) => seg.startsWith(":") || seg === segs[j]);
        expect(shadows, `${earlier.pattern} shadows ${rule.pattern}`).toBe(false);
      });
    });
  });
});

describe("parentFor", () => {
  it("is null on Home and Home for a top-level page", () => {
    expect(parentFor("/owner", OWNER)).toBeNull();
    expect(parentFor("/owner/contacts", OWNER)).toEqual(OWNER_HOME);
    expect(parentFor("/dashboard", PLATFORM, PLATFORM_HOME)).toBeNull();
    expect(parentFor("/instances", PLATFORM, PLATFORM_HOME)).toEqual(PLATFORM_HOME);
  });

  it("follows every ROUTE_PARENTS rule", () => {
    expect(parentFor("/owner/reports/builder/r1/runs/q9", OWNER)).toEqual({
      href: "/owner/reports/builder/r1/runs",
      label: "Run history",
    });
    expect(parentFor("/owner/reports/builder/r1/runs", OWNER)).toEqual({
      href: "/owner/reports/builder/r1",
      label: "Report",
    });
    expect(parentFor("/owner/reports/builder/r1/print", OWNER)?.href).toBe("/owner/reports/builder/r1");
    expect(parentFor("/owner/reports/builder/r1", OWNER)?.href).toBe("/owner/reports/builder");
    expect(parentFor("/owner/reports/builder/data", OWNER)?.href).toBe("/owner/reports/builder");
    expect(parentFor("/owner/integrations/razorpay/connect", OWNER)).toEqual({
      href: "/owner/integrations/razorpay",
      label: "Razorpay",
    });
    expect(parentFor("/owner/integrations/razorpay", OWNER)?.href).toBe("/owner/integrations");
    expect(parentFor("/instances/i1/calls", PLATFORM, PLATFORM_HOME)).toEqual({
      href: "/instances/i1",
      label: "Instance",
    });
    expect(parentFor("/instances/i1", PLATFORM, PLATFORM_HOME)?.href).toBe("/instances");
    expect(parentFor("/instances/new", PLATFORM, PLATFORM_HOME)?.href).toBe("/instances");
  });

  it("skips an ancestor the persona cannot see", () => {
    const noBuilder = OWNER.filter((i) => i.href !== "/owner/reports/builder");
    expect(parentFor("/owner/reports/builder/r1", noBuilder)?.href).toBe("/owner/reports");
    const noReports = noBuilder.filter((i) => i.href !== "/owner/reports");
    expect(parentFor("/owner/reports/builder/r1", noReports)).toEqual(OWNER_HOME);
  });

  it("never lands on a redirect-only page", () => {
    const trail: CrumbSource[] = [
      OWNER_HOME,
      { href: "/owner/account", label: "Account" },
      { href: "/owner/account/profile", label: "Profile" },
    ];
    expect(parentFrom(trail)).toEqual(OWNER_HOME);
  });
});

describe("Up and the trail cannot disagree", () => {
  const cases = [
    ...pageRoutes("(owner)").map((p) => ({ p, items: OWNER, home: OWNER_HOME })),
    ...pageRoutes("(platform)").map((p) => ({ p, items: PLATFORM, home: PLATFORM_HOME })),
  ];

  it("has a real route inventory to check", () => {
    expect(cases.length).toBeGreaterThan(60);
  });

  it("parentFor(p) is the last linked crumb of breadcrumbsFor(p), wherever a trail is drawn", () => {
    const drift = cases.flatMap(({ p, items, home }) => {
      const crumbs = breadcrumbsFor(p, items, null, home);
      if (crumbs.length === 0) return [];
      const lastLinked = crumbs[crumbs.length - 2]!;
      const up = parentFor(p, items, home);
      return lastLinked.href === up?.href && lastLinked.label === up?.label
        ? []
        : [`${p}: up=${up?.href} but the trail's last link is ${lastLinked.href}`];
    });
    expect(drift).toEqual([]);
  });

  it("every page below Home has somewhere to go up to", () => {
    const stranded = cases
      .filter(({ p, home }) => p !== home.href)
      .filter(({ p, items, home }) => parentFor(p, items, home) === null)
      .map(({ p }) => p);
    expect(stranded).toEqual([]);
  });
});
