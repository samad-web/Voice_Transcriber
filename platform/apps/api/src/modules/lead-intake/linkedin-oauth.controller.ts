import { randomUUID } from "node:crypto";
import {
  BadGatewayException,
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Logger,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "@aura/db";
import {
  exchangeLinkedInCode,
  linkedinAuthorizeUrl,
  linkedinConfigured,
  linkedinOAuthConfig,
  listAdAccounts,
  type LinkedInAdAccount,
} from "@aura/shared";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import {
  type ConnectErrorCode,
  connectReturnUrl,
  oauthParam,
  providerErrorCode,
} from "../../common/console-redirect";
import { OrgFeatureGuard, RequireFeature } from "../../common/org-feature.guard";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { isUniqueViolation } from "../../common/pg-errors";
import { actorUserId } from "../../common/soft-delete";
import { signOAuthState, verifyOAuthState } from "../meta-ads/meta-client";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";

const SelectAccount = z.object({
  accountUrn: z.string().min(5).max(200),
  accountName: z.string().max(200).nullish(),
  leadSourceId: z.string().uuid().nullish(),
});

/** The store's id for this app - where the callback sends the browser back to. */
const APP_ID = "linkedin_ads";

/** Who began a sign-in, as the signed state says. Both halves are required. */
interface Signer {
  orgId: string;
  userId: string;
}

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
 * Since doc 28 it names the person too, which is what finally lets the
 * callback write `connected_by_user_id`.
 *
 * ── WHO ─────────────────────────────────────────────────────────────────
 *
 * Starting a sign-in, listing what it can see, choosing an account and
 * disconnecting are owner, manager and marketing, behind `lead_sources` - the
 * store's `manageRoles` for this app, enforced here rather than by the page
 * (doc 28 §14). The callback has no guard: the signed state is its credential.
 */
@Controller("linkedin")
export class LinkedInOAuthController {
  private readonly logger = new Logger(LinkedInOAuthController.name);

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
  @UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OrgFeatureGuard)
  @RequireOwnerRole("owner", "manager", "marketing")
  @RequireFeature("lead_sources")
  start(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    const userId = requireSignedIn(req);
    const config = linkedinOAuthConfig();
    if (!config) {
      throw new ServiceUnavailableException(
        "LinkedIn is not configured on this deployment (LINKEDIN_CLIENT_ID/LINKEDIN_CLIENT_SECRET)",
      );
    }
    const state = signOAuthState(orgId, config.clientSecret, { userId });
    return { authorizeUrl: linkedinAuthorizeUrl(config, state) };
  }

  /**
   * Back from linkedin.com with a code. Always a 302 into the console, never
   * JSON - see common/console-redirect.ts for why, and why the target cannot
   * be steered from the query string.
   *
   * Unlike Meta's old callback this never auto-connected the first account it
   * found. A LinkedIn user frequently has access to several ad accounts
   * belonging to different clients of the same agency, and silently binding
   * the first one would pull another company's leads into this CRM. The grant
   * is stored unbound and the console's choose step lists the accounts
   * (`GET connections/:id/accounts`) for a person to pick from -
   * `POST connections/:id/account` completes it.
   */
  @Get("oauth/callback")
  async callback(@Query() query: Record<string, unknown>, @Res() res: Response): Promise<void> {
    let target: string;
    try {
      target = await this.finishSignIn(query);
    } catch (err) {
      this.logger.warn(`LinkedIn sign-in failed after the provider answered: ${messageOf(err)}`);
      target = connectReturnUrl(APP_ID, { step: "auth", error: "provider_error" });
    }
    res.setHeader("Cache-Control", "no-store").redirect(302, target);
  }

  /**
   * The ad accounts a stored grant can see - the choose step's list.
   *
   * Asked of LinkedIn fresh rather than remembered from the callback: the
   * list is only needed once, and a grant's accounts can change between a
   * sign-in and the choice. A failure is a 502 with a plain sentence; LinkedIn's
   * own text goes to the log.
   */
  @Get("connections/:id/accounts")
  @UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OrgFeatureGuard)
  @RequireOwnerRole("owner", "manager", "marketing")
  @RequireFeature("lead_sources")
  async accounts(@OrgId() orgId: string, @Param("id", ParseUUIDPipe) id: string) {
    const stored = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [row],
      } = await client.query<{ access_token: string | null }>(
        `SELECT access_token FROM linkedin_connections WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
      return row ?? null;
    });
    // A disconnected row has had its token cleared, so it lists nothing and
    // is as absent as a row that never existed.
    const token = stored ? decryptSecret(stored.access_token) : null;
    if (!token) throw new NotFoundException("no such LinkedIn connection");

    let accounts: LinkedInAdAccount[];
    try {
      accounts = await listAdAccounts(token);
    } catch (err) {
      this.logger.warn(`LinkedIn refused the ad-account list for connection ${id}: ${messageOf(err)}`);
      throw new BadGatewayException("LinkedIn did not return your ad accounts. Try again in a moment.");
    }
    return { accounts: accounts.map((a) => ({ urn: a.urn, name: a.name })) };
  }

  /** Bind a stored grant to the ad account a person picked. */
  @Post("connections/:id/account")
  @UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OrgFeatureGuard)
  @RequireOwnerRole("owner", "manager", "marketing")
  @RequireFeature("lead_sources")
  async selectAccount(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const userId = requireSignedIn(req);
    const parsed = SelectAccount.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const input = parsed.data;
    if (input.accountUrn.startsWith("pending:")) {
      throw new BadRequestException("that is the placeholder urn, not a real ad account");
    }
    return this.db
      .withOrg(orgId, async (client) => {
        const { rowCount } = await client.query(
          `UPDATE linkedin_connections
              SET account_urn = $3, account_name = $4, lead_source_id = $5,
                  status = 'active', sync_failures = 0, last_error = NULL
            WHERE id = $1 AND org_id = $2`,
          [id, orgId, input.accountUrn, input.accountName ?? null, input.leadSourceId ?? null],
        );
        if (!rowCount) throw new BadRequestException("no such LinkedIn connection");
        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
           VALUES ($1, 'user', $2, 'linkedin_connection.select', 'linkedin_connection', $3, $4::jsonb)`,
          [
            orgId,
            userId,
            id,
            JSON.stringify({ accountUrn: input.accountUrn, accountName: input.accountName ?? null }),
          ],
        );
        return { ok: true };
      })
      .catch((err: unknown) => {
        // linkedin_connections_account: one live row per ad account,
        // platform-wide (0078), so a second workspace cannot divert the
        // first one's leads. Said as a sentence, not a 500.
        if (isUniqueViolation(err)) {
          throw new ConflictException("This ad account is already connected to an Aura workspace.");
        }
        throw err;
      });
  }

  /**
   * Revoke locally. Deliberately does NOT call LinkedIn's revocation endpoint:
   * the same person may have granted the app for another tenant, and revoking
   * the token would break that one too.
   */
  @Post("connections/:id/disconnect")
  @UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OrgFeatureGuard)
  @RequireOwnerRole("owner", "manager", "marketing")
  @RequireFeature("lead_sources")
  async disconnect(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const userId = requireSignedIn(req);
    return this.db.withOrg(orgId, async (client) => {
      const { rowCount } = await client.query(
        `UPDATE linkedin_connections
            SET status = 'revoked', access_token = NULL, refresh_token = NULL
          WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
      // Still `{ ok: true }` for an unknown id, as it always was - but only a
      // row that was actually there gets an audit entry.
      if (rowCount) {
        await client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
           VALUES ($1, 'user', $2, 'linkedin_connection.disconnect', 'linkedin_connection', $3)`,
          [orgId, userId, id],
        );
      }
      return { ok: true };
    });
  }

  /**
   * The callback's decision, as the URL to send the browser to.
   *
   * Nothing is stored until LinkedIn has shown the grant can see at least one
   * ad account: an unbound row nobody can finish would sit in the status list
   * as a connection that never syncs. A state signed before it carried a
   * person is treated as expired, the same rule as Meta's callback.
   */
  private async finishSignIn(query: Record<string, unknown>): Promise<string> {
    const fail = (error: ConnectErrorCode) => connectReturnUrl(APP_ID, { step: "auth", error });

    const config = linkedinOAuthConfig();
    if (!config) {
      this.logger.warn("LinkedIn sign-in returned to a deployment with no LINKEDIN_CLIENT_ID/SECRET");
      return fail("provider_error");
    }

    const state = oauthParam(query.state);
    const verified = state ? verifyOAuthState(state, config.clientSecret) : null;
    const signer: Signer | null = verified?.userId
      ? { orgId: verified.orgId, userId: verified.userId }
      : null;

    const refused = providerErrorCode(oauthParam(query.error));
    if (refused) {
      await this.recordFailure(
        signer,
        refused,
        [query.error, query.error_description].map(oauthParam).filter(Boolean).join(" - "),
      );
      return fail(refused);
    }
    if (!signer) return fail("expired");

    const code = oauthParam(query.code);
    if (!code) {
      await this.recordFailure(signer, "provider_error", "LinkedIn returned neither a code nor an error");
      return fail("provider_error");
    }

    let tokens: Awaited<ReturnType<typeof exchangeLinkedInCode>>;
    let accounts: LinkedInAdAccount[];
    try {
      tokens = await exchangeLinkedInCode(config, code);
      accounts = await listAdAccounts(tokens.accessToken);
    } catch (err) {
      await this.recordFailure(signer, "provider_error", messageOf(err));
      return fail("provider_error");
    }
    if (accounts.length === 0) {
      await this.recordFailure(signer, "no_accounts", "LinkedIn listed no ad accounts for this grant");
      return fail("no_accounts");
    }

    const connectionId = await this.db.withOrg(signer.orgId, async (client) => {
      const expiresAt = tokens.expiresIn ? new Date(Date.now() + tokens.expiresIn * 1000) : null;
      // Bound to a PLACEHOLDER urn so the row can exist before a person
      // chooses; the sweep skips a connection whose urn is still the
      // placeholder, so nothing is ever pulled from an account nobody picked.
      const {
        rows: [row],
      } = await client.query<{ id: string }>(
        `INSERT INTO linkedin_connections
           (org_id, account_urn, account_name, access_token, refresh_token, token_expires_at,
            status, connected_by_user_id)
         VALUES ($1, $2, NULL, $3, $4, $5, 'active', $6)
         RETURNING id`,
        [
          signer.orgId,
          // Unique per attempt: `linkedin_connections_account` is UNIQUE on
          // account_urn for every non-revoked row, so a fixed placeholder would
          // make a second connect attempt by the same org raise 23505.
          `pending:${randomUUID()}`,
          encryptSecret(tokens.accessToken),
          tokens.refreshToken ? encryptSecret(tokens.refreshToken) : null,
          expiresAt,
          signer.userId,
        ],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'linkedin_connection.create', 'linkedin_connection', $3)`,
        [signer.orgId, signer.userId, row.id],
      );
      return row.id;
    });
    return connectReturnUrl(APP_ID, { step: "choose", pending: connectionId });
  }

  /**
   * Where LinkedIn's own words go, since they may not go in the URL: an audit
   * row when the state named an org, the log when it did not. Never fatal.
   */
  private async recordFailure(signer: Signer | null, code: ConnectErrorCode, detail: string): Promise<void> {
    const text = detail.slice(0, 500);
    if (!signer) {
      this.logger.warn(`LinkedIn sign-in ended "${code}" with no verifiable state: ${text}`);
      return;
    }
    try {
      await this.db.withOrg(signer.orgId, (client) =>
        client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
           VALUES ($1, 'user', $2, 'linkedin_connection.connect_failed', 'linkedin_connection', NULL, $3::jsonb)`,
          [signer.orgId, signer.userId, JSON.stringify({ code, detail: text })],
        ),
      );
    } catch (err) {
      this.logger.warn(`LinkedIn sign-in ended "${code}" and its audit row failed (${messageOf(err)}): ${text}`);
    }
  }
}

/**
 * The person acting, or a 403. OwnerRoleGuard already refuses a caller with no
 * user; this states what the handlers rely on. `req.principal.userId` is the
 * literal "admin-key" on the bare admin-key path, and `connected_by_user_id` is
 * a real uuid FK - see `actorUserId`.
 */
function requireSignedIn(req: PrincipalRequest): string {
  const userId = actorUserId(req);
  if (!userId) {
    throw new ForbiddenException(
      "connecting LinkedIn needs a signed-in person - this caller has no identity to attach it to",
    );
  }
  return userId;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
