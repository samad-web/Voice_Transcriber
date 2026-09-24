/**
 * Which payment gateways an org can mint a link through right now, and what
 * each one's own configuration looks like - without ever reading a secret.
 *
 * Shared by `GET /owner/payment-settings` (owner-only: the full per-provider
 * card) and `GET /invoices/:id` (anyone who may view the invoice: just the two
 * booleans the "Collect payment" picker needs).
 *
 * "Available" mirrors resolveRazorpayCredentials / resolveStripeCredentials
 * exactly: the org's own enabled row with a key id and a secret, OR the
 * platform's env fallback. It is computed from `IS NOT NULL`, so nothing is
 * decrypted to answer it.
 */

export const GATEWAY_PROVIDERS = ["razorpay", "stripe"] as const;
export type GatewayProvider = (typeof GATEWAY_PROVIDERS)[number];

export interface GatewayState {
  provider: GatewayProvider;
  /** Razorpay key id / Stripe publishable key. Neither is a secret. */
  keyId: string | null;
  hasSecret: boolean;
  hasWebhookSecret: boolean;
  enabled: boolean;
  /** The org's own keys are complete and switched on. */
  ownAccount: boolean;
  /** No own account, and the platform's keys are what a link would use. */
  usingPlatformGateway: boolean;
  /** A link can be created through this provider at all. */
  available: boolean;
}

type QueryClient = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

function platformConfigured(provider: GatewayProvider, env: NodeJS.ProcessEnv): boolean {
  return provider === "razorpay"
    ? Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET)
    : Boolean(env.STRIPE_SECRET_KEY);
}

export async function readGatewayStates(
  client: QueryClient,
  orgId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<GatewayProvider, GatewayState>> {
  const { rows } = await client.query(
    `SELECT provider, key_id,
            (key_secret IS NOT NULL)     AS has_secret,
            (webhook_secret IS NOT NULL) AS has_webhook,
            enabled
       FROM payment_gateway_config
      WHERE org_id = $1 AND provider = ANY($2::text[])`,
    [orgId, GATEWAY_PROVIDERS],
  );

  const out = {} as Record<GatewayProvider, GatewayState>;
  for (const provider of GATEWAY_PROVIDERS) {
    const row = rows.find((r) => r.provider === provider);
    const ownAccount = Boolean(row?.key_id && row?.has_secret && row?.enabled);
    const platform = platformConfigured(provider, env);
    out[provider] = {
      provider,
      keyId: row?.key_id ?? null,
      hasSecret: row?.has_secret ?? false,
      hasWebhookSecret: row?.has_webhook ?? false,
      enabled: row?.enabled ?? true,
      ownAccount,
      // Razorpay's historic meaning (0060's fallback), kept for the existing
      // card: "not your own account" reads as "the platform's".
      usingPlatformGateway: !ownAccount,
      available: ownAccount || platform,
    };
  }
  return out;
}
