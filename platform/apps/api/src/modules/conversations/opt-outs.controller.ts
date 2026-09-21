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
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { ThreadViewer, visibleThread } from "../../common/private-threads";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * The person's half of a `probable` opt-out (migrations 0100 and 0109).
 *
 * 0100 records "leave me alone" as probable and blocks nothing, on the grounds
 * that telling an opt-out from an exasperated customer who wants a HUMAN is
 * exactly what the classifier cannot do. This is where a person does it:
 *
 *   confirm  - it WAS a request to stop. Level becomes `certain`, and the send
 *              path starts refusing, the same as if the customer had typed STOP.
 *   dismiss  - it was not. The row leaves the queue and still blocks nothing;
 *              a later plain request is still promoted to `certain` by the
 *              ingest upsert. See 0109 §4 for why this is not a release.
 *
 * ── WHY OWNER/MANAGER ─────────────────────────────────────────────────────
 *
 * The same gate as `POST /conversations/:id/opt-out/release`, for the same
 * reason: whether to keep messaging somebody who may have asked us to stop is
 * a decision somebody must be accountable for, and it should not rest with the
 * rep who wants to send the next message. Confirming is the safe direction and
 * could be looser, but splitting one verdict across two gates would leave a
 * rep able to see the queue and act on only half of it.
 *
 * NOTHING HERE SENDS. Both outcomes only change whether the send path refuses.
 */
@Controller("opt-outs")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@RequireOwnerRole("owner", "manager")
export class OptOutsController {
  constructor(private readonly db: DbService) {}

  /** Probable opt-outs nobody has judged yet, newest first, with what was said. */
  @Get()
  async list(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @ThreadViewer() viewer: string | null,
  ) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    return this.db.withOrg(orgId, async (client) => {
      // ── private threads (0125) ────────────────────────────────────────
      // An opt-out is the ORGANISATION's obligation - a customer who asked one
      // rep's own number to stop has asked the business - so the row is listed
      // here whoever it arrived through. What is NOT listed is the private
      // conversation behind it: the thread link and the message text only
      // resolve when the reviewer may read that thread, and `source_private`
      // says why they are missing rather than leaving a blank that looks like
      // a bug.
      //
      // LATERAL + LIMIT 1 because a customer can now have several threads (one
      // shared, one per rep's personal number): a plain join would list the
      // opt-out once per thread.
      const { rows } = await client.query(
        `SELECT o.id, o.channel, o.peer_address, o.created_at,
                c.id AS conversation_id, c.peer_label, c.contact_id,
                m.body AS message_body, m.created_at AS message_at,
                (o.source_message_id IS NOT NULL AND m.id IS NULL) AS source_private
           FROM messaging_opt_outs o
           LEFT JOIN LATERAL (
             SELECT cv.id, cv.peer_label, cv.contact_id
               FROM conversations cv
              WHERE cv.org_id = o.org_id AND cv.channel = o.channel
                AND cv.peer_address = o.peer_address
                AND ${visibleThread("cv", 3)}
              ORDER BY cv.private_to_user_id NULLS FIRST, cv.last_message_at DESC NULLS LAST
              LIMIT 1
           ) c ON true
           LEFT JOIN conversation_messages m
                  ON m.id = o.source_message_id
                 AND EXISTS (
                   SELECT 1 FROM conversations src
                    WHERE src.id = m.conversation_id AND ${visibleThread("src", 3)}
                 )
          WHERE o.org_id = $1 AND o.level = 'probable'
            AND o.released_at IS NULL AND o.reviewed_at IS NULL
          ORDER BY o.created_at DESC
          LIMIT $2`,
        [orgId, parsed.data.limit, viewer],
      );
      const {
        rows: [count],
      } = await client.query<{ n: string }>(
        `SELECT count(*) AS n FROM messaging_opt_outs
          WHERE org_id = $1 AND level = 'probable'
            AND released_at IS NULL AND reviewed_at IS NULL`,
        [orgId],
      );
      return { items: rows, total: Number(count?.n ?? 0) };
    });
  }

  @Post(":id/confirm")
  async confirm(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const userId = requireUser(req);
    return this.db.withOrg(orgId, async (client) => {
      // The same WHERE as the list: only a live, unjudged probable. Two
      // managers acting on one row is a race, not an error - the second gets
      // `false` and the console simply drops the row.
      const { rows } = await client.query<{ id: string }>(
        `UPDATE messaging_opt_outs
            SET level = 'certain', reviewed_at = now(), reviewed_by = $3, updated_at = now()
          WHERE id = $1 AND org_id = $2 AND level = 'probable'
            AND released_at IS NULL AND reviewed_at IS NULL
        RETURNING id`,
        [id, orgId, userId],
      );
      if (rows.length === 0) return { confirmed: false };
      await audit(client, orgId, userId, "conversation.opt_out_confirmed", id);
      return { confirmed: true };
    });
  }

  @Post(":id/dismiss")
  async dismiss(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const userId = requireUser(req);
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `UPDATE messaging_opt_outs
            SET reviewed_at = now(), reviewed_by = $3, updated_at = now()
          WHERE id = $1 AND org_id = $2 AND level = 'probable'
            AND released_at IS NULL AND reviewed_at IS NULL
        RETURNING id`,
        [id, orgId, userId],
      );
      if (rows.length === 0) return { dismissed: false };
      await audit(client, orgId, userId, "conversation.opt_out_dismissed", id);
      return { dismissed: true };
    });
  }
}

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

function audit(client: Queryable, orgId: string, userId: string, action: string, optOutId: string) {
  return client.query(
    `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
     VALUES ($1, 'user', $2, $3, 'messaging_opt_out', $4)`,
    [orgId, userId, action, optOutId],
  );
}

/** A verdict is stamped with who gave it, so a caller with no seat cannot give one. */
function requireUser(req: PrincipalRequest): string {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  if (!parsed.success) {
    throw new ForbiddenException("reviewing an opt-out needs a signed-in user");
  }
  return parsed.data;
}
