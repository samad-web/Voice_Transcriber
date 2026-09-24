import type { SavedViewList } from "@aura/shared";

/**
 * The owner console's list views, as URL state - and what a saved view is.
 *
 * Every list keeps its filters and sort in the query string (a refresh, the
 * back button and a pasted link land on the same list). A saved view is
 * therefore nothing but a NAME for a normalised query string: saving one stores
 * the query below, opening one navigates to it. No rows, no columns.
 *
 * Normalising matters for two reasons:
 *   - "which saved tab is active" is an equality test, and `?sort=activity`,
 *     `?sort=activity&q=` and `` all mean the same list;
 *   - pagination, `focus` deep links and one-off params must not be saved, or
 *     opening "Stale deals" a month later lands on page 7 with a drawer open.
 *
 * The API stores whatever it is given (bounded in size); this file is the
 * whitelist, per list.
 */

export type ListKey = SavedViewList;

export interface ListDefinition {
  path: string;
  /** Params a view may keep, in display order. Everything else is dropped. */
  params: readonly string[];
  /** A param at its default is dropped, so the default list is the empty query. */
  defaults: Readonly<Record<string, string>>;
  /** Extra list-specific trimming after the generic pass. */
  refine?: (query: Record<string, string>) => Record<string, string>;
}

/** Deals: board view has no table filters - the same rule deals-url.ts applies to links. */
const DEAL_TABLE_ONLY = ["stage", "stale", "owner", "tagId", "q", "status", "createdFrom", "createdTo", "sort"];

export const LIST_DEFINITIONS: Readonly<Record<ListKey, ListDefinition>> = {
  leads: {
    path: "/owner/leads",
    params: [
      "q",
      "boardId",
      "stage",
      "status",
      "projectId",
      "sourceChannel",
      "assignedTo",
      "responded",
      "createdFrom",
      "createdTo",
      "sort",
    ],
    defaults: { sort: "activity" },
  },
  deals: {
    path: "/owner/deals",
    params: [
      "pipelineId",
      "view",
      "stage",
      "status",
      "stale",
      "owner",
      "tagId",
      "q",
      "createdFrom",
      "createdTo",
      "sort",
    ],
    defaults: { view: "board", sort: "activity" },
    refine: (query) => {
      if (query.view === "table") return query;
      const next = { ...query };
      for (const key of DEAL_TABLE_ONLY) delete next[key];
      return next;
    },
  },
  contacts: {
    path: "/owner/contacts",
    params: ["q", "owner", "tagId", "sourceChannel", "sort"],
    defaults: { sort: "activity" },
  },
  tasks: {
    path: "/owner/tasks",
    params: ["q", "status", "who", "due", "priority", "sort"],
    defaults: { status: "open", sort: "due" },
  },
  accounts: {
    path: "/owner/accounts",
    params: ["q", "sort"],
    defaults: { sort: "activity" },
  },
};

export type RawSearchParams =
  | URLSearchParams
  | Readonly<Record<string, string | string[] | undefined>>;

function read(sp: RawSearchParams, key: string): string | undefined {
  if (sp instanceof URLSearchParams) return sp.get(key) ?? undefined;
  const value = sp[key];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The query a view of `list` would save for these search params: whitelisted,
 * trimmed, empties and defaults dropped, keys in a stable order.
 */
export function viewQueryFrom(list: ListKey, sp: RawSearchParams): Record<string, string> {
  const def = LIST_DEFINITIONS[list];
  let query: Record<string, string> = {};
  for (const key of def.params) {
    const value = read(sp, key)?.trim();
    if (!value) continue;
    if (def.defaults[key] === value) continue;
    query[key] = value.slice(0, 200);
  }
  if (def.refine) query = def.refine(query);
  return Object.fromEntries(Object.entries(query).sort(([a], [b]) => a.localeCompare(b)));
}

/** The link that opens `query` on `list`. The empty query is the list's own path. */
export function viewHref(list: ListKey, query: Readonly<Record<string, string>>): string {
  const def = LIST_DEFINITIONS[list];
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query).sort(([a], [b]) => a.localeCompare(b))) {
    if (def.params.includes(key) && value) params.set(key, value);
  }
  const qs = params.toString();
  return `${def.path}${qs ? `?${qs}` : ""}`;
}

/**
 * The same list, one page further in (CRM dashboard Phase 8).
 *
 * `offset` is deliberately NOT a saved-view param: a view is a filter somebody
 * named, and a view pinned to page 7 opens on an empty table the day the list
 * shrinks. So it rides beside the view's query rather than inside it, and
 * `ListFilterForm` drops it whenever a filter changes.
 */
export function listPageHref(
  list: ListKey,
  query: Readonly<Record<string, string>>,
  offset: number,
): string {
  const base = viewHref(list, query);
  if (offset <= 0) return base;
  return `${base}${base.includes("?") ? "&" : "?"}offset=${offset}`;
}

/** Same list, whatever order or defaults either side was written with. */
export function sameViewQuery(list: ListKey, a: RawSearchParams | Record<string, string>, b: RawSearchParams | Record<string, string>): boolean {
  const left = viewQueryFrom(list, a);
  const right = viewQueryFrom(list, b);
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

export interface SavedView {
  id: string;
  list: ListKey;
  name: string;
  query: Record<string, string>;
  position: number;
}

/** The saved view the current URL IS, if any - first match wins, in tab order. */
export function activeSavedView(
  list: ListKey,
  views: readonly SavedView[],
  current: RawSearchParams | Record<string, string>,
): SavedView | null {
  return views.find((view) => sameViewQuery(list, view.query, current)) ?? null;
}

/** Whether the current URL has anything a view could save - the default list does not. */
export function hasSavableFilters(list: ListKey, current: RawSearchParams | Record<string, string>): boolean {
  return Object.keys(viewQueryFrom(list, current)).length > 0;
}
