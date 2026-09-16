import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { NotificationPreferencesInput } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const ListQuery = z.object({
  unread: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

type Queryable = {
  query: <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>;
};

/**
 * The signed-in user's own notifications (migration 0048).
 *
 * ── NO CRM PERMISSION GUARD, ON PURPOSE ───────────────────────────────────
 *
 * `CrmPermissionsGuard` answers "may this role touch contacts / deals /
 * tasks". None of those is the question here. A notification is addressed to
 * one person and it is theirs to read whatever their role is - a viewer who
 * gets told a deal moved is being told about a deal they can already see, and
 * a role change should not strand somebody's unread list.
 *
 * The scoping that DOES matter is `user_id = <caller>`, applied to every
 * query in this file without exception. RLS gives the org boundary; this
 * predicate gives the person boundary, the same division `tasks?mine=1` uses.
 * There is deliberately no route that reads another user's notifications, not
 * even for an admin: a manager who wants to know what their team is being
 * told should look at the tasks and the deals, which is where the underlying
 * facts live.
 *
 * ── HELD ROWS ARE NOT THERE YET ───────────────────────────────────────────
 *
 * A kind the person chose to get as a digest is written with `deliver_after`
 * at their next digest hour (migration 0109's trigger). Until then it is not
 * in the list, not in the unread count, and not touched by "mark all read" -
 * otherwise clearing the bell at 5pm would silently pre-read the digest that
 * arrives at 9am. The list says how many are held so the panel can say so.
 */
@Controller("notifications")
@UseGuards(AdminKeyGuard, TenantGuard)
export class NotificationsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@OrgId() orgId: string, @Query() query: unknown, @Req() req: PrincipalRequest) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { unread, limit } = parsed.data;

    // A caller with no user identity - the bare admin key - has no "mine".
    // An empty list is the honest answer; everyone's would be a leak.
    const userId = callerUserId(req);
    if (!userId) return { notifications: [], unread: 0, held: 0, nextDeliveryAt: null };

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, kind, title, body, link_path, deal_id, contact_id, task_id,
                read_at, created_at, deliver_after
           FROM notifications
          WHERE user_id = $1 AND deliver_after <= now()
                ${unread ? "AND read_at IS NULL" : ""}
          ORDER BY deliver_after DESC, created_at DESC
          LIMIT $2`,
        [userId, limit],
      );

      // Counted separately from the page: the badge says how many are unread
      // in total, not how many happened to fit in the last thirty rows.
      const {
        rows: [count],
      } = await client.query<{ unread: string; held: string; next_delivery_at: string | null }>(
        `SELECT count(*) FILTER (WHERE deliver_after <= now() AND read_at IS NULL) AS unread,
                count(*) FILTER (WHERE deliver_after > now())                      AS held,
                min(deliver_after) FILTER (WHERE deliver_after > now())            AS next_delivery_at
           FROM notifications
          WHERE user_id = $1`,
        [userId],
      );

      return {
        notifications: rows,
        unread: Number(count?.unread ?? 0),
        held: Number(count?.held ?? 0),
        nextDeliveryAt: count?.next_delivery_at ?? null,
      };
    });
  }

  /** The caller's delivery choice. A person with no row gets everything instantly. */
  @Get("preferences")
  async preferences(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    const userId = requireUser(req);
    return this.db.withOrg(orgId, (client) => readPreferences(client, orgId, userId));
  }

  /**
   * Replace the caller's delivery choice, and apply it to what is already held.
   *
   * Without the second half a change would only reach FUTURE rows: somebody who
   * switches a kind back to instant at 4pm would still wait until 9am for the
   * three that arrived at noon, which reads as the setting not working. So:
   *   - held rows of a kind that is now instant are released immediately;
   *   - held rows of a kind still on digest move to the NEW hour's next slot.
   * Rows already delivered are never pulled back - nothing disappears from the
   * bell because a setting changed.
   */
  @Put("preferences")
  async setPreferences(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const userId = requireUser(req);
    const parsed = NotificationPreferencesInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { digestKinds, digestHour } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      await client.query(
        `INSERT INTO notification_preferences (org_id, user_id, digest_kinds, digest_hour)
         VALUES ($1, $2, $3::text[], $4)
         ON CONFLICT (org_id, user_id) DO UPDATE
            SET digest_kinds = EXCLUDED.digest_kinds,
                digest_hour  = EXCLUDED.digest_hour,
                updated_at   = now()`,
        [orgId, userId, digestKinds, digestHour],
      );
      await client.query(
        `UPDATE notifications
            SET deliver_after = CASE
                  WHEN kind = ANY($2::text[]) THEN notification_next_digest_at($3, $4)
                  ELSE now()
                END
          WHERE user_id = $1 AND deliver_after > now()`,
        [userId, digestKinds, orgId, digestHour],
      );
      return readPreferences(client, orgId, userId);
    });
  }

  @Post(":id/read")
  async markRead(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const userId = requireUser(req);
    return this.db.withOrg(orgId, async (client) => {
      // `user_id = $2` in the WHERE, not just the SELECT: without it, knowing
      // an id would be enough to mark somebody else's notification read.
      const { rowCount } = await client.query(
        `UPDATE notifications SET read_at = now()
          WHERE id = $1 AND user_id = $2 AND read_at IS NULL AND deliver_after <= now()`,
        [id, userId],
      );
      return { updated: rowCount ?? 0 };
    });
  }

  @Post("read-all")
  async markAllRead(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    const userId = requireUser(req);
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE notifications SET read_at = now()
          WHERE user_id = $1 AND read_at IS NULL AND deliver_after <= now()`,
        [userId],
      );
      return { updated: rowCount ?? 0 };
    });
  }
}

async function readPreferences(client: Queryable, orgId: string, userId: string) {
  const {
    rows: [row],
  } = await client.query<{
    digest_kinds: string[] | null;
    digest_hour: number | null;
    next_digest_at: string;
    held: string;
  }>(
    `SELECT p.digest_kinds, p.digest_hour,
            notification_next_digest_at($1, COALESCE(p.digest_hour, 9)) AS next_digest_at,
            (SELECT count(*) FROM notifications n
              WHERE n.user_id = $2 AND n.deliver_after > now()) AS held
       FROM (SELECT 1) one
       LEFT JOIN notification_preferences p ON p.org_id = $1 AND p.user_id = $2`,
    [orgId, userId],
  );
  return {
    digestKinds: row?.digest_kinds ?? [],
    digestHour: row?.digest_hour ?? 9,
    nextDigestAt: row?.next_digest_at ?? null,
    held: Number(row?.held ?? 0),
  };
}

function callerUserId(req: PrincipalRequest): string | null {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}

function requireUser(req: PrincipalRequest): string {
  const userId = callerUserId(req);
  if (!userId) {
    throw new ForbiddenException("notifications belong to a signed-in user");
  }
  return userId;
}
