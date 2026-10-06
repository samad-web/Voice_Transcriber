import { Injectable, Logger } from "@nestjs/common";
import { consoleBaseUrl } from "../../common/console-redirect";
import { DbService } from "../../db/db.service";
import { assertInvitePending, assertMayAcceptInvite, refuse } from "../owner/invite-guards";
import { platformMailConfig, sendInviteMail } from "../owner/invite-mail";
import {
  generateInviteToken,
  hashInviteToken,
  inviteStatus,
  inviteTtlHours,
  isWellFormedInviteToken,
  normaliseEmail,
} from "../owner/invite-token";
import { SupabaseAdminService } from "../owner/supabase-admin.service";

/**
 * How a channel partner gets a login (Build docs/39 §18).
 *
 * ── WHAT IS REUSED, WHICH IS ALMOST EVERYTHING ─────────────────────────────
 *
 * §18 says to reuse Supabase auth, the live invite flow (0137) and Google
 * sign-in rather than building a second identity system, and that is what this
 * is. The token generator, its sha256, the 43-character shape check, the
 * TTL clamp, `inviteStatus`, `assertInvitePending`, `assertMayAcceptInvite`
 * (verified email + Google provider + address match), `SupabaseAdminService`
 * and the `users` row at the end are all the same code the owner console uses.
 * There is exactly one `users` table and exactly one place a Google identity is
 * verified.
 *
 * ── AND THE ONE THING THAT IS NOT: THE TABLE ───────────────────────────────
 *
 * A partner invite lives in `partner_invites`, not in `org_invites` with a
 * `partner_id` column. Migration 0163's header gives the argument in full; the
 * short version is that `AuthInvitesController.accept` dispatches on which
 * table holds the token and its org branch ends in `INSERT INTO memberships`.
 * A partner token sitting in `org_invites` would be indistinguishable to that
 * route, and anybody who posted one to the staff endpoint would be made a
 * MEMBER of the tenant - a broker with a console login and the pipeline behind
 * it - with a 200 in reply.
 *
 * Doc 34 reached the same conclusion for superadmin invites and built
 * `platform_operator_invites` (0145). A token is opaque and says nothing about
 * itself; which table holds it is the only honest answer to "what does this
 * grant".
 *
 * Acceptance writes a `partner_users` row and NO membership, which 0163 turns
 * from an intention into a constraint: a trigger on each table refuses a person
 * who already holds the other.
 */
@Injectable()
export class PartnerInvitesService {
  private readonly log = new Logger(PartnerInvitesService.name);

  constructor(
    private readonly db: DbService,
    private readonly supabase: SupabaseAdminService,
  ) {}

  /**
   * `${PUBLIC_APP_URL}/portal/invite/<token>`.
   *
   * Built from configuration, NEVER from the request - the same rule
   * `inviteLink` states for the owner's link and for the same reason: this URL
   * is mailed to somebody who trusts it because it came from a company they
   * deal with, and building it from a Host header would let anyone who can
   * reach the API with a forged one mint a real invite pointing at their
   * server. Classic password-reset poisoning.
   */
  static link(token: string, env: NodeJS.ProcessEnv = process.env): string {
    return `${consoleBaseUrl(env)}/portal/invite/${encodeURIComponent(token)}`;
  }

  // ── The tenant's side ────────────────────────────────────────────────────

  async issue(
    orgId: string,
    partnerId: string,
    fields: { email: string; name?: string; role: "owner" | "member"; ttlHours?: number },
    actor: { id: string },
  ) {
    const email = normaliseEmail(fields.email);
    const token = generateInviteToken();
    const hours = inviteTtlHours(fields.ttlHours);

    const issued = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [partner],
      } = await client.query<{ name: string; status: string }>(
        `SELECT name, status FROM partners WHERE id = $1`,
        [partnerId],
      );
      if (!partner) refuse(404, "invalid", "That partner no longer exists.");
      if (partner.status === "terminated") {
        refuse(409, "revoked", "This partner has been terminated - reinstate them before inviting anybody.");
      }

      // The one LIVE invite per (partner, email) is a partial unique index, so
      // re-inviting somebody whose link is still good is a conflict rather
      // than a second link they would both be holding. Withdrawn first, so
      // "send it again" is one action rather than revoke-then-invite.
      await client.query(
        `UPDATE partner_invites SET revoked_at = now()
          WHERE partner_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [partnerId, email],
      );

      const {
        rows: [row],
      } = await client.query<{ id: string; expires_at: Date }>(
        `INSERT INTO partner_invites
           (org_id, partner_id, email, name, role, token_hash, expires_at, invited_by)
         VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' hours')::interval, $8)
         RETURNING id, expires_at`,
        [orgId, partnerId, email, fields.name ?? null, fields.role, hashInviteToken(token), String(hours), actor.id],
      );

      const {
        rows: [org],
      } = await client.query<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [orgId]);

      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'partner.invite.issue', 'partner', $3)`,
        [orgId, actor.id, partnerId],
      );
      return { id: row!.id, expiresAt: row!.expires_at, orgName: org?.name ?? "", partnerName: partner.name };
    });

    // Mail is best-effort and OUTSIDE the transaction: SMTP can hang, and a
    // row lock held across the internet is how an invite takes a table with
    // it. A failure leaves `emailed_at` null, which is exactly what the
    // console reads as "copy the link instead" - the same contract 0137 has.
    const link = PartnerInvitesService.link(token);
    const mail = platformMailConfig();
    let emailed = false;
    if (mail) {
      try {
        await sendInviteMail(mail, {
          to: email,
          orgName: issued.orgName,
          inviterName: issued.partnerName,
          roleLabel: `a partner contact for ${issued.partnerName}`,
          link,
          expiresAt: new Date(issued.expiresAt),
        });
        emailed = true;
        await this.db.withOrg(orgId, (client) =>
          client.query(`UPDATE partner_invites SET emailed_at = now() WHERE id = $1`, [issued.id]),
        );
      } catch (err) {
        this.log.warn(`partner invite mail to ${email} failed: ${(err as Error).message}`);
      }
    }

    // The raw token is returned ONCE, here, and never stored - the column
    // holds its sha256. Whoever issued it can copy the link; nobody can read
    // it back out of the database afterwards.
    return { inviteId: issued.id, link, emailed, expiresAt: issued.expiresAt };
  }

  async revoke(orgId: string, inviteId: string, actor: { id: string }) {
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE partner_invites SET revoked_at = now()
          WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [inviteId],
      );
      if ((rowCount ?? 0) === 0) refuse(404, "invalid", "That invite is already used or withdrawn.");
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'partner.invite.revoke', 'partner', $3)`,
        [orgId, actor.id, inviteId],
      );
      return { revoked: true as const };
    });
  }

  // ── The invitee's side ───────────────────────────────────────────────────

  /**
   * Did THIS table issue that token?
   *
   * The mirror of `OperatorInvitesService.knows`, and it exists for the same
   * reason: `AuthInvitesController` dispatches a token to the right invite
   * flow by asking each table in turn, because a token is opaque and says
   * nothing about its own kind.
   *
   * Nothing calls this yet. It is the hook that lets the console's existing
   * public invite page - `/invite/<token>`, already on the middleware's public
   * list, already wired through `startGoogleInviteAction` and
   * `/auth/callback` - serve a partner invite too, with a three-line branch in
   * that controller rather than a second OAuth dance in the portal. Those
   * files belong to other changes in this phase; see the handover.
   *
   * A hash lookup on a unique index, and authoritative: true only for a token
   * this table actually holds.
   */
  async knows(token: string): Promise<boolean> {
    if (!isWellFormedInviteToken(token)) return false;
    const { rowCount } = await this.db
      .adminPool()
      .query(`SELECT 1 FROM partner_invites WHERE token_hash = $1`, [hashInviteToken(token)]);
    return (rowCount ?? 0) > 0;
  }

  /** What the portal's invite page shows. Details only for a live invite. */
  async preview(token: string) {
    const row = await this.findByToken(token);
    if (!row) return { kind: "partner" as const, status: "invalid" as const };
    const status = inviteStatus(row);
    if (status !== "pending") return { kind: "partner" as const, status };
    return {
      kind: "partner" as const,
      status,
      email: row.email,
      name: row.name,
      orgName: row.org_name,
      partnerName: row.partner_name,
      expiresAt: row.expires_at,
    };
  }

  /**
   * "Continue with Google" was pressed. Pre-create the GoTrue user so a
   * deployment with sign-ups switched off can still let this one person in -
   * `SupabaseAdminService.ensureUser`'s reason, unchanged.
   */
  async prepare(token: string): Promise<{ email: string }> {
    if (!this.supabase.configured) {
      refuse(503, "not_configured", "Sign-in is not configured on this platform yet. Ask your administrator.");
    }
    const row = await this.findByToken(token);
    if (!row) refuse(404, "invalid", "This invite link isn't valid.");
    assertInvitePending(row);

    const ensured = await this.supabase.ensureUser(row.email, {
      invited_to_org: row.org_id,
      invited_as_partner: row.partner_id,
    });
    if (ensured.created) {
      await this.db.withOrg(row.org_id, (client) =>
        client.query(`UPDATE partner_invites SET prepared_subject = $1 WHERE id = $2`, [
          ensured.id,
          row.id,
        ]),
      );
    }
    return { email: row.email };
  }

  /**
   * Back from Google holding the token: become a partner contact.
   *
   * Everything about WHO this is comes from GoTrue's answer to the access
   * token, never from the request body. `assertMayAcceptInvite` is the same
   * three checks the owner flow applies - Google proved the address, the
   * session came through Google rather than a password somebody chose, and it
   * is the address the invite was sent to - so a forwarded or leaked link lets
   * nobody in but the person it was addressed to.
   */
  async accept(token: string, accessToken: string) {
    if (!this.supabase.configured) {
      refuse(503, "not_configured", "Sign-in is not configured on this platform yet. Ask your administrator.");
    }
    const found = await this.findByToken(token);
    if (!found) refuse(404, "invalid", "This invite link isn't valid.");
    assertInvitePending(found);

    const user = await this.supabase.userFromAccessToken(accessToken);
    if (!user) refuse(401, "not_signed_in", "Your Google sign-in didn't complete. Try again.");
    assertMayAcceptInvite(found, user);

    // Decided BEFORE the transaction, because it needs a GoTrue round trip and
    // a row lock should not be held across the internet (invites.service.ts
    // makes the same move for the same reason).
    const bound = await this.db.adminPool().query<{ id: string; sso_subject: string | null }>(
      `SELECT id, sso_subject FROM users WHERE lower(email) = $1 ORDER BY created_at ASC LIMIT 1`,
      [found.email],
    );
    const existing = bound.rows[0] ?? null;
    if (existing?.sso_subject && existing.sso_subject !== user.id) {
      const other = await this.supabase.getUserById(existing.sso_subject);
      if (other) {
        refuse(409, "other_login", `${found.email} already signs in with a different account. Ask your administrator to reconcile it.`);
      }
    }

    return this.db.withOrg(found.org_id, async (client) => {
      // The lock is what makes "single use" true under a double click.
      const {
        rows: [invite],
      } = await client.query<InviteRow>(
        `SELECT * FROM partner_invites WHERE id = $1 FOR UPDATE`,
        [found.id],
      );
      if (!invite) refuse(404, "invalid", "This invite link isn't valid.");
      assertInvitePending(invite);

      // One human, one `users` row. Looked up case-insensitively because
      // `users.email` is unique on its RAW value, so an INSERT ... ON CONFLICT
      // (email) would miss "Asha@x.com" and make a second row for her.
      const {
        rows: [current],
      } = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE lower(email) = $1 ORDER BY created_at ASC LIMIT 1 FOR UPDATE`,
        [invite.email],
      );
      let userId: string;
      if (current) {
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

      // ── The membership that is NOT written ────────────────────────────────
      //
      // This is the whole difference between this method and
      // `InvitesService.accept`, and it is one INSERT that is absent rather
      // than present. A partner has no `memberships` row: that pair - a
      // partner_users row and no membership - IS the definition of a partner
      // principal that `PartnerScopeGuard` resolves on, and 0163's trigger
      // refuses this INSERT outright if the address already belongs to a
      // member of this workspace.
      await client.query(
        `INSERT INTO partner_users (org_id, partner_id, user_id, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (partner_id, user_id) DO UPDATE SET status = 'active'`,
        [invite.org_id, invite.partner_id, userId, invite.role],
      );

      await client.query(
        `UPDATE partner_invites SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1`,
        [invite.id, userId],
      );
      // A partner going live is the moment the relationship starts, and the
      // tenant's roster should say 'active' without somebody going and
      // clicking it. Only from 'pending': a suspended partner whose contact
      // accepts an old link must NOT let themselves back in.
      await client.query(
        `UPDATE partners SET status = 'active', onboarded_at = COALESCE(onboarded_at, now())
          WHERE id = $1 AND status = 'pending'`,
        [invite.partner_id],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'partner.invite.accept', 'partner', $3)`,
        [invite.org_id, userId, invite.partner_id],
      );

      const {
        rows: [org],
      } = await client.query<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [invite.org_id]);
      return { kind: "partner" as const, orgName: org?.name ?? "" };
    });
  }

  /**
   * Admin pool: the token is what names the org, so there is no org to scope
   * to until it has been looked up. The unique index on the hash makes this
   * one row or none.
   */
  private async findByToken(token: string): Promise<(InviteRow & { org_name: string; partner_name: string }) | null> {
    if (!isWellFormedInviteToken(token)) return null;
    const { rows } = await this.db.adminPool().query(
      `SELECT i.*, o.name AS org_name, p.name AS partner_name
         FROM partner_invites i
         JOIN organizations o ON o.id = i.org_id
         JOIN partners p      ON p.id = i.partner_id
        WHERE i.token_hash = $1`,
      [hashInviteToken(token)],
    );
    return rows[0] ?? null;
  }
}

interface InviteRow {
  id: string;
  org_id: string;
  partner_id: string;
  email: string;
  name: string | null;
  role: string;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
}
