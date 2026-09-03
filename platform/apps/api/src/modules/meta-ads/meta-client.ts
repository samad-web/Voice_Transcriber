import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Meta Graph API client for Lead Ads capture (Kailash gap Milestone 4).
 * Inbound only - Aura never sends anything to Meta here, it only reads a
 * Page's leadgen submissions once a human has connected that Page.
 */

const GRAPH_VERSION = "v21.0";
// Overridable so a local test can point this at a stub instead of the real
// Graph API - same reasoning as ASR_STUB/ANALYZE_STUB elsewhere in this
// codebase: an external provider should never be the only way to test the
// code that calls it.
const GRAPH_BASE = process.env.META_GRAPH_BASE_URL ?? `https://graph.facebook.com/${GRAPH_VERSION}`;

export interface MetaOAuthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
}

export function metaAuthorizeUrl(config: MetaOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.appId,
    redirect_uri: config.redirectUri,
    state,
    scope: "pages_show_list,pages_manage_ads,leads_retrieval,pages_manage_metadata",
    response_type: "code",
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

export async function exchangeCodeForToken(
  config: MetaOAuthConfig,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string }> {
  const params = new URLSearchParams({
    client_id: config.appId,
    client_secret: config.appSecret,
    redirect_uri: config.redirectUri,
    code,
  });
  const res = await fetchImpl(`${GRAPH_BASE}/oauth/access_token?${params.toString()}`);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Meta rejected the code exchange (${res.status}): ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as { access_token: string };
  return { accessToken: body.access_token };
}

export interface MetaPage {
  id: string;
  name: string;
  access_token: string;
}

/** The Pages this user manages, each with its own long-lived Page token. */
export async function listManagedPages(userAccessToken: string, fetchImpl: typeof fetch = fetch): Promise<MetaPage[]> {
  const res = await fetchImpl(`${GRAPH_BASE}/me/accounts?access_token=${encodeURIComponent(userAccessToken)}`);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Meta rejected the Pages list (${res.status}): ${detail.slice(0, 300)}`);
  }
  const body = (await res.json()) as { data: MetaPage[] };
  return body.data ?? [];
}

/** Subscribes a Page to leadgen webhook events - required before any lead arrives. */
export async function subscribePageToLeadgen(pageId: string, pageAccessToken: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(
    `${GRAPH_BASE}/${encodeURIComponent(pageId)}/subscribed_apps?subscribed_fields=leadgen&access_token=${encodeURIComponent(pageAccessToken)}`,
    { method: "POST" },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Meta rejected the webhook subscription (${res.status}): ${detail.slice(0, 300)}`);
  }
}

export interface MetaLeadFieldData {
  name: string;
  values: string[];
}

export interface MetaLead {
  id: string;
  created_time: string;
  form_id?: string;
  field_data: MetaLeadFieldData[];
  /**
   * Requested explicitly by `fetchLead` - the Graph node does not return these
   * by default. They are the most reliable place a PROJECT is named ("3D
   * Website - Showroom"), which is what the intake path runs project detection
   * over. `form_name` is deliberately absent: it lives on the form node, not
   * the lead, and fetching it would be a second round trip per lead.
   */
  ad_name?: string;
  adset_name?: string;
  campaign_name?: string;
  platform?: string;
}

/** The full submitted answers for one leadgen event - the webhook only ever carries the id. */
export async function fetchLead(leadgenId: string, pageAccessToken: string, fetchImpl: typeof fetch = fetch): Promise<MetaLead> {
  const fields = "id,created_time,form_id,field_data,ad_name,adset_name,campaign_name,platform";
  const res = await fetchImpl(
    `${GRAPH_BASE}/${encodeURIComponent(leadgenId)}?fields=${fields}` +
      `&access_token=${encodeURIComponent(pageAccessToken)}`,
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Meta rejected the lead fetch (${res.status}): ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as MetaLead;
}

/** Meta's standard field names -> the CRM concept they map to. */
export function mapLeadFields(fields: MetaLeadFieldData[]): { fullName: string | null; email: string | null; phone: string | null } {
  const get = (...names: string[]): string | null => {
    for (const f of fields) {
      if (names.includes(f.name.toLowerCase())) return f.values[0]?.trim() || null;
    }
    return null;
  };
  return {
    fullName: get("full_name", "name"),
    email: get("email"),
    phone: get("phone_number", "phone"),
  };
}

/** `x-hub-signature-256: sha256=<hex>` - the same scheme every Meta webhook (WhatsApp, leadgen) uses. */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header) return false;
  const provided = header.startsWith("sha256=") ? header.slice("sha256=".length) : header;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Signed, stateless OAuth CSRF token: `base64url(orgId.expiry).hmac`. No new
 * table needed - the state round-trips through Meta's redirect and verifies
 * itself, the same shape a JWT would use for something this narrow.
 */
export function signOAuthState(orgId: string, secret: string, ttlMs = 10 * 60 * 1000): string {
  const payload = `${orgId}.${Date.now() + ttlMs}`;
  const encoded = Buffer.from(payload, "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(encoded).digest("hex");
  return `${encoded}.${sig}`;
}

export function verifyOAuthState(state: string, secret: string): { orgId: string } | null {
  const [encoded, sig] = state.split(".");
  if (!encoded || !sig) return null;
  const expected = createHmac("sha256", secret).update(encoded).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  const [orgId, expiryRaw] = Buffer.from(encoded, "base64url").toString("utf8").split(".");
  const expiry = Number(expiryRaw);
  if (!orgId || !Number.isFinite(expiry) || Date.now() > expiry) return null;
  return { orgId };
}
