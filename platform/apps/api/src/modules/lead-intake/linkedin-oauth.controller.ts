import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import { z } from "zod";
import { encryptSecret } from "@aura/db";
import {
  exchangeLinkedInCode,
  linkedinAuthorizeUrl,
  linkedinConfigured,
  linkedinOAuthConfig,
  listAdAccounts,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { signOAuthState, verifyOAuthState } from "../meta-ads/meta-client";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const SelectAccount = z.object({
  accountUrn: z.string().min(5).max(200),
  accountName: z.string().max(200).nullish(),
  leadSourceId: z.string().uuid().nullish(),
});

/**
 * Connecting a LinkedIn ad account for Lead Gen Form capture (migration 0078).
 *
 * ── IT REPORTS "NOT CONFIGURED" RATHER THAN THROWING ────────────────────
 *
 * Lead Sync access needs a LinkedIn Marketing Developer Platform app that
 * LinkedIn has approved, and nobody can register one on the operator's behalf.
 * `GET /linkedin/status` says so plainly so the console can render "ask your
 * operator to register a LinkedIn app" instead of a button that 500s. Same
 * degrade-don't-fail posture as the Google and Microsoft OAuth providers in
 * connection-providers.ts.
 *
 * ── THE STATE IS SIGNED WITH THE APP SECRET ─────────────────────────────
 *
 * Reusing `signOAuthState`/`verifyOAuthState` from meta-client rather than
 * writing a second one. The callback carries no admin key - the browser is
 * coming back from linkedin.com - so the org it belongs to has to travel in
 * the state, and it has to be unforgeable or anyone could bind their own
 * LinkedIn account to another tenant's CRM. Ten-minute TTL, same as Meta's.
 */
@Controller("linkedin")
export class LinkedInOAuthController {
  constructor(private readonly db: DbService) {}

  /** Whether this deployment can connect LinkedIn at all, and what is connected. */
  @Get("status")
  @UseGuards(AdminKeyGuard, TenantGuard)
  async status(@OrgId() orgId: string) {
    const configured = linkedinConfigured();
    const connections = await this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, account_urn, account_name, status, sync_cursor, last_synced_at,
                sync_failures, last_error, lead_source_id, created_at
           FROM linkedin_connections
          WHERE org_id = $1 ORDER BY created_at DESC`,
        [orgId],
      );
      return rows;
    });
    return {
      configured,
      reason: configured
        ? null
        : "LinkedIn is not configured on this deployment - LINKEDIN_CLIENT_ID and " +
          "LINKEDIN_CLIENT_SECRET must be set from an approved LinkedIn Marketing " +
          "Developer Platform app with the r_marketing_leadgen_automation scope",
      connections,
    };
  }

  @Post("oauth/start")
  @UseGuards(AdminKeyGuard, TenantGuard)
  start(@OrgId() orgId: string) {
    const config = linkedinOAuthConfig();
    if (!config) {
      throw new ServiceUnavailableException(
        "LinkedIn is not configured on this deployment (LINKEDIN_CLIENT_ID/LINKEDIN_CLIENT_SECRET)",
      );
    }
    return { authorizeUrl: linkedinAuthorizeUrl(config, signOAuthState(orgId, config.clientSecret)) };
  }

  /**
   * Back from linkedin.com with a code.
   *
   * Unlike Meta's callback this does NOT auto-connect the first account it
   * finds. A LinkedIn user frequently has access to several ad accounts
   * belonging to different clients of the same agency, and silently binding
   * the first one would pull another company's leads into this CRM. The grant
   * is stored unbound and the accounts are returned for a person to choose
   * from - `POST /linkedin/connections/:id/account` completes it.
   */
  @Get("oauth/callback")
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Req() req: PrincipalRequest,
  ) {
    const config = linkedinOAuthConfig();
    if (!config) throw new ServiceUnavailableException("LinkedIn is not configured on this deployment");
    if (!code || !state) return { connected: false, reason: "missing code or state" };

    const verified = verifyOAuthState(state, config.clientSecret);
    if (!verified) {
      return { connected: false, reason: "invalid or expired state - start the connection again" };
    }

    const tokens = await exchangeLinkedInCode(config, code);
    const accounts = await listAdAccounts(tokens.accessToken).catch(() => []);

    const connection = await this.db.withOrg(verified.orgId, async (client) => {
      const expiresAt = tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null;
      // Bound to the first account only as a PLACEHOLDER urn so the row can
      // exist before a person chooses; the sweep skips a connection whose urn
      // is still the placeholder, so nothing is ever pulled from an account
      // nobody picked.
      const {
        rows: [row],
      } = await client.query<{ id: string }>(
        `INSERT INTO linkedin_connections
           (org_id, account_urn, account_name, access_token, refresh_token, token_expires_at,
            status, connected_by_user_id)
         VALUES ($1, $2, NULL, $3, $4, $5, 'active', $6)
         RETURNING id`,
        [
          verified.orgId,
          // Unique per attempt: `linkedin_connections_account` is UNIQUE on
          // account_urn for every non-revoked row, so a fixed placeholder would
          // make a second connect attempt by the same org raise 23505.
          `pending:${randomUUID()}`,
          encryptSecret(tokens.accessToken),
          tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
          expiresAt,
          actorUserId(req),
        ],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'linkedin_connection.create', 'linkedin_connection', $3)`,
        [verified.orgId, req.principal?.userId ?? "dev-admin", row.id],
      );
      return row;
    });

    return { connected: true, connectionId: connection.id, accounts };
  }

  /** Bind a stored grant to the ad account a person picked. */
  @Post("connections/:id/account")
  @UseGuards(AdminKeyGuard, TenantGuard)
  async selectAccount(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const input = SelectAccount.parse(body);
    if (input.accountUrn.startsWith("pending:")) {
      throw new BadRequestException("that is the placeholder urn, not a real ad account");
    }
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE linkedin_connections
            SET account_urn = $3, account_name = $4, lead_source_id = $5,
                status = 'active', sync_failures = 0, last_error = NULL
          WHERE id = $1 AND org_id = $2`,
        [id, orgId, input.accountUrn, input.accountName ?? null, input.leadSourceId ?? null],
      );
      if (!rowCount) throw new BadRequestException("no such LinkedIn connection");
      return { ok: true };
    });
  }

  /**
   * Revoke locally. Deliberately does NOT call LinkedIn's revocation endpoint:
   * the same person may have granted the app for another tenant, and revoking
   * the token would break that one too.
   */
  @Post("connections/:id/disconnect")
  @UseGuards(AdminKeyGuard, TenantGuard)
  async disconnect(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    return this.db.withOrg(orgId, async (client) => {
      await client.query(
        `UPDATE linkedin_connections
            SET status = 'revoked', access_token = NULL, refresh_token = NULL
          WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
      return { ok: true };
    });
  }
}

/**
 * `req.principal.userId` is the literal string "admin-key" on the dev
 * admin-key path, and `connected_by_user_id` is a real uuid FK - inserting it
 * raises 22P02. Same guard, and the same reason, as merge.controller.ts.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
function actorUserId(req: PrincipalRequest): string | null {
  const id = req.principal?.userId;
  return id && UUID.test(id) ? id : null;
}
