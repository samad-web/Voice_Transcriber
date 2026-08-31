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
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrmPermissionsGuard, RequireCrmPermission } from "../../common/crm-permissions.guard";
import { RecordScope, scopeClause, type CrmRecordScope } from "../../common/crm-scope";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const ListQuery = z.object({
  q: z.string().max(200).optional(),
  sort: z.enum(["activity", "created", "name"]).default("activity"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const CreateAccountBody = z.object({
  workspaceId: z.string().uuid().optional(),
  name: z.string().min(1).max(200),
  domain: z.string().max(200).optional(),
});

const UpdateAccountBody = z.object({
  name: z.string().min(1).max(200).optional(),
  domain: z.string().max(200).nullable().optional(),
  ownerUserId: z.string().uuid().nullable().optional(),
  status: z.enum(["active", "archived"]).optional(),
});

const ACCOUNT_COLUMNS = `id, workspace_id, name, domain, phone_prefix, phone_last3, external_ids,
  owner_user_id, facts, status, merged_into_id, last_activity_at, created_at, updated_at`;

/**
 * Accounts (companies) — CRM Phase 1, E0.1. Strangler-fig: nothing here
 * reads from or writes to `leads`/`call_facts`, and this module is not linked
 * into web nav yet. See the Phase 1 plan.
 */
@Controller("accounts")
@UseGuards(AdminKeyGuard, TenantGuard, CrmPermissionsGuard)
export class AccountsController {
  constructor(private readonly db: DbService) {}

  @Get()
  @RequireCrmPermission("account", "view")
  async list(
    @OrgId() orgId: string,
    @Query() query: unknown,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = ListQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { q, sort, limit, offset } = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const where = [`status <> 'merged'`];
      const params: unknown[] = [];

      if (q) {
        params.push(`%${q}%`);
        const p = `$${params.length}`;
        where.push(`(name ILIKE ${p} OR domain ILIKE ${p})`);
      }

      // The `owned` half of the permission grid — see common/crm-scope.ts.
      if (recordScope.scope === "owned") {
        params.push(recordScope.userId);
        where.push(`owner_user_id = $${params.length}`);
      }

      const ORDER = {
        activity: "last_activity_at DESC",
        created: "created_at DESC",
        name: "name ASC",
      } as const;

      params.push(limit, offset);
      const { rows } = await client.query(
        `SELECT ${ACCOUNT_COLUMNS}, count(*) OVER()::int AS total_count
           FROM accounts
          WHERE ${where.join(" AND ")}
          ORDER BY ${ORDER[sort]}
          LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params,
      );

      return {
        accounts: rows.map(({ total_count: _t, ...a }) => a),
        total: rows[0]?.total_count ?? 0,
        limit,
        offset,
      };
    });
  }

  @Get(":id")
  // `account` only, though the payload embeds a contact summary: those are the
  // people AT this account, so seeing the account implies seeing who is on it.
  // Contrast GET /contacts/:id/deals, where deals are the entire payload rather
  // than a nested summary and the grant is therefore `deal`.
  @RequireCrmPermission("account", "view")
  async detail(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    return this.db.withOrg(orgId, async (client) => {
      // 404 rather than 403 outside the caller's scope — a 403 would confirm
      // the record exists, which is the fact being withheld.
      const scoped = scopeClause("account", recordScope, 2);
      const {
        rows: [account],
      } = await client.query(
        `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1 ${scoped ? `AND ${scoped}` : ""}`,
        scoped ? [id, recordScope.userId] : [id],
      );
      if (!account) throw new NotFoundException("account not found");

      const { rows: contacts } = await client.query(
        `SELECT id, display_name, email, phone_prefix, phone_last3, title
           FROM contacts WHERE account_id = $1 AND status <> 'merged'
          ORDER BY last_activity_at DESC`,
        [id],
      );
      return { account, contacts };
    });
  }

  @Post()
  @RequireCrmPermission("account", "create")
  async create(
    @OrgId() orgId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = CreateAccountBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [account],
      } = await client.query(
        `INSERT INTO accounts (org_id, workspace_id, name, domain, owner_user_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${ACCOUNT_COLUMNS}`,
        [
          orgId,
          p.workspaceId ?? null,
          p.name,
          p.domain ?? null,
          // Stamped as the creator's when they are scoped, or they would
          // create a record and immediately lose sight of it.
          recordScope.scope === "owned" ? recordScope.userId : null,
        ],
      );
      await this.audit(client, orgId, "account.create", account.id, req);
      return { account };
    });
  }

  @Patch(":id")
  @RequireCrmPermission("account", "edit")
  async update(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
    @RecordScope() recordScope: CrmRecordScope,
  ) {
    const parsed = UpdateAccountBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const p = parsed.data;
    if (Object.keys(p).length === 0) throw new BadRequestException("no fields to update");

    return this.db.withOrg(orgId, async (client) => {
      // Same contract as the detail route: no row matched, no write, no
      // disclosure.
      const scopedUpdate = scopeClause("account", recordScope, 8);
      const {
        rows: [account],
      } = await client.query(
        `UPDATE accounts SET
           name          = COALESCE($2, name),
           -- A nullable field needs "was it sent?" separate from "is it null?"
           -- — COALESCE alone cannot express clearing one (same pattern as
           -- owner/leads.controller.ts's update handler).
           domain        = CASE WHEN $3::boolean THEN $4 ELSE domain END,
           owner_user_id = CASE WHEN $5::boolean THEN $6 ELSE owner_user_id END,
           status        = COALESCE($7, status),
           last_activity_at = now()
         WHERE id = $1 ${scopedUpdate ? `AND ${scopedUpdate}` : ""}
         RETURNING ${ACCOUNT_COLUMNS}`,
        [
          id,
          p.name ?? null,
          p.domain !== undefined,
          p.domain ?? null,
          p.ownerUserId !== undefined,
          p.ownerUserId ?? null,
          p.status ?? null,
          ...(scopedUpdate ? [recordScope.userId] : []),
        ],
      );
      if (!account) throw new NotFoundException("account not found");
      await this.audit(client, orgId, "account.update", id, req);
      return { account };
    });
  }

  private async audit(
    client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
    orgId: string,
    action: string,
    targetId: string,
    req: PrincipalRequest,
  ) {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
       VALUES ($1, 'user', $2, $3, 'account', $4)`,
      [orgId, req.principal?.userId ?? "dev-admin", action, targetId],
    );
  }
}
