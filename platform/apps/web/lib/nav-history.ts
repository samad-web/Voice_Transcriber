import { safeConsolePath } from "@aura/shared";
import { CONSOLE_HOME, isEntryTag, type EntryTag } from "@/lib/back-target";
import type { NavArea } from "@/lib/nav";

/**
 * The browser half of the Back button: tagging history entries, reading the
 * one behind, and remembering each list's last query. Client-only - every
 * function is a no-op (or a null) on the server and wherever the browser
 * refuses.
 *
 * ── WHY THE NAVIGATION API AND NOT `history.state` ──────────────────────────
 *
 * Next's App Router owns `history.state` and rewrites it on every replace, so
 * a tag put there does not survive a filter change. The Navigation API keeps
 * its own per-entry state (`navigation.updateCurrentEntry`) that the router
 * never touches, and `navigation.entries()` lists only the contiguous
 * same-origin run around the current entry - so "nothing behind us in this
 * run" is exactly the OAuth-return and new-tab case, with no extra bookkeeping.
 *
 * A browser without it gets tier 2 (Up) every time. That is the safe failure:
 * Up instead of Back, never the wrong tenant. There is deliberately no
 * `history.state` polyfill, for the reason above.
 */

/** The slice of the Navigation API this file uses. TypeScript's DOM lib does not ship it yet. */
interface NavigationEntryLike {
  index: number;
  getState(): unknown;
}
export interface NavigationLike {
  currentEntry: NavigationEntryLike | null;
  entries(): NavigationEntryLike[];
  updateCurrentEntry(options: { state: unknown }): void;
  addEventListener(type: "currententrychange", listener: () => void): void;
  removeEventListener(type: "currententrychange", listener: () => void): void;
}

export function navigationApi(): NavigationLike | null {
  if (typeof window === "undefined") return null;
  const nav = (window as unknown as { navigation?: NavigationLike }).navigation;
  return nav && typeof nav.updateCurrentEntry === "function" ? nav : null;
}

/** Tag the current history entry. Silently skipped where unsupported. */
export function tagCurrentEntry(tag: EntryTag): void {
  try {
    navigationApi()?.updateCurrentEntry({ state: tag });
  } catch {
    // An entry mid-navigation can refuse an update (InvalidStateError); the
    // next currententrychange re-tags it.
  }
}

/** The tag on the entry directly behind this one, if it is ours. */
export function previousEntryTag(): EntryTag | null {
  const nav = navigationApi();
  if (!nav?.currentEntry) return null;
  const i = nav.currentEntry.index;
  // Nothing behind in this same-origin run: a new tab, or back from an OAuth
  // provider's pages (rule O).
  if (i <= 0) return null;
  try {
    const tag = nav.entries()[i - 1]?.getState();
    // Untagged = /login, the marketing site, a page from before this build.
    return isEntryTag(tag) ? tag : null;
  } catch {
    return null;
  }
}

/* ── Remembered list queries (doc 28 §3.6) ───────────────────────────────── */

/**
 * Keyed by console AND tenant, so tenant A's `?pipelineId=` never reaches
 * tenant B. Bounded by construction: one key per index page per tenant this
 * tab visited.
 */
const queryKey = (area: NavArea, orgId: string | null, path: string) =>
  `aura.nav.q:${area}:${orgId ?? "-"}:${path}`;

export function rememberQuery(area: NavArea, orgId: string | null, path: string, query: string): void {
  try {
    window.sessionStorage.setItem(queryKey(area, orgId, path), query);
  } catch {
    // Private mode, storage full, storage blocked: Up simply lands unfiltered.
  }
}

/**
 * The query this tab last used on `path`, re-checked on the way out - storage
 * is writable by anything on this origin, and this string becomes an href.
 */
export function rememberedQuery(area: NavArea, orgId: string | null, path: string): string | null {
  let query: string | null;
  try {
    query = window.sessionStorage.getItem(queryKey(area, orgId, path));
  } catch {
    return null;
  }
  if (!query || !query.startsWith("?")) return null;
  const whole = safeConsolePath(`${path}${query}`, "");
  return whole ? query : null;
}

/** For tests and callers that need to know a console's home without the nav. */
export const homeOf = (area: NavArea) => CONSOLE_HOME[area];
