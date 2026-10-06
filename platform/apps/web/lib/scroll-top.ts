/**
 * Should the console jump back to the top of the page?
 *
 * ── THE BUG THIS EXISTS FOR ─────────────────────────────────────────────────
 *
 * Both consoles render their chrome in the LAYOUT - the header row, then
 * <ConsoleSectionTabs>, then {children} - which is what keeps the tab strip on
 * screen while the next tab's server data loads. The cost is that moving
 * between tabs changes only the `children` segment, and the App Router's own
 * scroll handling scrolls the CHANGED SEGMENT into view rather than the page.
 * On any screen tall enough to have been scrolled, choosing an option therefore
 * lands with the page already pushed down and the tabs parked above the fold -
 * reported as "while choosing an option it is anchoring down".
 *
 * `scrollIntoView` on the segment is the right default for a document; it is
 * the wrong one for an application whose every route is a fresh screen. So the
 * decision is taken here instead, and <ScrollTopOnNavigate> applies it.
 *
 * ── A PURE FUNCTION, BECAUSE THE INTERESTING PART IS THE EXCEPTIONS ─────────
 *
 * Two of them, and both would be invisible in a component that simply called
 * `window.scrollTo(0, 0)` on every render:
 *
 *   BACK AND FORWARD keep their place. Restoring where somebody was is the
 *   whole point of going back - landing at the top of a list they had scrolled
 *   halfway down, after opening one row, is the behaviour people describe as
 *   losing their place. Reaching a page by Back is not "choosing an option".
 *
 *   A URL WITH A HASH keeps its anchor. `/instances/<id>/devices#enrollment` is
 *   a deliberate jump to a section (the operator console links it from two
 *   places, and the sections carry `scroll-mt` to clear the sticky strip).
 *   Forcing the top would silently break every one of those links.
 */
export type ScrollAction = "top" | "leave";

export interface ScrollInput {
  /** What is on screen, as pathname + search - a filter change counts as a new screen. */
  key: string;
  /** What was on screen at the last decision, or null for the first paint. */
  previous: string | null;
  /** The fragment, with or without its "#". Empty when there is none. */
  hash: string;
  /** The reader pressed Back or Forward to get here. */
  viaHistory: boolean;
}

export function scrollDecision({ key, previous, hash, viaHistory }: ScrollInput): ScrollAction {
  // An anchored link means "put me at that section", at any time - including
  // on a first load, where it is the only thing the URL is asking for.
  if (hash.replace(/^#/, "") !== "") return "leave";
  // The first paint of a tab. A fresh load or a deep link starts at the top:
  // that is the "load to the top of the page at all times" half of the ask,
  // and it also covers a reload of a page the browser had remembered a scroll
  // offset for.
  if (previous === null) return "top";
  if (viaHistory) return "leave";
  return key === previous ? "leave" : "top";
}
