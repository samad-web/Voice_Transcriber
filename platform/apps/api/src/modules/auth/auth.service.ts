import { Injectable } from "@nestjs/common";
import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { DbService } from "../../db/db.service";
import type { Principal } from "../../common/auth-principal";

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
  async login(email: string, password: string): Promise<{ token: string; principal: Principal } | null> {
    const {
      rows: [row],
    } = await this.db.adminPool().query(
      `SELECT u.id AS user_id, u.password_hash, u.status,
              m.org_id, m.role, m.recordings_listen, m.recordings_export
         FROM users u
         JOIN memberships m ON m.user_id = u.id
        WHERE lower(u.email) = lower($1)
        ORDER BY m.created_at ASC
        LIMIT 1`,
      [email],
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
      },
    };
  }

  /** Resolve a session bearer token to a principal (used by the guard). */
  async principalFromToken(token: string): Promise<Principal | null> {
    const {
      rows: [row],
    } = await this.db.adminPool().query(
      `SELECT s.user_id, s.org_id, m.role, m.recordings_listen, m.recordings_export
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
    };
  }

  async logout(token: string): Promise<void> {
    await this.db.adminPool().query("DELETE FROM sessions WHERE token_hash = $1", [
      AuthService.tokenHash(token),
    ]);
  }
}
