import { z } from "zod";

/**
 * "Whose records" on a list endpoint - contacts and deals by owner, tasks by
 * assignee.
 *
 * `me` resolves to the caller server-side, so a saved "My deals" view (0108)
 * means the person OPENING it, not whoever saved it. `none` is the unowned
 * pile. A caller with no resolvable user asking for `me` gets an empty list,
 * never everyone's.
 *
 * A filter only ever narrows: the caller's record scope is still applied on
 * top, so `?owner=<colleague>` from a rep scoped to their own records is empty.
 */
export const OwnerFilter = z.union([z.string().uuid(), z.literal("me"), z.literal("none")]);
export type OwnerFilter = z.infer<typeof OwnerFilter>;
