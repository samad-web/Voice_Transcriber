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
import { InteractionInput } from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { enqueueAutomationEventSafely } from "../automation/enqueue";

const ListQuery = z.object({
  type: z.string().max(40).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const INTERACTION_COLUMNS = `i.id, i.type, i.direction, i.contact_id, i.account_id, i.deal_id,
  i.call_id, i.subject, i.body, i.occurred_at, i.duration_s, i.actor_user_id,
  COALESCE(u.name, i.actor_label) AS actor, i.metadata, i.created_at`;

/**
 * The unified interaction timeline (Track A2, migration 0040).
 *
 * Routes are NESTED under the object they describe — `GET /v1/contacts/:id/
 * interactions` rather than `GET /v1/interactions?contactId=` — because that
 * is what makes the permission gate correct. `CrmPermissionsGuard` reads
 * STATIC decorator metadata, so a single flat endpoint filtered by query
 * param could not decide whether to demand `contact:view` or `deal:view`; the
 * parent in the path decides it unambiguously.
 *
 * Shares the `contacts`/`accounts`/`deals` prefixes from a separate
 * controller, the same way NotesController shares `calls` with
 * CallsController — the timeline is one concern and belongs in one file, even
 * though it hangs off three parents.
 *
 * Gated on the PARENT's `view`, not on some interaction-level permission:
 * `PermissionObjectType` is `contact|account|deal` only, and a contact's
 * timeline is a fact about that contact. Note the rows carry `deal_id`, so a
 * role with `contact:view` but not `deal:view` learns that some deal exists —
 * an id and nothing more, no deal fields — which is the same exposure
 * `contacts.account_id` already carries on the contact row itself.
 */
@Controller()
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class InteractionsController {
  constructor(private readonly db: DbService) {}

  @Get("contacts/:id/interactions")
  @RequireCrmPermission("contact", "view")
  async forContact(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ) {
    return this.list(orgId, "contacts", id, "i.contact_id = $1", query);
  }

  @Get("deals/:id/interactions")
  @RequireCrmPermission("deal", "view")
  async forDeal(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ) {
    return this.list(orgId, "deals", id, "i.deal_id = $1", query);
  }

  /**
   * An account's timeline is its own rows PLUS every row belonging to a
   * contact that works there — an account with no direct interactions but
   * three busy contacts should not look dormant. Resolved through the
   * subquery at read time rather than denormalised onto `interactions.
   * account_id`, so re-parenting a contact (a merge, an admin edit) moves its
   * history with it automatically.
   */
  @Get("accounts/:id/interactions")
  @RequireCrmPermission("account", "view")
  async forAccount(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Query() query: unknown,
  ) {
    return this.list(
      orgId,
      "accounts",
      id,
      `(i.account_id = $1 OR i.contact_id IN (SELECT id FROM contacts WHERE account_id = $1))`,
      query,
    );
  }

  @Post("contacts/:id/interactions")
  @RequireCrmPermission("contact", "edit")
  async logOnContact(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    return this.create(orgId, "contacts", id, { contactId: id }, body, req);
  }

  @Post("accounts/:id/interactions")
  @RequireCrmPermission("account", "edit")
  async logOnAccount(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    return this.create(orgId, "accounts", id, { accountId: id }, body, req);
  }

  /**
   * Logging against a deal also stamps the deal's contact, so the note shows
   * up on that person's timeline too — which is what a rep means by "log a
   * call with Priya about the Acme deal".
   */
  @Post("deals/:id/interactions")
  @RequireCrmPermission("deal", "edit")
  async logOnDeal(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    return this.create(orgId, "deals", id, { dealId: id }, body, req);
  }

  // ── shared implementation ────────────────────────────────────────────────

  private async list(
    orgId: string,
    parentTable: "contacts" | "accounts" | "deals",
    parentId: string,
    scope: string,
    query: unknown,
  ) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { type, limit, offset } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      await assertExists(client, parentTable, parentId);

      const params: unknown[] = [parentId];
      let where = scope;
      if (type) {
        params.push(type);
        where += ` AND i.type = $${params.length}`;
      }

      params.push(limit, offset);
      const { rows } = await client.query(
        `SELECT ${INTERACTION_COLUMNS}, count(*) OVER() AS total
           FROM interactions i
           LEFT JOIN users u ON u.id = i.actor_user_id
          WHERE ${where}
          ORDER BY i.occurred_at DESC
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return {
        interactions: rows.map(({ total: _total, ...row }) => row),
        total: rows.length > 0 ? Number(rows[0].total) : 0,
        limit,
        offset,
      };
    });
  }

  private async create(
    orgId: string,
    parentTable: "contacts" | "accounts" | "deals",
    parentId: string,
    attach: { contactId?: string; accountId?: string; dealId?: string },
    body: unknown,
    req: PrincipalRequest,
  ) {
    // The parent comes from the PATH, so the body may not also name one —
    // otherwise `POST /contacts/A/interactions {contactId: B}` would write to
    // B while having been permission-checked against A.
    const parsed = InteractionInput.safeParse({ ...(body as object), ...attach });
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      await assertExists(client, parentTable, parentId);

      // Logging against a deal fills in that deal's contact; see logOnDeal.
      let contactId = p.contactId ?? null;
      if (!contactId && parentTable === "deals") {
        const {
          rows: [deal],
        } = await client.query<{ contact_id: string | null }>(
          `SELECT contact_id FROM deals WHERE id = $1`,
          [parentId],
        );
        contactId = deal?.contact_id ?? null;
      }

      const {
        rows: [interaction],
      } = await client.query(
        `INSERT INTO interactions
           (org_id, type, direction, contact_id, account_id, deal_id, subject, body,
            occurred_at, duration_s, actor_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()), $10, $11)
         RETURNING id, type, direction, contact_id, account_id, deal_id, subject, body,
                   occurred_at, duration_s, actor_user_id, metadata, created_at`,
        [
          orgId,
          p.type,
          p.direction ?? null,
          contactId,
          p.accountId ?? null,
          p.dealId ?? null,
          p.subject ?? null,
          p.body ?? null,
          p.occurredAt ?? null,
          p.durationS ?? null,
          actorUserId(req),
        ],
      );

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', 'dev-admin', 'interaction.create', $2, $3)`,
        [orgId, parentTable.replace(/s$/, ""), parentId],
      );

      // Any interaction is activity: keep the object's sort key honest so a
      // freshly-noted deal rises to the top of an activity-ordered list.
      await client.query(
        `UPDATE ${parentTable} SET last_activity_at = GREATEST(last_activity_at, $2::timestamptz)
          WHERE id = $1`,
        [parentId, interaction.occurred_at],
      );

      await enqueueAutomationEventSafely(
        client,
        orgId,
        "interaction.logged",
        "interaction",
        interaction.id,
        {
          dealId: interaction.deal_id ?? null,
          contactId: interaction.contact_id ?? null,
          accountId: interaction.account_id ?? null,
          interactionType: interaction.type,
        },
      );

      return { interaction };
    });
  }
}

/**
 * FK violations bypass RLS and surface as a 500, so confirm the parent is
 * visible in THIS org first — same reasoning (and same fix) as
 * NotesController's call check.
 */
async function assertExists(
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rowCount: number | null }> },
  table: "contacts" | "accounts" | "deals",
  id: string,
): Promise<void> {
  const found = await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  if (!found.rowCount) throw new NotFoundException(`${table.replace(/s$/, "")} not found`);
}

/**
 * `interactions.actor_user_id` is a real uuid FK, but the dev admin-key path
 * leaves `principal.userId` as the literal string "admin-key" — inserting
 * that raises 22P02. Same validate-or-null helper merge.controller.ts needs
 * for `merge_log.performed_by`.
 */
function actorUserId(req: PrincipalRequest): string | null {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}
