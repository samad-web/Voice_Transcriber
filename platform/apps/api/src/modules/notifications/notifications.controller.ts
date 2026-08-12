import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
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

const ListQuery = z.object({
  unread: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

/**
 * The signed-in user's own notifications (migration 0048).
 *
 * ── NO CRM PERMISSION GUARD, ON PURPOSE ───────────────────────────────────
 *
 * `CrmPermissionsGuard` answers "may this role touch contacts / deals /
 * tasks". None of those is the question here. A notification is addressed to
 * one person and it is theirs to read whatever their role is — a viewer who
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

    // A caller with no user identity — the bare admin key — has no "mine".
    // An empty list is the honest answer; everyone's would be a leak.
    const userId = callerUserId(req);
    if (!userId) return { notifications: [], unread: 0 };

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, kind, title, body, link_path, deal_id, contact_id, task_id,
                read_at, created_at
           FROM notifications
          WHERE user_id = $1 ${unread ? "AND read_at IS NULL" : ""}
          ORDER BY created_at DESC
          LIMIT $2`,
        [userId, limit],
      );

      // Counted separately from the page: the badge says how many are unread
      // in total, not how many happened to fit in the last thirty rows.
      const {
        rows: [count],
      } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
        [userId],
      );

      return { notifications: rows, unread: Number(count?.n ?? 0) };
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
          WHERE id = $1 AND user_id = $2 AND read_at IS NULL`,
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
        `UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`,
        [userId],
      );
      return { updated: rowCount ?? 0 };
    });
  }
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
