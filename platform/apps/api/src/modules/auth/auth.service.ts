import { Injectable } from "@nestjs/common";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { OwnerRole } from "@aura/shared";
import { DbService } from "../../db/db.service";
import type { Principal } from "../../common/auth-principal";

/** Null when the row's `owner_role` is unset or predates personas. */
function parseOwnerRole(raw: unknown): OwnerRole | null {
  const parsed = OwnerRole.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const SESSION_TTL_DAYS = 7;

@Injectable()
export class AuthService {
  constructor(private readonly db: DbService) {}

  // ── password hashing (scrypt) ──────────────────────────────────────────
  static hashPassword(password: string): string {
    const salt = randomBytes(16);
    const hash = scryptSync(password, salt, 32);
    return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
  }

  static verifyPassword(password: string, stored: string | null): boolean {
    if (!stored) return false;
    const [scheme, saltHex, hashHex] = stored.split("$");
    if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  private static tokenHash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  // ── login: verify credentials, resolve org+role, mint a session ────────
  /**
   * `orgId` is an optional caller hint (e.g. a returning user's last-used org,
   * or a login screen that already knows which tenant it's for) — when given
   * AND the user actually has that membership, it wins; otherwise this falls
   * back to the earliest-created membership, same as before `orgId` existed.
   * That fallback is what let a multi-org user sign in at all before this hint
   * was plumbed through, so it stays rather than becoming an error: a stale or
   * wrong hint should degrade to "your first org", not lock the user out.
   */
  async login(
    email: string,
    password: string,
    orgId?: string,
  ): Promise<{ token: string; principal: Principal } | null> {
    const {
      rows: [row],
    } = await this.db.adminPool().query(
      `SELECT u.id AS user_id, u.password_hash, u.status,
              m.org_id, m.role, m.owner_role, m.recordings_listen, m.recordings_export
         FROM users u
         JOIN memberships m ON m.user_id = u.id
        WHERE lower(u.email) = lower($1)
        -- The requested org sorts first when the caller supplied one AND the
        -- user actually belongs to it; ties (no hint, or a hint that doesn't
        -- match any membership) fall through to the original ordering.
        ORDER BY ($2::uuid IS NOT NULL AND m.org_id = $2) DESC, m.created_at ASC
        LIMIT 1`,
      [email, orgId ?? null],
    );
    if (!row || row.status !== "active") return null;
    if (!AuthService.verifyPassword(password, row.password_hash)) return null;

    const token = `aus_${randomBytes(32).toString("base64url")}`;
    await this.db.withOrg(row.org_id, (client) =>
      client.query(
        `INSERT INTO sessions (org_id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, now() + make_interval(days => $4))`,
        [row.org_id, row.user_id, AuthService.tokenHash(token), SESSION_TTL_DAYS],
      ),
    );

    return {
      token,
      principal: {
        userId: row.user_id,
        orgId: row.org_id,
        role: row.role,
        recordingsListen: row.recordings_listen,
        recordingsExport: row.recordings_export,
        viaAdminKey: false,
        ownerRole: parseOwnerRole(row.owner_role),
      },
    };
  }

  /**
   * Resolve an external identity (Supabase Auth subject, or the email it signed
   * in with) to the orgs it belongs to.
   *
   * Matching on the subject is authoritative; email is the fallback for an
   * account provisioned before the subject was linked. Runs on the admin pool
   * because the whole point is to discover WHICH org context to use — there is
   * none yet to scope the query with.
   */
  async contextFor(identity: { subject?: string; email?: string }): Promise<{
    memberships: Array<{
      orgId: string;
      orgName: string;
      orgStatus: string;
      role: string;
      ownerRole: string | null;
      recordingsListen: boolean;
      recordingsExport: boolean;
      workspaceId: string | null;
      enabledModules: string[];
    }>;
    user: { id: string; email: string; name: string | null; status: string } | null;
  }> {
    const {
      rows: [user],
    } = await this.db.adminPool().query(
      `SELECT id, email, name, status FROM users
        WHERE ($1::text IS NOT NULL AND sso_subject = $1)
           OR ($2::text IS NOT NULL AND lower(email) = lower($2))
        ORDER BY (sso_subject = $1) DESC NULLS LAST
        LIMIT 1`,
      [identity.subject ?? null, identity.email ?? null],
    );
    if (!user || user.status !== "active") return { memberships: [], user: null };

    const { rows } = await this.db.adminPool().query(
      `SELECT m.org_id AS "orgId", o.name AS "orgName", o.status AS "orgStatus", m.role,
              m.owner_role AS "ownerRole",
              m.recordings_listen AS "recordingsListen",
              m.recordings_export AS "recordingsExport",
              (SELECT w.id FROM workspaces w WHERE w.org_id = m.org_id
                ORDER BY w.created_at ASC LIMIT 1) AS "workspaceId",
              o.enabled_modules AS "enabledModules"
         FROM memberships m
         JOIN organizations o ON o.id = m.org_id
        WHERE m.user_id = $1
        ORDER BY m.created_at ASC`,
      [user.id],
    );

    return { memberships: rows, user };
  }

  /**
   * The owner-console persona a real membership actually carries — used by
   * `OwnerRoleGuard` to enforce `@RequireOwnerRole` for an admin-key caller
   * (checklist 08 §2.5), instead of trusting the `x-caller-owner-role` header
   * the same caller supplied. A Bearer session never needs this: its
   * `ownerRole` was already read from this same table at token-resolution
   * time (`principalFromToken`, above), not from anything the client sent.
   *
   * Three distinct outcomes, and the caller must be able to tell them apart:
   *   - `undefined` — no membership row for this (user, org) pair AT ALL.
   *     There is nothing here to derive a persona from, so there is nothing
   *     to grant based on one; the caller treats this as a denial.
   *   - `null` — a membership row exists but its `owner_role` predates 0018.
   *     `resolveOwnerRole(null)` already has a documented default for this
   *     (the most permissive persona) and that default must apply the same
   *     way regardless of which auth mechanism resolved the membership.
   *   - a real `OwnerRole` — the membership names one.
   */
  async ownerRoleFor(userId: string, orgId: string): Promise<OwnerRole | null | undefined> {
    const {
      rows: [row],
    } = await this.db.adminPool().query<{ owner_role: string | null }>(
      `SELECT owner_role FROM memberships WHERE user_id = $1 AND org_id = $2`,
      [userId, orgId],
    );
    if (!row) return undefined;
    return parseOwnerRole(row.owner_role);
  }

  /** Resolve a session bearer token to a principal (used by the guard). */
  async principalFromToken(token: string): Promise<Principal | null> {
    const {
      rows: [row],
    } = await this.db.adminPool().query(
      `SELECT s.user_id, s.org_id, m.role, m.owner_role, m.recordings_listen, m.recordings_export
         FROM sessions s
         JOIN memberships m ON m.user_id = s.user_id AND m.org_id = s.org_id
        WHERE s.token_hash = $1 AND s.expires_at > now()
        LIMIT 1`,
      [AuthService.tokenHash(token)],
    );
    if (!row) return null;
    return {
      userId: row.user_id,
      orgId: row.org_id,
      role: row.role,
      recordingsListen: row.recordings_listen,
      recordingsExport: row.recordings_export,
      viaAdminKey: false,
      ownerRole: parseOwnerRole(row.owner_role),
    };
  }

  async logout(token: string): Promise<void> {
    await this.db.adminPool().query("DELETE FROM sessions WHERE token_hash = $1", [
      AuthService.tokenHash(token),
    ]);
  }
}
