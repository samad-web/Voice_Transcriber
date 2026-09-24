import "server-only";
import { headers } from "next/headers";

/**
 * The console's public base URL - origin plus basePath, e.g.
 * `https://aura.sirahagents.com/admin`.
 *
 * `PUBLIC_APP_URL` when set (production: docker-compose.prod.yml derives it
 * from APP_DOMAIN + CONSOLE_BASE_PATH, as it does for the API). Otherwise the
 * forwarded host of the current request, which is what local dev wants.
 *
 * NOT `new URL(request.url).origin` in a route handler: behind nginx the
 * standalone server reports the address it is bound to, and the live Google
 * callback redirected people to `https://0.0.0.0:3000/admin/...`.
 */
export async function consolePublicBase(): Promise<string> {
  const configured = process.env.PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");
  return `${proto}://${host}${basePath}`;
}

/** Just the origin of {@link consolePublicBase} - what `consoleUrl()` takes. */
export async function consolePublicOrigin(): Promise<string> {
  return new URL(await consolePublicBase()).origin;
}
