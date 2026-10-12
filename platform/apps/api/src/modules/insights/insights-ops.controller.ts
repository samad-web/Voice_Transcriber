import {
  BadRequestException,
  Body,
  Controller,
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
import { actorUserId, auditActor } from "../../common/audit-actor";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgRoleGuard, RequireOrgRole } from "../../common/org-role.guard";
import { RequireOwnerRole, OwnerRoleGuard } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const EventsQuery = z.object({
  status: z.enum(["queued", "processed", "rejected"]).optional(),
  resource: z.string().max(40).optional(),
  env: z.enum(["test", "live"]).optional(),
  externalId: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Cursor-based paging (§6.3): the `received_at` of the last row seen. */
  before: z.string().datetime().optional(),
});

const ResolveBody = z.object({
  resolution: z.enum(["created", "mapped", "ignored"]),
  /** For `mapped`: the existing telecaller or team to point the ref at. */
  targetId: z.string().uuid().optional(),
});

/**
 * The Integration Center's server half (§8.8, M6).
 *
 * ── WHO MAY SEE A RAW EVENT ─────────────────────────────────────────────────
 *
 * §6.5: "access to raw events limited to Owner, Admin and Developer". A raw
 * payload is the least redacted thing this tier stores - it is whatever the
 * customer sent, including any `lead_ref` and any custom attributes they chose
 * to include - so the inspector sits behind `org_admin`, the tenant tier that
 * already governs API keys, rather than behind a console persona.
 *
 * That is the spec's "Developer" role as this codebase already expresses it.
 * The repository has three access axes (`memberships.role`, `owner_role`, and
 * the permission grid) and adding a fourth persona for one page would make
 * "why can't Priya see this" a question with four answers - which is the exact
 * argument `permissions.ts` makes for keeping `call` out of the grid.
 *
 * The UNMAPPED QUEUE is different and is owner-persona: resolving it creates
 * people and changes who work is attributed to, which is a management decision
 * rather than an integration one.
 */
@Controller("insights")
@UseGuards(AdminKeyGuard, TenantGuard)
export class InsightsOpsController {
  constructor(private readonly db: DbService) {}

  /**
   * §8.8's event inspector.
   *
   * The payload has `__idx` stripped - it is our own bookkeeping (see
   * `ingest.service.ts`) and showing it to an integrator who is trying to
   * match this against what they sent would be a field they have to ask about.
   */
  @Get("events")
  @UseGuards(OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async events(@OrgId() orgId: string, @Query() query: unknown) {
    const q = EventsQuery.parse(query);
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT e.id, e.resource, e.external_id, e.status, e.env, e.source,
                e.received_at, e.idempotency_key,
                e.payload - '__idx' AS payload,
                k.name AS key_name, k.prefix AS key_prefix,
                r.status AS result_status, r.error, r.fact_table, r.fact_id, r.processed_at
           FROM ingest_events e
           LEFT JOIN api_keys k ON k.id = e.api_key_id
           -- The LATEST attempt only. An event replayed three times has three
           -- results and the inspector's list wants the current verdict; the
           -- detail route returns every attempt.
           LEFT JOIN LATERAL (
             SELECT status, error, fact_table, fact_id, processed_at
               FROM ingest_event_results
              WHERE ingest_event_id = e.id
              ORDER BY attempt DESC
              LIMIT 1
           ) r ON true
          WHERE e.org_id = $1
            AND ($2::text IS NULL OR e.status = $2)
            AND ($3::text IS NULL OR e.resource = $3)
            AND ($4::text IS NULL OR e.env = $4)
            AND ($5::text IS NULL OR e.external_id = $5)
            AND ($6::timestamptz IS NULL OR e.received_at < $6)
          ORDER BY e.received_at DESC
          LIMIT $7`,
        [
          orgId,
          q.status ?? null,
          q.resource ?? null,
          q.env ?? null,
          q.externalId ?? null,
          q.before ?? null,
          q.limit,
        ],
      );
      return {
        events: rows,
        // Cursor, not an offset: an offset over a table that is being appended
        // to re-reads rows the caller already saw.
        nextBefore: rows.length === q.limit ? rows.at(-1)?.received_at : null,
      };
    });
  }

  /** §8.8's ingestion-error list, which is the same data with one filter. */
  @Get("events/errors")
  @UseGuards(OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async errors(@OrgId() orgId: string, @Query("limit") limit?: string) {
    const take = Math.min(Math.max(Number(limit ?? 50) || 50, 1), 200);
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT e.id, e.resource, e.external_id, e.received_at, e.env,
                r.error, r.attempt, r.processed_at
           FROM ingest_event_results r
           JOIN ingest_events e ON e.id = r.ingest_event_id
          WHERE r.org_id = $1 AND r.status = 'rejected'
            AND e.status = 'rejected'
          ORDER BY r.processed_at DESC
          LIMIT $2`,
        [orgId, take],
      );
      // Grouped by reason as well as listed, because "1,400 rejected" is not
      // actionable and "1,400 rejected: unknown telecaller tc_991" is.
      const byReason = new Map<string, number>();
      for (const row of rows) {
        const code = ((row.error as { code?: string } | null)?.code ?? "unknown") as string;
        byReason.set(code, (byReason.get(code) ?? 0) + 1);
      }
      return {
        errors: rows,
        byReason: [...byReason].map(([code, count]) => ({ code, count })).sort((a, b) => b.count - a.count),
      };
    });
  }

  /**
   * Re-queue a rejected event (§8.8's replay).
   *
   * Flips `status` back to `queued` and nothing else - the drain picks it up
   * on its next tick. This is the whole return on an append-only raw store:
   * the fix for "we rejected 1,400 calls because the telecaller did not exist
   * yet" is to create the telecaller and press this, rather than asking the
   * customer to re-send three weeks of data.
   *
   * `status` is the ONE column `ingest_events`' append-only trigger allows to
   * change, so a replay cannot rewrite a payload even by accident.
   */
  @Post("events/:id/replay")
  @UseGuards(OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async replay(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE ingest_events SET status = 'queued'
          WHERE org_id = $1 AND id = $2 AND status = 'rejected'`,
        [orgId, id],
      );
      if (!rowCount) throw new NotFoundException("no rejected event with that id");
      return { requeued: 1 };
    });
  }

  /**
   * Replay every rejected event of a kind, which is what an owner actually
   * wants after resolving an unmapped telecaller.
   *
   * Bounded, deliberately. An unbounded "replay everything" on a tenant with
   * 400,000 rejected rows would hand the drain a backlog that starves live
   * ingestion for an hour, so this does 5,000 at a time and says how many are
   * left - a number the console turns into a "replay the next 5,000" button
   * rather than a spinner that never ends.
   */
  @Post("events/replay-failed")
  @UseGuards(OrgRoleGuard)
  @RequireOrgRole("org_admin")
  async replayFailed(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = z
      .object({ resource: z.string().max(40).optional(), code: z.string().max(60).optional() })
      .safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { resource, code } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE ingest_events e SET status = 'queued'
          WHERE e.id IN (
            SELECT e2.id FROM ingest_events e2
             WHERE e2.org_id = $1 AND e2.status = 'rejected'
               AND ($2::text IS NULL OR e2.resource = $2)
               AND ($3::text IS NULL OR EXISTS (
                     SELECT 1 FROM ingest_event_results r
                      WHERE r.ingest_event_id = e2.id AND r.error->>'code' = $3))
             ORDER BY e2.received_at
             LIMIT 5000)`,
        [orgId, resource ?? null, code ?? null],
      );
      const {
        rows: [left],
      } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM ingest_events
          WHERE org_id = $1 AND status = 'rejected'
            AND ($2::text IS NULL OR resource = $2)`,
        [orgId, resource ?? null],
      );
      return { requeued: rowCount ?? 0, remaining: Number(left?.n ?? 0) };
    });
  }

  /** §7's unmapped queue. */
  @Get("unmapped")
  @UseGuards(OwnerRoleGuard)
  @RequireOwnerRole("owner", "manager")
  async unmapped(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT u.id, u.kind, u.external_ref, u.occurrences, u.first_seen_at, u.last_seen_at,
                e.payload - '__idx' AS sample_payload
           FROM unmapped_refs u
           LEFT JOIN ingest_events e ON e.id = u.last_event_id
          WHERE u.org_id = $1 AND u.resolved_at IS NULL
          ORDER BY u.occurrences DESC, u.last_seen_at DESC
          LIMIT 200`,
        [orgId],
      );
      return { unmapped: rows };
    });
  }

  /**
   * Resolve one unmapped reference (§7's "one-click create or map").
   *
   * Resolving does NOT replay the events itself. The drain re-reads whatever is
   * queued on its next tick, and the rejected ones are re-queued by
   * `replay-failed` - two actions rather than one, because "create this person"
   * and "re-process three weeks of their calls" have very different costs and
   * an owner should get to choose the second deliberately. The response says
   * how many are waiting, so the console can offer it.
   */
  @Post("unmapped/:id/resolve")
  @UseGuards(OwnerRoleGuard)
  @RequireOwnerRole("owner")
  async resolveUnmapped(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
    @Body() body: unknown,
  ) {
    const parsed = ResolveBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { resolution, targetId } = parsed.data;
    const actor = auditActor(req);

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [ref],
      } = await client.query<{ kind: string; external_ref: string }>(
        `SELECT kind, external_ref FROM unmapped_refs
          WHERE org_id = $1 AND id = $2 AND resolved_at IS NULL`,
        [orgId, id],
      );
      if (!ref) throw new NotFoundException("no open unmapped reference with that id");

      if (resolution === "created") {
        // Create the subject with the customer's own id, so the next event
        // that names it resolves. The display name IS the external id until
        // somebody renames it - inventing a friendlier one would be making up
        // a person's name.
        if (ref.kind === "telecaller") {
          await client.query(
            `INSERT INTO telecallers (org_id, external_id, display_name)
                  VALUES ($1, $2, $2)
             ON CONFLICT (org_id, external_id) WHERE external_id IS NOT NULL DO NOTHING`,
            [orgId, ref.external_ref],
          );
        } else {
          await client.query(
            `INSERT INTO teams (org_id, external_id, name) VALUES ($1, $2, $2)
             ON CONFLICT (org_id, lower(name)) DO UPDATE
               SET external_id = COALESCE(teams.external_id, EXCLUDED.external_id)`,
            [orgId, ref.external_ref],
          );
        }
      } else if (resolution === "mapped") {
        if (!targetId) throw new BadRequestException("mapping needs a targetId");
        // Point an EXISTING row at the customer's id. This is the case where
        // the tenant already has "Priya Sharma" from the handset and their
        // dialer calls her `tc_102`.
        const table = ref.kind === "telecaller" ? "telecallers" : "teams";
        const { rowCount } = await client.query(
          `UPDATE ${table} SET external_id = $3, updated_at = now()
            WHERE org_id = $1 AND id = $2
              AND (external_id IS NULL OR external_id = $3)`,
          [orgId, targetId, ref.external_ref],
        );
        if (!rowCount) {
          // Either no such row, or it already carries a DIFFERENT external id.
          // Overwriting that would silently re-point every past fact of
          // whoever owned the old id, which is the reassignment bug 0017 was
          // written to prevent.
          throw new BadRequestException(
            "that record does not exist, or already has a different external id",
          );
        }
      }

      await client.query(
        `UPDATE unmapped_refs
            SET resolved_at = now(), resolution = $3, resolved_by = $4, updated_at = now()
          WHERE org_id = $1 AND id = $2`,
        [orgId, id, resolution, actorUserId(actor)],
      );

      const {
        rows: [waiting],
      } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM ingest_events
          WHERE org_id = $1 AND status = 'rejected'`,
        [orgId],
      );
      return { resolved: resolution, rejectedWaiting: Number(waiting?.n ?? 0) };
    });
  }
}
