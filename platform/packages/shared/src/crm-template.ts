/**
 * The rendering engine behind every CRM connector.
 *
 * A connector is data, not code: a URL template, a body template and a field
 * map. This module turns those three into a concrete HTTP request. Keeping it
 * pure (no fetch, no db, no node builtins) means the API can render a preview
 * for the console and the worker can render the real request from exactly the
 * same functions — a payload that looks right in the UI is the payload that
 * gets sent.
 */

/**
 * How the credential is attached to the request.
 *
 *  none          — no credential (open webhook)
 *  bearer        — Authorization: Bearer <secret>
 *  header        — <header>: <secret>                    e.g. api-key, X-API-Key
 *  header_prefix — <header>: <prefix><secret>            e.g. Authorization: Zoho-oauthtoken …
 *  basic         — Authorization: Basic base64(<secret>:)  API key as the username
 *  query         — ?<header>=<secret> appended to the URL
 *
 * `oauth2` is deliberately absent: nothing here needs to change to add it
 * later, because a refreshed access token is just a bearer secret.
 */
export type CrmAuthScheme = "none" | "bearer" | "header" | "header_prefix" | "basic" | "query";

export const CRM_AUTH_SCHEMES: CrmAuthScheme[] = [
  "none",
  "bearer",
  "header",
  "header_prefix",
  "basic",
  "query",
];

export type CrmMethod = "POST" | "PUT" | "PATCH";

/**
 * Dotted path lookup, with numeric segments indexing arrays — Zoho answers
 * `{"data":[{"details":{"id":"…"}}]}`, so `data.0.details.id` has to work.
 */
export function pluckPath(source: unknown, path: string): unknown {
  let cur: unknown = source;
  for (const seg of path.split(".")) {
    if (cur === null || cur === undefined) return null;
    if (Array.isArray(cur)) {
      const i = Number(seg);
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return null;
      cur = cur[i];
      continue;
    }
    if (typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur === undefined ? null : cur;
}

export interface RenderedTemplate {
  value: string;
  /** Placeholders the caller did not supply, in order of appearance. */
  missing: string[];
}

/**
 * Substitute `{{key}}` from `vars` (dotted paths allowed).
 *
 * Missing keys are reported rather than silently blanked. A Salesforce
 * integration saved without an instance URL should be rejected at connect
 * time with "instanceUrl is missing", not discovered at 3am as a POST to
 * `/services/data/v61.0/sobjects/Lead` against no host at all.
 */
export function renderTemplate(template: string, vars: Record<string, unknown>): RenderedTemplate {
  const missing: string[] = [];
  const value = template.replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_match, key: string) => {
    const found = pluckPath(vars, key);
    if (found === null || found === undefined || found === "") {
      if (!missing.includes(key)) missing.push(key);
      return "";
    }
    return String(found);
  });
  return { value, missing };
}

/** True when the string is a template placeholder we would substitute. */
function hasPlaceholder(s: string): boolean {
  return s.includes("{{");
}

export interface RenderBodyOptions {
  /**
   * Key names for `$fieldsPairs`. LeadSquared wants
   * `[{"Attribute":"FirstName","Value":"…"}]` rather than an object.
   */
  pairKeys?: [string, string];
}

/**
 * Render a body template against the mapped fields.
 *
 * Four placeholders, which between them cover every CRM in the catalogue:
 *
 *   "$fields"       → the whole mapped object      {"properties": "$fields"}
 *   "$fieldsJson"   → the same, JSON-encoded       monday.com wants column_values as a string
 *   "$fieldsPairs"  → [{Attribute, Value}, …]      LeadSquared's capture format
 *   "$field:key"    → one mapped value             the escape hatch for nested shapes,
 *                                                  e.g. Close's contacts[].phones[].phone
 *
 * Plain strings containing `{{…}}` are interpolated from `vars`, so a body can
 * also carry per-tenant config such as GoHighLevel's locationId.
 *
 * A null template means "send the mapped object as-is", which is what a plain
 * webhook wants.
 */
export function renderBody(
  template: unknown,
  fields: Record<string, unknown>,
  vars: Record<string, unknown> = {},
  opts: RenderBodyOptions = {},
): unknown {
  if (template === null || template === undefined) return prune(fields);
  const rendered = walk(template, fields, vars, opts);
  return rendered === EMPTY ? undefined : prune(rendered);
}

/**
 * A placeholder that resolved to nothing, kept distinct from a literal null so
 * the structure around it can be collapsed. See the object case in walk().
 */
const EMPTY = Symbol("empty-placeholder");

/**
 * Does this piece of template depend on call data, anywhere inside it?
 *
 * Purely static scaffolding (`{"VALUE_TYPE": "WORK"}`) was written on purpose
 * and is kept; scaffolding that exists only to carry a mapped value is not.
 */
function isDynamic(node: unknown): boolean {
  if (typeof node === "string") {
    return (
      node === "$fields" ||
      node === "$fieldsJson" ||
      node === "$fieldsPairs" ||
      node.startsWith("$field:") ||
      hasPlaceholder(node)
    );
  }
  if (Array.isArray(node)) return node.some(isDynamic);
  if (node && typeof node === "object") return Object.values(node).some(isDynamic);
  return false;
}

function walk(
  node: unknown,
  fields: Record<string, unknown>,
  vars: Record<string, unknown>,
  opts: RenderBodyOptions,
): unknown {
  if (typeof node === "string") {
    if (node === "$fields") {
      const cleaned = prune(fields);
      return cleaned === undefined ? EMPTY : cleaned;
    }
    // Always a string: monday wants column_values as JSON text, and "{}" is a
    // valid empty column set where a dropped key would be a GraphQL error.
    if (node === "$fieldsJson") return JSON.stringify(prune(fields) ?? {});
    if (node === "$fieldsPairs") {
      const [k, v] = opts.pairKeys ?? ["key", "value"];
      const pairs = Object.entries(fields)
        .filter(([, value]) => value !== null && value !== undefined)
        .map(([key, value]) => ({ [k]: key, [v]: value }));
      return pairs.length === 0 ? EMPTY : pairs;
    }
    if (node.startsWith("$field:")) {
      const found = fields[node.slice("$field:".length)];
      return found === null || found === undefined ? EMPTY : found;
    }
    if (hasPlaceholder(node)) {
      const out = renderTemplate(node, vars);
      // Unresolved and nothing left over — the string was only the placeholder.
      return out.missing.length > 0 && out.value === "" ? EMPTY : out.value;
    }
    return node;
  }

  if (Array.isArray(node)) {
    const items = node
      .map((item) => walk(item, fields, vars, opts))
      .filter((item) => item !== EMPTY);
    // A template that listed entries but produced none carries no information;
    // an array written empty on purpose stays empty.
    return items.length === 0 && node.length > 0 ? EMPTY : items;
  }

  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    let dynamic = 0;
    let survived = 0;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const isDyn = isDynamic(value);
      const result = walk(value, fields, vars, opts);
      if (isDyn) {
        dynamic++;
        if (result !== EMPTY) survived++;
      }
      if (result !== EMPTY) out[key] = result;
    }
    // Every data-carrying key came back empty: this object existed to hold a
    // value the call didn't have. Sending `{"type":"office"}` as a phone entry
    // with no number is worse than sending no phone at all.
    if (dynamic > 0 && survived === 0) return EMPTY;
    return Object.keys(out).length === 0 ? EMPTY : out;
  }

  return node;
}

/**
 * Drop nulls before sending.
 *
 * A call that never mentioned a budget produces `budget: null`, and several
 * CRMs treat an explicit null as "clear this field" — which would erase data
 * on the receiving side rather than leave it alone. Objects that empty out
 * entirely are removed too, so a phones[] whose only entry had no number
 * doesn't arrive as `[{}]`.
 */
export function prune(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(prune).filter((item) => item !== undefined);
    return items;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = prune(raw);
      if (cleaned === undefined) continue;
      out[key] = cleaned;
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }
  return value === null ? undefined : value;
}

/**
 * `prune` at the top level, where an empty result must still be an object —
 * `JSON.stringify(undefined)` is the string "undefined", which is not a body.
 */
export function pruneBody(value: unknown): unknown {
  const cleaned = prune(value);
  return cleaned === undefined ? {} : cleaned;
}

/** Attach the credential. Returns headers plus any query params to append. */
export function applyAuth(
  scheme: CrmAuthScheme,
  secret: string | null,
  header: string,
  prefix: string,
  /** Base64 encoder — node's Buffer in the worker, btoa in a browser preview. */
  base64: (input: string) => string,
): { headers: Record<string, string>; query: Record<string, string> } {
  if (scheme === "none" || !secret) return { headers: {}, query: {} };
  switch (scheme) {
    case "bearer":
      return { headers: { authorization: `Bearer ${secret}` }, query: {} };
    case "header":
      return { headers: { [header || "X-API-Key"]: secret }, query: {} };
    case "header_prefix":
      return { headers: { [header || "Authorization"]: `${prefix}${secret}` }, query: {} };
    case "basic":
      // API key as username with an empty password — Close's documented scheme.
      return { headers: { authorization: `Basic ${base64(`${secret}:`)}` }, query: {} };
    case "query":
      return { headers: {}, query: { [header || "api_token"]: secret } };
    default:
      return { headers: {}, query: {} };
  }
}

/** The stored connector fields that decide where a request goes. */
export interface CrmRequestConfig {
  endpoint: string | null;
  method?: CrmMethod | null;
  authType: CrmAuthScheme;
  authHeader?: string | null;
  authPrefix?: string | null;
  headers?: Record<string, string> | null;
  /** Per-tenant values interpolated into the endpoint and headers. */
  config?: Record<string, unknown> | null;
}

export interface ResolvedCrmRequest {
  url: string;
  method: CrmMethod;
  headers: Record<string, string>;
  /** Config keys the templates referenced but nothing supplied. */
  missing: string[];
}

/**
 * Turn stored connector config into a concrete request line: interpolate the
 * endpoint and headers, then attach the credential.
 *
 * Lives here rather than in the worker so the console's "test connection" and
 * the worker's real send resolve identically — a test that passes against a
 * different URL than production uses is worse than no test at all. The secret
 * arrives already decrypted and base64 is injected, keeping this module free
 * of node builtins so the web bundle can import its siblings.
 */
export function resolveCrmRequest(
  cfg: CrmRequestConfig,
  secret: string | null,
  base64: (input: string) => string,
): ResolvedCrmRequest {
  const vars = (cfg.config ?? {}) as Record<string, unknown>;
  const rendered = renderTemplate(cfg.endpoint ?? "", vars);
  const missing = [...rendered.missing];

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(cfg.headers ?? {})) {
    const out = renderTemplate(String(value), vars);
    headers[name] = out.value;
    for (const key of out.missing) if (!missing.includes(key)) missing.push(key);
  }

  const auth = applyAuth(
    cfg.authType,
    secret,
    cfg.authHeader ?? "",
    cfg.authPrefix ?? "",
    base64,
  );

  return {
    url: withQuery(rendered.value, auth.query),
    method: cfg.method ?? "POST",
    headers: { ...headers, ...auth.headers },
    missing,
  };
}

/** Append query params to a URL that may already carry some. */
export function withQuery(url: string, params: Record<string, string>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== "");
  if (entries.length === 0) return url;
  const encoded = entries
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  return url.includes("?") ? `${url}&${encoded}` : `${url}?${encoded}`;
}
