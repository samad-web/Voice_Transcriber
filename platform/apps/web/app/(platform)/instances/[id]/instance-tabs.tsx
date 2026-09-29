"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * The instance's pages as a tab strip - the third level of the operator
 * console's navigation, under the rail and its section tabs.
 *
 * ── THESE ARE ROUTES NOW ────────────────────────────────────────────────────
 *
 * This component replaces a client-side switcher of the same name. That one took
 * five `content` nodes and revealed one at a time with `hidden`, keeping every
 * panel MOUNTED - which meant one visit to the instance page fetched the audit
 * ledger, the CRM catalogue, the owner logins and a per-instance detail call in
 * order to look at the fleet. It also carried a `data-goto-tab` delegation so
 * that server-rendered buttons deep in a panel could switch panels without
 * threading a callback down, since a server component cannot call `setTab`.
 *
 * Every panel is a route under `/instances/<id>/` (doc 34 Part B), so all of that
 * goes away: each page fetches only its own data, a cross-panel jump is an
 * ordinary `<Link>`, and the back button, middle-click and bookmarking work on
 * the tabs for the first time.
 *
 * Like `ConsoleSectionTabs`, these are deliberately NOT `role="tablist"`. Each is
 * a separate route with its own server data; a real tab panel is content already
 * in the document that a click reveals. `<nav>` + `aria-current="page"` says the
 * true thing and keeps prefetch and open-in-new-tab.
 */

/**
 * Tab order, which is reading order: what the customer IS, then what they have
 * recorded, then their hardware, then what we have configured for them, then the
 * ledger of what was done. `seg: ""` is the instance page itself.
 *
 * Thirteen is a lot for one strip, and it scrolls sideways below a wide viewport.
 * Accepted on purpose rather than split into a fourth level: three levels of
 * nesting is already the limit of what a person can hold, and a sub-strip that
 * appears only inside some tabs is worse than a long row that is always the same
 * shape. If this grows again, the answer is fewer screens, not more levels.
 */
export const INSTANCE_TABS = [
  { seg: "", label: "Overview" },
  { seg: "calls", label: "Calls" },
  { seg: "search", label: "Transcripts" },
  { seg: "agents", label: "Agents" },
  { seg: "devices", label: "Devices" },
  { seg: "settings", label: "Settings" },
  { seg: "lead-delivery", label: "Lead delivery" },
  { seg: "targets", label: "Targets" },
  { seg: "fields", label: "Fields" },
  { seg: "automations", label: "Automations" },
  { seg: "usage", label: "Usage" },
  { seg: "access", label: "Access" },
  { seg: "audit", label: "Audit" },
] as const;

/**
 * Which tab a path is on. Exported for its test.
 *
 * Longest segment match, so `/instances/x/calls/anything` stays on Calls, and
 * Overview (`seg: ""`) wins only on the instance root - otherwise its empty
 * segment would prefix-match every tab at once.
 */
export function activeInstanceSeg(pathname: string, orgId: string): string | null {
  const base = `/instances/${orgId}`;
  const rest = pathname.startsWith(base) ? pathname.slice(base.length).replace(/^\//, "") : null;
  if (rest === null) return null;
  if (rest === "") return "";
  const match = INSTANCE_TABS.filter((t) => t.seg !== "")
    .filter((t) => rest === t.seg || rest.startsWith(`${t.seg}/`))
    .sort((a, b) => b.seg.length - a.seg.length)[0];
  return match?.seg ?? null;
}

export function InstanceTabs({ orgId }: { orgId: string }) {
  const pathname = usePathname();
  const active = activeInstanceSeg(pathname, orgId);

  const tab =
    // The strip scrolls horizontally, which clips the block axis too - the
    // theme's focus ring sits 2px outside the element and would be cropped.
    // Drawn inside instead. Same treatment as ConsoleSectionTabs.
    "flex h-11 shrink-0 items-center rounded-t-md border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors duration-150 ease-out focus-visible:-outline-offset-2 sm:px-4 ";

  return (
    <nav
      aria-label="Instance sections"
      className="print-hide -mx-4 overflow-x-auto border-b border-border px-4 sm:-mx-5 sm:px-5 md:-mx-8 md:px-8"
    >
      <ul className="-mb-px flex gap-0.5">
        {INSTANCE_TABS.map((t) => {
          const on = t.seg === active;
          const href = t.seg ? `/instances/${orgId}/${t.seg}` : `/instances/${orgId}`;
          return (
            <li key={t.seg || "overview"}>
              <Link
                href={href}
                aria-current={on ? "page" : undefined}
                className={
                  tab +
                  (on
                    ? "border-text text-text"
                    : "border-transparent text-text-muted hover:text-text")
                }
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
