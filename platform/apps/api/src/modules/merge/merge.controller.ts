import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * Merge & duplicate detection (CRM Phase 1, E0.3) — Contact/Account only,
 * matching the epic's own wording. Schema: packages/db/migrations/0038.
 *
 * SCOPE (per the user's explicit call, 2026-08-11): exact-match dedup only
 * this milestone. Fuzzy name+company matching needs `pg_trgm`, which no
 * migration in this codebase has ever enabled and which is unverified on the
 * production Supabase project — that half of `match_reason` (`fuzzy_name_
 * company`) is deliberately not populated here.
 *
 * Of the three remaining exact-match kinds, only `external_id` can actually
 * produce a candidate: `contacts`/`accounts` already carry partial UNIQUE
 * indexes on `(org_id, phone_hash)` / `(org_id, lower(email))` /
 * `(org_id, lower(domain))` for active rows (0035), so two ACTIVE rows can
 * never share a phone/email/domain in the first place — the database has
 * already deduped those at write time. `external_ids` has no such
 * constraint (a jsonb map, not a single column), so it is the one field
 * where a genuine duplicate can exist for this scan to find.
 */

const ObjectType = z.enum(["contact", "account"]);
type ObjectType = z.infer<typeof ObjectType>;

/** contact -> contacts / account -> accounts, and the FK column deals uses to point at each. */
const TABLE: Record<ObjectType, string> = { contact: "contacts", account: "accounts" };
const DEAL_FK: Record<ObjectType, string> = { contact: "contact_id", account: "account_id" };

const ScanQuery = z.object({ objectType: ObjectType });
const DuplicatesQuery = z.object({
  objectType: ObjectType.optional(),
  status: z.enum(["pending", "dismissed", "merged"]).default("pending"),
});
const MergeLogQuery = z.object({ objectType: ObjectType.optional() });

const PerformMergeBody = z.object({
  objectType: ObjectType,
  survivorId: z.string().uuid(),
  victimId: z.string().uuid(),
  /** Per contested field, which side's value the merge keeps. Fields not
   *  listed keep the survivor's existing value — the merge only overwrites
   *  what an operator explicitly decided. */
  fieldDecisions: z.record(z.string(), z.enum(["survivor", "victim"])).default({}),
});

/** Mutable columns eligible for a field decision, per object type. Deliberately
 *  excludes id/org_id/workspace_id/status/merged_into_id/timestamps — those
 *  are structural, not "which side's data is right". */
const MERGE_FIELDS: Record<ObjectType, string[]> = {
  contact: ["first_name", "last_name", "display_name", "email", "title", "account_id", "owner_user_id"],
  account: ["name", "domain", "owner_user_id"],
};

const REVERT_WINDOW_DAYS = 30;

/**
 * `performed_by`/`reverted_by` are real uuid FKs into `users`, unlike
 * audit_log.actor_id (text). The admin-key auth path's principal.userId
 * defaults to the literal string "admin-key" when no `x-caller-user-id`
 * header is sent (admin-key.guard.ts) — never a uuid — so it must be
 * validated before landing in a uuid column rather than passed through.
 */
function actorUserId(req: PrincipalRequest): string | null {
  const userId = req.principal?.userId;
  return userId && z.string().uuid().safeParse(userId).success ? userId : null;
}

@Controller("merge")
@UseGuards(AdminKeyGuard, TenantGuard)
export class MergeController {
  constructor(private readonly db: DbService) {}

  /**
   * Scan for external_id collisions among active (non-merged) rows and
   * upsert them into the candidate queue. Not computed live on every page
   * load — see 0038's header on `duplicate_matches`.
   */
  @Post("scan")
  async scan(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = ScanQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const table = TABLE[parsed.data.objectType];

    return this.db.withOrg(orgId, async (client) => {
      // Two rows collide when they share a (system, id) pair inside external_ids.
      // The CTE unpacks every row's map to (id, key, value) via CROSS JOIN
      // LATERAL, then a self-join on matching key+value finds the pairs.
      const { rows: pairs } = await client.query<{ a: string; b: string }>(
        `WITH ext AS (
           SELECT t.id, e.key, e.value
             FROM ${table} t
             CROSS JOIN LATERAL jsonb_each_text(t.external_ids) e
            WHERE t.org_id = $1 AND t.status <> 'merged'
         )
         SELECT DISTINCT LEAST(a.id, b.id) AS a, GREATEST(a.id, b.id) AS b
           FROM ext a
           JOIN ext b ON b.key = a.key AND b.value = a.value AND b.id <> a.id`,
        [orgId],
      );

      let inserted = 0;
      for (const pair of pairs) {
        const { rowCount } = await client.query(
          `INSERT INTO duplicate_matches (org_id, object_type, record_a_id, record_b_id, match_reason, score)
           VALUES ($1, $2, $3, $4, 'external_id', 1)
           ON CONFLICT (org_id, object_type, record_a_id, record_b_id) DO NOTHING`,
          [orgId, parsed.data.objectType, pair.a, pair.b],
        );
        inserted += rowCount ?? 0;
      }
      return { scanned: pairs.length, newCandidates: inserted };
    });
  }

  /**
   * Candidates plus a label/detail for each side (contact.display_name/email,
   * or account.name/domain) — duplicate_matches itself only holds ids, and a
   * review screen showing two bare uuids is useless for deciding which side
   * to keep.
   */
  @Get("duplicates")
  async duplicates(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = DuplicatesQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { objectType, status } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT dm.id, dm.object_type, dm.record_a_id, dm.record_b_id, dm.match_reason,
                dm.score, dm.status, dm.created_at,
                COALESCE(c1.display_name, a1.name)  AS record_a_label,
                COALESCE(c1.email, a1.domain)        AS record_a_detail,
                COALESCE(c2.display_name, a2.name)  AS record_b_label,
                COALESCE(c2.email, a2.domain)        AS record_b_detail
           FROM duplicate_matches dm
           LEFT JOIN contacts c1 ON dm.object_type = 'contact' AND c1.id = dm.record_a_id
           LEFT JOIN accounts a1 ON dm.object_type = 'account' AND a1.id = dm.record_a_id
           LEFT JOIN contacts c2 ON dm.object_type = 'contact' AND c2.id = dm.record_b_id
           LEFT JOIN accounts a2 ON dm.object_type = 'account' AND a2.id = dm.record_b_id
          WHERE dm.status = $1 AND ($2::text IS NULL OR dm.object_type = $2)
          ORDER BY dm.created_at DESC`,
        [status, objectType ?? null],
      );
      return { duplicates: rows };
    });
  }

  @Post("duplicates/:id/dismiss")
  async dismiss(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows: [row] } = await client.query(
        `UPDATE duplicate_matches SET status = 'dismissed' WHERE id = $1 AND status = 'pending'
         RETURNING id`,
        [id],
      );
      if (!row) throw new NotFoundException("duplicate candidate not found or already resolved");
      return { dismissed: true };
    });
  }

  @Get()
  async mergeLog(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = MergeLogQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, object_type, survivor_id, victim_id, field_decisions, reassigned_deals,
                performed_by, performed_at, revert_deadline_at, reverted_at, reverted_by
           FROM merge_log
          WHERE $1::text IS NULL OR object_type = $1
          ORDER BY performed_at DESC
          LIMIT 100`,
        [parsed.data.objectType ?? null],
      );
      return { merges: rows };
    });
  }

  /**
   * Perform a merge: survivor absorbs victim's fields per `fieldDecisions`,
   * additively merges facts/external_ids (never blanks — same rule as
   * upsertLead's fact merge), repoints the victim's deals onto the survivor,
   * and tombstones the victim rather than deleting it.
   */
  @Post()
  async merge(@Req() req: PrincipalRequest, @OrgId() orgId: string, @Body() body: unknown) {
    const parsed = PerformMergeBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { objectType, survivorId, victimId, fieldDecisions } = parsed.data;
    if (survivorId === victimId) {
      throw new BadRequestException("survivor and victim must be different records");
    }
    const table = TABLE[objectType];
    const dealFk = DEAL_FK[objectType];
    const actorId = actorUserId(req);

    return this.db.withOrg(orgId, async (client) => {
      const { rows: [survivor] } = await client.query(
        `SELECT * FROM ${table} WHERE id = $1 AND status <> 'merged'`,
        [survivorId],
      );
      if (!survivor) throw new NotFoundException("survivor not found (or already merged away)");
      const { rows: [victim] } = await client.query(
        `SELECT * FROM ${table} WHERE id = $1 AND status <> 'merged'`,
        [victimId],
      );
      if (!victim) throw new NotFoundException("victim not found (or already merged away)");

      for (const key of Object.keys(fieldDecisions)) {
        if (!MERGE_FIELDS[objectType].includes(key)) {
          throw new BadRequestException(`"${key}" is not a mergeable field on ${objectType}`);
        }
      }

      // Snapshot BEFORE mutating — this is what a revert restores.
      const survivorSnapshot = { ...survivor };

      const setClauses: string[] = [];
      const params: unknown[] = [survivorId];
      for (const [key, side] of Object.entries(fieldDecisions)) {
        if (side !== "victim") continue;
        params.push(victim[key]);
        setClauses.push(`${key} = $${params.length}`);
      }
      params.push(JSON.stringify(victim.facts ?? {}));
      setClauses.push(`facts = facts || $${params.length}::jsonb`);
      params.push(JSON.stringify(victim.external_ids ?? {}));
      setClauses.push(`external_ids = external_ids || $${params.length}::jsonb`);
      params.push(victim.last_activity_at);
      setClauses.push(`last_activity_at = GREATEST(last_activity_at, $${params.length}::timestamptz)`);

      await client.query(
        `UPDATE ${table} SET ${setClauses.join(", ")} WHERE id = $1`,
        params,
      );

      const { rows: reassigned } = await client.query<{ id: string }>(
        `UPDATE deals SET ${dealFk} = $1 WHERE ${dealFk} = $2 RETURNING id`,
        [survivorId, victimId],
      );

      await client.query(
        `UPDATE ${table} SET status = 'merged', merged_into_id = $1 WHERE id = $2`,
        [survivorId, victimId],
      );

      const revertDeadline = new Date(Date.now() + REVERT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const { rows: [logRow] } = await client.query<{ id: string }>(
        `INSERT INTO merge_log
           (org_id, object_type, survivor_id, victim_id, field_decisions,
            survivor_snapshot, victim_snapshot, reassigned_deals, performed_by, revert_deadline_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10)
         RETURNING id`,
        [
          orgId,
          objectType,
          survivorId,
          victimId,
          JSON.stringify(fieldDecisions),
          JSON.stringify(survivorSnapshot),
          JSON.stringify(victim),
          JSON.stringify(reassigned.map((r) => r.id)),
          actorId,
          revertDeadline,
        ],
      );

      await client.query(
        `UPDATE duplicate_matches SET status = 'merged', resolved_merge_id = $1
          WHERE object_type = $2
            AND ((record_a_id = $3 AND record_b_id = $4) OR (record_a_id = $4 AND record_b_id = $3))`,
        [logRow.id, objectType, survivorId, victimId],
      );

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'merge.perform', $3, $4, $5::jsonb)`,
        [orgId, actorId ?? "unknown", objectType, survivorId, JSON.stringify({ victimId, mergeLogId: logRow.id })],
      );

      return { mergeId: logRow.id, survivorId, victimId, reassignedDeals: reassigned.length };
    });
  }

  /**
   * Undo a merge inside its window: restores the survivor's overwritten
   * fields from the pre-merge snapshot, un-tombstones the victim, and
   * repoints its deals back. Rejected once `revert_deadline_at` has passed —
   * the snapshot is not deleted, but honouring it indefinitely would let a
   * revert silently undo work done on the survivor since the merge.
   */
  @Post(":id/revert")
  async revert(@Req() req: PrincipalRequest, @OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    const actorId = actorUserId(req);

    return this.db.withOrg(orgId, async (client) => {
      const { rows: [log] } = await client.query(
        `SELECT * FROM merge_log WHERE id = $1`,
        [id],
      );
      if (!log) throw new NotFoundException("merge not found");
      if (log.reverted_at) throw new ConflictException("this merge was already reverted");
      if (new Date(log.revert_deadline_at).getTime() < Date.now()) {
        throw new ConflictException(
          `the ${REVERT_WINDOW_DAYS}-day revert window for this merge has passed`,
        );
      }

      const table = TABLE[log.object_type as ObjectType];
      const dealFk = DEAL_FK[log.object_type as ObjectType];
      const snapshot = log.survivor_snapshot as Record<string, unknown>;

      const restorable = [...MERGE_FIELDS[log.object_type as ObjectType], "facts", "external_ids", "last_activity_at"];
      const setClauses: string[] = [];
      const params: unknown[] = [log.survivor_id];
      for (const key of restorable) {
        params.push(key === "facts" || key === "external_ids" ? JSON.stringify(snapshot[key]) : snapshot[key]);
        setClauses.push(
          key === "facts" || key === "external_ids"
            ? `${key} = $${params.length}::jsonb`
            : `${key} = $${params.length}`,
        );
      }
      await client.query(`UPDATE ${table} SET ${setClauses.join(", ")} WHERE id = $1`, params);

      await client.query(
        `UPDATE ${table} SET status = 'active', merged_into_id = NULL WHERE id = $1`,
        [log.victim_id],
      );

      const reassignedDeals = (log.reassigned_deals as string[]) ?? [];
      if (reassignedDeals.length > 0) {
        await client.query(
          `UPDATE deals SET ${dealFk} = $1 WHERE id = ANY($2::uuid[])`,
          [log.victim_id, reassignedDeals],
        );
      }

      await client.query(
        `UPDATE merge_log SET reverted_at = now(), reverted_by = $2 WHERE id = $1`,
        [id, actorId],
      );
      await client.query(
        `UPDATE duplicate_matches SET status = 'pending', resolved_merge_id = NULL WHERE resolved_merge_id = $1`,
        [id],
      );

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'merge.revert', $3, $4, $5::jsonb)`,
        [orgId, actorId ?? "unknown", log.object_type, log.survivor_id, JSON.stringify({ mergeLogId: id })],
      );

      return { reverted: true, survivorId: log.survivor_id, victimId: log.victim_id };
    });
  }
}
