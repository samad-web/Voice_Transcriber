/**
 * Startup assertions for the web tier.
 *
 * Next calls `register()` once per server process, before the first request is
 * handled - the earliest point at which we can refuse to run. Stable since Next
 * 15 (this app is on 15.5), so no `experimental.instrumentationHook` flag is
 * needed in next.config.ts.
 *
 * What it is guarding: `lib/server-api.ts` does
 * `process.env.ADMIN_API_KEY ?? "dev-admin-key"`, and that key is the platform's
 * root credential - the API's AdminKeyGuard mints a synthetic platform_admin
 * from it and trusts the `x-org-id` header that comes with it. One missing env
 * var (a typo, a container started without --env-file) therefore turns a
 * hardcoded public string into working root access to every tenant. A crashed
 * container is a far better outcome than an open one (road map §0.2).
 */

import { AUTH_ENABLED } from "@/lib/supabase/config";

/** Dev defaults that must never be the live value. Mirrors the API's own list. */
const DEV_DEFAULTS = new Set(["dev-admin-key", "changeme", "change-me"]);

export async function register() {
  // Also loaded in the edge runtime (middleware); the env checks below are
  // about the Node server that actually holds the admin key.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const production = process.env.NODE_ENV === "production";
  const adminKey = process.env.ADMIN_API_KEY;
  const problems: string[] = [];

  if (!adminKey) {
    problems.push("ADMIN_API_KEY is unset - lib/server-api.ts would fall back to \"dev-admin-key\"");
  } else if (DEV_DEFAULTS.has(adminKey)) {
    problems.push(`ADMIN_API_KEY is the known dev default "${adminKey}"`);
  }

  // Road map §0.2 names SUPABASE_URL alongside ADMIN_API_KEY, and for the web
  // tier it is the more dangerous of the two: AUTH_ENABLED is
  // `Boolean(NEXT_PUBLIC_SUPABASE_URL && NEXT_PUBLIC_SUPABASE_ANON_KEY)`, and
  // when it is false the middleware stops gating, getSessionUser() returns null
  // unconditionally, getPrincipal() synthesises an operator and isOperator()
  // returns true for it - the whole console, every tenant, open to anyone who
  // can reach the port. Both values are BUILD-time inlined (docker/web.Dockerfile
  // ARGs), so an image built without `--env-file .env.production` ships that way
  // no matter what the runtime environment says, and nothing else would report it.
  if (!AUTH_ENABLED) {
    problems.push(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY were not set when this image was " +
        "BUILT - sign-in is disabled and every console page is reachable without a session",
    );
  }

  // Not fatal, because a console that refuses to boot is worse than one nobody
  // can sign into - but it is the difference between "operator locked out" and
  // "nobody knows why", and isOperator() now denies by default (§0.1).
  if (!process.env.PLATFORM_OPERATOR_EMAILS) {
    console.error(
      "[startup] PLATFORM_OPERATOR_EMAILS is unset - no account can reach the platform-operator console.",
    );
  }

  if (problems.length === 0) return;

  const detail = problems.join("; ");
  if (production) {
    // Throwing here aborts server start: the process exits non-zero and the
    // container restart-loops loudly instead of serving with a public key.
    throw new Error(
      `[startup] refusing to start in production: ${detail}. ` +
        "Set it in the web tier's environment (platform/.env.production, consumed by the `web` " +
        "service in docker-compose.prod.yml) and redeploy.",
    );
  }
  console.warn(`[startup] ${detail}. Fine for local dev; fatal in production.`);
}
