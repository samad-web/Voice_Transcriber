import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { ConversationListQuery, ConversationPatch } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, scopeFilter, type CrmRecordScope } from "../../common/crm-scope";
import { assertInOrg, assertMembers } from "../../common/org-references";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

/**
 * The inbox (migrations 0055/0056).
 *
 * Gated on the `conversation` object type, which joined PermissionObjectType
 * with this change; 0055 seeds every system role's conversation grants to
 * match its contact grants, so no existing user is locked out the day these
 * routes appear.
 *
 * ── THERE IS NO SEND ROUTE HERE, ON PURPOSE ─────────────────────────────
 *
 * Reading, routing, claiming and closing are all this controller does.
 * WhatsApp sending (Kailash gap Milestone 3, `whatsapp-send.controller.ts`)
 * is a deliberately SEPARATE, narrow controller - one recipient read from the
 * conversation itself, a signed-in human required, off by default behind
 * `WHATSAPP_SENDING_ENABLED`, capped per day - so this file's claim stays
 * literally true rather than becoming a stale comment the day sending
 * shipped. Safety rule 3 is a property of that other controller's shape, not
 * of this file pretending sending doesn't exist.
 */
const CONVERSATION_COLUMNS = `c.id, c.workspace_id, c.channel, c.peer_address, c.peer_label,
  c.contact_id, c.status, c.assigned_user_id, c.messaging_channel_id,
  c.last_message_at, c.last_inbound_at, c.unread_count, c.created_at, c.updated_at,
  /*
   * The PROVIDER behind the thread, for the composer's 24-hour window notice
   * (@aura/shared messagingWindow). It is the provider's restriction, not the
   * medium's - WhatsApp through a Business Solution Provider has the window,
   * a relay bridging a personal handset does not - so the channel alone
   * cannot answer it and the console must be told which one this is.
   *
   * A LEFT JOIN that was already here for contacts, extended rather than a
   * second query: the inbox list is the one page people sit and watch, and it
   * runs Mumbai->Seoul.
   */
  mc.provider AS channel_provider,
  /*
   * Has this person asked us to stop (migration 0100)? EXISTS rather than a
   * join, so a released opt-out contributes nothing and the partial index
   * messaging_opt_outs_active is the one consulted.
   *
   * No backticks anywhere in these comments: they sit INSIDE a template
   * literal, and one would end the SQL string mid-sentence.
   *
   * The composer needs it because the send route REFUSES, and a Send button
   * that looks armed and then 403s is worse than one that was never offered.
   */
  EXISTS (
    SELECT 1 FROM messaging_opt_outs o
     WHERE o.org_id = c.org_id AND o.channel = c.channel
       AND o.peer_address = c.peer_address
       AND o.level = 'certain' AND o.released_at IS NULL
  ) AS opted_out`;

@Controller("conversations")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class ConversationsController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequireCrmPermission("conversation", "view")
  async list(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = ConversationListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const q = parsed.data;

    const where: string[] = ["c.org_id = $1"];
    const params: unknown[] = [orgId];
    const add = (sql: string, value: unknown): void => {
      params.push(value);
      where.push(sql.replace("$?", `$${params.length}`));
    };

    if (q.status) add("c.status = $?", q.status);
    if (q.channel) add("c.channel = $?", q.channel);
    if (q.assignedUserId) add("c.assigned_user_id = $?", q.assignedUserId);
    if (q.unmatchedOnly) where.push("c.contact_id IS NULL");
    // One person's threads - the contact page's reverse lookup (doc 23, H2).
    if (q.contactId) add("c.contact_id = $?", q.contactId);
    if (q.search) {
      // Peer address and label only. NOT message bodies: an inbox search that
      // reaches into correspondence is a different feature with a different
      // permission question, and a LIKE over every body is a sequential scan
      // of the largest table here.
      // Pushed directly rather than through add(): the clause needs the SAME
      // parameter twice, and add() substitutes only the first `$?`.
      params.push(`%${q.search}%`);
      where.push(
        `(c.peer_address ILIKE $${params.length} OR c.peer_label ILIKE $${params.length})`,
      );
    }

    const owned = scopeFilter("conversation", recordScope, "c");
    if (owned) add(owned.sql, owned.value);

    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT ${CONVERSATION_COLUMNS},
                k.display_name AS contact_name
           FROM conversations c
           LEFT JOIN contacts k ON k.id = c.contact_id
           LEFT JOIN messaging_channels mc ON mc.id = c.messaging_channel_id
          WHERE ${where.join(" AND ")}
          ORDER BY c.last_message_at DESC NULLS LAST
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, q.limit, q.offset],
      );
      const {
        rows: [count],
      } = await client.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM conversations c WHERE ${where.join(" AND ")}`,
        params,
      );
      return {
        conversations: rows,
        total: Number(count?.total ?? 0),
        limit: q.limit,
        offset: q.offset,
      };
    });
  }

  @Get(":id")
  @RequireCrmPermission("conversation", "view")
  async detail(
    @OrgId() orgId: string,
    @Param("id", new ParseUUIDPipe()) id: string,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      const scoped = scopeClause("conversation", recordScope, 2, "c");
      const {
        rows: [conversation],
      } = await client.query(
        `SELECT ${CONVERSATION_COLUMNS}, k.display_name AS contact_name
           FROM conversations c
           LEFT JOIN contacts k ON k.id = c.contact_id
           LEFT JOIN messaging_channels mc ON mc.id = c.messaging_channel_id
          WHERE c.id = $1 ${scoped ? `AND ${scoped}` : ""}`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!conversation) throw new NotFoundException("conversation not found");

      // `sent_by_name` so a reply reads "Logesh sent a WhatsApp message" on the
      // contact's activity feed rather than an id - the join is to `users`,
      // which the tenant already reads for every interaction timeline.
      const { rows: messages } = await client.query(
        `SELECT m.id, m.direction, m.channel, m.status, m.from_address, m.to_address,
                m.subject, m.body, m.provider, m.external_id, m.error, m.sent_by_user_id,
                u.name AS sent_by_name, m.occurred_at
           FROM conversation_messages m
           LEFT JOIN users u ON u.id = m.sent_by_user_id
          WHERE m.conversation_id = $1
          ORDER BY m.occurred_at ASC, m.created_at ASC
          LIMIT 500`,
        [id],
      );
      return { conversation, messages };
    });
  }

  @Patch(":id")
  @RequireCrmPermission("conversation", "edit")
  async update(
    @OrgId() orgId: string,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = ConversationPatch.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const patch = parsed.data;

    const sets: string[] = [];
    const params: unknown[] = [id];
    const set = (sql: string, value: unknown): void => {
      params.push(value);
      sets.push(sql.replace("$?", `$${params.length}`));
    };

    if (patch.status !== undefined) set("status = $?", patch.status);
    if (patch.assignedUserId !== undefined) set("assigned_user_id = $?", patch.assignedUserId);
    if (patch.contactId !== undefined) set("contact_id = $?", patch.contactId);
    // Reading is not closing: markRead only zeroes the badge. A thread stays
    // open - and therefore still in the default inbox filter - until somebody
    // says it is finished.
    if (patch.markRead) sets.push("unread_count = 0");

    if (sets.length === 0) throw new BadRequestException("nothing to update");

    return this.db.withOrg(orgId, async (client) => {
      // Claiming a thread onto a contact, or assigning it, must name this org's
      // contact and a member of this org - foreign-key checks ignore RLS and
      // `users` has none (doc 23, A1/A2).
      await assertInOrg(client, orgId, { contactId: patch.contactId });
      await assertMembers(client, orgId, { assignedUserId: patch.assignedUserId });

      const scoped = scopeClause("conversation", recordScope, params.length + 1);
      if (scoped) params.push(recordScope.userId);
      const {
        rows: [updated],
      } = await client.query(
        `UPDATE conversations SET ${sets.join(", ")}
          WHERE id = $1 ${scoped ? `AND ${scoped}` : ""}
        RETURNING id, status, assigned_user_id, contact_id, unread_count`,
        params,
      );
      if (!updated) throw new NotFoundException("conversation not found");
      return updated;
    });
  }

  /**
   * Undo an opt-out (migration 0100), because the customer said otherwise.
   *
   * ── WHY THIS ROUTE HAS TO EXIST ─────────────────────────────────────────
   *
   * `whatsapp-send.controller.ts` refuses to send to somebody who asked to
   * stop, and its refusal tells the rep an owner or manager can release it. A
   * promise like that with no endpoint behind it is worse than no promise: the
   * rep reads a way out, cannot find it, and the next move is somebody editing
   * the database by hand.
   *
   * ── WHY OWNER/MANAGER AND NOT `conversation:edit` ───────────────────────
   *
   * Everything else on this controller is a rep's day job. This one reverses a
   * customer's explicit instruction, and the reason to reverse it always
   * happens OUTSIDE the system - the customer said something on a call, or in
   * person. Somebody has to be accountable for asserting that, and it should
   * not be the same person who wants to send the message.
   *
   * ── WHY IT DOES NOT DELETE THE ROW ──────────────────────────────────────
   *
   * See the migration header. The question people ask afterwards is "did they
   * ever ask us to stop?", and a deleted row cannot answer it. The release is
   * an UPDATE stamping who and when, and the schema has no DELETE grant to
   * make that the only available shape.
   */
  @Post(":id/opt-out/release")
  @UseGuards(OwnerRoleGuard)
  @RequireOwnerRole("owner", "manager")
  async releaseOptOut(
    @OrgId() orgId: string,
    @Param("id", new ParseUUIDPipe()) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const userId = z.string().uuid().safeParse(req.principal?.userId);
    if (!userId.success) {
      // The schema's CHECK requires a release to name its actor, so a caller
      // with no seat of its own cannot perform one. Refused here with a
      // sentence rather than at the database with a constraint violation.
      throw new ForbiddenException(
        "releasing an opt-out needs a signed-in user - this caller has no seat of its own",
      );
    }

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [convo],
      } = await client.query<{ channel: string; peer_address: string }>(
        `SELECT channel, peer_address FROM conversations WHERE id = $1`,
        [id],
      );
      if (!convo) throw new NotFoundException("conversation not found");

      const {
        rows: [released],
      } = await client.query<{ id: string; level: string }>(
        `UPDATE messaging_opt_outs
            SET released_at = now(), released_by = $4, updated_at = now()
          WHERE org_id = $1 AND channel = $2 AND peer_address = $3
            AND released_at IS NULL
        RETURNING id, level`,
        [orgId, convo.channel, convo.peer_address, userId.data],
      );
      // Nothing to release is not an error - two managers clicking the same
      // button is a race, not a mistake, and 404ing the second one would make
      // the console show a failure for an action that succeeded.
      if (!released) return { released: false };

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'conversation.opt_out_released', 'conversation', $3)`,
        [orgId, userId.data, id],
      );
      return { released: true, level: released.level };
    });
  }
}
