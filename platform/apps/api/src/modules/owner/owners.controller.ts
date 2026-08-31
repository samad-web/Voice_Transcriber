import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
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
 * Owner logins - one sign-in per customer instance (§3.4).
 *
 * An owner is two linked records: a Supabase Auth user (what the console signs
 * in against) and a platform membership in exactly one org (what scopes every
 * query they make). `users.sso_subject` is the join between them, which is the
 * column the identity model always intended to carry an external subject - the
 * OIDC swap later replaces who mints the subject, not this wiring.
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
   * The generated password is returned EXACTLY ONCE - the same contract as the
   * enrollment key, and for the same reason: nothing here can retrieve it later.
   *
   * Order matters. The Supabase user is created first so a failure there leaves
   * no half-provisioned membership; if the platform-side write then fails, the
   * auth user is deleted again rather than left orphaned with a live password.
   */
  @Post()
  async create(@OrgId() orgId: string, @Body() body: unknown) {
    const parsed = CreateOwnerBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { email, name, recordingsListen, recordingsExport } = parsed.data;

    const existing = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [org],
      } = await client.query("SELECT name FROM organizations LIMIT 1");
      if (!org) throw new NotFoundException("organization not found");
      const {
        rows: [user],
      } = await client.query(
        `SELECT u.id, u.sso_subject,
                EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id) AS member_here
           FROM users u WHERE lower(u.email) = lower($1)`,
        [email],
      );
      return { orgName: org.name as string, user };
    });

    if (existing.user?.member_here) {
      throw new ConflictException(`${email} already has access to this instance`);
    }

    // An account that already exists (they own another instance, or were added
    // as a member) is linked, not recreated - one human, one login.
    let password: string | null = null;
    let subject: string | undefined = existing.user?.sso_subject ?? undefined;
    let createdSubject: string | null = null;

    if (!subject) {
      password = SupabaseAdminService.generatePassword();
      try {
        const created = await this.supabase.createUser(email, password, {
          org_id: orgId,
          org_name: existing.orgName,
          role: OWNER_ROLE,
        });
        subject = created.id;
        createdSubject = created.id;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The auth user exists but nothing on this side points at it - the
        // operator needs a different remedy than "try again".
        if (/already been registered|already registered|already exists/i.test(message)) {
          throw new ConflictException(
            `${email} already has a Supabase login not linked to any instance - remove it in the Supabase dashboard, or use a different address`,
          );
        }
        throw err;
      }
    }

    try {
      return await this.db.withOrg(orgId, async (client) => {
        const {
          rows: [user],
        } = await client.query(
          `INSERT INTO users (email, name, sso_subject)
           VALUES ($1, $2, $3)
           ON CONFLICT (email) DO UPDATE SET
             name = COALESCE(EXCLUDED.name, users.name),
             sso_subject = COALESCE(users.sso_subject, EXCLUDED.sso_subject)
           RETURNING id, email, name`,
          [email, name ?? null, subject ?? null],
        );

        const {
          rows: [membership],
        } = await client.query(
          `INSERT INTO memberships
             (org_id, user_id, scope_type, scope_id, role, owner_role, recordings_listen, recordings_export)
           VALUES ($1, $2, 'org', $3, $4, 'owner', $5, $6)
           ON CONFLICT (user_id, scope_type, scope_id) DO UPDATE SET
             role = EXCLUDED.role,
             owner_role = EXCLUDED.owner_role,
             recordings_listen = EXCLUDED.recordings_listen,
             recordings_export = EXCLUDED.recordings_export
           RETURNING role, owner_role AS "ownerRole", recordings_listen AS "recordingsListen",
                     recordings_export AS "recordingsExport"`,
          // scope_id is a separate param from org_id even though they hold the
          // same value: reusing one placeholder for two columns trips 42P08.
          [orgId, user.id, orgId, OWNER_ROLE, recordingsListen, recordingsExport],
        );

        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
           VALUES ($1, 'user', 'operator', 'owner.create', 'user', $2, $3::jsonb)`,
          [orgId, user.id, JSON.stringify({ email, linkedExisting: !createdSubject })],
        );

        return {
          owner: { userId: user.id, email: user.email, name: user.name, ...membership },
          // Null when an existing login was linked - they keep their password.
          password,
          linkedExisting: !createdSubject,
        };
      });
    } catch (err) {
      // Compensate: an auth user with a live password and no tenant binding is
      // worse than no user at all.
      if (createdSubject) {
        await this.supabase
          .deleteUser(createdSubject)
          .catch((cleanupErr) =>
            console.error(`owner.create rollback failed for ${email}:`, cleanupErr),
          );
      }
      throw err;
    }
  }

  /** Issue a fresh password. Shown once, like the original. */
  @Post(":userId/password")
  async resetPassword(
    @OrgId() orgId: string,
    @Param("userId", ParseUUIDPipe) userId: string,
  ) {
    const subject = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `SELECT u.sso_subject FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.user_id = $1`,
        [userId],
      );
      if (!row) throw new NotFoundException("owner not found in this instance");
      if (!row.sso_subject) {
        throw new ConflictException("this member has no console login to reset");
      }
      return row.sso_subject as string;
    });

    const password = SupabaseAdminService.generatePassword();
    await this.supabase.setPassword(subject, password);

    await this.db.withOrg(orgId, (client) =>
      client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', 'operator', 'owner.password_reset', 'user', $2)`,
        [orgId, userId],
      ),
    );

    return { password };
  }

  /**
   * Revoke access to THIS instance.
   *
   * The Supabase login is deleted only when the membership removed was their
   * last one - someone who owns two instances must not lose their sign-in
   * because one of them was closed.
   */
  @Delete(":userId")
  async revoke(
    @OrgId() orgId: string,
    @Param("userId", ParseUUIDPipe) userId: string,
  ) {

    const outcome = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [user],
      } = await client.query("SELECT sso_subject FROM users WHERE id = $1", [userId]);
      // `org_id = $2` on both deletes below. RLS already confines them to this
      // tenant (withOrg → getPool() → the NOBYPASSRLS `aura_app` role; both
      // memberships and sessions carry FORCE RLS with USING + WITH CHECK on
      // org_id), so this changes no behaviour today. It matters because THIS
      // handler deliberately mixes pools: fifteen lines below, the "does this
      // human hold a membership anywhere else" question runs on `adminPool()`
      // with RLS off, and it is correct that it does. An unqualified
      // `WHERE user_id = $1` sitting that close to an RLS-bypassing client is a
      // copy-paste away from revoking a person from every tenant at once and
      // then, seeing no remaining memberships, deleting their Supabase login too.
      const res = await client.query("DELETE FROM memberships WHERE user_id = $1 AND org_id = $2", [
        userId,
        orgId,
      ]);
      if ((res.rowCount ?? 0) === 0) {
        throw new NotFoundException("owner not found in this instance");
      }

      // Any session already issued to them is bound to this org; drop it so
      // revocation is immediate rather than "at token expiry". Scoped to this
      // org on purpose - a person who owns two instances keeps their session on
      // the other one, matching the login-deletion rule below.
      await client.query("DELETE FROM sessions WHERE user_id = $1 AND org_id = $2", [
        userId,
        orgId,
      ]);

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', 'operator', 'owner.revoke', 'user', $2)`,
        [orgId, userId],
      );
      return { subject: user?.sso_subject as string | undefined };
    });

    // Cross-tenant question, so it runs on the admin pool: RLS would hide the
    // memberships this user still holds in OTHER orgs and we would delete a
    // login that is still in use.
    let loginDeleted = false;
    if (outcome.subject) {
      const { rows } = await this.db
        .adminPool()
        .query("SELECT 1 FROM memberships WHERE user_id = $1 LIMIT 1", [userId]);
      if (rows.length === 0) {
        await this.supabase
          .deleteUser(outcome.subject)
          .then(() => {
            loginDeleted = true;
          })
          .catch((err) => console.error(`owner.revoke: auth user cleanup failed:`, err));
        await this.db
          .adminPool()
          .query("UPDATE users SET status = 'disabled' WHERE id = $1", [userId]);
      }
    }

    return { revoked: true, loginDeleted };
  }
}
