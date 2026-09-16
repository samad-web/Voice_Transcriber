import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";

/**
 * CORS allowlist (checklist 08 §0.7).
 *
 * Was a single `process.env.WEB_ORIGIN ?? "http://localhost:3000"` string, which
 * cannot express the two cases that already exist in practice: a staging console
 * pointed at the same API, and a developer running the console on a second port.
 * WEB_ORIGIN is now parsed as a comma-separated list; a single value behaves
 * exactly as before, so no deployment changes.
 *
 * Scope note: nothing in the browser talks to this API today - the console is
 * server-rendered and calls it from the Next.js server with the admin key
 * (apps/web/lib/server-api.ts), and the Android client is not subject to CORS at
 * all. So this is a tightening for the day something DOES call it from a page,
 * not a live control. Requests with no Origin header (the Android app, curl,
 * the container healthcheck) are unaffected: the cors middleware only decides
 * which Access-Control-Allow-Origin to echo, it never rejects a request.
 */
export function corsOptions(env: NodeJS.ProcessEnv = process.env): CorsOptions {
  const origins = (env.WEB_ORIGIN ?? "http://localhost:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  // An empty or whitespace-only WEB_ORIGIN would otherwise produce `origin: []`,
  // which allows nothing - a config typo silently breaking every browser call is
  // worse than the documented default.
  return { origin: origins.length > 0 ? origins : ["http://localhost:3000"] };
}

/**
 * Paths that must answer a browser from ANY origin.
 *
 * The web-form intake endpoint (migration 0078) exists to be posted to by a
 * form on a tenant's own website - acme.com, then the next tenant's site, then
 * a staging copy of each. That list is tenant data, it changes without a
 * deployment, and it is not knowable here where there is no database.
 *
 * So the transport is open and the DECISION is made in the handler, which does
 * have the source's configured origin list and records a refusal in the intake
 * ledger where the tenant can see it. That is not a weakening: a browser's
 * Origin header is unforgeable only by browsers, and any attacker can post the
 * same body from a server with no Origin at all. The token is the credential;
 * the origin list is hygiene, and pretending otherwise in CORS would only have
 * made the honest case (a real customer's form) fail.
 */
const OPEN_ORIGIN_PATHS = ["/v1/intake/form/"];

/**
 * Per-request CORS, so the intake endpoint can be open while the console API
 * stays on its allowlist. Nest accepts this delegate shape directly.
 */
export function corsDelegate(env: NodeJS.ProcessEnv = process.env) {
  const base = corsOptions(env);
  return (req: { url?: string }, callback: (err: Error | null, options: object) => void): void => {
    const url = req.url ?? "";
    if (OPEN_ORIGIN_PATHS.some((path) => url.startsWith(path))) {
      callback(null, { origin: true, methods: ["POST", "OPTIONS"], maxAge: 86_400 });
      return;
    }
    callback(null, base);
  };
}
