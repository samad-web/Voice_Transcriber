import { Controller, Get, Post, Query, Req, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import { encryptSecret } from "@aura/db";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import {
  exchangeCodeForToken,
  listManagedPages,
  metaAuthorizeUrl,
  signOAuthState,
  subscribePageToLeadgen,
  verifyOAuthState,
  type MetaOAuthConfig,
} from "./meta-client";

function oauthConfig(): MetaOAuthConfig | null {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_OAUTH_REDIRECT_URI;
  if (!appId || !appSecret || !redirectUri) return null;
  return { appId, appSecret, redirectUri };
}

/**
 * Connecting a Facebook Page for Lead Ads capture (Kailash gap Milestone 4).
 *
 * A human clicks "Connect Facebook Page" - /start returns Meta's own OAuth
 * consent URL; the browser is redirected there directly, does the
 * click-through in Meta's UI, and comes back to /callback. Aura never sees a
 * password, only the resulting code.
 *
 * NOT full multi-page selection UI (that needs a web frontend, out of scope
 * for this backend-only milestone): /callback auto-connects the FIRST Page
 * Meta returns for this user. A future page-picker can pass `pageId` through
 * unchanged - see how it round-trips through the signed state below.
 */
@Controller("meta/oauth")
export class MetaOAuthController {
  constructor(private readonly db: DbService) {}

  @Post("start")
  @UseGuards(AdminKeyGuard, TenantGuard)
  start(@OrgId() orgId: string) {
    const config = oauthConfig();
    if (!config) {
      throw new ServiceUnavailableException("Meta Lead Ads is not configured on this deployment (META_APP_ID/SECRET/OAUTH_REDIRECT_URI)");
    }
    const state = signOAuthState(orgId, config.appSecret);
    return { authorizeUrl: metaAuthorizeUrl(config, state) };
  }

  @Get("callback")
  async callback(
    @Query("code") code: string | undefined,
    @Query("state") state: string | undefined,
    @Req() req: PrincipalRequest,
  ) {
    const config = oauthConfig();
    if (!config) throw new ServiceUnavailableException("Meta Lead Ads is not configured on this deployment");
    if (!code || !state) return { connected: false, reason: "missing code or state" };

    const verified = verifyOAuthState(state, config.appSecret);
    if (!verified) return { connected: false, reason: "invalid or expired state - start the connection again" };

    const { accessToken: userToken } = await exchangeCodeForToken(config, code);
    const pages = await listManagedPages(userToken);
    if (pages.length === 0) return { connected: false, reason: "this Facebook user manages no Pages" };

    const page = pages[0];
    await subscribePageToLeadgen(page.id, page.access_token);

    const inserted = await this.db.withOrg(verified.orgId, async (client) => {
      const {
        rows: [connection],
      } = await client.query(
        `INSERT INTO meta_connections (org_id, page_id, page_name, access_token, status)
         VALUES ($1, $2, $3, $4, 'connected')
         ON CONFLICT (page_id) WHERE status = 'connected'
         DO UPDATE SET access_token = EXCLUDED.access_token, page_name = EXCLUDED.page_name, updated_at = now()
         RETURNING id, page_id, page_name, status`,
        [verified.orgId, page.id, page.name, encryptSecret(page.access_token)],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'meta_connection.create', 'meta_connection', $3)`,
        [verified.orgId, req.principal?.userId ?? "dev-admin", connection.id],
      );
      return connection;
    });

    return { connected: true, page: { id: inserted.page_id, name: inserted.page_name } };
  }
}
