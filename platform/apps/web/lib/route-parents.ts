import { integrationById } from "@aura/shared";

/**
 * THE SCREENS WHOSE PARENT IS NOT A NAV ITEM.
 *
 * Most console pages find their parent for free: `/owner/contacts/<id>` sits
 * under the Contacts nav item on a whole segment, and that is what the
 * breadcrumb trail and the header's Back button both climb to. A few sit under
 * another RECORD instead - a report's run history belongs to that report, not
 * to the Report Builder list - and the nav cannot know that, because a record
 * is not a nav item. Those, and only those, are written down here.
 *
 * ── ONE TABLE, TWO READERS ──────────────────────────────────────────────────
 *
 * `trailFor` (lib/breadcrumbs.ts) walks these rules to draw the trail, and the
 * Back button's fallback (lib/back-target.ts) takes the trail's second-to-last
 * crumb as "up". Same table, same walk, so Up and the trail cannot disagree;
 * route-parents.test.ts holds that as a property over every route below.
 *
 * ── HOW A RULE READS ────────────────────────────────────────────────────────
 *
 * `pattern` is matched on whole segments, `:x` standing for exactly one.
 * `parent` is filled from the same params. `label` names THIS page when it
 * appears in somebody else's trail - "Run history" above a single run - and is
 * the fallback when the page itself has not supplied a <BreadcrumbLeaf>.
 *
 * Order matters where a literal and a parameter compete for one segment:
 * `/owner/reports/builder/data` must be listed before `…/builder/:id`, or the
 * data-sources page would read as a report called "data".
 */

export interface RouteRule {
  pattern: string;
  parent: string;
  label: string | ((params: Record<string, string>) => string);
}

export const ROUTE_PARENTS: readonly RouteRule[] = [
  // ── Owner console ─────────────────────────────────────────────────────────
  { pattern: "/owner/reports/builder/data", parent: "/owner/reports/builder", label: "Data sources" },
  { pattern: "/owner/reports/builder/:id/runs/:runId", parent: "/owner/reports/builder/:id/runs", label: "Report run" },
  { pattern: "/owner/reports/builder/:id/runs", parent: "/owner/reports/builder/:id", label: "Run history" },
  { pattern: "/owner/reports/builder/:id/print", parent: "/owner/reports/builder/:id", label: "Print" },
  { pattern: "/owner/reports/builder/:id", parent: "/owner/reports/builder", label: "Report" },
  // The store (doc 28 Part B). An app page is named from the catalogue, so
  // its crumb needs no fetch; the connect flow belongs to its app, not to the
  // store, so leaving it goes back to the app.
  { pattern: "/owner/integrations/:app/connect", parent: "/owner/integrations/:app", label: "Connect" },
  {
    pattern: "/owner/integrations/:app",
    parent: "/owner/integrations",
    label: ({ app }) => integrationById(app ?? "")?.label ?? "App",
  },

  // ── Operator console ──────────────────────────────────────────────────────
  // The operator's own account pages (doc 27) are reached from the account
  // menu, not the rail, so the nav cannot name them. The owner console's
  // equivalents carry their own trail (lib/account-menu.ts, accountCrumbsFor).
  { pattern: "/account/profile", parent: "/dashboard", label: "Profile" },
  { pattern: "/account/login-activity", parent: "/dashboard", label: "Login activity" },
  { pattern: "/instances/new", parent: "/instances", label: "New instance" },
  { pattern: "/instances/:id/calls", parent: "/instances/:id", label: "Calls" },
  { pattern: "/instances/:id", parent: "/instances", label: "Instance" },
];

/**
 * Pages that only ever redirect. Up never lands on one: "Back to Account"
 * that opens Profile again, from Profile, is a button that does nothing.
 */
export const REDIRECT_ONLY_HREFS: ReadonlySet<string> = new Set([
  "/owner/account",
  "/owner/team",
  "/owner/connections",
]);

export interface RouteMatch {
  /** This page's label, from the rule. */
  label: string;
  /** The parent path, params filled in. */
  parent: string;
}

const segments = (path: string) => path.split("/").filter(Boolean);

/** The first rule whose pattern matches `path` exactly, on whole segments. */
export function matchRouteRule(path: string, rules: readonly RouteRule[] = ROUTE_PARENTS): RouteMatch | null {
  const actual = segments(path);
  for (const rule of rules) {
    const expected = segments(rule.pattern);
    if (expected.length !== actual.length) continue;
    const params: Record<string, string> = {};
    const matches = expected.every((seg, i) => {
      const value = actual[i]!;
      if (seg.startsWith(":")) {
        params[seg.slice(1)] = value;
        return true;
      }
      return seg === value;
    });
    if (!matches) continue;
    const parent = `/${segments(rule.parent)
      .map((seg) => (seg.startsWith(":") ? (params[seg.slice(1)] ?? seg) : seg))
      .join("/")}`;
    const label = typeof rule.label === "function" ? rule.label(params) : rule.label;
    return { label, parent };
  }
  return null;
}
