/**
 * Page arithmetic for offset-paged lists whose position lives in the URL
 * (`?offset=`), shared by the pager component and its tests.
 */

/** A page number to link, or a run of pages left out. */
export type PageSlot = number | "gap";

/**
 * Which page numbers to show. Seven slots is the ceiling: every page when
 * there are seven or fewer, otherwise the first, the last, the current one and
 * its neighbours, with a gap for each run left out.
 *
 * Always exactly seven slots past that point, wherever the reader is - a pager
 * whose width changes as you step through it moves the button under the
 * pointer, and the next click lands on the wrong page.
 */
export function pageWindow(current: number, pages: number, max = 7): PageSlot[] {
  const total = Math.max(1, Math.floor(pages));
  const at = Math.min(Math.max(1, Math.floor(current)), total);
  if (total <= max) return Array.from({ length: total }, (_, i) => i + 1);
  if (at <= 4) return [1, 2, 3, 4, 5, "gap", total];
  if (at >= total - 3) return [1, "gap", total - 4, total - 3, total - 2, total - 1, total];
  return [1, "gap", at - 1, at, at + 1, "gap", total];
}

/** Where a list stands: the page it is on and how many there are. */
export function pageState(total: number, pageSize: number, offset: number) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(pages, Math.floor(Math.max(0, offset) / pageSize) + 1);
  const first = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const last = Math.min(current * pageSize, total);
  return { pages, current, first, last };
}

/**
 * A typed page number made usable: clamped into range, or null when it is not
 * a number at all. "0" goes to the first page and "999" to the last, which is
 * what someone typing either one meant.
 */
export function parsePageInput(raw: string, pages: number): number | null {
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(1, n), Math.max(1, pages));
}

/**
 * The URL of one page, keeping every other parameter the list carries. Page 1
 * drops `offset` altogether rather than writing `offset=0`, so the first page
 * has one address, not two.
 */
export function pageHref(pathname: string, search: string, page: number, pageSize: number): string {
  const next = new URLSearchParams(search);
  const offset = (Math.max(1, page) - 1) * pageSize;
  if (offset > 0) next.set("offset", String(offset));
  else next.delete("offset");
  const qs = next.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
