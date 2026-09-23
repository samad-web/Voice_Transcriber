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
import type { PoolClient } from "pg";
import { z } from "zod";
import { decryptSecret, encryptSecret } from "@aura/db";
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
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import {
  exchangeCodeForToken,
  listManagedPages,
  metaAuthorizeUrl,
  signOAuthState,
  subscribePageToLeadgen,
  unsubscribePage,
  verifyOAuthState,
  type MetaOAuthConfig,
  type MetaPage,
} from "./meta-client";

function oauthConfig(): MetaOAuthConfig | null {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_OAUTH_REDIRECT_URI;
  if (!appId || !appSecret || !redirectUri) return null;
  return { appId, appSecret, redirectUri };
}

/** The store's id for this app - where every callback sends the browser back to. */
const APP_ID = "meta_lead_ads";

/** What `integration_pending_choices.payload` decrypts to for a Meta sign-in (0131). */
const PendingPages = z.array(
  z.object({ pageId: z.string().min(1), name: z.string(), token: z.string().min(1) }),
);
type PendingPage = z.infer<typeof PendingPages>[number];

const ChooseBody = z.object({
  pageIds: z.array(z.string().min(1).max(64)).min(1).max(100),
});

/** Who began a sign-in, as the signed state says. Both halves are required. */
interface Signer {
  orgId: string;
  userId: string;
}

/**
 * Connecting a Facebook Page for Lead Ads capture (Kailash gap Milestone 4,
 * reworked for doc 28's Integrations store).
 *
 * ── THE FLOW ────────────────────────────────────────────────────────────────
 *
 *   1. `POST oauth/start` returns Meta's consent URL, with a signed state that
 *      names the org AND the person.
 *   2. Meta sends the browser to `GET oauth/callback`, which exchanges the
 *      code, lists the Pages the person manages, parks them (tokens sealed) in
 *      `integration_pending_choices`, and 302s into the console's choose step.
 *   3. The console reads the Page NAMES from `GET oauth/pending/:id` and the
 *      person ticks the ones running lead ads.
 *   4. `POST oauth/pending/:id/choose` subscribes those Pages and connects them.
 *
 * ── WHY THERE IS A CHOOSE STEP ──────────────────────────────────────────────
 *
 * The callback used to connect `pages[0]` and stop. Somebody whose lead ads
 * run on their second Page connected their first, saw "connected", and got no
 * leads - and the answer was JSON on the API's own domain, so they were not
 * even back in the console to notice. Nothing is connected now until a person
 * has picked it.
 *
 * ── WHO ─────────────────────────────────────────────────────────────────────
 *
 * Owner, manager and marketing, behind the `meta_ads` feature - the store's
 * `manageRoles` for this app, enforced here rather than by the page (doc 28
 * §14). The callback carries no guard at all: the browser is coming back from
 * facebook.com with no credential of ours, so the signed state IS the
 * credential. Guards are therefore per route rather than on the class.
 */
@Controller("meta")
export class MetaOAuthController {
  private readonly logger = new Logger(MetaOAuthController.name);

  constructor(private readonly db: DbService) {}

  @Post("oauth/start")
  @UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OrgFeatureGuard)
  @RequireOwnerRole("owner", "manager", "marketing")
  @RequireFeature("meta_ads")
  start(@OrgId() orgId: string, @Req() req: PrincipalRequest) {
    const userId = requireSignedIn(req);
    const config = oauthConfig();
    if (!config) {
      throw new ServiceUnavailableException("Meta Lead Ads is not configured on this deployment (META_APP_ID/SECRET/OAUTH_REDIRECT_URI)");
    }
    const state = signOAuthState(orgId, config.appSecret, { userId });
    return { authorizeUrl: metaAuthorizeUrl(config, state) };
  }

  /**
   * Back from facebook.com. Always a 302 into the console - never JSON, and
   * never an exception page, because whoever lands here is a person in a
   * browser and a stack trace on the API's domain is a dead end for them.
   *
   * `no-store` because the answer depends on a one-time code: a cached
   * redirect would send a second visit to a choice that has already been made.
   */
  @Get("oauth/callback")
  async callback(@Query() query: Record<string, unknown>, @Res() res: Response): Promise<void> {
    let target: string;
    try {
      target = await this.finishSignIn(query);
    } catch (err) {
      this.logger.warn(`Meta sign-in failed after the provider answered: ${messageOf(err)}`);
      target = connectReturnUrl(APP_ID, { step: "auth", error: "provider_error" });
    }
    res.setHeader("Cache-Control", "no-store").redirect(302, target);
  }

  /** The Pages a sign-in returned, by name. Never a token. */
  @Get("oauth/pending/:id")
  @UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OrgFeatureGuard)
  @RequireOwnerRole("owner", "manager", "marketing")
  @RequireFeature("meta_ads")
  async pending(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const userId = requireSignedIn(req);
    return this.db.withOrg(orgId, async (client) => {
      await sweepExpiredChoices(client);
      const choice = await loadChoice(client, orgId, id, userId);
      // "Already connected here" lets the console tick and disable those rows
      // instead of letting somebody re-pick a Page and wonder what changed.
      const { rows } = await client.query<{ page_id: string }>(
        `SELECT page_id FROM meta_connections
          WHERE org_id = $1 AND status = 'connected' AND page_id = ANY($2::text[])`,
        [orgId, choice.pages.map((p) => p.pageId)],
      );
      const connected = new Set(rows.map((r) => r.page_id));
      return {
        pages: choice.pages.map((p) => ({
          pageId: p.pageId,
          name: p.name,
          connected: connected.has(p.pageId),
        })),
        expiresAt: choice.expiresAt,
      };
    });
  }

  /**
   * Connect the Pages the person picked.
   *
   * ── THE ORDER IS DELIBERATE ─────────────────────────────────────────────────
   *
   *   1. Read the choice (not yet consumed) and check every id is in it. The
   *      ids come from the browser; the tokens only ever come from the row.
   *   2. Subscribe each Page at Graph, OUTSIDE any transaction - a database
   *      connection is not held open across a round trip to Facebook. A
   *      refusal here is a 502 with nothing written, and the choice is still
   *      there to retry. Subscribing a Page that turns out to be taken (step 3)
   *      costs nothing: that Page is already subscribed to this same app.
   *   3. One transaction: consume the choice, connect every Page, audit each.
   *      Consuming is the DELETE, so two tabs pressing Save race on the row
   *      and the loser gets a 404 rather than a second set of connections. Any
   *      failure - a Page another workspace holds, say - rolls the lot back,
   *      choice included, so the person can untick that Page and save again.
   */
  @Post("oauth/pending/:id/choose")
  @UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OrgFeatureGuard)
  @RequireOwnerRole("owner", "manager", "marketing")
  @RequireFeature("meta_ads")
  async choose(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const userId = requireSignedIn(req);
    const parsed = ChooseBody.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);

    const { pages } = await this.db.withOrg(orgId, async (client) => {
      await sweepExpiredChoices(client);
      return loadChoice(client, orgId, id, userId);
    });
    const byId = new Map(pages.map((p) => [p.pageId, p]));
    const chosen: PendingPage[] = [];
    for (const pageId of new Set(parsed.data.pageIds)) {
      const page = byId.get(pageId);
      if (!page) throw new BadRequestException(`${pageId} is not one of the Pages you signed in with`);
      chosen.push(page);
    }

    for (const page of chosen) {
      try {
        await subscribePageToLeadgen(page.pageId, page.token);
      } catch (err) {
        this.logger.warn(`Meta refused the leadgen subscription for Page ${page.pageId}: ${messageOf(err)}`);
        throw new BadGatewayException(
          `Facebook would not turn on lead notifications for ${page.name || "that Page"}. Try again in a moment.`,
        );
      }
    }

    return this.db
      .withOrg(orgId, async (client) => {
        const { rowCount } = await client.query(
          `DELETE FROM integration_pending_choices
            WHERE id = $1 AND org_id = $2 AND user_id = $3 AND provider = 'meta' AND expires_at > now()`,
          [id, orgId, userId],
        );
        if (!rowCount) throw new NotFoundException(CHOICE_GONE);

        const connected: Array<{ id: string; name: string }> = [];
        for (const page of chosen) {
          const row = await connectPage(client, orgId, userId, page);
          await client.query(
            `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
             VALUES ($1, 'user', $2, 'meta_connection.create', 'meta_connection', $3, $4::jsonb)`,
            [
              orgId,
              userId,
              row.id,
              JSON.stringify({ pageId: page.pageId, pageName: page.name, refreshed: row.refreshed }),
            ],
          );
          connected.push({ id: row.id, name: row.page_name ?? page.name });
        }
        return { connected };
      })
      .catch((err: unknown) => {
        // meta_connections_page: one connected row per Page, platform-wide
        // (0063). Only another workspace's row can collide here - this org's
        // own is refreshed by `connectPage` rather than inserted twice.
        if (isUniqueViolation(err)) {
          throw new ConflictException("This Page is already connected to an Aura workspace.");
        }
        throw err;
      });
  }

  /**
   * Disconnect one Page (doc 28 §12.2): new leads from it stop, every lead
   * already created stays.
   *
   * The Graph unsubscribe is best effort and comes FIRST, while the token is
   * still on the row; the local revoke happens whatever Facebook says. A
   * failure is written into the audit row, not thrown - the person asked to be
   * disconnected, and a dead token is a common reason to ask.
   *
   * The token is cleared with the status. Nothing reads a revoked row's token,
   * and a credential kept "just in case" is one a later bug can find.
   */
  @Post("connections/:id/disconnect")
  @UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard, OrgFeatureGuard)
  @RequireOwnerRole("owner", "manager", "marketing")
  @RequireFeature("meta_ads")
  async disconnect(
    @OrgId() orgId: string,
    @Param("id", ParseUUIDPipe) id: string,
    @Req() req: PrincipalRequest,
  ) {
    const userId = requireSignedIn(req);
    const row = await this.db.withOrg(orgId, async (client) => {
      const {
        rows: [found],
      } = await client.query<{ page_id: string; access_token: string | null; status: string }>(
        `SELECT page_id, access_token, status FROM meta_connections WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
      return found ?? null;
    });
    if (!row) throw new NotFoundException("no such Facebook Page connection");
    // Already revoked: nothing to undo at Facebook, and a second audit row for
    // a double click would only be noise. Unsubscribing here would be worse
    // than noise - the same Page may since have been reconnected on a NEW row,
    // and this would silence that one.
    if (row.status !== "connected") return { ok: true, unsubscribed: false };

    let unsubscribed = false;
    let providerError: string | null = null;
    try {
      const token = decryptSecret(row.access_token);
      if (!token) throw new Error("no Page token is stored for this connection");
      await unsubscribePage(row.page_id, token);
      unsubscribed = true;
    } catch (err) {
      providerError = messageOf(err).slice(0, 500);
    }

    await this.db.withOrg(orgId, async (client) => {
      await client.query(
        `UPDATE meta_connections SET status = 'revoked', access_token = NULL
          WHERE id = $1 AND org_id = $2`,
        [id, orgId],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'meta_connection.revoke', 'meta_connection', $3, $4::jsonb)`,
        [orgId, userId, id, JSON.stringify({ pageId: row.page_id, unsubscribed, providerError })],
      );
    });
    return { ok: true, unsubscribed };
  }

  /**
   * The callback's decision, as the URL to send the browser to.
   *
   * The org and person come from the signed state and nowhere else - there is
   * no session on this route. A state with no person in it was signed before
   * the state carried one (at most ten minutes before this shipped); it is
   * treated as expired rather than finished on nobody's behalf, because the
   * choice it would create has to belong to somebody.
   */
  private async finishSignIn(query: Record<string, unknown>): Promise<string> {
    const fail = (error: ConnectErrorCode) => connectReturnUrl(APP_ID, { step: "auth", error });

    const config = oauthConfig();
    if (!config) {
      this.logger.warn("Meta sign-in returned to a deployment with no META_APP_ID/SECRET/OAUTH_REDIRECT_URI");
      return fail("provider_error");
    }

    const state = oauthParam(query.state);
    const verified = state ? verifyOAuthState(state, config.appSecret) : null;
    const signer: Signer | null = verified?.userId
      ? { orgId: verified.orgId, userId: verified.userId }
      : null;

    const refused = providerErrorCode(oauthParam(query.error), oauthParam(query.error_reason));
    if (refused) {
      await this.recordFailure(
        signer,
        refused,
        [query.error, query.error_reason, query.error_description].map(oauthParam).filter(Boolean).join(" - "),
      );
      return fail(refused);
    }
    if (!signer) return fail("expired");

    const code = oauthParam(query.code);
    if (!code) {
      await this.recordFailure(signer, "provider_error", "Facebook returned neither a code nor an error");
      return fail("provider_error");
    }

    let pages: MetaPage[];
    try {
      const { accessToken } = await exchangeCodeForToken(config, code);
      pages = await listManagedPages(accessToken);
    } catch (err) {
      await this.recordFailure(signer, "provider_error", messageOf(err));
      return fail("provider_error");
    }
    // A Page listed without its own token is one the person has no task on;
    // it could never be subscribed, so offering it would be offering a failure.
    const usable = pages.filter((p) => p.id && p.access_token);
    if (usable.length === 0) {
      await this.recordFailure(
        signer,
        "no_pages",
        `Facebook listed ${pages.length} Page(s), none with a Page token`,
      );
      return fail("no_pages");
    }

    const payload: PendingPage[] = usable.map((p) => ({
      pageId: p.id,
      name: p.name ?? p.id,
      token: p.access_token,
    }));
    const pendingId = await this.db.withOrg(signer.orgId, async (client) => {
      await sweepExpiredChoices(client);
      const {
        rows: [row],
      } = await client.query<{ id: string }>(
        `INSERT INTO integration_pending_choices (org_id, user_id, provider, payload)
         VALUES ($1, $2, 'meta', $3)
         RETURNING id`,
        [signer.orgId, signer.userId, encryptSecret(JSON.stringify(payload))],
      );
      return row.id;
    });
    return connectReturnUrl(APP_ID, { step: "choose", pending: pendingId });
  }

  /**
   * Where the provider's own words go, since they may not go in the URL.
   *
   * An audit row when the state named an org to write it in; the log when it
   * did not (a forged or stale state has no org we can trust). Never fatal:
   * the person is still owed their redirect.
   */
  private async recordFailure(signer: Signer | null, code: ConnectErrorCode, detail: string): Promise<void> {
    const text = detail.slice(0, 500);
    if (!signer) {
      this.logger.warn(`Meta sign-in ended "${code}" with no verifiable state: ${text}`);
      return;
    }
    try {
      await this.db.withOrg(signer.orgId, (client) =>
        client.query(
          `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
           VALUES ($1, 'user', $2, 'meta_connection.connect_failed', 'meta_connection', NULL, $3::jsonb)`,
          [signer.orgId, signer.userId, JSON.stringify({ code, detail: text })],
        ),
      );
    } catch (err) {
      this.logger.warn(`Meta sign-in ended "${code}" and its audit row failed (${messageOf(err)}): ${text}`);
    }
  }
}

const CHOICE_GONE = "This Facebook sign-in has expired or was already used. Connect Facebook again.";

/**
 * The lazy half of 0131's fifteen-minute lifetime. Nothing else deletes an
 * unmade choice, and every read below refuses an expired row regardless, so
 * this only keeps sealed tokens from outliving their purpose on disk.
 */
async function sweepExpiredChoices(client: PoolClient): Promise<void> {
  await client.query(`DELETE FROM integration_pending_choices WHERE expires_at < now()`);
}

/**
 * The caller's own, unexpired Meta choice, unsealed.
 *
 * Absent, expired and somebody else's are one 404 on purpose: the tokens in it
 * were granted on the signer's own Facebook account, and telling a colleague
 * "that exists but is not yours" would be telling them something.
 */
async function loadChoice(
  client: PoolClient,
  orgId: string,
  id: string,
  userId: string,
): Promise<{ pages: PendingPage[]; expiresAt: Date }> {
  const {
    rows: [row],
  } = await client.query<{ payload: string; expires_at: Date }>(
    `SELECT payload, expires_at FROM integration_pending_choices
      WHERE id = $1 AND org_id = $2 AND user_id = $3 AND provider = 'meta' AND expires_at > now()`,
    [id, orgId, userId],
  );
  if (!row) throw new NotFoundException(CHOICE_GONE);
  const pages = PendingPages.parse(JSON.parse(decryptSecret(row.payload) ?? "[]"));
  return { pages, expiresAt: row.expires_at };
}

/**
 * Connect one Page for this org, or refresh this org's existing connection to
 * it. Storage is the old callback's: the Page token sealed with
 * `encryptSecret`, status 'connected' - plus `connected_by_user_id`, which
 * that callback never had a user to write.
 *
 * ── WHY NOT `INSERT ... ON CONFLICT DO UPDATE` ──────────────────────────────
 *
 * The old callback used one, and it cannot tell the two conflicts apart. The
 * partial unique index is platform-wide, but the row it collides with may
 * belong to another org - and under FORCE ROW LEVEL SECURITY, an ON CONFLICT
 * DO UPDATE whose existing row fails the UPDATE policy raises an RLS error
 * rather than a unique violation. That surfaced as a 500. Updating this org's
 * own row first, and inserting only when there is none, leaves exactly one way
 * to collide - another workspace holds the Page - and it arrives as 23505.
 */
async function connectPage(
  client: PoolClient,
  orgId: string,
  userId: string,
  page: PendingPage,
): Promise<{ id: string; page_name: string | null; refreshed: boolean }> {
  const token = encryptSecret(page.token);
  const {
    rows: [updated],
  } = await client.query<{ id: string; page_name: string | null }>(
    `UPDATE meta_connections
        SET access_token = $3, page_name = $4, connected_by_user_id = $5, updated_at = now()
      WHERE org_id = $1 AND page_id = $2 AND status = 'connected'
      RETURNING id, page_name`,
    [orgId, page.pageId, token, page.name, userId],
  );
  if (updated) return { ...updated, refreshed: true };

  const {
    rows: [inserted],
  } = await client.query<{ id: string; page_name: string | null }>(
    `INSERT INTO meta_connections (org_id, page_id, page_name, access_token, status, connected_by_user_id)
     VALUES ($1, $2, $3, $4, 'connected', $5)
     RETURNING id, page_name`,
    [orgId, page.pageId, page.name, token, userId],
  );
  return { ...inserted, refreshed: false };
}

/**
 * The person acting, or a 403. OwnerRoleGuard already refuses a caller with no
 * user, so this is the handler saying out loud what it relies on: a Page token
 * is granted on somebody's own Facebook account, and a choice is theirs to make.
 */
function requireSignedIn(req: PrincipalRequest): string {
  const userId = actorUserId(req);
  if (!userId) {
    throw new ForbiddenException(
      "connecting Facebook needs a signed-in person - this caller has no identity to attach it to",
    );
  }
  return userId;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
