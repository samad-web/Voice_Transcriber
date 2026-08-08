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
 * Scope note: nothing in the browser talks to this API today — the console is
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
  // which allows nothing — a config typo silently breaking every browser call is
  // worse than the documented default.
  return { origin: origins.length > 0 ? origins : ["http://localhost:3000"] };
}
