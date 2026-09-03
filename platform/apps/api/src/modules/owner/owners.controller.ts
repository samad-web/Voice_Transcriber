import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { OwnerAccountsService } from "./owner-accounts.service";
import { SupabaseAdminService } from "./supabase-admin.service";

const CreateOwnerBody = z.object({
  email: z.string().email().max(200),
  name: z.string().min(1).max(200).optional(),
  /** Listening to a recording is a privacy event; owners get it by default. */
  recordingsListen: z.boolean().default(true),
  recordingsExport: z.boolean().default(false),
});

/** The role an instance owner holds in their org. */
const OWNER_ROLE = "org_admin";

/**
 * Owner logins - the provider's side of §3.4.
 *
 * An owner is two linked records: a Supabase Auth user (what the console signs
 * in against) and a platform membership in exactly one org (what scopes every
 * query they make). `users.sso_subject` is the join between them, which is the
 * column the identity model always intended to carry an external subject - the
 * OIDC swap later replaces who mints the subject, not this wiring.
 *
 * The three WRITE paths now live in `OwnerAccountsService`, shared verbatim
 * with the customer's own Team page (`owner-team.controller.ts`). Same records,
 * same ordering, same rollback; the only difference is who is asking and which
 * persona they are allowed to create. Before that extraction this file was the
 * only copy, and a second one would eventually have drifted into the failure
 * this one is carefully written to avoid: an auth user holding a live password
 * with no tenant binding behind it.
 *
 * Tenant-scoped by `TenantGuard` like every other tenant endpoint, so the
 * operator console manages a customer's owners from that customer's instance
 * page.
 */
@Controller("owners")
@UseGuards(AdminKeyGuard, TenantGuard)
export class OwnersController {
  constructor(
    private readonly db: DbService,
    private readonly accounts: OwnerAccountsService,
    private readonly supabase: SupabaseAdminService,
  ) {}

  @Get()
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT u.id AS "userId", u.email, u.name, u.status,
                (u.sso_subject IS NOT NULL) AS "hasLogin",
                m.role, m.recordings_listen AS "recordingsListen",
                m.recordings_export AS "recordingsExport", m.created_at AS "createdAt"
           FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.role = $1
          ORDER BY m.created_at ASC`,
        [OWNER_ROLE],
      );
      return { owners: rows, authConfigured: this.supabase.configured };
    });
  }

  /**
   * Provision an owner login for this instance.
   *
   * The generated password is returned EXACTLY ONCE - see the service for the
   * ordering and the rollback that keeps a failure from leaving a live
   * password behind.
   */
  @Post()
  async create(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = CreateOwnerBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { email, name, recordingsListen, recordingsExport } = parsed.data;

    return this.accounts.createLogin(
      orgId,
      {
        email,
        name,
        // The operator provisions ACCOUNT HOLDERS, so both the persona and the
        // tenant role are fixed here rather than read from the body. An
        // operator creating a telecaller would be making a staffing decision
        // inside a customer's console that the customer never asked for; the
        // Team page is where that belongs.
        ownerRole: "owner",
        tenantRole: OWNER_ROLE,
        recordingsListen,
        recordingsExport,
      },
      { id: "operator", action: "owner.create" },
    );
  }

  /** Issue a fresh password. Shown once, like the original. */
  @Post(":userId/password")
  async resetPassword(@OrgId() orgId: string, @Param("userId", ParseUUIDPipe) userId: string) {
    return this.accounts.resetPassword(orgId, userId, {
      id: "operator",
      action: "owner.password_reset",
    });
  }

  /**
   * Revoke access to THIS instance. The Supabase login survives if they belong
   * to another one - see the service.
   */
  @Delete(":userId")
  async revoke(@OrgId() orgId: string, @Param("userId", ParseUUIDPipe) userId: string) {
    return this.accounts.revoke(orgId, userId, { id: "operator", action: "owner.revoke" });
  }
}
