import { Injectable } from "@nestjs/common";
import { DbService } from "../../db/db.service";
import {
  operatorInviteMailContent,
  platformMailConfig,
  sendOperatorInviteMail,
} from "../owner/invite-mail";
import {
  assertInvitePending,
  assertMayAcceptInvite,
  refuse,
} from "../owner/invite-guards";
import {
  generateInviteToken,
  hashInviteToken,
  inviteLink,
  inviteStatus,
  inviteTtlHours,
  isWellFormedInviteToken,
  normaliseEmail,
  type InviteStatus,
} from "../owner/invite-token";
import { SupabaseAdminService } from "../owner/supabase-admin.service";

/**
 * Inviting a superadmin (migration 0145, doc 34 Part C).
 *
 * ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
 *
 * Appointing a superadmin wrote a `platform_operators` row and stopped there. To
 * let that person in, the root then pressed "create login", got a generated
 * password back in the HTTP response - shown once - and passed it on by hand.
 * The Superadmins page said as much: "sign-in is email and password, with no
 * magic link and no forgotten-password mail".
 *
 * Google sign-in already worked, and `isOperator` never cared how a session was
 * created; only the invitation was missing. So this is a small service, and the
 * password endpoints on OperatorsController deliberately stay as the recovery
 * path for when Google is unreachable or switched off.
 *
 * ── NO withOrg, ANYWHERE ────────────────────────────────────────────────────
 *
 * `InvitesService` is the org-scoped sibling of this file and every read in it
 * goes through `db.withOrg(orgId, ...)` to set an RLS context. There is no org
 * here to set one with, so every statement runs on `db.adminPool()` - the same
 * reason `platform_operators` itself is admin-pool-only, and why 0145 revokes
 * that table from `aura_app`.
 *
 * ── AND NO IDENTITY CHECK ───────────────────────────────────────────────────
 *
 * "Only the root may invite a superadmin" is NOT enforced here, for the reason
 * OperatorsController's header spells out at length: every console request
 * reaches this API on one shared `ADMIN_API_KEY` and is minted `platform_admin`,
 * so the API cannot tell one operator from another and a header claiming an
 * identity would be forgeable by anyone holding that key. That check lives in the
 * web tier, in `requireMax()`, which is the only layer that knows which human is
 * asking.
 *
 * What this layer enforces is the invariants that hold without knowing the
 * caller, and they are below: the root is never invited (it is not a row), and an
 * address that is already a superadmin is not invited again.
 */

export interface OperatorInviteSummary {
  id: string;
  email: string;
  note: string | null;
  status: InviteStatus;
  expiresAt: string;
  createdAt: string;
  invitedBy: string;
  emailedAt: string | null;
}

export interface IssuedOperatorInvite {
  invite: OperatorInviteSummary;
  /** Shown to the root ONCE. The database keeps only its hash. */
  link: string;
  emailed: boolean;
  /** Why it was not emailed, when sending was asked for. */
  emailError: string | null;
}

interface InviteRow {
  id: string;
  email: string;
  note: string | null;
  expires_at: Date;
  created_at: Date;
  invited_by: string;
  emailed_at: Date | null;
  prepared_subject: string | null;
  accepted_at: Date | null;
  revoked_at: Date | null;
}

const COLUMNS = `id, email, note, expires_at, created_at, invited_by, emailed_at,
                 prepared_subject, accepted_at, revoked_at`;

@Injectable()
export class OperatorInvitesService {
  constructor(
    private readonly db: DbService,
    private readonly supabase: SupabaseAdminService,
  ) {}

  /** Can the platform mail an invite? The form says so before asking. */
  get mailConfigured(): boolean {
    return platformMailConfig() !== null;
  }

  /** The root, from the environment. Never read from a table. */
  private root(): string {
    return (process.env.PLATFORM_ROOT_OPERATOR_EMAIL ?? "").trim().toLowerCase();
  }

  private summary(row: InviteRow): OperatorInviteSummary {
    return {
      id: row.id,
      email: row.email,
      note: row.note,
      status: inviteStatus(row),
      expiresAt: row.expires_at.toISOString(),
      createdAt: row.created_at.toISOString(),
      invitedBy: row.invited_by,
      emailedAt: row.emailed_at?.toISOString() ?? null,
    };
  }

  /**
   * Every invite, newest first - including spent and revoked ones.
   *
   * Readable by every operator, not only the root, for the same reason the
   * superadmin list itself is: knowing who else was offered the keys is not a
   * privilege, and a list nobody can see is a list nobody audits.
   */
  async list(): Promise<OperatorInviteSummary[]> {
    const { rows } = await this.db
      .adminPool()
      .query<InviteRow>(
        `SELECT ${COLUMNS} FROM platform_operator_invites ORDER BY created_at DESC LIMIT 200`,
      );
    return rows.map((r) => this.summary(r));
  }

  async issue(input: {
    email: string;
    note?: string;
    ttlHours?: number;
    sendEmail: boolean;
    invitedBy: string;
  }): Promise<IssuedOperatorInvite> {
    const email = normaliseEmail(input.email);
    if (!email) refuse(400, "invalid", "Enter an email address.");

    // The root is defined by the environment and must have exactly one source.
    // A row - or an invite that would create one - is a second, deletable copy
    // of an identity that cannot be allowed to have two.
    if (email === this.root()) {
      refuse(
        409,
        "invalid",
        "That address is the root operator, which is set in the deployment's environment and already has access.",
      );
    }

    const existing = await this.db
      .adminPool()
      .query(`SELECT 1 FROM platform_operators WHERE email = $1`, [email]);
    if ((existing.rowCount ?? 0) > 0) {
      refuse(409, "accepted", `${email} is already a superadmin.`);
    }

    const token = generateInviteToken();
    const hours = inviteTtlHours(input.ttlHours);
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);

    let row: InviteRow;
    try {
      const { rows } = await this.db.adminPool().query<InviteRow>(
        `INSERT INTO platform_operator_invites (email, note, token_hash, expires_at, invited_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${COLUMNS}`,
        [email, input.note?.trim() || null, hashInviteToken(token), expiresAt, input.invitedBy],
      );
      row = rows[0];
    } catch (err) {
      // Matched on the CONSTRAINT, not just the 23505 code. Two unique indexes
      // can raise it: `platform_operator_invites_live` (the partial one - an
      // address already has a live invite) and the token_hash key. Only the first
      // is a thing the root can act on, and reporting a 1-in-2^256 token
      // collision as "revoke it first" would send them looking for an invite that
      // does not exist.
      //
      // The live index is reported rather than silently replacing the outstanding
      // invite, because the link already in somebody's inbox would stop working
      // with nothing to say why.
      const pg = err as { code?: string; constraint?: string };
      if (pg.code === "23505" && pg.constraint === "platform_operator_invites_live") {
        refuse(
          409,
          "invalid",
          `${email} already has an invite outstanding. Revoke it first, or resend it.`,
        );
      }
      throw err;
    }

    const { emailed, emailError } = await this.maybeMail(row, token, input.sendEmail);
    return { invite: this.summary({ ...row, emailed_at: emailed ? new Date() : null }), link: inviteLink(token), emailed, emailError };
  }

  /**
   * A fresh token for the same address.
   *
   * The old token stops working, which is the point: an invite that was mislaid
   * should not stay live alongside its replacement.
   */
  async resend(id: string, opts: { sendEmail: boolean }): Promise<IssuedOperatorInvite> {
    const found = await this.byId(id);
    assertInvitePending(found);

    const token = generateInviteToken();
    const { rows } = await this.db.adminPool().query<InviteRow>(
      `UPDATE platform_operator_invites SET token_hash = $1, expires_at = $2, emailed_at = NULL
       WHERE id = $3 RETURNING ${COLUMNS}`,
      [hashInviteToken(token), new Date(Date.now() + inviteTtlHours(null) * 60 * 60 * 1000), id],
    );
    const row = rows[0];
    const { emailed, emailError } = await this.maybeMail(row, token, opts.sendEmail);
    return { invite: this.summary({ ...row, emailed_at: emailed ? new Date() : null }), link: inviteLink(token), emailed, emailError };
  }

  /**
   * Withdraw it.
   *
   * If `prepare` created a GoTrue user for this address and the invite was never
   * accepted, that user is deleted too - otherwise revoking would leave behind a
   * confirmed auth account for somebody who was never let in. Only when no
   * platform user is bound to it, and never for an accepted invite: by then the
   * login is somebody's real login.
   */
  async revoke(id: string): Promise<{ revoked: true }> {
    const found = await this.byId(id);
    if (found.accepted_at) {
      refuse(
        409,
        "accepted",
        "That invite was already accepted. Remove them from the superadmin list instead.",
      );
    }
    await this.db
      .adminPool()
      .query(`UPDATE platform_operator_invites SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [id]);

    if (found.prepared_subject) {
      const bound = await this.db
        .adminPool()
        .query(`SELECT 1 FROM users WHERE sso_subject = $1`, [found.prepared_subject]);
      if ((bound.rowCount ?? 0) === 0) {
        await this.supabase.deleteUser(found.prepared_subject).catch(() => {
          // Best effort. The invite is revoked either way, which is the part
          // that decides access; an orphaned auth user grants nothing on its own
          // because `isOperator` reads platform_operators, not GoTrue.
        });
      }
    }
    return { revoked: true };
  }

  /**
   * Does this token belong to a SUPERADMIN invite?
   *
   * How the public routes tell the two kinds apart. A token is opaque and carries
   * no hint of which table issued it - deliberately, since encoding the kind in
   * the link would tell whoever found one what it is worth. So the acceptance
   * path asks here first and falls through to the org invites otherwise.
   *
   * Answers on the hash, never on the token, and answers `false` for anything
   * malformed without touching the database.
   */
  async knows(token: string): Promise<boolean> {
    return (await this.findByToken(token)) !== null;
  }

  /** What the public invite page shows before anybody signs in. */
  async preview(
    token: string,
  ): Promise<
    | { kind: "operator"; status: "pending"; email: string; invitedBy: string; expiresAt: string }
    | { kind: "operator"; status: Exclude<InviteStatus, "pending"> | "invalid" }
  > {
    const row = await this.findByToken(token);
    if (!row) return { kind: "operator", status: "invalid" };
    const status = inviteStatus(row);
    if (status !== "pending") return { kind: "operator", status };
    return {
      kind: "operator",
      status,
      email: row.email,
      invitedBy: row.invited_by,
      expiresAt: row.expires_at.toISOString(),
    };
  }

  /**
   * Called when the invitee presses "Continue with Google", before the redirect.
   * Refuses a dead invite early - so nobody is sent through Google for nothing -
   * and makes sure GoTrue has a user for the address, which a deployment with
   * sign-ups switched off otherwise would not.
   */
  async prepare(token: string): Promise<{ email: string }> {
    if (!this.supabase.configured) {
      refuse(503, "not_configured", "Sign-in is not configured on this platform yet.");
    }
    const row = await this.findByToken(token);
    if (!row) refuse(404, "invalid", "This invite link isn't valid.");
    assertInvitePending(row);

    const ensured = await this.supabase.ensureUser(row.email, { platform_operator: true });
    if (ensured.created) {
      await this.db
        .adminPool()
        .query(`UPDATE platform_operator_invites SET prepared_subject = $1 WHERE id = $2`, [
          ensured.id,
          row.id,
        ]);
    }
    return { email: row.email };
  }

  /**
   * Accept. `accessToken` is the Supabase session the OAuth callback just
   * received; everything about who this is comes from GoTrue's answer to it.
   *
   * The two writes are ONE transaction. A `platform_operators` row with the
   * invite still pending means the link keeps working after it has been used -
   * which, for a grant this wide, is the one outcome worth a transaction.
   */
  async accept(token: string, accessToken: string): Promise<{ email: string }> {
    if (!this.supabase.configured) {
      refuse(503, "not_configured", "Sign-in is not configured on this platform yet.");
    }
    const found = await this.findByToken(token);
    if (!found) refuse(404, "invalid", "This invite link isn't valid.");
    assertInvitePending(found);

    const user = await this.supabase.userFromAccessToken(accessToken);
    if (!user) refuse(401, "not_signed_in", "Your Google sign-in didn't complete. Try again.");
    assertMayAcceptInvite(found, user);

    const client = await this.db.adminPool().connect();
    try {
      await client.query("BEGIN");
      // Re-read under a row lock: two tabs on the same link would otherwise both
      // pass the checks above and both try to spend it.
      const { rows } = await client.query<InviteRow>(
        `SELECT ${COLUMNS} FROM platform_operator_invites WHERE id = $1 FOR UPDATE`,
        [found.id],
      );
      const locked = rows[0];
      if (!locked) refuse(404, "invalid", "This invite link isn't valid.");
      assertInvitePending(locked);

      await client.query(
        `INSERT INTO platform_operators (email, added_by, note)
         VALUES ($1, $2, $3)
         ON CONFLICT (email) DO NOTHING`,
        [locked.email, locked.invited_by, locked.note],
      );
      await client.query(`UPDATE platform_operator_invites SET accepted_at = now() WHERE id = $1`, [
        locked.id,
      ]);
      await client.query("COMMIT");
      return { email: locked.email };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /** Exported shape of the mail body, so a test can assert it without SMTP. */
  static mailPreview = operatorInviteMailContent;

  private async maybeMail(
    row: InviteRow,
    token: string,
    send: boolean,
  ): Promise<{ emailed: boolean; emailError: string | null }> {
    if (!send) return { emailed: false, emailError: null };
    const config = platformMailConfig();
    // Not an error. Issuing must still succeed with the link shown to copy -
    // that is the only way to invite anybody on a deployment without SMTP.
    if (!config) return { emailed: false, emailError: "Email is not configured on this platform." };
    try {
      await sendOperatorInviteMail(config, {
        to: row.email,
        inviterName: row.invited_by,
        link: inviteLink(token),
        expiresAt: row.expires_at,
      });
      await this.db
        .adminPool()
        .query(`UPDATE platform_operator_invites SET emailed_at = now() WHERE id = $1`, [row.id]);
      return { emailed: true, emailError: null };
    } catch (err) {
      return { emailed: false, emailError: (err as Error).message.slice(0, 200) };
    }
  }

  private async byId(id: string): Promise<InviteRow> {
    const { rows } = await this.db
      .adminPool()
      .query<InviteRow>(`SELECT ${COLUMNS} FROM platform_operator_invites WHERE id = $1`, [id]);
    if (!rows[0]) refuse(404, "invalid", "That invite no longer exists.");
    return rows[0];
  }

  /**
   * Look one up by the token the invitee holds.
   *
   * The shape is checked before the database is touched: a malformed token is a
   * 404 without a query, so this public route cannot be used to make the
   * database work for an attacker one guess at a time.
   */
  private async findByToken(token: string): Promise<InviteRow | null> {
    if (!isWellFormedInviteToken(token)) return null;
    const { rows } = await this.db
      .adminPool()
      .query<InviteRow>(`SELECT ${COLUMNS} FROM platform_operator_invites WHERE token_hash = $1`, [
        hashInviteToken(token),
      ]);
    return rows[0] ?? null;
  }
}
