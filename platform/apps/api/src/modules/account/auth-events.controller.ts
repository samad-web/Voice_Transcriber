import { isIP } from "node:net";
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  AUTH_EVENT_UA_MAX,
  AuthEventInput,
  FAILED_SIGN_IN_CAP_PER_HOUR,
  LOGIN_ACTIVITY_DAYS,
  LOGIN_ACTIVITY_PAGE_SIZE,
  decodeActivityCursor,
  encodeActivityCursor,
  type LoginActivityPage,
  type LoginActivityRow,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { CrossTenant, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ActivityQuery = z.object({ cursor: z.string().max(80).optional() });

/**
 * One sign-in event. Admin pool only (0127).
 *
 * A named constant so apps/api/verify-account-storage-setup.cjs can execute
 * this exact text against a real database - typecheck cannot see SQL.
 */
export const AUTH_EVENT_INSERT_SQL = `INSERT INTO auth_events
         (auth_user_id, user_id, kind, session_id, console, console_org_id, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7::inet, $8)`;

/**
 * A page of one person's history. $1 auth_user_id, $2 days, $3/$4 cursor, $5 limit.
 *
 * A named constant so apps/api/verify-account-storage-setup.cjs can execute
 * this exact text against a real database - typecheck cannot see SQL.
 */
export const LOGIN_ACTIVITY_SQL = `SELECT e.id::text AS id, e.kind, e.session_id, e.console, o.name AS org_name,
              host(e.ip) AS ip, e.user_agent, e.created_at,
              to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_at
         FROM auth_events e
         LEFT JOIN organizations o ON o.id = e.console_org_id
        WHERE e.auth_user_id = $1
          AND e.created_at > now() - make_interval(days => $2)
          AND ($3::timestamptz IS NULL OR (e.created_at, e.id) < ($3::timestamptz, $4::bigint))
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $5`;

/**
 * Sign-in history (doc 27 §5): the writes, and the one read.
 *
 * ── CROSS-TENANT, AND WHY THAT IS SAFE HERE ────────────────────────────────
 *
 * A platform operator has no org, and a failed sign-in has no session - so
 * neither route can carry the tenant pin every other owner-console route has.
 * The boundary is the PERSON instead: every read and every write is bound to
 * `principal.authUserId`, which AdminKeyGuard takes from `x-caller-auth-id`,
 * which the Next server sets from a verified getClaims(). There is no
 * parameter anywhere in this file that names whose history to read.
 *
 * `auth_events` is admin-pool only (0127: RLS forced with no policy, aura_app
 * revoked), so there is no withOrg here, deliberately.
 *
 * ── FAILED SIGN-INS ────────────────────────────────────────────────────────
 *
 * The one write with no session behind it. It names an email instead, which is
 * resolved to an account by a local SELECT on `users` - never a GoTrue call -
 * and records NOTHING when it matches nobody. The response is the same either
 * way, and the login form never looks at it: this route must not become a way
 * to learn which addresses have accounts. Capped per account per hour, so a
 * password spray cannot flood the table.
 */
@Controller("account")
@UseGuards(AdminKeyGuard, TenantGuard)
@CrossTenant()
export class AuthEventsController {
  constructor(private readonly db: DbService) {}

  @Post("auth-events")
  @HttpCode(200)
  async record(@Body() body: unknown, @Req() req: PrincipalRequest): Promise<{ recorded: boolean }> {
    const parsed = AuthEventInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const e = parsed.data;
    const admin = this.db.adminPool();

    let authUserId: string | null;
    let userId: string | null = null;

    if (e.kind === "sign_in_failed") {
      if (!e.email) throw new BadRequestException("a failed sign-in names the email that was typed");
      const {
        rows: [user],
      } = await admin.query<{ id: string; sso_subject: string | null }>(
        `SELECT id, sso_subject FROM users
          WHERE lower(email) = $1 AND sso_subject IS NOT NULL
          LIMIT 1`,
        [e.email],
      );
      // Unknown address, or an account never linked to a login: nothing to
      // attach it to, so nothing is written. Same response as a success.
      if (!user?.sso_subject || !UUID_RE.test(user.sso_subject)) return { recorded: false };
      authUserId = user.sso_subject;
      userId = user.id;

      const {
        rows: [recent],
      } = await admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM auth_events
          WHERE auth_user_id = $1 AND kind = 'sign_in_failed'
            AND created_at > now() - interval '1 hour'`,
        [authUserId],
      );
      if ((recent?.n ?? 0) >= FAILED_SIGN_IN_CAP_PER_HOUR) return { recorded: false };
    } else {
      authUserId = req.principal?.authUserId ?? null;
      if (!authUserId) throw new ForbiddenException("x-caller-auth-id is required");
      const {
        rows: [user],
      } = await admin.query<{ id: string }>(`SELECT id FROM users WHERE sso_subject = $1 LIMIT 1`, [authUserId]);
      userId = user?.id ?? null;
    }

    // Which console, and which workspace, when the web tier could not say -
    // a sign-in is recorded BEFORE the console the person lands in has been
    // resolved. A tenant user enters their first active workspace (the same
    // fallback getPrincipal uses without a switcher preference); someone with
    // no users row is an operator. Display only: nothing reads this back as a
    // boundary.
    let consoleKind = e.console;
    let consoleOrgId = e.orgId;
    if (e.kind === "sign_in" && consoleKind === null) {
      if (userId) {
        const {
          rows: [m],
        } = await admin.query<{ org_id: string }>(
          `SELECT org_id FROM memberships
            WHERE user_id = $1 AND status = 'active'
            ORDER BY created_at ASC LIMIT 1`,
          [userId],
        );
        consoleKind = m ? "owner" : "operator";
        consoleOrgId = m?.org_id ?? null;
      } else {
        consoleKind = "operator";
      }
    }

    // The web tier already picked the right-most proxy hop (lib/client-ip.ts);
    // anything that does not parse as an address is dropped rather than stored
    // into an `inet` column where it would throw.
    const ip = e.ip && isIP(e.ip.trim()) ? e.ip.trim() : null;
    const userAgent = e.userAgent ? e.userAgent.slice(0, AUTH_EVENT_UA_MAX) : null;

    await admin.query(
      AUTH_EVENT_INSERT_SQL,
      [authUserId, userId, e.kind, e.sessionId, consoleKind, consoleOrgId, ip, userAgent],
    );
    return { recorded: true };
  }

  /**
   * The caller's own sign-ins, last 90 days, newest first, 50 a page.
   *
   * Keyset on (created_at, id), not OFFSET: a sign-in landing while somebody
   * pages would otherwise shift every page by a row. The WHERE clause's first
   * predicate is the whole security model of this route.
   */
  @Get("login-activity")
  async loginActivity(@Query() query: unknown, @Req() req: PrincipalRequest): Promise<LoginActivityPage> {
    const authUserId = req.principal?.authUserId ?? null;
    if (!authUserId) throw new ForbiddenException("x-caller-auth-id is required");
    const parsed = ActivityQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const cursor = decodeActivityCursor(parsed.data.cursor);

    const { rows } = await this.db.adminPool().query<{
      id: string;
      kind: LoginActivityRow["kind"];
      session_id: string | null;
      console: LoginActivityRow["console"];
      org_name: string | null;
      ip: string | null;
      user_agent: string | null;
      created_at: Date;
      cursor_at: string;
    }>(
      // `cursor_at` keeps the MICROseconds a JS Date would drop. A cursor cut
      // at milliseconds would sit just below its own row, and every row
      // sharing that millisecond after it would silently fall between pages.
      LOGIN_ACTIVITY_SQL,
      [authUserId, LOGIN_ACTIVITY_DAYS, cursor?.createdAt ?? null, cursor?.id ?? "0", LOGIN_ACTIVITY_PAGE_SIZE + 1],
    );

    const page = rows.slice(0, LOGIN_ACTIVITY_PAGE_SIZE);
    const last = page[page.length - 1];
    return {
      rows: page.map((r) => ({
        id: r.id,
        kind: r.kind,
        sessionId: r.session_id,
        console: r.console,
        orgName: r.org_name,
        ip: r.ip,
        userAgent: r.user_agent,
        createdAt: r.created_at.toISOString(),
      })),
      next: rows.length > LOGIN_ACTIVITY_PAGE_SIZE && last ? encodeActivityCursor(last.cursor_at, last.id) : null,
    };
  }
}
