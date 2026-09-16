import "server-only";
import { ownerGet } from "@/lib/owner-context";
import type { ListKey, SavedView } from "@/lib/list-views";

/**
 * The signed-in person's saved views for one list, for a server page.
 *
 * `[]` on any failure, never a thrown page: views are a shortcut to a filter
 * the page can still build by hand, so an API deployed ahead of migration 0108
 * (or a blip) costs the tab row, not the list.
 */
export async function loadSavedViews(list: ListKey): Promise<SavedView[]> {
  const data = await ownerGet<{ views: SavedView[] }>(`/v1/saved-views?list=${list}`);
  return Array.isArray(data?.views) ? data.views : [];
}
