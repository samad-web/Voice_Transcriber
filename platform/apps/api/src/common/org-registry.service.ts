import { Injectable } from "@nestjs/common";
import { DbService } from "../db/db.service";

/**
 * Does this org id name a real tenant?
 *
 * `x-org-id` is trusted input on the admin-key path (the operator legitimately
 * acts across tenants), which means a typo'd or stale uuid used to sail through:
 * `withOrg` would set `app.org_id` to something that matches no rows, every RLS
 * policy would filter everything out, and the caller would get a cheerful
 * `200 {"calls": []}`. "This customer has no calls" and "this customer does not
 * exist" are very different answers to be conflating.
 *
 * Cached because the check sits in front of every request and the answer is
 * effectively static - an org id is created once and never changes. Only
 * positive results are cached: a miss must stay queryable so a tenant created
 * seconds ago is not rejected for the rest of the TTL.
 */
@Injectable()
export class OrgRegistryService {
  private readonly seen = new Map<string, number>();

  /** Long enough to make the lookup negligible, short enough that a deleted
   *  org stops being accepted promptly. */
  private static readonly TTL_MS = 5 * 60 * 1000;

  constructor(private readonly db: DbService) {}

  async exists(orgId: string): Promise<boolean> {
    const now = Date.now();
    const cachedAt = this.seen.get(orgId);
    if (cachedAt !== undefined && now - cachedAt < OrgRegistryService.TTL_MS) return true;

    // Admin pool: this runs before an org context exists, which is the whole
    // point - asking under RLS would beg the question.
    const { rows } = await this.db
      .adminPool()
      .query("SELECT 1 FROM organizations WHERE id = $1", [orgId]);
    const found = rows.length > 0;

    if (found) this.seen.set(orgId, now);
    else this.seen.delete(orgId);
    return found;
  }
}
