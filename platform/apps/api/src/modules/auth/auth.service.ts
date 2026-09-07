import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { Injectable } from "@nestjs/common";
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
   * or a login screen that already knows which tenant it's for) - when given
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
         -- Suspended memberships (0102) are not memberships for the purposes of
         -- signing in. A user whose only membership is suspended has no row
         -- here and the login fails as though the account did not exist, which
         -- is the same outcome contextFor produces for the console.
         JOIN memberships m ON m.user_id = u.id AND m.status = 'active'
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
   * because the whole point is to discover WHICH org context to use - there is
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
      /**
       * The org's sparse feature overrides (migration 0101), raw. Resolved by
       * the caller through `resolveFeatures` rather than here, so the API and
       * the web tier run the SAME entitlement-and-dependency logic - two
       * resolutions of one catalogue is exactly how a sidebar ends up offering
       * a page the API refuses.
       */
      featureOverrides: Record<string, boolean>;
    }>;
    user: { id: string; email: string; name: string | null; status: string } | null;
  }> {
    // ONE round trip, not two. The web console calls this on every single
    // navigation - it is how a Supabase session becomes an org - and the two
    // queries this replaces ran back to back against a database in AWS Seoul
    // while the API runs in Mumbai, so the second lookup cost ~125ms of pure
    // flight time on every page in the product.
    //
    // The dependency that forced the split (memberships need `users.id`, which
    // only the first query knows) is expressed as a CTE instead, so Postgres
    // resolves it server-side in a single exchange. LEFT JOIN, not JOIN: a user
    // holding no memberships must still come back as a found user, exactly as
    // it did when the membership query simply returned no rows.
    const { rows } = await this.db.adminPool().query(
      `WITH u AS (
         SELECT id, email, name, status FROM users
          WHERE ($1::text IS NOT NULL AND sso_subject = $1)
             OR ($2::text IS NOT NULL AND lower(email) = lower($2))
          ORDER BY (sso_subject = $1) DESC NULLS LAST
          LIMIT 1
       )
       SELECT u.id AS "userId", u.email AS "userEmail", u.name AS "userName",
              u.status AS "userStatus",
              m.org_id AS "orgId", o.name AS "orgName", o.status AS "orgStatus", m.role,
              m.owner_role AS "ownerRole",
              m.recordings_listen AS "recordingsListen",
              m.recordings_export AS "recordingsExport",
              (SELECT w.id FROM workspaces w WHERE w.org_id = m.org_id
                ORDER BY w.created_at ASC LIMIT 1) AS "workspaceId",
              o.enabled_modules AS "enabledModules",
              -- The client's own switchboard (0101), aggregated in the same
              -- exchange. This query runs on every navigation in the console;
              -- a second lookup would cost ~125ms of Mumbai->Seoul flight time
              -- per page, which is the whole reason this is one CTE already.
              COALESCE(
                (SELECT jsonb_object_agg(f.feature_key, f.enabled)
                   FROM org_feature_settings f WHERE f.org_id = m.org_id),
                '{}'::jsonb) AS "featureOverrides"
         FROM u
         LEFT JOIN memberships m
           -- Suspended memberships (0102) are dropped HERE, which is what makes
           -- suspension real rather than decorative. This is how a Supabase
           -- session becomes an org, so a membership that does not come back is
           -- a console the person cannot open at all - not a page they are
           -- refused on, the whole thing. One predicate, in the one place every
           -- console request already passes through, and it cannot be forgotten
           -- by a route added later.
           --
           -- The precedent is directly below: userStatus <> 'active' already
           -- empties this response for a platform-disabled account. This is the
           -- same rule one level down, where a customer is allowed to apply it.
           ON m.user_id = u.id AND m.status = 'active'
         LEFT JOIN organizations o ON o.id = m.org_id
        ORDER BY m.created_at ASC`,
      [identity.subject ?? null, identity.email ?? null],
    );

    const found = rows[0];
    if (!found || found.userStatus !== "active") return { memberships: [], user: null };

    const user = {
      id: found.userId,
      email: found.userEmail,
      name: found.userName,
      status: found.userStatus,
    };

    // A user with no memberships still produces one row, with every membership
    // column NULL from the LEFT JOIN - that is "found, but unbound", not a
    // membership in an org whose id is null. Drop those rows.
    const memberships = rows
      .filter((r) => r.orgId !== null)
      .map((r) => ({
        orgId: r.orgId,
        orgName: r.orgName,
        orgStatus: r.orgStatus,
        role: r.role,
        ownerRole: r.ownerRole,
        recordingsListen: r.recordingsListen,
        recordingsExport: r.recordingsExport,
        workspaceId: r.workspaceId,
        enabledModules: r.enabledModules,
        featureOverrides: (r.featureOverrides ?? {}) as Record<string, boolean>,
      }));

    return { memberships, user };
  }

  /**
   * The owner-console persona a real membership actually carries - used by
   * `OwnerRoleGuard` to enforce `@RequireOwnerRole` for an admin-key caller
   * (checklist 08 §2.5), instead of trusting the `x-caller-owner-role` header
   * the same caller supplied. A Bearer session never needs this: its
   * `ownerRole` was already read from this same table at token-resolution
   * time (`principalFromToken`, above), not from anything the client sent.
   *
   * Three distinct outcomes, and the caller must be able to tell them apart:
   *   - `undefined` - no membership row for this (user, org) pair AT ALL.
   *     There is nothing here to derive a persona from, so there is nothing
   *     to grant based on one; the caller treats this as a denial.
   *   - `null` - a membership row exists but its `owner_role` predates 0018.
   *     `resolveOwnerRole(null)` already has a documented default for this
   *     (the most permissive persona) and that default must apply the same
   *     way regardless of which auth mechanism resolved the membership.
   *   - a real `OwnerRole` - the membership names one.
   */
  async ownerRoleFor(userId: string, orgId: string): Promise<OwnerRole | null | undefined> {
    const {
      rows: [row],
    } = await this.db.adminPool().query<{ owner_role: string | null }>(
      // `status = 'active'` (0102) makes a suspended membership indistinguishable
      // from no membership, so every `@RequireOwnerRole` route denies. Belt and
      // braces beside `contextFor`'s filter: that one closes the console, this
      // one closes the API, and neither depends on the other being right.
      `SELECT owner_role FROM memberships
        WHERE user_id = $1 AND org_id = $2 AND status = 'active'`,
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
         -- Suspension takes effect on the NEXT request, not at the next login:
         -- a bearer token issued before somebody was suspended stops resolving
         -- here. Without this the person would keep working until their session
         -- expired, which is exactly the window suspension exists to close.
         JOIN memberships m
           ON m.user_id = s.user_id AND m.org_id = s.org_id AND m.status = 'active'
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
    await this.db
      .adminPool()
      .query("DELETE FROM sessions WHERE token_hash = $1", [AuthService.tokenHash(token)]);
  }
}
