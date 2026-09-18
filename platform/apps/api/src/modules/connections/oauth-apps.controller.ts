import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Put,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  CONNECTION_PROVIDERS,
  connectionProvider,
  DIRECTORY_TENANT,
  OAuthAppInput,
  type ConnectionProviderSpec,
} from "@aura/shared";
import { encryptSecret, platformOAuthClient } from "@aura/db";
import { AdminKeyGuard } from "../../common/admin-key.guard";
import type { PrincipalRequest } from "../../common/auth-principal";
import { OwnerRoleGuard, RequireOwnerRole } from "../../common/owner-role.guard";
import { OrgId, TenantGuard } from "../../common/tenant.guard";
import { DbService } from "../../db/db.service";
import { redirectUri } from "./oauth";

/**
 * An organisation's own Google and Microsoft OAuth apps (migration 0120).
 *
 * ── WHY THE CLIENT BRINGS THE APP ─────────────────────────────────────────
 *
 * This is a multi-tenant platform. One platform-wide app would have every
 * client's staff consenting to the platform, every client's rollout waiting on
 * the platform's Google verification, and every client sharing one quota. Each
 * client registers an app in its own Google Cloud project or Entra directory
 * and stores it here; the platform's environment app is only the fallback.
 *
 * ── WHY OWNER-ONLY ────────────────────────────────────────────────────────
 *
 * The app decides whose consent screen the entire team signs in through, and
 * replacing it disconnects every account made through the old one. That is
 * the same weight as payment-settings.controller.ts's gateway keys, and gets
 * the same gate: owner alone, enforced here rather than implied by the page.
 *
 * ── THE SECRET IS WRITE-ONLY ──────────────────────────────────────────────
 *
 * `GET` returns the client ID (not secret - it travels in every authorize URL,
 * and seeing it is how an owner tells which app is set) and `hasSecret`. The
 * secret is never selected into a response, never logged and never audited by
 * value. The only edit anybody makes to it is replacing it.
 */
@Controller("connections/oauth-apps")
@UseGuards(AdminKeyGuard, TenantGuard, OwnerRoleGuard)
@RequireOwnerRole("owner")
export class OAuthAppsController {
  constructor(private readonly db: DbService) {}

  @Get()
  async list(@OrgId() orgId: string) {
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{
        provider: string;
        client_id: string;
        has_secret: boolean;
        tenant: string | null;
        updated_at: Date;
      }>(
        // `client_secret IS NOT NULL` - the boolean, never the column.
        `SELECT provider, client_id, (client_secret IS NOT NULL) AS has_secret, tenant, updated_at
           FROM org_oauth_apps WHERE org_id = $1`,
        [orgId],
      );
      const { rows: usage } = await client.query<{ provider: string; n: number }>(
        `SELECT provider, count(*)::int AS n
           FROM connected_accounts
          WHERE org_id = $1 AND status = 'active'
          GROUP BY provider`,
        [orgId],
      );
      const byProvider = new Map(rows.map((r) => [r.provider, r]));
      const connections = new Map(usage.map((u) => [u.provider, u.n]));

      return {
        // The one value every app registration needs pasted in verbatim.
        redirectUri: redirectUri(),
        apps: oauthProviders().map((spec) => {
          const row = byProvider.get(spec.id);
          return {
            provider: spec.id,
            label: spec.label,
            clientId: row?.client_id ?? null,
            hasSecret: row?.has_secret ?? false,
            tenant: row?.tenant ?? null,
            updatedAt: row?.updated_at ?? null,
            clientIdHint: spec.oauth.clientIdHint,
            registerUrl: spec.oauth.registerUrl,
            registerLabel: spec.oauth.registerLabel,
            tenantField: spec.oauth.tenant ?? null,
            // So the page can say "your team is using the platform's app for
            // now" rather than "not set up" when a fallback exists.
            platformFallback: platformOAuthClient(spec) !== null,
            activeConnections: connections.get(spec.id) ?? 0,
          };
        }),
      };
    });
  }

  @Put(":provider")
  async save(
    @OrgId() orgId: string,
    @Param("provider") providerId: string,
    @Body() body: unknown,
    @Req() req: PrincipalRequest,
  ) {
    const spec = requireOAuthProvider(providerId);
    const parsed = OAuthAppInput.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const { clientId, clientSecret } = parsed.data;

    // Checked here rather than left to the provider: a secret pasted into the
    // client ID box otherwise surfaces as Google's or Microsoft's error page
    // on somebody's first sign-in, long after the person who made the mistake
    // has moved on. The message never echoes the value back.
    if (!new RegExp(spec.oauth.clientIdPattern, "i").test(clientId)) {
      throw new BadRequestException(
        `that does not look like a ${spec.label} client ID. ${spec.oauth.clientIdHint}`,
      );
    }

    const tenant = parsed.data.tenant?.trim() || null;
    if (tenant && !spec.oauth.tenant) {
      throw new BadRequestException(`${spec.label} apps do not take a directory`);
    }
    if (tenant && !DIRECTORY_TENANT.test(tenant)) {
      throw new BadRequestException(
        "the directory must be a tenant ID (a GUID) or a verified domain such as contoso.com",
      );
    }

    return this.db.withOrg(orgId, async (client) => {
      const {
        rows: [existing],
      } = await client.query<{ client_id: string }>(
        `SELECT client_id FROM org_oauth_apps WHERE org_id = $1 AND provider = $2`,
        [orgId, spec.id],
      );
      // A secret is required when there is none stored, and when the client
      // ID changes: another app's secret is never the one on file, and
      // keeping it would store an app that cannot sign anybody in.
      const clientIdChanged = existing !== undefined && existing.client_id !== clientId;
      if (!clientSecret && (!existing || clientIdChanged)) {
        throw new BadRequestException(
          existing
            ? "paste the client secret as well - a new client ID needs its own secret"
            : "a client secret is required the first time you add an app",
        );
      }

      if (clientSecret) {
        await client.query(
          `INSERT INTO org_oauth_apps (org_id, provider, client_id, client_secret, tenant, updated_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (org_id, provider) DO UPDATE SET
             client_id     = EXCLUDED.client_id,
             client_secret = EXCLUDED.client_secret,
             tenant        = EXCLUDED.tenant,
             updated_by    = EXCLUDED.updated_by`,
          // Sealed (AES-256-GCM under CRM_SECRET_KEY) before it leaves this process.
          [orgId, spec.id, clientId, encryptSecret(clientSecret), tenant, actorUuid(req)],
        );
      } else {
        // No secret sent: keep the stored one. A plain UPDATE, NOT the upsert
        // above with a NULL secret and COALESCE - Postgres checks NOT NULL on
        // the row it would INSERT before ON CONFLICT ever turns it into an
        // update, so that shape refused every secret-less save (caught
        // against a real database, not by any unit test). The refusals above
        // guarantee a row exists here and its client ID is unchanged.
        await client.query(
          `UPDATE org_oauth_apps
              SET client_id = $3, tenant = $4, updated_by = $5
            WHERE org_id = $1 AND provider = $2`,
          [orgId, spec.id, clientId, tenant, actorUuid(req)],
        );
      }

      await client.query(
        // What changed, never to what: the secret's value is not recorded
        // anywhere but the sealed column.
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)
         VALUES ($1, 'user', $2, 'oauth_app.update', 'oauth_app', $3, $4::jsonb)`,
        [
          orgId,
          req.principal?.userId ?? "owner-console",
          spec.id,
          JSON.stringify({
            created: !existing,
            clientIdChanged,
            secretReplaced: Boolean(clientSecret) && Boolean(existing),
          }),
        ],
      );
      return { saved: true };
    });
  }

  /**
   * Remove the organisation's app. Connections made through it stop syncing
   * at their next token refresh - the console says so, with the count, before
   * anybody gets here.
   */
  @Delete(":provider")
  async remove(
    @OrgId() orgId: string,
    @Param("provider") providerId: string,
    @Req() req: PrincipalRequest,
  ) {
    const spec = requireOAuthProvider(providerId);
    return this.db.withOrg(orgId, async (client) => {
      const { rows } = await client.query<{ provider: string }>(
        `DELETE FROM org_oauth_apps WHERE org_id = $1 AND provider = $2 RETURNING provider`,
        [orgId, spec.id],
      );
      if (rows.length === 0) throw new NotFoundException(`no ${spec.label} app is set up`);
      await client.query(
        `INSERT INTO audit_log (org_id, actor_type, actor_id, action, target_type, target_id)
         VALUES ($1, 'user', $2, 'oauth_app.remove', 'oauth_app', $3)`,
        [orgId, req.principal?.userId ?? "owner-console", spec.id],
      );
      return { removed: true };
    });
  }
}

type OAuthProviderSpec = ConnectionProviderSpec & { oauth: NonNullable<ConnectionProviderSpec["oauth"]> };

function oauthProviders(): OAuthProviderSpec[] {
  return CONNECTION_PROVIDERS.filter((s): s is OAuthProviderSpec => s.auth === "oauth2" && !!s.oauth);
}

function requireOAuthProvider(id: string): OAuthProviderSpec {
  const spec = connectionProvider(id);
  if (!spec || spec.auth !== "oauth2" || !spec.oauth) {
    throw new NotFoundException(`no sign-in app can be set for ${id}`);
  }
  return spec as OAuthProviderSpec;
}

/** `updated_by` references users(id); anything that is not a uuid is left unset. */
function actorUuid(req: PrincipalRequest): string | null {
  const id = req.principal?.userId;
  return typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null;
}
