import { captureError, initErrorReporting } from "@aura/shared";

/**
 * Error reporting for the marketing site (doc 49 P2-A, lowest value, done for
 * completeness).
 *
 * ── WHY IT IS WORTH ANYTHING AT ALL ─────────────────────────────────────────
 *
 * This is mostly static pages, and a broken static page is visible to anyone
 * who looks. But it is also the front of the funnel: the pricing page's buy
 * button, the signup claim route and the web-form endpoints live here, and a
 * 500 on one of those is a sale that silently did not happen. Nobody complains
 * about a checkout they could not start - they leave. That is the same failure
 * shape as P1, on the revenue side rather than the product side.
 *
 * Deliberately NOT process handlers: Next owns this process and
 * `onRequestError` already receives every uncaught server-side error.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  initErrorReporting({ service: "marketing", installProcessHandlers: false });
}

/**
 * The route TEMPLATE and nothing else.
 *
 * No resolved path, because this site's own routes take a signup token and a
 * price-list query; no body, because a web-form POST here carries a prospect's
 * name, email and phone number. `captureError` builds its event from an
 * allowlist, so neither can travel even if somebody adds them to this call.
 */
export async function onRequestError(
  err: unknown,
  request: { path?: string; method?: string },
  context: { routePath?: string; routerKind?: string },
): Promise<void> {
  const route = context?.routePath ?? "unrouted";
  const where = `${request?.method ?? "?"} ${route}`;
  captureError(err, { where, fingerprint: `marketing:${where}` });
}
