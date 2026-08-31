import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import {
  BasicConnectionInput,
  CONNECTION_PROVIDERS,
  connectionProvider,
  type ConnectionProviderSpec,
} from "@aura/shared";
import { encryptSecret } from "@aura/db";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import {
  buildAuthorizeUrl,
  emailFromIdToken,
  exchangeCode,
  newState,
  oauthClient,
  pkcePair,
  safeRedirectPath,
} from "./oauth";

const StartBody = z.object({
  provider: z.string().min(1).max(40),
  redirectPath: z.string().max(300).optional(),
});

const CompleteBody = z.object({
  state: z.string().min(1).max(200),
  code: z.string().min(1).max(4000),
});

/** Everything a console needs, and no credential material whatsoever. */
const CONNECTION_COLUMNS = `id, user_id, provider, capabilities, account_email, display_name,
  scopes, config, status, last_error, last_synced_at, token_expires_at, created_at, updated_at`;

const STATE_TTL_MINUTES = 10;

/**
 * A user's own email and calendar connections (PRD Layer 1).
 *
 * PROVIDER-AGNOSTIC BY CONSTRUCTION. Nothing here names Google or Microsoft;
 * every branch is driven by the catalogue in packages/shared/src/
 * connection-providers.ts. Generic IMAP/SMTP and CalDAV are first-class
 * entries in that catalogue rather than an afterthought, so a tenant on
 * neither big provider is not stuck.
 *
 * WHOSE CONNECTION. Every row belongs to a user, and the guard for these
 * routes is identity rather than the CRM permission grid: a rep managing
 * their own mailbox needs no grant, and no grant should let one rep touch
 * another's tokens. `assertSelf` enforces that both ways.
 *
 * A caller with no resolvable user — the bare admin key used by seed scripts
 * and ops tooling — can LIST providers but cannot create a connection, since
 * there is no "own mailbox" for it to be. That is a deliberate exception to
 * the carve-out CrmPermissionsGuard makes elsewhere: everywhere else the
 * admin key acts on the org's behalf, but a mailbox belongs to a person.
 *
 * CREDENTIALS NEVER LEAVE. `CONNECTION_COLUMNS` has no token column in it,
 * and nothing in this file selects one into a response.
 */
@Controller("connections")
@UseGuards(AdminKeyGuard, TenantGuard)
export class ConnectionsController {
  constructor(private readonly db: DbService) {}

  /**
   * The catalogue, with each entry marked configured or not.
   *
   * An OAuth provider needs a registered app, and only the operator can
   * create one. Reporting `configured: false` lets the console explain that
   * instead of offering a Connect button that dead-ends — the same
   * degrade-and-say-so shape 0042 uses for pg_trgm.
   */
  @Get("providers")
  providers() {
    return {
      providers: CONNECTION_PROVIDERS.map((spec) => ({
        id: spec.id,
        label: spec.label,
        blurb: spec.blurb,
        capabilities: spec.capabilities,
        auth: spec.auth,
        fields: spec.fields ?? [],
        configured: spec.auth === "basic" ? true : oauthClient(spec) !== null,
        setupHint:
          spec.auth === "oauth2" && oauthClient(spec) === null && spec.oauth
            ? `Set ${spec.oauth.clientIdEnv} and ${spec.oauth.clientSecretEnv} to enable this.`
            : null,
      })),
    };
  }

  /** The caller's own connections. Never another user's. */
  @Get()
  async list(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    const userId = callerUserId(req);
    return this.db.withOrg(orgId, async (client) => {
      // A caller with no identity has no connections — returning the org's
      // would hand one rep every other rep's mailbox list.
      if (!userId) return { connections: [] };
      const { rows } = await client.query(
        `SELECT ${CONNECTION_COLUMNS} FROM connected_accounts
          WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId],
      );
      return { connections: rows };
    });
  }

  /** Begin an OAuth handshake: mint state + PKCE, hand back the authorize URL. */
  @Post("oauth/start")
  async start(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = StartBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const userId = requireCallerUserId(req);

    const spec = requireProvider(parsed.data.provider);
    if (spec.auth !== "oauth2") {
      throw new BadRequestException(`${spec.label} does not use OAuth — use POST /connections`);
    }
    const client = oauthClient(spec);
    if (!client) {
      throw new BadRequestException(
        `${spec.label} is not configured on this deployment. ${
          spec.oauth ? `Set ${spec.oauth.clientIdEnv} and ${spec.oauth.clientSecretEnv}.` : ""
        }`,
      );
    }

    const state = newState();
    const pkce = spec.oauth?.pkce ? pkcePair() : null;

    return this.db.withOrg(orgId, async (db) => {
      await db.query(
        `INSERT INTO oauth_authorizations
           (state, org_id, user_id, provider, code_verifier, redirect_path, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' minutes')::interval)`,
        [
          state,
          orgId,
          userId,
          spec.id,
          pkce?.verifier ?? null,
          safeRedirectPath(parsed.data.redirectPath),
          String(STATE_TTL_MINUTES),
        ],
      );
      return { authorizeUrl: buildAuthorizeUrl(spec, client.clientId, state, pkce?.challenge ?? null) };
    });
  }

  /**
   * Redeem the code the provider sent back.
   *
   * The state row is deleted before the exchange runs, which makes the
   * handshake single-use: a replayed callback finds nothing and is rejected
   * rather than minting a second connection.
   */
  @Post("oauth/complete")
  async complete(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = CompleteBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const userId = requireCallerUserId(req);

    const pending = await this.db.withOrg(orgId, async (db) => {
      const {
        rows: [row],
      } = await db.query<{
        user_id: string;
        provider: string;
        code_verifier: string | null;
        redirect_path: string | null;
        expired: boolean;
      }>(
        `DELETE FROM oauth_authorizations
          WHERE state = $1
        RETURNING user_id, provider, code_verifier, redirect_path, (expires_at < now()) AS expired`,
        [parsed.data.state],
      );
      return row ?? null;
    });

    // Unknown state, replayed state, or one issued to a different user. All
    // three are the same answer on purpose: distinguishing them would tell a
    // caller which of their guesses was closest.
    if (!pending || pending.expired || pending.user_id !== userId) {
      throw new BadRequestException("this sign-in link is no longer valid — start again");
    }

    const spec = requireProvider(pending.provider);
    const client = oauthClient(spec);
    if (!client) throw new BadRequestException(`${spec.label} is not configured`);

    const token = await exchangeCode(spec, client, parsed.data.code, pending.code_verifier);
    const accountEmail = emailFromIdToken(token.id_token) ?? `${spec.id}-account`;
    const granted = token.scope ? token.scope.split(/\s+/).filter(Boolean) : spec.oauth?.scopes ?? [];

    return this.db.withOrg(orgId, async (db) => {
      const {
        rows: [connection],
      } = await db.query(
        `INSERT INTO connected_accounts
           (org_id, user_id, provider, capabilities, account_email, scopes,
            access_token, refresh_token, token_expires_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
                 CASE WHEN $9::int IS NULL THEN NULL ELSE now() + ($9 || ' seconds')::interval END,
                 'active')
         ON CONFLICT (org_id, user_id, provider, lower(account_email))
         DO UPDATE SET
           access_token   = EXCLUDED.access_token,
           -- Providers omit the refresh token on re-consent. Keeping the
           -- existing one is the difference between a reconnect that works
           -- and one that silently expires an hour later.
           refresh_token  = COALESCE(EXCLUDED.refresh_token, connected_accounts.refresh_token),
           token_expires_at = EXCLUDED.token_expires_at,
           scopes         = EXCLUDED.scopes,
           capabilities   = EXCLUDED.capabilities,
           status         = 'active',
           last_error     = NULL
         RETURNING ${CONNECTION_COLUMNS}`,
        [
          orgId,
          userId,
          spec.id,
          spec.capabilities,
          accountEmail,
          granted,
          encryptSecret(token.access_token),
          encryptSecret(token.refresh_token ?? null),
          token.expires_in ?? null,
        ],
      );
      await audit(db, orgId, "connection.connect", connection.id, req);
      return { connection, redirectPath: safeRedirectPath(pending.redirect_path) };
    });
  }

  /** Connect a provider that has no OAuth — IMAP/SMTP, CalDAV. */
  @Post()
  async connectBasic(@OrgId() orgId: string, @Body() body: unknown, @Req() req: PrincipalRequest) {
    const parsed = BasicConnectionInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const userId = requireCallerUserId(req);

    const spec = requireProvider(parsed.data.provider);
    if (spec.auth !== "basic") {
      throw new BadRequestException(`${spec.label} connects through OAuth — use /oauth/start`);
    }

    // Validated against the SPEC, so a caller cannot invent config keys or
    // omit a required one, and secrets are separated from plain settings by
    // what the spec says rather than by what the caller labelled them.
    const config: Record<string, string> = {};
    let secret: string | null = null;
    for (const field of spec.fields ?? []) {
      const value = parsed.data.config[field.key]?.trim();
      if (!value) {
        if (field.required) throw new BadRequestException(`${field.label} is required`);
        continue;
      }
      if (field.secret) secret = value;
      else config[field.key] = value;
    }

    return this.db.withOrg(orgId, async (db) => {
      const {
        rows: [connection],
      } = await db.query(
        `INSERT INTO connected_accounts
           (org_id, user_id, provider, capabilities, account_email, display_name, config, secret, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'active')
         ON CONFLICT (org_id, user_id, provider, lower(account_email))
         DO UPDATE SET
           display_name = EXCLUDED.display_name,
           config       = EXCLUDED.config,
           secret       = COALESCE(EXCLUDED.secret, connected_accounts.secret),
           status       = 'active',
           last_error   = NULL
         RETURNING ${CONNECTION_COLUMNS}`,
        [
          orgId,
          userId,
          spec.id,
          spec.capabilities,
          parsed.data.accountEmail,
          parsed.data.displayName ?? null,
          JSON.stringify(config),
          encryptSecret(secret),
        ],
      );
      await audit(db, orgId, "connection.connect", connection.id, req);
      return { connection };
    });
  }

  @Delete(":id")
  async disconnect(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const userId = requireCallerUserId(req);
    return this.db.withOrg(orgId, async (db) => {
      // Deleted rather than flagged: this row is a live credential for
      // somebody's mailbox, and "disconnected" has to mean the token is gone,
      // not archived where a later bug could read it.
      const {
        rows: [removed],
      } = await db.query<{ id: string }>(
        `DELETE FROM connected_accounts WHERE id = $1 AND user_id = $2 RETURNING id`,
        [id, userId],
      );
      if (!removed) throw new NotFoundException("connection not found");
      await audit(db, orgId, "connection.disconnect", id, req);
      return { disconnected: true };
    });
  }
}

function requireProvider(id: string): ConnectionProviderSpec {
  const spec = connectionProvider(id);
  if (!spec) throw new BadRequestException(`unknown provider: ${id}`);
  return spec;
}

function callerUserId(req: PrincipalRequest): string | null {
  const parsed = z.string().uuid().safeParse(req.principal?.userId);
  return parsed.success ? parsed.data : null;
}

/**
 * A connection belongs to a person, so acting without one is refused —
 * including for the admin key, which everywhere else acts for the org. There
 * is no org-level mailbox for it to connect.
 */
function requireCallerUserId(req: PrincipalRequest): string {
  const userId = callerUserId(req);
  if (!userId) {
    throw new ForbiddenException(
      "a connection belongs to a signed-in user — this caller has no identity to attach one to",
    );
  }
  return userId;
}

async function audit(
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  orgId: string,
  action: string,
  targetId: string,
  req: PrincipalRequest,
): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
     VALUES ($1, 'user', $2, $3, 'connection', $4)`,
    [orgId, req.principal?.userId ?? "dev-admin", action, targetId],
  );
}
