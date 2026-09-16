import { z } from "zod";
import { RECYCLE_BIN, type RecycleBinResource } from "@aura/shared";
import type { PrincipalRequest } from "./auth-principal";

/**
 * Soft delete and restore, for the seven resources migration 0097 made
 * reversible.
 *
 * ── WHY THIS TAKES A RESOURCE AND NOT A TABLE NAME ─────────────────────────
 *
 * The table is looked up from the shared catalogue rather than passed in, so a
 * controller cannot soft-delete something the recycle bin does not know about.
 * That would be the quiet failure: the row vanishes from the console, the bin
 * never lists it because the bin iterates the catalogue, and the purge sweep
 * never removes it because it iterates the same catalogue. The row would sit in
 * the database forever, invisible, while the UI said it was deleted 30 days
 * ago. Making the catalogue the only way in removes that state entirely.
 *
 * It also keeps the interpolation honest: `table` reaches SQL as a literal from
 * a file in this repository, never as anything derived from a request.
 */

interface Queryable {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
}

/**
 * The user id to attribute an action to, or null.
 *
 * Null is the normal answer for an ops script or the operator console: they
 * present the platform admin key, and `admin-key.guard.ts` writes the literal
 * string "admin-key" as the caller. Storing that in a uuid column would fail,
 * and inventing a user for it would put a name on an action nobody took.
 */
export function actorUserId(req: PrincipalRequest): string | null {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}

/**
 * Mark one row deleted. Returns false if it was not there, or was already gone.
 *
 * The `deleted_at IS NULL` guard is what makes a repeat delete a 404 instead of
 * a silent no-op that resets the 30-day clock. Without it a double-clicked
 * button would quietly extend the retention window, and a row could be kept out
 * of the purge indefinitely by deleting it again.
 */
export async function softDelete(
  client: Queryable,
  resource: RecycleBinResource,
  id: string,
  req: PrincipalRequest,
  /**
   * An extra condition the row must also satisfy, for the callers that gate a
   * delete on more than its id - today only sales_targets, where a scoped rep
   * may remove their own target and nobody else's.
   *
   * It has to be part of THIS statement rather than a check before it. A
   * separate SELECT would let a target reassigned between the two calls be
   * deleted by somebody who no longer owns it, and it would report success.
   *
   * `$1` is the id and `$2` the actor, so a clause numbers its own parameters
   * from `$3` - which is what `scopeClause(..., 3)` produces.
   */
  guard?: { clause: string; params: unknown[] },
): Promise<boolean> {
  const { table } = RECYCLE_BIN[resource];
  const { rows } = await client.query(
    `UPDATE ${table}
        SET deleted_at = now(), deleted_by = $2
      WHERE id = $1 AND deleted_at IS NULL ${guard ? `AND ${guard.clause}` : ""}
      RETURNING id`,
    [id, actorUserId(req), ...(guard?.params ?? [])],
  );
  return rows.length > 0;
}

/**
 * Put one row back. Returns false if it was not in the bin.
 *
 * `deleted_at IS NOT NULL` is the mirror of the guard above: restoring a live
 * row is not an error worth inventing a success for, and a restore that
 * reported success on a row it did not touch would make the bin's own list
 * lie on the next refresh.
 *
 * Nothing is written to the children. They were never deleted - see the 0097
 * header - so the parent coming back is the whole restore.
 */
export async function restoreDeleted(
  client: Queryable,
  resource: RecycleBinResource,
  id: string,
): Promise<boolean> {
  const { table } = RECYCLE_BIN[resource];
  const { rows } = await client.query(
    `UPDATE ${table}
        SET deleted_at = NULL, deleted_by = NULL
      WHERE id = $1 AND deleted_at IS NOT NULL
      RETURNING id`,
    [id],
  );
  return rows.length > 0;
}
