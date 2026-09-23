/**
 * Where an OAuth callback that lands on the API sends the browser next
 * (doc 28 §11.3).
 *
 * ── WHY THE API REDIRECTS AT ALL ────────────────────────────────────────────
 *
 * Meta and LinkedIn were registered with API URLs (`META_OAUTH_REDIRECT_URI`,
 * `LINKEDIN_REDIRECT_URI`), and changing those means editing each provider's
 * developer dashboard - so they stay. What changed is the answer. Both
 * callbacks used to render JSON on the API's own domain, which left the person
 * staring at `{"connected":true}` with no way back into the console. They now
 * always answer with a 302 into the connect flow, success or failure.
 *
 * ── WHY THE TARGET NEVER COMES FROM THE REQUEST ─────────────────────────────
 *
 * Everything in a callback's query string was written by whoever built the
 * link, and a callback is a link anybody can build. So the base is
 * `PUBLIC_APP_URL` - the same value `connections/oauth.ts` builds the Google
 * and Microsoft redirect URI on, which already carries the console's basePath
 * - and the rest is fixed here. There is nothing a caller can put in a URL
 * that changes where this sends them, which is what makes it not an open
 * redirect.
 *
 * ── WHY ERRORS ARE CODES ────────────────────────────────────────────────────
 *
 * The provider's own words ("Permissions error", a JSON body, sometimes an
 * HTML page) never go into a URL: a URL ends up in history, in logs and in
 * Referer headers, and the console could not render arbitrary provider text
 * safely anyway. The console maps each code to a sentence of its own; the raw
 * text goes to the audit row or the log, where an operator can read it.
 */

/** The console apps whose connect flow an API callback can return to. */
export type ConnectReturnApp = "meta_lead_ads" | "linkedin_ads";

export type ConnectErrorCode =
  /** The person pressed Cancel (or Not now) at the provider. */
  | "denied"
  /** The signed state is missing, forged or older than its ten minutes. */
  | "expired"
  /** Facebook signed them in, but they manage no Page Aura could use. */
  | "no_pages"
  /** LinkedIn signed them in, but the grant sees no ad account. */
  | "no_accounts"
  /** Anything else: the code exchange failed, the provider errored. */
  | "provider_error";

export type ConnectReturn =
  | { step: "choose"; pending: string }
  | { step: "auth"; error: ConnectErrorCode };

/** `PUBLIC_APP_URL` without its trailing slashes, or the local console. */
export function consoleBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PUBLIC_APP_URL?.trim();
  return (configured || "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * `${PUBLIC_APP_URL}/owner/integrations/<app>/connect?step=...`.
 *
 * Success carries the id of whatever is waiting for the person's choice;
 * failure carries one code. Never both, and never anything else.
 */
export function connectReturnUrl(
  app: ConnectReturnApp,
  outcome: ConnectReturn,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const query =
    outcome.step === "choose"
      ? new URLSearchParams({ step: "choose", pending: outcome.pending })
      : new URLSearchParams({ step: "auth", error: outcome.error });
  return `${consoleBaseUrl(env)}/owner/integrations/${app}/connect?${query.toString()}`;
}

/**
 * The values providers send when a person says no, rather than when something
 * broke. Facebook: `error=access_denied&error_reason=user_denied`. LinkedIn:
 * `error=user_cancelled_login` or `user_cancelled_authorize`.
 */
const DENIALS = new Set([
  "access_denied",
  "user_denied",
  "user_cancelled_login",
  "user_cancelled_authorize",
]);

/**
 * What a provider's own `error` parameters mean for the console, or null when
 * it sent none.
 *
 * Split in two on purpose. "You cancelled" and "Facebook had a problem" ask
 * for different things from the person - one is a choice they can simply
 * reverse, the other might need their account owner - so an error that is not
 * a recognisable refusal is `provider_error`, not `denied`.
 */
export function providerErrorCode(...values: Array<string | undefined>): ConnectErrorCode | null {
  const sent = values.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (sent.length === 0) return null;
  return sent.some((v) => DENIALS.has(v)) ? "denied" : "provider_error";
}

/**
 * One query parameter as a plain string. Express parses `?a=1&a=2` into an
 * array and `?a[b]=1` into an object, and a callback has to survive whatever
 * the link it was sent contained.
 */
export function oauthParam(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
