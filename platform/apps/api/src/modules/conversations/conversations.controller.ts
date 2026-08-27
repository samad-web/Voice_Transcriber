import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ConversationListQuery, ConversationPatch } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, scopeFilter, type CrmRecordScope } from "../../common/crm-scope";
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
 * is a deliberately SEPARATE, narrow controller — one recipient read from the
 * conversation itself, a signed-in human required, off by default behind
 * `WHATSAPP_SENDING_ENABLED`, capped per day — so this file's claim stays
 * literally true rather than becoming a stale comment the day sending
 * shipped. Safety rule 3 is a property of that other controller's shape, not
 * of this file pretending sending doesn't exist.
 */
const CONVERSATION_COLUMNS = `c.id, c.workspace_id, c.channel, c.peer_address, c.peer_label,
  c.contact_id, c.status, c.assigned_user_id, c.messaging_channel_id,
  c.last_message_at, c.last_inbound_at, c.unread_count, c.created_at, c.updated_at`;

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
          WHERE c.id = $1 ${scoped ? `AND ${scoped}` : ""}`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!conversation) throw new NotFoundException("conversation not found");

      const { rows: messages } = await client.query(
        `SELECT id, direction, channel, status, from_address, to_address,
                subject, body, provider, external_id, error, sent_by_user_id, occurred_at
           FROM conversation_messages
          WHERE conversation_id = $1
          ORDER BY occurred_at ASC, created_at ASC
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
    // open — and therefore still in the default inbox filter — until somebody
    // says it is finished.
    if (patch.markRead) sets.push("unread_count = 0");

    if (sets.length === 0) throw new BadRequestException("nothing to update");

    return this.db.withOrg(orgId, async (client) => {
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
}
