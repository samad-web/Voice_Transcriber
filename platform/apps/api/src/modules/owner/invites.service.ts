import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { OWNER_ROLE_LABELS, resolveOwnerRole, type OwnerRole } from "@aura/shared";
import { DbService } from "../../db/db.service";
import { platformMailConfig, sendInviteMail } from "./invite-mail";
import {
  generateInviteToken,
  hashInviteToken,
  inviteLink,
  inviteStatus,
  inviteTtlHours,
  isWellFormedInviteToken,
  maskEmail,
  normaliseEmail,
  type InviteStatus,
} from "./invite-token";
import { SupabaseAdminService, type AuthUser } from "./supabase-admin.service";

/**
 * Invite by link, finish with Google (migration 0137).
 *
 * ── THE TWO HALVES ─────────────────────────────────────────────────────────
 *
 * An OWNER issues, resends and revokes (owner-invites.controller.ts, owner
 * only). The INVITEE previews, prepares and accepts (auth-invites.controller.ts,
 * reached only server-to-server from the public invite page and the OAuth
 * callback). The invitee has no workspace yet, so their half is cross-tenant:
 * the token is the only thing that names the org.
 *
 * ── WHAT ACCEPTANCE WRITES ─────────────────────────────────────────────────
 *
 * The same two rows `OwnerAccountsService.createLogin` writes - a `users` row
 * bound by `sso_subject`, and one `memberships` row carrying the persona the
 * owner chose - plus the telecaller binding and numbers the Team form already
 * takes. The difference is only WHERE the auth user comes from: createLogin
 * mints one with a generated password; here it is the invitee's own Google
 * identity, verified by GoTrue.
 *
 * ── WHO MAY ACCEPT ─────────────────────────────────────────────────────────
 *
 * Holding the token is necessary and not sufficient. The session presented
 * must be one GoTrue itself vouches for (we ask it, with the person's own
 * access token), whose address GoTrue has verified, that came through Google,
 * and whose address equals the one the owner typed. A forwarded link opens
 * nothing for anybody else.
 */

/** The fields an owner decides when inviting - applied verbatim on acceptance. */
export interface InviteFields {
  email: string;
  name?: string | null;
  ownerRole: OwnerRole;
  tenantRole: string;
  telecallerId?: string | null;
  recordingsListen: boolean;
  recordingsExport: boolean;
  /** Already normalised to E.164 by the controller (consolePhone). */
  phone?: string | null;
  whatsapp?: string | null;
}

export interface IssueOptions {
  /** Mail it now. Ignored (reported, not an error) when SMTP is not configured. */
  send: boolean;
  ttlHours?: number | null;
}

export interface InviteSummary {
  id: string;
  email: string;
  name: string | null;
  ownerRole: OwnerRole;
  status: InviteStatus;
  expiresAt: string;
  createdAt: string;
  emailedAt: string | null;
  invitedByName: string | null;
}

export interface IssuedInvite {
  invite: InviteSummary;
  /** Shown to the owner ONCE. The database keeps only its hash. */
  link: string;
  emailed: boolean;
  /** Why it was not emailed, when sending was asked for. */
  emailError: string | null;
}

/** Refusals the invite page and callback turn into sentences. */
export type InviteRefusal =
  | "invalid"
  | "expired"
  | "accepted"
  | "revoked"
  | "not_signed_in"
  | "unverified_email"
  | "not_google"
  | "email_mismatch"
  | "unlinked_login"
  | "other_login"
  | "not_configured";

function refuse(status: number, code: InviteRefusal, message: string, extra: Record<string, unknown> = {}): never {
  throw new HttpException({ code, message, ...extra }, status);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InviteRow {
  id: string;
  org_id: string;
  email: string;
  name: string | null;
  owner_role: string;
  tenant_role: string;
  telecaller_id: string | null;
  recordings_listen: boolean;
  recordings_export: boolean;
  phone: string | null;
  whatsapp_number: string | null;
  expires_at: Date;
  emailed_at: Date | null;
  prepared_subject: string | null;
  accepted_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

@Injectable()
export class InvitesService {
  constructor(
    private readonly db: DbService,
    private readonly supabase: SupabaseAdminService,
  ) {}

  /** Can the platform mail an invite? The Team form says so before asking. */
  get mailConfigured(): boolean {
    return platformMailConfig() !== null;
  }

  get authConfigured(): boolean {
    return this.supabase.configured;
  }

  // ── owner side ─────────────────────────────────────────────────────────

  /** Live and expired invites - the ones an owner might still act on. */
  async list(orgId: string): Promise<InviteSummary[]> {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT i.id, i.email, i.name, i.owner_role, i.expires_at, i.created_at, i.emailed_at,
                i.accepted_at, i.revoked_at, u.name AS invited_by_name
           FROM org_invites i
           LEFT JOIN users u ON u.id = i.invited_by
          WHERE i.org_id = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
          ORDER BY i.created_at DESC
          LIMIT 200`,
        [orgId],
      );
      return rows.map((r) => this.summary(r));
    });
  }

  /**
   * Issue an invite. Any live invite for the same address in this workspace is
   * revoked in the same transaction, so there is only ever one working link.
   */
  async issue(orgId: string, fields: InviteFields, actor: { id: string }, opts: IssueOptions): Promise<IssuedInvite> {
    return this.issueRow(orgId, fields, actor, opts, null);
  }

  /** A fresh link (and expiry) for an invite that has not been accepted. */
  async resend(orgId: string, inviteId: string, actor: { id: string }, opts: IssueOptions): Promise<IssuedInvite> {
    const row = await this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<InviteRow>(
        `SELECT * FROM org_invites WHERE id = $1 AND org_id = $2`,
        [inviteId, orgId],
      );
      return rows[0] ?? null;
    });
    if (!row || row.revoked_at) throw new NotFoundException("invite not found");
    if (row.accepted_at) throw new ConflictException("this invite has already been accepted");
    return this.issueRow(
      orgId,
      {
        email: row.email,
        name: row.name,
        ownerRole: resolveOwnerRole(row.owner_role),
        tenantRole: row.tenant_role,
        telecallerId: row.telecaller_id,
        recordingsListen: row.recordings_listen,
        recordingsExport: row.recordings_export,
        phone: row.phone,
        whatsapp: row.whatsapp_number,
      },
      actor,
      opts,
      row.prepared_subject,
    );
  }

  /**
   * Withdraw an invite. If the invite page had pre-created an auth user for
   * it and nobody ever used that user, the user goes too - an owner who
   * withdraws an invite should not leave a login behind for that address.
   */
  async revoke(orgId: string, inviteId: string, actor: { id: string }): Promise<{ revoked: true }> {
    const row = await this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<InviteRow>(
        `UPDATE org_invites SET revoked_at = now()
          WHERE id = $1 AND org_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL
          RETURNING *`,
        [inviteId, orgId],
      );
      if (!rows[0]) throw new NotFoundException("invite not found, or already accepted or withdrawn");
      await this.audit(client, orgId, actor.id, "owner.invite.revoke", rows[0].id, { email: rows[0].email });
      return rows[0];
    });

    if (row.prepared_subject) await this.cleanUpPreparedUser(row.prepared_subject, row.email);
    return { revoked: true };
  }

  // ── invitee side (cross-tenant; the token names the org) ───────────────

  /**
   * What the invite page shows. Details only for a live invite - an expired or
   * used link says so and nothing else, since whoever holds it now may not be
   * who it was meant for.
   */
  async preview(token: string): Promise<
    | { status: "pending"; orgName: string; email: string; name: string | null; roleLabel: string; invitedByName: string | null; expiresAt: string }
    | { status: Exclude<InviteStatus, "pending"> | "invalid" }
  > {
    const row = await this.findByToken(token);
    if (!row) return { status: "invalid" };
    const status = inviteStatus(row);
    if (status !== "pending") return { status };
    return {
      status,
      orgName: row.org_name,
      email: row.email,
      name: row.name,
      roleLabel: OWNER_ROLE_LABELS[resolveOwnerRole(row.owner_role)],
      invitedByName: row.invited_by_name,
      expiresAt: new Date(row.expires_at).toISOString(),
    };
  }

  /**
   * Called when the invitee presses "Continue with Google", before the
   * redirect. Refuses a dead invite early (so nobody is sent through Google for
   * nothing) and makes sure GoTrue has a user for the address - see
   * `SupabaseAdminService.ensureUser` for why a locked-down deployment needs it.
   */
  async prepare(token: string): Promise<{ email: string }> {
    if (!this.supabase.configured) {
      refuse(503, "not_configured", "Sign-in is not configured on this platform yet. Ask your administrator.");
    }
    const row = await this.findByToken(token);
    if (!row) refuse(404, "invalid", "This invite link isn't valid.");
    this.assertPending(row);

    const ensured = await this.supabase.ensureUser(row.email, { invited_to_org: row.org_id });
    if (ensured.created) {
      await this.db.withOrg(row.org_id, (client) =>
        client.query(`UPDATE org_invites SET prepared_subject = $1 WHERE id = $2 AND org_id = $3`, [
          ensured.id,
          row.id,
          row.org_id,
        ]),
      );
    }
    return { email: row.email };
  }

  /**
   * Accept. `accessToken` is the Supabase session the OAuth callback has just
   * received; everything about who this is comes from GoTrue's answer to it.
   */
  async accept(
    token: string,
    accessToken: string,
  ): Promise<{ orgId: string; orgName: string; alreadyMember: boolean; telecallerBound: boolean }> {
    if (!this.supabase.configured) {
      refuse(503, "not_configured", "Sign-in is not configured on this platform yet. Ask your administrator.");
    }
    const found = await this.findByToken(token);
    if (!found) refuse(404, "invalid", "This invite link isn't valid.");
    this.assertPending(found);

    const user = await this.supabase.userFromAccessToken(accessToken);
    if (!user) refuse(401, "not_signed_in", "Your Google sign-in didn't complete. Try again.");
    this.assertMayAccept(found, user);

    // Decided BEFORE the transaction, because each needs a GoTrue round trip
    // and a row lock should not be held across the internet.
    const bound = await this.db.adminPool().query<{ id: string; sso_subject: string | null }>(
      `SELECT id, sso_subject FROM users WHERE lower(email) = $1 ORDER BY created_at ASC LIMIT 1`,
      [found.email],
    );
    const existing = bound.rows[0] ?? null;
    let replaceableSubject: string | null = null;
    if (existing?.sso_subject && existing.sso_subject !== user.id) {
      // The platform user points at a DIFFERENT auth user. Re-point it only
      // when that one no longer exists - which is what removing somebody from
      // their last workspace does (OwnerAccountsService.revoke deletes the
      // login). A live other login is somebody else's problem to reconcile.
      const other = await this.supabase.getUserById(existing.sso_subject);
      if (other) {
        refuse(409, "other_login", `${found.email} already signs in with a different account. Ask your administrator to reconcile it.`);
      }
      replaceableSubject = existing.sso_subject;
    }
    await this.assertNotPreRegistered(user, existing?.sso_subject === user.id);

    return this.db.withOrg(found.org_id, async (client) => {
      // The lock is what makes "single use" true under a double click.
      const { rows } = await client.query<InviteRow>(
        `SELECT * FROM org_invites WHERE id = $1 AND org_id = $2 FOR UPDATE`,
        [found.id, found.org_id],
      );
      const invite = rows[0];
      if (!invite) refuse(404, "invalid", "This invite link isn't valid.");
      this.assertPending(invite);

      // One human, one `users` row. Looked up case-insensitively because
      // `users.email` is unique on its raw value - an INSERT ... ON CONFLICT
      // (email) would miss "Asha@x.com" and create a second row for her.
      const {
        rows: [current],
      } = await client.query<{ id: string; sso_subject: string | null }>(
        `SELECT id, sso_subject FROM users WHERE lower(email) = $1 ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
        [invite.email],
      );
      let userId: string;
      if (current) {
        if (current.sso_subject && current.sso_subject !== user.id && current.sso_subject !== replaceableSubject) {
          refuse(409, "other_login", `${invite.email} already signs in with a different account. Ask your administrator to reconcile it.`);
        }
        // status back to 'active': the only writer of 'disabled' is
        // OwnerAccountsService.revoke, when somebody is removed from their LAST
        // workspace. An owner inviting them again is the explicit reversal.
        await client.query(
          `UPDATE users SET sso_subject = $2, status = 'active', name = COALESCE(name, $3), updated_at = now()
            WHERE id = $1`,
          [current.id, user.id, invite.name],
        );
        userId = current.id;
      } else {
        const {
          rows: [created],
        } = await client.query<{ id: string }>(
          `INSERT INTO users (email, name, sso_subject) VALUES ($1, $2, $3) RETURNING id`,
          [invite.email, invite.name, user.id],
        );
        userId = created!.id;
      }

      const {
        rows: [org],
      } = await client.query<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [invite.org_id]);

      // Already in this workspace (added by hand meanwhile, or accepted a
      // parallel invite). Their existing role wins - an invite is not a way to
      // regrade somebody - and the link is spent either way.
      const { rowCount: memberRows } = await client.query(
        `SELECT 1 FROM memberships WHERE user_id = $1 AND org_id = $2`,
        [userId, invite.org_id],
      );
      const alreadyMember = (memberRows ?? 0) > 0;

      let telecallerBound = false;
      if (!alreadyMember) {
        await client.query(
          `INSERT INTO memberships
             (org_id, user_id, scope_type, scope_id, role, owner_role, recordings_listen, recordings_export,
              phone, whatsapp_number)
           VALUES ($1, $2, 'org', $3, $4, $5, $6, $7, $8, $9)`,
          // scope_id separate from org_id for the reason createLogin gives: one
          // placeholder bound to two columns trips 42P08.
          [
            invite.org_id,
            userId,
            invite.org_id,
            invite.tenant_role,
            invite.owner_role,
            invite.recordings_listen,
            invite.recordings_export,
            invite.phone,
            invite.whatsapp_number,
          ],
        );
        if (invite.telecaller_id) {
          // Only if still free. It may have been given to somebody else since
          // the invite went out; stealing it would show two people each
          // other's leads, so the owner re-links it on the Team page instead.
          const bind = await client.query(
            `UPDATE telecallers SET user_id = $3, updated_at = now()
              WHERE id = $1 AND org_id = $2 AND (user_id IS NULL OR user_id = $3)`,
            [invite.telecaller_id, invite.org_id, userId],
          );
          telecallerBound = (bind.rowCount ?? 0) > 0;
        }
      }

      await client.query(
        `UPDATE org_invites SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1`,
        [invite.id, userId],
      );
      await this.audit(client, invite.org_id, userId, "owner.invite.accept", invite.id, {
        email: invite.email,
        ownerRole: invite.owner_role,
        alreadyMember,
      });

      return { orgId: invite.org_id, orgName: org?.name ?? "", alreadyMember, telecallerBound };
    });
  }

  /**
   * Plain "Continue with Google" on the sign-in page: bind this Google identity
   * to the platform user with the same (verified) address, if that user has no
   * binding yet. Never creates a user or a membership - somebody with no
   * workspace gets `hasWorkspace: false` and the console signs them out.
   */
  async linkIdentity(accessToken: string): Promise<{ linked: boolean; hasWorkspace: boolean }> {
    const user = await this.supabase.userFromAccessToken(accessToken);
    if (!user) refuse(401, "not_signed_in", "Your Google sign-in didn't complete. Try again.");
    if (!user.emailVerified || !user.email) return { linked: false, hasWorkspace: false };

    const pool = this.db.adminPool();
    // Only where the row has NO binding: re-pointing an existing binding is
    // the invite path's job, with the checks that come with it.
    // The oldest row for the address only: `users.email` is unique on its raw
    // value, so "Asha@x.com" and "asha@x.com" can both exist, and binding one
    // subject to two rows would trip the UNIQUE on sso_subject.
    const linked = await pool.query(
      `UPDATE users AS target SET sso_subject = $1, updated_at = now()
        WHERE target.id = (SELECT id FROM users WHERE lower(email) = $2 ORDER BY created_at ASC LIMIT 1)
          AND target.sso_subject IS NULL AND target.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM users bound WHERE bound.sso_subject = $1)
          AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = target.id AND m.status = 'active')`,
      [user.id, user.email],
    );
    // Same rule the console's context query applies (AUTH_CONTEXT_SQL).
    const { rows } = await pool.query(
      `SELECT 1 FROM users u
         JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
         JOIN organizations o ON o.id = m.org_id
        WHERE u.status = 'active' AND (u.sso_subject = $1 OR lower(u.email) = $2)
        LIMIT 1`,
      [user.id, user.email],
    );
    if ((linked.rowCount ?? 0) > 0) {
      await pool.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         SELECT m.org_id, 'user', u.id, 'auth.identity.link', 'user', u.id, $2::jsonb
           FROM users u JOIN memberships m ON m.user_id = u.id
          WHERE u.sso_subject = $1`,
        [user.id, JSON.stringify({ providers: user.providers })],
      );
    }
    return { linked: (linked.rowCount ?? 0) > 0, hasWorkspace: rows.length > 0 };
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async issueRow(
    orgId: string,
    fields: InviteFields,
    actor: { id: string },
    opts: IssueOptions,
    preparedSubject: string | null,
  ): Promise<IssuedInvite> {
    const email = normaliseEmail(fields.email);
    const token = generateInviteToken();
    const hours = inviteTtlHours(opts.ttlHours);
    const invitedBy = UUID_RE.test(actor.id) ? actor.id : null;

    const { row, orgName, inviterName } = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [org],
      } = await client.query<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [orgId]);
      if (!org) throw new NotFoundException("organization not found");

      const { rowCount: member } = await client.query(
        `SELECT 1 FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.org_id = $1 AND lower(u.email) = $2`,
        [orgId, email],
      );
      if ((member ?? 0) > 0) throw new ConflictException(`${email} already has access to this workspace`);

      if (fields.telecallerId) {
        const { rowCount } = await client.query(
          `SELECT 1 FROM telecallers WHERE id = $1 AND org_id = $2 AND user_id IS NULL`,
          [fields.telecallerId, orgId],
        );
        if (!rowCount) {
          throw new BadRequestException("that telecaller identity does not exist here, or is already bound to someone else");
        }
      }

      // One working link per address: whatever was live is withdrawn first.
      await client.query(
        `UPDATE org_invites SET revoked_at = now()
          WHERE org_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [orgId, email],
      );

      let inserted: InviteRow;
      try {
        const { rows } = await client.query<InviteRow>(
          `INSERT INTO org_invites
             (org_id, email, name, owner_role, tenant_role, telecaller_id, recordings_listen, recordings_export,
              phone, whatsapp_number, token_hash, expires_at, invited_by, prepared_subject)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(hours => $12), $13, $14)
           RETURNING *`,
          [
            orgId,
            email,
            fields.name?.trim() || null,
            fields.ownerRole,
            fields.tenantRole,
            fields.telecallerId ?? null,
            fields.recordingsListen,
            fields.recordingsExport,
            fields.phone ?? null,
            fields.whatsapp ?? null,
            hashInviteToken(token),
            hours,
            invitedBy,
            preparedSubject,
          ],
        );
        inserted = rows[0]!;
      } catch (err) {
        // A concurrent invite for the same address won the partial unique index.
        if ((err as { code?: string }).code === "23505") {
          throw new ConflictException(`an invite for ${email} was just sent - refresh to see it`);
        }
        throw err;
      }

      const { rows: inviter } = invitedBy
        ? await client.query<{ name: string | null; email: string }>(`SELECT name, email FROM users WHERE id = $1`, [invitedBy])
        : { rows: [] as Array<{ name: string | null; email: string }> };

      await this.audit(client, orgId, actor.id, "owner.invite.create", inserted.id, {
        email,
        ownerRole: fields.ownerRole,
        ttlHours: hours,
      });
      return { row: inserted, orgName: org.name, inviterName: inviter[0]?.name ?? null };
    });

    const link = inviteLink(token);
    let emailed = false;
    let emailError: string | null = null;
    if (opts.send) {
      const mail = platformMailConfig();
      if (!mail) {
        emailError = "Email isn't set up on this platform, so nothing was sent. Copy the link and send it yourself.";
      } else {
        try {
          await sendInviteMail(mail, {
            to: email,
            orgName,
            inviterName,
            roleLabel: OWNER_ROLE_LABELS[fields.ownerRole],
            link,
            expiresAt: new Date(row.expires_at),
          });
          emailed = true;
          await this.db.withOrg(orgId, (client) =>
            client.query(`UPDATE org_invites SET emailed_at = now() WHERE id = $1 AND org_id = $2`, [row.id, orgId]),
          );
          row.emailed_at = new Date();
        } catch (err) {
          // The invite stands; only the delivery failed. The owner still has
          // the link on screen, and the server log has the SMTP detail.
          console.error(`[invites] mail to ${maskEmail(email)} failed:`, err instanceof Error ? err.message : err);
          emailError = "The invite was created, but the email could not be sent. Copy the link and send it yourself.";
        }
      }
    }

    return {
      invite: this.summary({ ...row, invited_by_name: inviterName }),
      link,
      emailed,
      emailError,
    };
  }

  private async findByToken(
    token: string,
  ): Promise<(InviteRow & { org_name: string; invited_by_name: string | null }) | null> {
    if (!isWellFormedInviteToken(token)) return null;
    // Admin pool: the token is what names the org, so there is no org to scope
    // to until it has been looked up. A unique index on the hash makes this one
    // row or none.
    const { rows } = await this.db.adminPool().query(
      `SELECT i.*, o.name AS org_name, u.name AS invited_by_name
         FROM org_invites i
         JOIN organizations o ON o.id = i.org_id
         LEFT JOIN users u ON u.id = i.invited_by
        WHERE i.token_hash = $1`,
      [hashInviteToken(token)],
    );
    return rows[0] ?? null;
  }

  private assertPending(row: InviteRow): void {
    const status = inviteStatus(row);
    if (status === "expired") refuse(410, "expired", "This invite has expired. Ask whoever invited you to send a new one.");
    if (status === "accepted") refuse(410, "accepted", "This invite has already been used. Sign in instead.");
    if (status === "revoked") refuse(410, "revoked", "This invite was withdrawn. Ask whoever invited you for a new one.");
  }

  private assertMayAccept(invite: InviteRow, user: AuthUser): void {
    if (!user.emailVerified || !user.email) {
      refuse(403, "unverified_email", "Google didn't confirm an email address for that account.");
    }
    if (!user.providers.includes("google")) {
      refuse(403, "not_google", "Finish accepting this invite by continuing with Google.");
    }
    if (user.email !== invite.email) {
      refuse(403, "email_mismatch", `This invite is for ${maskEmail(invite.email)}. Continue with the Google account for that address.`, {
        invitedEmail: maskEmail(invite.email),
      });
    }
  }

  /**
   * Refuse an auth user that somebody else may have registered for this
   * address before the invitee arrived.
   *
   * If GoTrue allows password sign-ups with auto-confirm, anybody can register
   * `invitee@company.com` with a password of their choosing; when the real
   * invitee later signs in with Google, GoTrue links Google INTO that account -
   * and the squatter's password still opens it. The shape is recognisable: an
   * auth user holding a password (`email` provider) that no platform user is
   * bound to and that no invite of ours created. A legitimate account never
   * looks like that - createLogin binds what it creates, and `prepare` records
   * what it creates - so it is refused rather than adopted.
   */
  private async assertNotPreRegistered(user: AuthUser, alreadyBound: boolean): Promise<void> {
    if (alreadyBound || !user.providers.includes("email")) return;
    const { rows } = await this.db.adminPool().query(
      `SELECT 1 FROM users WHERE sso_subject = $1
       UNION ALL
       SELECT 1 FROM org_invites WHERE prepared_subject = $1
       LIMIT 1`,
      [user.id],
    );
    if (rows.length === 0) {
      refuse(409, "unlinked_login", "This address already has a sign-in that isn't linked to any workspace. Ask your administrator to reconcile it.");
    }
  }

  /** Delete an auth user an invite created, if it is still unused by anything. */
  private async cleanUpPreparedUser(subject: string, email: string): Promise<void> {
    try {
      const { rows } = await this.db.adminPool().query(
        `SELECT 1 FROM users WHERE sso_subject = $1
         UNION ALL
         SELECT 1 FROM org_invites WHERE email = $2 AND accepted_at IS NULL AND revoked_at IS NULL
         LIMIT 1`,
        [subject, email],
      );
      if (rows.length === 0) await this.supabase.deleteUser(subject);
    } catch (err) {
      // Not fatal: the user has no password and no binding, so it opens nothing.
      console.error("[invites] prepared auth user cleanup failed:", err instanceof Error ? err.message : err);
    }
  }

  private async audit(
    client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
    orgId: string,
    actorId: string,
    action: string,
    inviteId: string,
    meta: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
       VALUES ($1, 'user', $2, $3, 'invite', $4, $5::jsonb)`,
      [orgId, actorId, action, inviteId, JSON.stringify(meta)],
    );
  }

  private summary(r: {
    id: string;
    email: string;
    name: string | null;
    owner_role: string;
    expires_at: Date | string;
    created_at: Date | string;
    emailed_at: Date | string | null;
    accepted_at: Date | string | null;
    revoked_at: Date | string | null;
    invited_by_name?: string | null;
  }): InviteSummary {
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      ownerRole: resolveOwnerRole(r.owner_role),
      status: inviteStatus(r),
      expiresAt: new Date(r.expires_at).toISOString(),
      createdAt: new Date(r.created_at).toISOString(),
      emailedAt: r.emailed_at ? new Date(r.emailed_at).toISOString() : null,
      invitedByName: r.invited_by_name ?? null,
    };
  }
}
