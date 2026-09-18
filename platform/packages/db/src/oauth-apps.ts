import { oauthEndpoints, type ConnectionProviderSpec } from "@aura/shared";
import { decryptSecret } from "./secrets";

/**
 * Which registered OAuth app a Google or Microsoft connection goes through
 * (migration 0120).
 *
 * An organisation's own app (org_oauth_apps) comes first; the platform's app
 * from the environment is the fallback. Lives in @aura/db because the API
 * (connect, send, sheet preview) and the worker (mail, calendar and sheet
 * sweeps) must answer this identically, cannot import each other, and the
 * answer needs a database read plus a decrypt - neither of which belongs in
 * the network- and database-free @aura/shared.
 */

export interface ResolvedOAuthClient {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Whose registration this is - the organisation's own, or the platform's. */
  source: "organization" | "platform";
}

/** Anything with a pg-style `query`: a PoolClient, the worker's DbClient, a test fake. */
export interface OAuthAppQueryable {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

/**
 * A connection was made through an app that is no longer configured.
 *
 * Its refresh token belongs to that app's client ID, so no other app can
 * refresh it: the only fix is signing in again. A distinct type so the sweeps
 * can park the connection at once instead of retrying something that cannot
 * succeed.
 */
export class OAuthAppChangedError extends Error {
  readonly needsReconnect = true;

  constructor(label: string) {
    super(
      `this account was connected through a ${label} app that is no longer set up for your ` +
        "organisation - reconnect it from Connections",
    );
    this.name = "OAuthAppChangedError";
  }
}

/** The platform's own app, from the environment. */
export function platformOAuthClient(
  spec: ConnectionProviderSpec,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedOAuthClient | null {
  if (!spec.oauth) return null;
  const clientId = env[spec.oauth.clientIdEnv]?.trim();
  const clientSecret = env[spec.oauth.clientSecretEnv]?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, ...oauthEndpoints(spec), source: "platform" };
}

/**
 * The organisation's own app. `db` must already be scoped to `orgId` (RLS);
 * the explicit `org_id` filter is belt and braces, not the boundary.
 */
export async function organizationOAuthClient(
  db: OAuthAppQueryable,
  orgId: string,
  spec: ConnectionProviderSpec,
): Promise<ResolvedOAuthClient | null> {
  if (!spec.oauth) return null;
  const { rows } = await db.query(
    `SELECT client_id, client_secret, tenant
       FROM org_oauth_apps
      WHERE org_id = $1 AND provider = $2`,
    [orgId, spec.id],
  );
  const row = rows[0] as
    | { client_id: string; client_secret: string | null; tenant: string | null }
    | undefined;
  const clientSecret = row ? decryptSecret(row.client_secret) : null;
  if (!row || !clientSecret) return null;
  return {
    clientId: row.client_id,
    clientSecret,
    ...oauthEndpoints(spec, row.tenant),
    source: "organization",
  };
}

/**
 * The app to use for `spec` in this organisation.
 *
 * With `issuedTo` - the client ID a connection or sign-in was started with -
 * only that app will do, and its absence throws OAuthAppChangedError rather
 * than returning a different app whose token requests would all be refused.
 * Without it (a new sign-in, or a row from before 0120 recorded one), the
 * organisation's app wins over the platform's. Null means neither exists.
 */
export async function resolveOAuthClient(
  db: OAuthAppQueryable,
  orgId: string,
  spec: ConnectionProviderSpec,
  options: { issuedTo?: string | null; env?: NodeJS.ProcessEnv } = {},
): Promise<ResolvedOAuthClient | null> {
  const candidates = [
    await organizationOAuthClient(db, orgId, spec),
    platformOAuthClient(spec, options.env),
  ].filter((c): c is ResolvedOAuthClient => c !== null);

  if (options.issuedTo) {
    const match = candidates.find((c) => c.clientId === options.issuedTo);
    if (!match) throw new OAuthAppChangedError(spec.label);
    return match;
  }
  return candidates[0] ?? null;
}
