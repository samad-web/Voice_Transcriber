import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NAV_ITEMS, OWNER_NAV_ITEMS } from "@/lib/nav";

/**
 * EVERY CONSOLE SCREEN HAS ITS OWN LOADING SKELETON, AND IT IS THE RIGHT ONE.
 *
 * Next.js applies the nearest `loading.tsx` to a route AND to every nested route
 * beneath it that lacks one. That is the whole failure mode here, and it is
 * silent: a page with no loader of its own does not error, it just shows some
 * ancestor's placeholder - for the operator console that was, for a long time,
 * one row of stat cards and a list under every page from the call log to the API
 * keys - and nobody sees it as wrong because it is not broken, only unlike the
 * page it precedes. A nested route is worse: `agents/[id]` (an editor) quietly
 * inherited `agents/` (a list).
 *
 * Nothing in typecheck, lint or build can see any of that, so it is a test.
 * Four properties, each one a thing that went wrong or nearly did:
 *
 *  1. COVERAGE. Every `page.tsx` in a console route group has a sibling
 *     `loading.tsx`, unless it is on NO_LOADER with a reason. A loader with no
 *     page beside it is dead code and fails too (a route-group root is exempt:
 *     that is the deliberate last-resort fallback).
 *
 *  2. HEADER PARITY. A page that renders `<PageHeader title="X" context="Y" />`
 *     with literals must have its loader render that same header, because the
 *     title is known without data and the skeleton should show it for real. A
 *     loader that hard-codes "Calls" while the page says "Call log" swaps text
 *     on arrival, which reads as a flicker. `PageHeaderSkeleton` is for pages
 *     whose title is fetched.
 *
 *  2b. NAV PARITY. The rail's `title` and `context` are documented as "the page's
 *     own <PageHeader>" and two things print them: the phone's top bar, and the
 *     last-resort loaders. A nav entry that says "Sales Targets" over a page
 *     headed "Targets" is invisible in a diff and wrong on a phone. The page is
 *     the source of truth - it is what renders.
 *
 *  3. SHAPE. Each loader renders, contains skeleton blocks, is not wrapped in a
 *     single element, and does not announce itself. The wrapper matters
 *     because the layout's `<main>` spaces its DIRECT children with `space-y-*`
 *     and one wrapping div would collapse the whole page into a single child;
 *     the announcement matters because route loaders are covered by Next's
 *     route announcer and a second live region would say it twice.
 */

const APP = __dirname;

/** The route groups that are consoles. `login`, `docs` and `events` are not. */
const CONSOLE_GROUPS = ["(owner)", "(platform)", "(admin)", "(dashboard)"];

/**
 * Pages that deliberately have no loader, and why. Keyed by the page's directory
 * relative to `app/`, forward slashes. Adding to this list is a decision and
 * needs a reason a reviewer can disagree with.
 */
const NO_LOADER: Record<string, string> = {
  "(owner)/owner/team":
    "redirects to /owner/staff before rendering anything - there is nothing to wait for",
  // Doc 28 (Q8): a person's own mailbox is the Integrations store's Mine view
  // now; the old URL is kept for bookmarks. Its sign-in callback does not move.
  "(owner)/owner/connections": "redirects to /owner/integrations?view=mine before rendering anything",
  // Doc 27: the account menu links to each section directly; the bare URL is
  // a redirect to Profile for anybody who types it.
  "(owner)/owner/account": "redirects to /owner/account/profile before rendering anything",
  // The three operator pages folded into /client-config (one page, three tabs).
  // Each old URL is kept as a bare redirect for bookmarks; the loader that matters
  // is client-config's own.
  "(platform)/roles": "redirect stub into /client-config?tab=roles",
  "(platform)/team": "redirect stub into /client-config?tab=team",
  "(platform)/api-keys": "redirect stub into /client-config?tab=keys",
};

/**
 * The groups whose LAYOUT draws `<main className="... space-y-*">`, so a loader
 * there is one of that `<main>`'s direct children and must be a fragment.
 * `(admin)` and `(dashboard)` are not on it, and that is not an oversight: the
 * admin page draws its own full-page `<main>` (its layout adds "no chrome"), and
 * `(dashboard)` has no layout at all - so a faithful loader for either has to
 * draw its own shell, and a single root element is correct there.
 */
const RHYTHM_GROUPS = ["(owner)", "(platform)"];

function files(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(full));
    else out.push(full);
  }
  return out;
}

const posix = (p: string) => relative(APP, p).split(sep).join("/");
const inConsole = (rel: string) => CONSOLE_GROUPS.some((g) => rel.startsWith(`${g}/`));
const dirOf = (rel: string) => rel.split("/").slice(0, -1).join("/");

const all = files(APP).map((f) => ({ abs: f, rel: posix(f) }));
const pages = all.filter((f) => f.rel.endsWith("/page.tsx") && inConsole(f.rel));
const loaders = all.filter((f) => f.rel.endsWith("/loading.tsx") && inConsole(f.rel));
const loaderDirs = new Set(loaders.map((l) => dirOf(l.rel)));

/* ── 1. coverage ─────────────────────────────────────────────────────────── */

describe("every console page has its own loader", () => {
  it("finds the console at all", () => {
    // A rename of a route group would turn every check below into a vacuous pass.
    expect(pages.length).toBeGreaterThan(30);
    expect(loaders.length).toBeGreaterThan(30);
  });

  it("no page falls through to an ancestor's skeleton", () => {
    const missing = pages
      .map((p) => dirOf(p.rel))
      .filter((dir) => !loaderDirs.has(dir) && !(dir in NO_LOADER));
    expect(
      missing,
      `These pages have no loading.tsx of their own and so show an ancestor's skeleton:\n  ${missing.join("\n  ")}\n` +
        "Add one shaped like the page, or list the route in NO_LOADER with a reason.",
    ).toEqual([]);
  });

  it("NO_LOADER only names pages that exist and still lack a loader", () => {
    const pageDirs = new Set(pages.map((p) => dirOf(p.rel)));
    const stale = Object.keys(NO_LOADER).filter((d) => !pageDirs.has(d) || loaderDirs.has(d));
    expect(stale, "delete these from NO_LOADER").toEqual([]);
  });

  it("no loader is orphaned from a page", () => {
    const pageDirs = new Set(pages.map((p) => dirOf(p.rel)));
    const orphans = [...loaderDirs].filter(
      // A route-group root ("(owner)", "(platform)") is the intentional fallback.
      (dir) => !pageDirs.has(dir) && !/^\([^/]+\)$/.test(dir.split("/").pop() ?? "") && dir !== "",
    );
    expect(
      orphans,
      "loading.tsx with no page.tsx beside it - dead code, or in the wrong folder",
    ).toEqual([]);
  });
});

/* ── 2. header parity ────────────────────────────────────────────────────── */

interface Header {
  title: string;
  context: string;
  /** The sentence under the title, or "" - a loader that omits it grows by a line on arrival. */
  description: string;
}

/**
 * The literal `<PageHeader title="…" context="…" />` pairs in a source file, and
 * whether any header in it takes its title from an expression. `context`
 * defaults to "Workspace" in the component, so an omitted one is normalised to
 * that on both sides - the loader and the page may differ in spelling and
 * still render the same eyebrow.
 *
 * `titles` is every literal title, INCLUDING those on a header whose eyebrow is an
 * expression (a tenant's name) and so is left out of `literal`: the title is
 * still knowable, and dropping it made a drifted title on such a page invisible.
 */
function headers(src: string): { literal: Header[]; dynamic: boolean; titles: string[] } {
  const literal: Header[] = [];
  const titles: string[] = [];
  let dynamic = false;
  for (const tag of src.matchAll(/<PageHeader\b([\s\S]*?)\/>/g)) {
    const props = tag[1];
    const title = /\btitle="([^"]*)"/.exec(props)?.[1];
    if (title === undefined) {
      dynamic = true;
      continue;
    }
    titles.push(title);
    const context = /\bcontext="([^"]*)"/.exec(props)?.[1];
    // context={expr} is dynamic too - the eyebrow is not knowable from source.
    if (context === undefined && /\bcontext=\{/.test(props)) {
      dynamic = true;
      continue;
    }
    const description = /\bdescription="([^"]*)"/.exec(props)?.[1] ?? "";
    literal.push({ title, context: context ?? "Workspace", description });
  }
  return { literal, dynamic, titles };
}

const show = (h: Header) =>
  `"${h.title}" / "${h.context}"${h.description ? ` / "${h.description.slice(0, 40)}..."` : ""}`;

describe("a loader's header matches its page's", () => {
  const pairs = pages
    .map((p) => ({ page: p, loader: loaders.find((l) => dirOf(l.rel) === dirOf(p.rel)) }))
    .filter(
      (x): x is { page: (typeof pages)[number]; loader: (typeof loaders)[number] } => !!x.loader,
    );

  it("has pairs to check", () => {
    expect(pairs.length).toBeGreaterThan(30);
  });

  it("renders the page's own title for real when it is a literal", () => {
    const problems: string[] = [];
    for (const { page, loader } of pairs) {
      const p = headers(readFileSync(page.abs, "utf8"));
      const l = headers(readFileSync(loader.abs, "utf8"));
      if (p.literal.length === 0) continue; // header is drawn elsewhere or fetched

      if (l.literal.length === 0) {
        // A dynamic title is exactly what PageHeaderSkeleton is for; a literal one is not.
        if (!p.dynamic) {
          problems.push(
            `${loader.rel}: page renders ${p.literal.map(show).join(" or ")} but the loader draws no real <PageHeader>`,
          );
        }
        continue;
      }
      const match = l.literal.some((h) =>
        p.literal.some(
          (q) => q.title === h.title && q.context === h.context && q.description === h.description,
        ),
      );
      if (!match && !p.dynamic) {
        problems.push(
          `${loader.rel}: loader header ${l.literal.map(show).join(", ")} is not one of the page's (${p.literal
            .map(show)
            .join(", ")})`,
        );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});

/* ── 2b. nav parity ──────────────────────────────────────────────────────── */

describe("a nav item's heading matches its page's", () => {
  // `NavItem.title` is documented as "the page's own <PageHeader> title". Two things
  // read it: the mobile top bar, and the last-resort loaders above, which render it
  // as the real heading. A drift is invisible in the diff and shows up as a phone
  // reading "Sales Targets" over a page headed "Targets".
  const consoles = [
    { group: "(platform)", items: NAV_ITEMS },
    { group: "(owner)", items: OWNER_NAV_ITEMS },
  ];

  it("every nav item points at a page that exists", () => {
    const orphans = consoles.flatMap(({ group, items }) =>
      items
        .filter((i) => !pages.some((p) => p.rel === `${group}${i.href}/page.tsx`))
        .map((i) => `${group}${i.href}`),
    );
    expect(orphans, "nav items with no page.tsx").toEqual([]);
  });

  it("title and eyebrow are what the page renders, where the page states them", () => {
    const problems: string[] = [];
    for (const { group, items } of consoles) {
      for (const item of items) {
        const page = pages.find((p) => p.rel === `${group}${item.href}/page.tsx`);
        if (!page) continue; // reported above
        const p = headers(readFileSync(page.abs, "utf8"));
        // Nothing literal to compare against (the header is fetched, or drawn elsewhere).
        if (p.titles.length === 0) continue;
        if (!p.titles.includes(item.title)) {
          problems.push(
            `${group}${item.href}: nav title "${item.title}" but the page renders ${p.titles
              .map((t) => `"${t}"`)
              .join(" or ")}`,
          );
          continue;
        }
        // The eyebrow is comparable only where the page states it; one that is an
        // expression (the tenant's name) has no literal pair and is skipped.
        const stated = p.literal.filter((h) => h.title === item.title);
        const eyebrow = item.context ?? "Workspace";
        if (stated.length > 0 && !stated.some((h) => h.context === eyebrow)) {
          problems.push(
            `${group}${item.href}: nav eyebrow "${eyebrow}" but the page renders ${stated
              .map((h) => `"${h.context}"`)
              .join(" or ")}`,
          );
        }
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});

/* ── 3. shape ────────────────────────────────────────────────────────────── */

// The group-level fallbacks read the URL to title themselves. There is no router in a unit test.
vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard" }));

/** How many sibling elements sit at the top of this markup. One means a wrapper. */
function topLevelElements(html: string): number {
  let depth = 0;
  let top = 0;
  for (const tag of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
    const closing = tag[1] === "/";
    const selfClosing = tag[3] === "/" || /^(br|hr|img|input|meta|link)$/i.test(tag[2]);
    if (closing) depth -= 1;
    else {
      if (depth === 0) top += 1;
      if (!selfClosing) depth += 1;
    }
  }
  return top;
}

describe("every loader renders a skeleton, unwrapped and unannounced", () => {
  for (const loader of loaders) {
    it(loader.rel, async () => {
      const mod = (await import(/* @vite-ignore */ pathToFileURL(loader.abs).href)) as {
        default: ComponentType;
      };
      expect(typeof mod.default, "default export must be a component").toBe("function");

      const html = renderToStaticMarkup(createElement(mod.default));

      expect(html, "no skeleton blocks drawn").toContain("animate-pulse");
      // A fragment of siblings, not one wrapper: the layout's `space-y-*` acts on direct children.
      if (RHYTHM_GROUPS.some((g) => loader.rel.startsWith(`${g}/`))) {
        expect(
          topLevelElements(html),
          "loader is wrapped in a single element - return a fragment so <main>'s space-y-* still spaces the blocks",
        ).toBeGreaterThanOrEqual(2);
      }
      // Next's route announcer already speaks the navigation. LoadingRegion is for inline regions.
      expect(html, "route loaders must not render a live region").not.toContain('role="status"');
    });
  }

  it("has a loader to render", () => {
    expect(existsSync(join(APP, "(platform)", "loading.tsx"))).toBe(true);
  });
});
