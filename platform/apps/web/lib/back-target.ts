import type { CrumbSource } from "@/lib/breadcrumbs";
import type { NavArea } from "@/lib/nav";

/**
 * WHERE THE HEADER'S BACK BUTTON GOES (doc 28 §3.3).
 *
 * Pure, so every row of the edge-case table is a unit test rather than a
 * browser session. The browser half - reading the entry behind this one and
 * the remembered list queries - is lib/nav-history.ts.
 *
 * ── THREE TIERS ─────────────────────────────────────────────────────────────
 *
 *   1  HISTORY  the entry directly behind is a console page this console
 *               tagged, for the same tenant → `router.back()`. That is what
 *               restores page 3 of a filtered list, scrolled where it was,
 *               which is the thing a hand-written "← All contacts" link
 *               threw away.
 *   2  UP       otherwise, the parent the breadcrumb trail shows, with the
 *               list query this tab last used there → a plain link.
 *   3  HIDDEN   neither: Home, arrived fresh.
 *
 * ── WHY NOT ALWAYS ONE OR THE OTHER ─────────────────────────────────────────
 *
 * Always-Up drops the reader's context. Always-history leaves the app after a
 * deep link, a new tab, the sign-in redirect or an OAuth return, and after a
 * tenant switch it would reopen tenant A's contact inside tenant B's session -
 * an error page at best. The entry behind has to be ours, in this console, for
 * this tenant (rules O, C and T); untagged means somebody else's, and somebody
 * else's means Up.
 */

/** What each console history entry carries, via the Navigation API. */
export interface EntryTag {
  v: 1;
  console: NavArea;
  /** The active tenant when the entry was made; null in the operator console. */
  orgId: string | null;
  /** How "Back to …" names this entry. */
  label: string;
  /** Router path plus query - never with the basePath. */
  href: string;
}

export function isEntryTag(value: unknown): value is EntryTag {
  if (!value || typeof value !== "object") return false;
  const tag = value as Partial<EntryTag>;
  return (
    tag.v === 1 &&
    (tag.console === "owner" || tag.console === "platform") &&
    (tag.orgId === null || typeof tag.orgId === "string") &&
    typeof tag.label === "string" &&
    typeof tag.href === "string"
  );
}

export interface BackTarget {
  kind: "history" | "link";
  /** Where the link points. For `history` this is the Up target, so a
   *  middle-click or a no-JS click still lands somewhere sensible. */
  href: string;
  label: string;
}

export const CONSOLE_HOME: Record<NavArea, string> = { owner: "/owner", platform: "/dashboard" };

/**
 * Query params that describe a moment, not a place. Remembering `?focus=`
 * would reopen yesterday's drawer; remembering `?error=` would repeat a
 * failure nobody is looking at any more.
 */
export const ONE_SHOT_PARAMS = ["focus", "connected", "error", "pending", "step", "from"] as const;

/** `search` ("?a=1&focus=x" or "a=1") minus the one-shot params, as "?a=1" or "". */
export function stripOneShot(search: string): string {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  for (const key of ONE_SHOT_PARAMS) params.delete(key);
  const rest = params.toString();
  return rest ? `?${rest}` : "";
}

export function resolveBack(input: {
  previous: EntryTag | null;
  current: { console: NavArea; orgId: string | null; href: string };
  parent: CrumbSource | null;
  rememberedQuery: (path: string) => string | null;
}): BackTarget | null {
  const { previous, current, parent } = input;
  const up = parent
    ? { href: parent.href + (input.rememberedQuery(parent.href) ?? ""), label: parent.label }
    : null;

  if (
    previous &&
    previous.console === current.console &&
    previous.orgId === current.orgId &&
    // The same URL twice in a row: going "back" to it would look like a dead
    // button. Up is the more useful answer.
    previous.href !== current.href
  ) {
    return { kind: "history", href: up?.href ?? CONSOLE_HOME[current.console], label: previous.label };
  }
  return up ? { kind: "link", ...up } : null;
}

/** The first render's target: Up only, since storage and history are client-side. */
export function upTarget(parent: CrumbSource | null): BackTarget | null {
  return parent ? { kind: "link", href: parent.href, label: parent.label } : null;
}
