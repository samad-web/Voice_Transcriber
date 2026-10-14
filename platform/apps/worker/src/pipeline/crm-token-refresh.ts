import { decryptSecret, encryptSecret, getAdminPool, withOrgContext } from "@aura/db";
import { OWNER_ROLE_ADMINS, crmProvider } from "@aura/shared";
import { announce } from "./realtime";

/**
 * REFRESH A CRM ACCESS TOKEN BEFORE IT EXPIRES (doc 49 P10-B, migration 0205).
 *
 * ── THE FAILURE THIS ENDS ───────────────────────────────────────────────────
 *
 * Four connectors take an OAuth access token - Salesforce, Zoho, monday,
 * Dynamics 365 - and for Zoho and Dynamics it lasts one hour. Every delivery
 * then 401s until a human opens the integration card. Nothing is lost, because
 * the outbox retries, but nothing arrives either, and until 0204 nothing even
 * said so.
 *
 * ── ONE GRANT, THREE SHAPES ─────────────────────────────────────────────────
 *
 * All three refreshable providers use the same RFC 6749 refresh-token grant:
 * a form POST with `grant_type=refresh_token`, the client credentials, and the
 * refresh token. What differs is only where to POST it and which extra field
 * the vendor insists on. So this is one function and a small table, rather than
 * three integrations:
 *
 *   Zoho       accounts.zoho.<dc>/oauth/v2/token - the data centre is the
 *              customer's, which is why `token_url` is stored per connection
 *              rather than derived from the provider id.
 *   Salesforce login.salesforce.com or test.salesforce.com (sandbox), and the
 *              response carries a NEW `instance_url` that can differ from the
 *              one configured - Salesforce migrates orgs between pods.
 *   Dynamics   login.microsoftonline.com/<tenant>/oauth2/v2.0/token, and it is
 *              the one that REQUIRES a `scope` on the refresh, not only on the
 *              initial grant.
 *
 * monday is absent on purpose: its tokens are issued without expiry when the
 * option is taken, and it has no refresh grant to call.
 *
 * ── WHAT IT WILL NOT DO ─────────────────────────────────────────────────────
 *
 * Retry a refusal. A refresh token the vendor has REVOKED cannot be recovered
 * by asking again - the customer has to re-consent - so a 400/401 from the
 * token endpoint stops the sweep for that connection and raises a notice.
 * Without that rule a revoked credential becomes a request every five minutes
 * against a vendor that has already said no, which is how an integration gets
 * an account rate-limited.
 */

/** Refresh this long before the access token expires. */
const REFRESH_LEAD_MS = () => Number(process.env.CRM_TOKEN_REFRESH_LEAD_MS ?? 10 * 60 * 1000);

interface Refreshable {
  id: string;
  org_id: string;
  provider: string;
  label: string | null;
  config: Record<string, unknown> | null;
  token_url: string | null;
  refresh_secret: string;
  token_expires_at: Date | null;
}

/**
 * Which connections are due.
 *
 * `token_refresh_error IS NULL` is the stop: a connection whose refresh token
 * the vendor rejected is excluded until a human clears it by saving a new
 * credential, which is what the console's save path does.
 *
 * `token_expires_at IS NULL` IS included - a hand-pasted credential has no
 * known expiry, and refreshing it once establishes one. After that first
 * refresh the column is set and the lead time governs.
 */
const DUE_SQL = `
  SELECT i.id, i.org_id, i.provider, i.label, i.config, i.token_url,
         i.refresh_secret, i.token_expires_at
    FROM crm_integrations i
   WHERE i.deleted_at IS NULL
     AND i.status IN ('connected', 'error')
     AND i.refresh_secret IS NOT NULL
     AND i.token_refresh_error IS NULL
     AND (i.token_expires_at IS NULL
          OR i.token_expires_at < now() + make_interval(secs => $1))
   ORDER BY i.token_expires_at NULLS FIRST
   LIMIT 20`;

interface ProviderRefresh {
  /** Where to POST when the connection has no stored token_url. */
  defaultTokenUrl?: (config: Record<string, unknown>) => string | null;
  /** Extra form fields this vendor requires on a refresh. */
  extraFields?: (config: Record<string, unknown>) => Record<string, string>;
}

const PROVIDERS: Record<string, ProviderRefresh> = {
  zoho: {
    // The accounts host mirrors the API host the customer chose: a token
    // minted at accounts.zoho.com does not work against www.zohoapis.in.
    defaultTokenUrl: (config) => {
      const api = typeof config.apiDomain === "string" ? config.apiDomain : "www.zohoapis.in";
      const dc = api.replace(/^www\.zohoapis/, "");
      return `https://accounts.zoho${dc}/oauth/v2/token`;
    },
  },
  salesforce: {
    defaultTokenUrl: (config) =>
      config.sandbox === true
        ? "https://test.salesforce.com/services/oauth2/token"
        : "https://login.salesforce.com/services/oauth2/token",
  },
  dynamics365: {
    defaultTokenUrl: (config) => {
      const tenant = typeof config.tenantId === "string" ? config.tenantId : null;
      return tenant ? `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token` : null;
    },
    // Entra refuses a refresh with no scope, unlike the other two. The
    // resource host comes from the connection's own config because every
    // Dataverse environment has its own.
    extraFields: (config): Record<string, string> => {
      const host = typeof config.resourceUrl === "string" ? config.resourceUrl : null;
      if (!host) return {};
      return { scope: `${host.replace(/\/+$/, "")}/.default offline_access` };
    },
  },
};

export interface RefreshOutcome {
  accessToken: string;
  /** Some vendors rotate the refresh token on every use; most do not. */
  refreshToken?: string;
  expiresInSeconds?: number;
  /** Salesforce returns a possibly-moved instance URL. */
  instanceUrl?: string;
}

/** A refusal the customer must act on, as opposed to one worth retrying. */
export class RefreshRejected extends Error {}

export async function refreshAccessToken(
  provider: string,
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  config: Record<string, unknown>,
  fetchImpl: typeof fetch = fetch,
): Promise<RefreshOutcome> {
  const spec = PROVIDERS[provider];
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
    ...(spec?.extraFields?.(config) ?? {}),
  });

  const res = await fetchImpl(tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
    signal: AbortSignal.timeout(Number(process.env.CRM_TOKEN_REFRESH_TIMEOUT_MS ?? 15_000)),
  });

  const text = await res.text();
  if (!res.ok) {
    // 400 and 401 from a token endpoint mean the grant itself is bad - revoked,
    // expired, or the wrong client. Retrying cannot fix any of those, and the
    // caller must stop rather than loop.
    if (res.status === 400 || res.status === 401) {
      throw new RefreshRejected(`token endpoint refused the grant: HTTP ${res.status}`);
    }
    throw new Error(`token endpoint returned HTTP ${res.status}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("token endpoint did not return JSON");
  }
  // Zoho returns HTTP 200 with `{"error":"invalid_code"}` - a refusal wearing a
  // success code, which is exactly the shape that makes a naive refresher loop
  // forever on a dead credential.
  if (typeof parsed.error === "string") {
    throw new RefreshRejected(`token endpoint refused the grant: ${parsed.error}`);
  }
  const access = parsed.access_token;
  if (typeof access !== "string" || access.length === 0) {
    throw new Error("token endpoint returned no access_token");
  }

  return {
    accessToken: access,
    refreshToken: typeof parsed.refresh_token === "string" ? parsed.refresh_token : undefined,
    expiresInSeconds: typeof parsed.expires_in === "number" ? parsed.expires_in : undefined,
    instanceUrl: typeof parsed.instance_url === "string" ? parsed.instance_url : undefined,
  };
}

export async function refreshDueCrmTokens(fetchImpl: typeof fetch = fetch): Promise<number> {
  const pool = getAdminPool();
  const { rows } = await pool.query<Refreshable>(DUE_SQL, [
    Math.round(REFRESH_LEAD_MS() / 1000),
  ]);
  if (rows.length === 0) return 0;

  let refreshed = 0;
  for (const row of rows) {
    const spec = PROVIDERS[row.provider];
    if (!spec) continue; // monday and the fifteen key-based vendors.

    const config = (row.config ?? {}) as Record<string, unknown>;
    const tokenUrl = row.token_url ?? spec.defaultTokenUrl?.(config) ?? null;
    if (!tokenUrl) {
      await markError(
        pool,
        row.id,
        "no token endpoint is configured for this connection, so its access token cannot be refreshed",
      );
      continue;
    }

    // The tenant's OWN OAuth app (0120). The platform's credentials must never
    // be used to refresh a customer's token: the refresh is performed against
    // the client that issued the grant, and a mismatched client id is refused
    // by every one of these vendors.
    const app = await readOauthApp(pool, row.org_id, row.provider);
    if (!app) {
      await markError(
        pool,
        row.id,
        "this workspace has not connected its own OAuth app for this provider, so there are no client credentials to refresh with",
      );
      continue;
    }

    const refreshToken = decryptSecret(row.refresh_secret);
    if (!refreshToken) {
      await markError(pool, row.id, "the stored refresh token could not be read");
      continue;
    }

    try {
      const out = await refreshAccessToken(
        row.provider,
        tokenUrl,
        app.clientId,
        app.clientSecret,
        refreshToken,
        config,
        fetchImpl,
      );

      await withOrgContext(row.org_id, async (client) => {
        await client.query(
          `UPDATE crm_integrations
              SET auth_secret = $2,
                  -- Only when the vendor rotated it. Overwriting a working
                  -- refresh token with undefined would be a self-inflicted
                  -- re-consent.
                  refresh_secret = COALESCE($3, refresh_secret),
                  token_expires_at = CASE WHEN $4::int IS NULL THEN NULL
                                          ELSE now() + make_interval(secs => $4::int) END,
                  token_refreshed_at = now(),
                  token_refresh_error = NULL,
                  -- A connection parked on 'error' by a lapsed token is live
                  -- again the moment it has a working one.
                  status = CASE WHEN status = 'error' THEN 'connected' ELSE status END,
                  -- Salesforce migrates orgs between pods and returns the new
                  -- host on refresh. Ignoring it means every delivery after a
                  -- migration goes to the old pod and 404s.
                  endpoint = CASE WHEN $5::text IS NULL THEN endpoint
                                  ELSE regexp_replace(endpoint, '^https://[^/]+', $5::text) END,
                  updated_at = now()
            WHERE id = $1`,
          [
            row.id,
            encryptSecret(out.accessToken),
            out.refreshToken ? encryptSecret(out.refreshToken) : null,
            out.expiresInSeconds ?? null,
            out.instanceUrl ?? null,
          ],
        );
      });
      refreshed++;
      console.log(
        `crm token refresh: ${row.label ?? row.provider} renewed` +
          (out.expiresInSeconds ? ` for ${Math.round(out.expiresInSeconds / 60)}m` : ""),
      );
    } catch (err) {
      if (err instanceof RefreshRejected) {
        await markError(pool, row.id, err.message);
        await raiseReconsent(row);
      } else {
        // A transient failure leaves the row alone entirely, so the next sweep
        // tries again. It must NOT write token_refresh_error, which is the
        // permanent stop.
        console.error(`crm token refresh: ${row.label ?? row.provider} failed transiently:`, err);
      }
    }
  }

  if (refreshed > 0) console.log(`crm token refresh: renewed ${refreshed} token(s)`);
  return refreshed;
}

async function readOauthApp(
  pool: ReturnType<typeof getAdminPool>,
  orgId: string,
  provider: string,
): Promise<{ clientId: string; clientSecret: string } | null> {
  try {
    const {
      rows: [row],
    } = await pool.query<{ client_id: string; client_secret: string | null }>(
      `SELECT client_id, client_secret FROM org_oauth_apps
        WHERE org_id = $1 AND provider = $2`,
      [orgId, provider],
    );
    const secret = row?.client_secret ? decryptSecret(row.client_secret) : null;
    if (!row?.client_id || !secret) return null;
    return { clientId: row.client_id, clientSecret: secret };
  } catch {
    return null;
  }
}

/** The permanent stop. Cleared only by a human saving a new credential. */
async function markError(
  pool: ReturnType<typeof getAdminPool>,
  id: string,
  reason: string,
): Promise<void> {
  await pool
    .query(
      `UPDATE crm_integrations
          SET token_refresh_error = $2, status = 'error', updated_at = now()
        WHERE id = $1`,
      [id, reason.slice(0, 500)],
    )
    .catch((err) => console.error("crm token refresh: could not record the failure:", err));
}

/**
 * Tell the workspace admins they must re-consent.
 *
 * Reuses 0204's `integration_needs_attention` rather than inventing a kind: a
 * revoked refresh token and an expired access token are the same problem to the
 * person who has to fix them, and two kinds would mean two notification
 * preferences for one job.
 */
async function raiseReconsent(row: Refreshable): Promise<void> {
  const spec = crmProvider(row.provider);
  const name = row.label ?? spec?.label ?? row.provider;
  await withOrgContext(row.org_id, async (client) => {
    await client.query(
      `INSERT INTO notifications (org_id, user_id, kind, title, body, link_path, dedupe_key)
       SELECT $1, m.user_id, 'integration_needs_attention', $2, $3, '/owner/integrations', $4
         FROM memberships m
        WHERE m.org_id = $1 AND m.owner_role = ANY($5::text[]) AND m.status = 'active'
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [
        row.org_id,
        `${name} needs to be reconnected`,
        `${name} has rejected our stored credential, and it cannot be renewed automatically - ` +
          `this usually means the authorisation was revoked at ${name} or expired. Deliveries are ` +
          `queued and will resume once it is reconnected. Open Integrations and save a fresh ` +
          `credential; we will stop retrying until you do, so the connection is not locked out for ` +
          `too many attempts.`,
        `integration-reconsent:${row.id}`,
        OWNER_ROLE_ADMINS,
      ],
    );
  });
  announce(row.org_id, "notification", "created");
}

export function startCrmTokenRefresh(): NodeJS.Timeout {
  // Every five minutes against a ten-minute lead time, so a token is renewed
  // with slack to spare even if one sweep is missed. Cheap: the query is
  // partial-indexed and, on this deployment, returns nothing most of the time.
  const interval = Number(process.env.CRM_TOKEN_REFRESH_INTERVAL_MS ?? 5 * 60 * 1000);
  const timer = setInterval(() => {
    void refreshDueCrmTokens().catch((err) => console.error("crm token refresh:", err));
  }, interval);
  timer.unref?.();
  return timer;
}
