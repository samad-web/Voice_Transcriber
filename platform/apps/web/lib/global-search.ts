/**
 * The global search contract - what the header's search box asks for and what
 * it gets back, independent of which CRM answers.
 *
 * ── WHY A CONTRACT, NOT THE API'S SHAPES ────────────────────────────────────
 *
 * The box must work the same whether a tenant's records live in Aura's own
 * tables or in a CRM behind a connector. So the UI knows nothing about
 * `display_name` or `deal.stage`: every backend is adapted SERVER-SIDE into
 * `SearchHit`s that already carry their label and their link (see
 * lib/crm-search.ts for the Aura adapter). Swapping a tenant's data source is
 * a new adapter, not a change to the component.
 *
 * No `server-only` here: the component imports these types and the pure helpers.
 */

export type SearchHitKind = "contact" | "deal" | "note";

export interface SearchHit {
  kind: SearchHitKind;
  id: string;
  title: string;
  subtitle: string | null;
  /** A short right-aligned fact: a deal value, a note's date. */
  meta: string | null;
  /** Console path, without basePath - the component's router adds it. */
  href: string;
}

export interface SearchGroup {
  kind: SearchHitKind;
  label: string;
  hits: SearchHit[];
}

export interface GlobalSearchResponse {
  query: string;
  groups: SearchGroup[];
  /**
   * Kinds that SHOULD have been searched but could not be (an upstream error),
   * so the box can say "couldn't search deals" instead of implying no match.
   * A kind the reader is not permitted to see is simply absent - never listed
   * here, which would disclose that the data exists.
   */
  unavailable: SearchHitKind[];
}

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 200;

/** The endpoint, relative to the app - see `searchUrl` for the basePath. */
export const OWNER_SEARCH_ENDPOINT = "/owner/api/search";

/**
 * The URL to fetch. Plain `fetch` does NOT get Next's basePath the way <Link>
 * and the router do, and production serves the console under `/admin` - so a
 * bare "/owner/api/search" would 404 there while working perfectly in dev.
 */
export function searchUrl(query: string, basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? ""): string {
  return `${basePath}${OWNER_SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}`;
}

/** `text` split around case-insensitive occurrences of `query`, for highlighting. */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [{ text, match: false }];
  const parts: { text: string; match: boolean }[] = [];
  const haystack = text.toLowerCase();
  let from = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, from)) {
    if (at > from) parts.push({ text: text.slice(from, at), match: false });
    parts.push({ text: text.slice(at, at + needle.length), match: true });
    from = at + needle.length;
  }
  if (from < text.length) parts.push({ text: text.slice(from), match: false });
  return parts;
}
