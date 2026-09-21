import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { OwnerRole } from "@aura/shared";
import { retirePersonalChannel } from "../../common/private-threads";
import { DbService } from "../../db/db.service";
import { SupabaseAdminService } from "./supabase-admin.service";

/**
 * Provisioning a console login: create, re-password, revoke.
 *
 * ── WHY THIS IS A SERVICE AND NOT A CONTROLLER METHOD ─────────────────────
 *
 * Two audiences now do the same three things to the same two records. The
 * OPERATOR provisions a customer's first owner from the instance page
 * (`owners.controller.ts`); the CUSTOMER now provisions their own colleagues
 * from the console's Team page (`owner-team.controller.ts`). The mechanics are
 * identical and unusually easy to get subtly wrong - the Supabase user must be
 * created before the platform rows and deleted again if they fail, the auth
 * login must survive revocation from ONE of two instances, and every delete
 * must carry an explicit `org_id` even though RLS already scopes it.
 *
 * Two copies of that would drift, and the failure mode of the drift is an auth
 * user with a live password and no tenant binding. So it lives here once, and
 * both controllers are thin.
 *
 * WHAT THE CALLER DECIDES, AND WHY IT IS PASSED IN RATHER THAN INFERRED:
 * the console persona and the tenant role. The operator path creates owners
 * (`owner` / `org_admin`); the customer path creates whatever persona was
 * chosen, mapped one rung lower by `tenantRoleForOwnerRole`. Inferring either
 * here would mean this file deciding an authorization question on behalf of a
 * caller it cannot see.
 */

export interface CreateLoginInput {
  email: string;
  name?: string | null;
  /** The console persona (design doc §9). */
  ownerRole: OwnerRole;
  /** `memberships.role` - the operator-side tenant role. See tenantRoleForOwnerRole. */
  tenantRole: string;
  recordingsListen: boolean;
  recordingsExport: boolean;
}

/** Who is doing this, for the audit row. `'operator'` on the provider path. */
export interface Actor {
  id: string;
  action: string;
}

@Injectable()
export class OwnerAccountsService {
  constructor(
    private readonly db: DbService,
    private readonly supabase: SupabaseAdminService,
  ) {}

  get authConfigured(): boolean {
    return this.supabase.configured;
  }

  /**
   * Provision a login for this instance.
   *
   * The generated password is returned EXACTLY ONCE - the same contract as the
   * enrollment key, and for the same reason: nothing here can retrieve it
   * later. It is returned rather than emailed on purpose; this platform sends
   * nothing to a person's inbox without someone deciding to.
   *
   * Order matters. The Supabase user is created first so a failure there
   * leaves no half-provisioned membership; if the platform-side write then
   * fails, the auth user is deleted again rather than left orphaned with a
   * live password.
   */
  async createLogin(orgId: string, input: CreateLoginInput, actor: Actor) {
    const { email, name, ownerRole, tenantRole, recordingsListen, recordingsExport } = input;

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
          role: tenantRole,
        });
        subject = created.id;
        createdSubject = created.id;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The auth user exists but nothing on this side points at it - the
        // caller needs a different remedy than "try again".
        if (/already been registered|already registered|already exists/i.test(message)) {
          throw new ConflictException(
            `${email} already has a login not linked to any instance - ask your provider to reconcile it, or use a different address`,
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
           VALUES ($1, $2, 'org', $3, $4, $7, $5, $6)
           ON CONFLICT (user_id, scope_type, scope_id) DO UPDATE SET
             role = EXCLUDED.role,
             owner_role = EXCLUDED.owner_role,
             recordings_listen = EXCLUDED.recordings_listen,
             recordings_export = EXCLUDED.recordings_export
           RETURNING role, owner_role AS "ownerRole", recordings_listen AS "recordingsListen",
                     recordings_export AS "recordingsExport"`,
          // scope_id is a separate param from org_id even though they hold the
          // same value: reusing one placeholder for two columns trips 42P08.
          [orgId, user.id, orgId, tenantRole, recordingsListen, recordingsExport, ownerRole],
        );

        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
           VALUES ($1, 'user', $2, $3, 'user', $4, $5::jsonb)`,
          [
            orgId,
            actor.id,
            actor.action,
            user.id,
            JSON.stringify({ email, ownerRole, linkedExisting: !createdSubject }),
          ],
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
            console.error(`login rollback failed for ${email}:`, cleanupErr),
          );
      }
      throw err;
    }
  }

  /** Issue a fresh password. Shown once, like the original. */
  async resetPassword(orgId: string, userId: string, actor: Actor): Promise<{ password: string }> {
    const subject = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query(
        `SELECT u.sso_subject FROM memberships m
           JOIN users u ON u.id = m.user_id
          WHERE m.user_id = $1`,
        [userId],
      );
      if (!row) throw new NotFoundException("member not found in this instance");
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
         VALUES ($1, 'user', $2, $3, 'user', $4)`,
        [orgId, actor.id, actor.action, userId],
      ),
    );

    return { password };
  }

  /**
   * Revoke access to THIS instance.
   *
   * The Supabase login is deleted only when the membership removed was their
   * last one - someone who belongs to two instances must not lose their
   * sign-in because one of them removed them.
   */
  async revoke(orgId: string, userId: string, actor: Actor) {
    const outcome = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [user],
      } = await client.query("SELECT sso_subject FROM users WHERE id = $1", [userId]);

      // `org_id = $2` on both deletes below. RLS already confines them to this
      // tenant, so this changes no behaviour today. It matters because the
      // "does this human belong anywhere else" question fifteen lines below
      // runs on `adminPool()` with RLS OFF, and it is correct that it does. An
      // unqualified `WHERE user_id = $1` sitting that close to an
      // RLS-bypassing client is a copy-paste away from revoking a person from
      // every tenant at once and then, seeing no memberships left, deleting
      // their login too.
      const res = await client.query("DELETE FROM memberships WHERE user_id = $1 AND org_id = $2", [
        userId,
        orgId,
      ]);
      if ((res.rowCount ?? 0) === 0) {
        throw new NotFoundException("member not found in this instance");
      }
      // Their own WhatsApp number stops delivering here (0125).
      await retirePersonalChannel(client, orgId, userId);

      // Any session already issued to them is bound to this org; drop it so
      // revocation is immediate rather than "at token expiry".
      await client.query("DELETE FROM sessions WHERE user_id = $1 AND org_id = $2", [
        userId,
        orgId,
      ]);

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, $3, 'user', $4)`,
        [orgId, actor.id, actor.action, userId],
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
        // `loginDeleted` is set INSIDE the success branch, not beside the
        // call: a failed cleanup must be reported as "still has a login",
        // because that is what is true and it is the state somebody has to go
        // and fix by hand.
        await this.supabase
          .deleteUser(outcome.subject)
          .then(() => {
            loginDeleted = true;
          })
          .catch((err) => console.error(`revoke: auth user cleanup failed:`, err));
        await this.db
          .adminPool()
          .query("UPDATE users SET status = 'disabled' WHERE id = $1", [userId]);
      }
    }

    return { revoked: true, loginDeleted };
  }
}
