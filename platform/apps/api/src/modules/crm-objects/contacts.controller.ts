import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const ListQuery = z.object({
  accountId: z.string().uuid().optional(),
  q: z.string().max(200).optional(),
  sort: z.enum(["activity", "created", "name"]).default("activity"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const CreateContactBody = z.object({
  workspaceId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  displayName: z.string().min(1).max(200),
  firstName: z.string().max(120).optional(),
  lastName: z.string().max(120).optional(),
  email: z.string().email().max(200).optional(),
  title: z.string().max(120).optional(),
});

const UpdateContactBody = z.object({
  displayName: z.string().min(1).max(200).optional(),
  firstName: z.string().max(120).nullable().optional(),
  lastName: z.string().max(120).nullable().optional(),
  email: z.string().email().max(200).nullable().optional(),
  title: z.string().max(120).nullable().optional(),
  accountId: z.string().uuid().nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

const CONTACT_COLUMNS = `id, workspace_id, account_id, first_name, last_name, display_name, email,
  phone_prefix, phone_last3, title, external_ids, owner_user_id, facts, status, merged_into_id,
  call_count, last_activity_at, created_at, updated_at`;

/**
 * Contacts (people) — CRM Phase 1, E0.1. Strangler-fig: nothing here reads
 * from or writes to `leads`/`call_facts`, and this module is not linked into
 * web nav yet. See the Phase 1 plan.
 */
@Controller("contacts")
@UseGuards(AdminKeyGuard, TenantGuard)
export class ContactsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@OrgId() orgId: string, @Query() query: unknown) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { accountId, q, sort, limit, offset } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const where = [`status <> 'merged'`];
      const params: unknown[] = [];
      const add = (clause: string, value: unknown) => {
        params.push(value);
        where.push(clause.replace("$?", `$${params.length}`));
      };

      if (accountId) add("account_id = $?", accountId);
      if (q) {
        params.push(`%${q}%`);
        const p = `$${params.length}`;
        where.push(`(display_name ILIKE ${p} OR email ILIKE ${p})`);
      }

      const ORDER = {
        activity: "last_activity_at DESC",
        created: "created_at DESC",
        name: "display_name ASC",
      } as const;

      params.push(limit, offset);
      const { rows } = await client.query(
        `SELECT ${CONTACT_COLUMNS}, count(*) OVER()::int AS total_count
           FROM contacts
          WHERE ${where.join(" AND ")}
          ORDER BY ${ORDER[sort]}
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return {
        contacts: rows.map(({ total_count: _t, ...c }) => c),
        total: rows[0]?.total_count ?? 0,
        limit,
        offset,
      };
    });
  }

  @Get(":id")
  async detail(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [contact],
      } = await client.query(`SELECT ${CONTACT_COLUMNS} FROM contacts WHERE id = $1`, [id]);
      if (!contact) throw new NotFoundException("contact not found");
      return { contact };
    });
  }

  /** Every deal this contact is on, most recently active first. */
  @Get(":id/deals")
  async deals(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [contact],
      } = await client.query(`SELECT id FROM contacts WHERE id = $1`, [id]);
      if (!contact) throw new NotFoundException("contact not found");

      const { rows: deals } = await client.query(
        `SELECT id, pipeline_id, name, stage, status, amount, last_activity_at, created_at
           FROM deals WHERE contact_id = $1
          ORDER BY last_activity_at DESC`,
        [id],
      );
      return { deals };
    });
  }

  @Post()
  async create(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = CreateContactBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [contact],
      } = await client.query(
        `INSERT INTO contacts
           (org_id, workspace_id, account_id, first_name, last_name, display_name, email, title)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${CONTACT_COLUMNS}`,
        [
          orgId,
          p.workspaceId ?? null,
          p.accountId ?? null,
          p.firstName ?? null,
          p.lastName ?? null,
          p.displayName,
          p.email ?? null,
          p.title ?? null,
        ],
      );
      await this.audit(client, orgId, "contact.create", contact.id);
      return { contact };
    });
  }

  @Patch(":id")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const parsed = UpdateContactBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("no fields to update");

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [contact],
      } = await client.query(
        `UPDATE contacts SET
           display_name  = COALESCE($2, display_name),
           first_name    = CASE WHEN $3::boolean THEN $4 ELSE first_name END,
           last_name     = CASE WHEN $5::boolean THEN $6 ELSE last_name END,
           email         = CASE WHEN $7::boolean THEN $8 ELSE email END,
           title         = CASE WHEN $9::boolean THEN $10 ELSE title END,
           account_id    = CASE WHEN $11::boolean THEN $12 ELSE account_id END,
           owner_user_id = CASE WHEN $13::boolean THEN $14 ELSE owner_user_id END,
           status        = COALESCE($15, status),
           last_activity_at = now()
         WHERE id = $1
         RETURNING ${CONTACT_COLUMNS}`,
        [
          id,
          p.displayName ?? null,
          p.firstName !== undefined,
          p.firstName ?? null,
          p.lastName !== undefined,
          p.lastName ?? null,
          p.email !== undefined,
          p.email ?? null,
          p.title !== undefined,
          p.title ?? null,
          p.accountId !== undefined,
          p.accountId ?? null,
          p.ownerUserId !== undefined,
          p.ownerUserId ?? null,
          p.status ?? null,
        ],
      );
      if (!contact) throw new NotFoundException("contact not found");
      await this.audit(client, orgId, "contact.update", id);
      return { contact };
    });
  }

  private async audit(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    orgId: string,
    action: string,
    targetId: string,
  ) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, 'user', 'dev-admin', $2, 'contact', $3)`,
      [orgId, action, targetId],
    );
  }
}
