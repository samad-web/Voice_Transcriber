/**
 * The Deals page's URL state, in one place.
 *
 * Everything the page shows is in the query string - which pipeline, board or
 * table, and the table's filters - so a refresh, the back button and a shared
 * link all land on the same view (the rule plan 23 §G wrote into nav.ts). The
 * catch with URL state is that every link on the page has to carry ALL of it:
 * the pipeline picker used to build `?pipelineId=` alone and would have thrown
 * the view away. So links are built here, from the current state plus a change,
 * never by hand.
 */

export type DealsView = "board" | "table";
export type DealsSort = "activity" | "amount" | "name" | "created";
export type DealsStatus = "open" | "won" | "lost" | "closed";

export interface DealsState {
  pipelineId: string | null;
  view: DealsView;
  /** Table only - a stage key, or null for every stage. */
  stage: string | null;
  /** Table only - just the deals past the stale threshold. */
  staleOnly: boolean;
  /** Table only - `me`, `none` or a user id (the API resolves `me`). */
  owner: string | null;
  /** Table only - a tag id. */
  tagId: string | null;
  /** Table only - name/summary search. */
  q: string | null;
  /** Table only - `closed` is won OR lost. */
  status: DealsStatus | null;
  /** Table only - created within these dates (the Reports dashboard's drill-downs set them). */
  createdFrom: string | null;
  createdTo: string | null;
  sort: DealsSort;
  /** 1-based. */
  page: number;
}

const SORTS: readonly DealsSort[] = ["activity", "amount", "name", "created"];
const STATUSES: readonly DealsStatus[] = ["open", "won", "lost", "closed"];
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export function parseDealsState(sp: Record<string, string | string[] | undefined>): DealsState {
  const sort = first(sp.sort);
  const page = Number(first(sp.page));
  return {
    pipelineId: first(sp.pipelineId) || null,
    view: first(sp.view) === "table" ? "table" : "board",
    stage: first(sp.stage) || null,
    staleOnly: first(sp.stale) === "1",
    owner: first(sp.owner)?.trim() || null,
    tagId: first(sp.tagId)?.trim() || null,
    q: first(sp.q)?.trim() || null,
    status: STATUSES.includes(first(sp.status) as DealsStatus) ? (first(sp.status) as DealsStatus) : null,
    createdFrom: DATE.test(first(sp.createdFrom) ?? "") ? (first(sp.createdFrom) as string) : null,
    createdTo: DATE.test(first(sp.createdTo) ?? "") ? (first(sp.createdTo) as string) : null,
    sort: SORTS.includes(sort as DealsSort) ? (sort as DealsSort) : "activity",
    page: Number.isInteger(page) && page > 1 ? page : 1,
  };
}

/**
 * The URL for `state` with `change` applied. Changing anything but the page
 * returns to page 1 - a filter that leaves you on page 7 of a 2-page result is
 * an empty table that looks broken. Defaults are omitted so URLs stay short.
 */
export function dealsHref(state: DealsState, change: Partial<DealsState> = {}): string {
  const next = { ...state, ...change };
  if (!("page" in change)) next.page = 1;
  // Board view has no table filters; carrying them would make "switch back to
  // table" silently re-apply a filter nobody can see on the board.
  const table = next.view === "table";

  const params = new URLSearchParams();
  if (next.pipelineId) params.set("pipelineId", next.pipelineId);
  if (table) {
    params.set("view", "table");
    if (next.stage) params.set("stage", next.stage);
    if (next.staleOnly) params.set("stale", "1");
    if (next.owner) params.set("owner", next.owner);
    if (next.tagId) params.set("tagId", next.tagId);
    if (next.q) params.set("q", next.q);
    if (next.status) params.set("status", next.status);
    if (next.createdFrom) params.set("createdFrom", next.createdFrom);
    if (next.createdTo) params.set("createdTo", next.createdTo);
    if (next.sort !== "activity") params.set("sort", next.sort);
    if (next.page > 1) params.set("page", String(next.page));
  }
  const query = params.toString();
  return `/owner/deals${query ? `?${query}` : ""}`;
}
