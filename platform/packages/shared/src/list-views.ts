import { z } from "zod";

/**
 * Saved views and bulk actions on the owner console's lists (CRM dashboard,
 * Phase 5; packages/db/migrations/0108).
 */

/**
 * The lists a view can belong to. The DB's CHECK on `saved_views.list_key` is
 * the other copy of this list - list-views.test.ts reads the migration and
 * fails if the two drift.
 */
export const SavedViewList = z.enum(["leads", "deals", "contacts", "tasks", "accounts"]);
export type SavedViewList = z.infer<typeof SavedViewList>;

/**
 * A list's query string, as a flat object.
 *
 * Deliberately dumb: the console normalises it against the list's own param
 * whitelist before saving (apps/web/lib/list-views.ts), and the API only
 * bounds its size. It is a filter re-run under the viewer's own permissions,
 * never data, so the API has nothing to check inside it.
 */
export const SavedViewQuery = z
  .record(z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/, "not a query parameter name"), z.string().max(200))
  .refine((q) => Object.keys(q).length <= 20, { message: "a view keeps at most 20 filters" });
export type SavedViewQuery = z.infer<typeof SavedViewQuery>;

const ViewName = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1, "give the view a name").max(60, "keep the name under 60 characters"));

export const SavedViewInput = z.object({
  list: SavedViewList,
  name: ViewName,
  query: SavedViewQuery,
});
export type SavedViewInput = z.infer<typeof SavedViewInput>;

/**
 * Rename, re-point or reorder. No `.default()` anywhere in here, on purpose:
 * a PATCH schema with a default silently writes the default over a field the
 * caller never sent.
 */
export const SavedViewPatch = z
  .object({
    name: ViewName.optional(),
    query: SavedViewQuery.optional(),
    position: z.number().int().min(0).max(1000).optional(),
  })
  .refine((v) => v.name !== undefined || v.query !== undefined || v.position !== undefined, {
    message: "nothing to update",
  });
export type SavedViewPatch = z.infer<typeof SavedViewPatch>;

// ── bulk actions ────────────────────────────────────────────────────────────

/**
 * The most rows one bulk request may touch - four pages of a 50-row list.
 *
 * Bounded because each id is checked against the org and the caller's record
 * scope inside one transaction, and because "reassign 40,000 contacts" should
 * be a deliberate import job, not a checkbox.
 */
export const BULK_MAX = 200;

/** Selected row ids. Duplicates collapse: selecting a row twice is one row. */
export const BulkIds = z
  .array(z.string().uuid())
  .min(1, "select at least one row")
  .max(BULK_MAX, `select at most ${BULK_MAX} rows at a time`)
  .transform((ids) => [...new Set(ids)]);

/**
 * Contacts and deals: a new owner, or `null` to leave them unowned. Required
 * rather than optional - an omitted field and an explicit "nobody" must not
 * be the same request.
 */
export const BulkReassignInput = z.object({
  ids: BulkIds,
  ownerUserId: z.string().uuid().nullable(),
});
export type BulkReassignInput = z.infer<typeof BulkReassignInput>;

/** Tasks belong to an assignee, not an owner. */
export const BulkAssignTasksInput = z.object({
  ids: BulkIds,
  assigneeUserId: z.string().uuid().nullable(),
});
export type BulkAssignTasksInput = z.infer<typeof BulkAssignTasksInput>;

/**
 * Leads belong to a TELECALLER identity (`leads.assigned_telecaller_id`), not
 * a user - a telecaller may have no console login at all.
 */
export const BulkAssignLeadsInput = z.object({
  ids: BulkIds,
  telecallerId: z.string().uuid().nullable(),
});
export type BulkAssignLeadsInput = z.infer<typeof BulkAssignLeadsInput>;

/** Attach one tag to many records; the tag is in the path. */
export const BulkTagInput = z.object({ ids: BulkIds });
export type BulkTagInput = z.infer<typeof BulkTagInput>;

/**
 * What every bulk route answers. `skipped` is the selected rows the caller
 * could not touch - gone, merged, or outside their record scope - and is
 * reported as a number rather than a list of ids, so a scoped rep learns
 * nothing about a colleague's records by selecting them.
 */
export interface BulkResult {
  updated: number;
  skipped: number;
}
