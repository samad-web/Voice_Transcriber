import { WasiErrorResponse, type ChannelProbeOutcome } from "@aura/shared";

/**
 * `WasiSendRequest` minus `client_id` - hand-written rather than
 * `Omit<WasiSendRequest, "client_id">` because `Omit` does not distribute
 * over a union, and collapses the two send shapes into one that's missing
 * both variants' own fields. `sendWasiMessage` supplies `client_id` itself
 * from the channel, so the caller should never need to pass it.
 */
type WasiSendInput =
  | { type: "template"; to: string; template: string; params?: Record<string, string>; headerMediaUrl?: string }
  | { type: "text"; to: string; body: string };

/**
 * Aura as a Hub API CLIENT of Wasi (`C:\Users\mas20\Desktop\work\Wasi`) - the
 * user's own WhatsApp Business Solution Provider platform. This is the
 * outbound half; the inbound half (signature verification, event routing)
 * lives in messaging-webhook.controller.ts.
 */

export interface WasiChannel {
  apiBaseUrl: string;
  /** Decrypted already - callers read this off `decryptSecret(channel.api_key)`. */
  apiKey: string;
  wasiClientId: string;
}

export class WasiSendError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
    public readonly metaError: unknown,
    public readonly httpStatus: number,
  ) {
    super(message);
  }
}

export interface WasiSendResult {
  /** Wasi's `messages` row, `returning *` - the fields this codebase reads are typed below. */
  metaMessageId: string | null;
  status: string;
  raw: unknown;
}

/**
 * `POST /api/v1/messages`. Wasi enforces the real business rules (WABA
 * connected, consent, plan volume cap, 24h session window, template
 * approval) server-side - this is a thin, faithful client, not a
 * reimplementation of that logic. A rejection is surfaced with Wasi's own
 * `code` intact so the caller (whatsapp-send.controller.ts) can react to
 * `session_window_closed` differently from `waba_not_connected`.
 */
export async function sendWasiMessage(
  channel: WasiChannel,
  request: WasiSendInput,
  fetchImpl: typeof fetch = fetch,
): Promise<WasiSendResult> {
  const res = await fetchImpl(`${channel.apiBaseUrl.replace(/\/$/, "")}/api/v1/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${channel.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...request, client_id: channel.wasiClientId }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const parsed = WasiErrorResponse.safeParse(body);
    throw new WasiSendError(
      parsed.success ? parsed.data.error : `Wasi rejected the send (${res.status})`,
      parsed.success ? parsed.data.code : undefined,
      parsed.success ? parsed.data.metaError : undefined,
      res.status,
    );
  }
  const row = body as { meta_message_id?: string | null; status?: string };
  return { metaMessageId: row.meta_message_id ?? null, status: row.status ?? "sent", raw: body };
}

export interface WasiTemplate {
  name: string;
  status: string;
  category?: string;
  language?: string;
}

/* ── Probing ────────────────────────────────────────────────────────────────
 *
 * "Are these credentials real?" - asked on demand, and recorded as a
 * measurement rather than a verdict (migration 0099).
 *
 * Until this existed, a channel created with a typo'd key was indistinguishable
 * from a working one until the first real customer message failed to send. The
 * console showed "active", because that is the operator switch and it was never
 * a health signal.
 *
 * WHY IT REUSES THE TEMPLATE LIST RATHER THAN SENDING ANYTHING
 *
 * `GET /api/v1/templates` is the only Wasi endpoint that is authenticated,
 * read-only, and has no side effect anybody can see. A probe that sent a
 * message would put a real WhatsApp message on somebody's phone every time an
 * owner pressed a button on a settings page, and a probe that created anything
 * would leave debris behind on every check.
 *
 * WHAT IT PROVES, AND WHAT IT DOES NOT
 *
 * It proves the OUTBOUND half only: our key, against their host. It says
 * nothing about whether inbound deliveries can arrive, which turns on
 * `forward_secret` and is a fact Aura already holds locally. Conflating the two
 * is exactly what let a send-only channel look finished, so `readChannel()`
 * keeps them apart and this function is careful not to claim the other half.
 */
export interface WasiProbeResult {
  outcome: ChannelProbeOutcome;
  /** The provider's own words, truncated. Never a credential. */
  detail: string | null;
}

/** Enough of a channel to ask the question. `wasiClientId` is not needed here. */
export type WasiProbeTarget = Pick<WasiChannel, "apiBaseUrl" | "apiKey">;

export async function probeWasiChannel(
  channel: WasiProbeTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<WasiProbeResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${channel.apiBaseUrl.replace(/\/$/, "")}/api/v1/templates`, {
      headers: { authorization: `Bearer ${channel.apiKey}` },
      // A settings page is waiting on this. A probe that hangs for the default
      // socket timeout is indistinguishable from a broken page, and the answer
      // it is waiting for - "did the host answer" - is already known by then.
      signal: AbortSignal.timeout(8_000),
    });
  } catch (err) {
    // No answer at all: DNS, TLS, refused, timed out. Deliberately NOT the same
    // outcome as a refusal - see channel-health.ts. The fix for one is to wait,
    // and for the other is to re-paste a key; a single "connection problem"
    // sends people to do the wrong one.
    return { outcome: "unreachable", detail: truncate(errorText(err)) };
  }

  if (res.ok) return { outcome: "ok", detail: null };

  // Read ONCE. A Response body is a stream and reading it twice throws, which
  // would turn every failing probe into an exception and every exception into
  // `unreachable` - the one outcome that tells the reader to wait rather than
  // to fix something.
  const body = await bodyText(res);

  if (res.status === 401 || res.status === 403) {
    // The host answered, and its answer was no. Retrying changes nothing.
    return { outcome: "credentials_rejected", detail: providerMessage(body) };
  }

  // A 404 usually means the host URL points at something that is not the
  // provider; a 5xx means the provider itself is unwell. Both are "we do not
  // know whether the key is good", which is what provider_error means.
  //
  // MEASURED against the live host: probing `https://example.com` returns a
  // 404 whose body is a full HTML page, and the first draft put 300 characters
  // of `<!doctype html><html lang="en">…` straight onto the settings card.
  // That is worse than saying nothing - it buries the one fact that matters
  // under markup. A host answering with a web page instead of JSON is not an
  // unknown error, it is a precise diagnosis: whatever is at that URL, it is
  // not the provider's API.
  if (looksLikeHtml(res, body)) {
    return {
      outcome: "provider_error",
      detail: `The host answered with a web page rather than the provider's API (HTTP ${res.status}). Check the host URL.`,
    };
  }
  return { outcome: "provider_error", detail: truncate(`HTTP ${res.status} ${providerMessage(body) ?? ""}`) };
}

/**
 * Why the request never got an answer.
 *
 * MEASURED against a hostname that does not resolve: `undici` throws
 * `TypeError: fetch failed` and puts the ACTUAL reason - `ENOTFOUND`,
 * `ECONNREFUSED`, a certificate error - on `err.cause`. The first draft read
 * only `err.message`, so every network failure in the product reported the
 * same two useless words, and "the DNS name is wrong" was indistinguishable
 * from "the provider is down" at the one moment the difference decides who
 * gets called.
 */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === "TimeoutError") return "no response within 8s";

  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    return code ? `${code}: ${cause.message}` : cause.message;
  }
  return err.message;
}

async function bodyText(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).trim();
}

/**
 * Did the host answer with a document rather than an API response?
 *
 * The content-type first, because that is the host's own claim, and the body
 * shape only as a fallback - a misconfigured proxy serves an error page as
 * `text/plain` often enough that trusting the header alone would miss the case
 * this function exists for.
 */
function looksLikeHtml(res: Response, body: string): boolean {
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) return true;
  return /^\s*<(?:!doctype|html)\b/i.test(body);
}

/**
 * The provider's message, unwrapped from its envelope.
 *
 * MEASURED: live Wasi answers a bad key with
 * `{"error":{"code":"invalid_api_key","message":"Invalid or revoked API key."}}`
 * and the first draft put that whole string on the card. The owner has to read
 * past two levels of JSON to reach four words that were written for them. Both
 * envelope shapes are handled because the two are one refactor apart on the
 * provider's side, and a change there must degrade to the raw body rather than
 * to an empty card.
 */
function providerMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as {
      error?: string | { message?: string; code?: string };
      message?: string;
    };
    const err = parsed.error;
    if (typeof err === "string") return truncate(err);
    if (err?.message) return truncate(err.message);
    if (parsed.message) return truncate(parsed.message);
  } catch {
    /* Not JSON. The raw body below is the best we have. */
  }
  return truncate(body);
}

/**
 * Bounded before it reaches the database. Long enough to carry a real provider
 * message, short enough that a provider echoing the request back cannot write a
 * page of text into every channel row.
 */
function truncate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

/**
 * `GET /api/v1/templates` - for the composer's template picker. No client_id
 * on this one (unlike send): the Bearer key alone resolves to exactly one
 * client on Wasi's side, and a template has no separate "who is this for."
 */
export async function listWasiTemplates(channel: WasiChannel, fetchImpl: typeof fetch = fetch): Promise<WasiTemplate[]> {
  const res = await fetchImpl(`${channel.apiBaseUrl.replace(/\/$/, "")}/api/v1/templates`, {
    headers: { authorization: `Bearer ${channel.apiKey}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Wasi rejected the template list request (${res.status}): ${detail.slice(0, 300)}`);
  }
  return (await res.json()) as WasiTemplate[];
}

/* ── Embedded Signup ────────────────────────────────────────────────────────
 *
 * Meta's Embedded Signup is how a business connects its own WhatsApp Business
 * Account without leaving the app it is already in. Three parties, and which
 * one does what is the whole design:
 *
 *   The BROWSER runs Meta's JS SDK, calls `FB.login()` with Wasi's app and
 *     config id, and comes back with a short-lived authorization `code` plus
 *     the `waba_id` / `phone_number_id` Meta posts back over `postMessage`.
 *   AURA (this file) forwards that triple to Wasi. It never sees a Meta token
 *     and never calls the Graph API, which is the same boundary the rest of
 *     this client already respects.
 *   WASI exchanges the code for a long-lived token with its own app secret,
 *     subscribes the app to the WABA, registers the number, and syncs
 *     templates. That has to be Wasi: it is the Business Solution Provider,
 *     it holds the app secret, and the token belongs to its Meta app.
 *
 * ── THE ONE PIECE THAT IS NOT BUILT ─────────────────────────────────────────
 *
 * Wasi's onboarding routes (`/api/onboarding/*`) are mounted behind
 * `requireClientAuth` - a browser JWT for somebody logged into Wasi's own app.
 * Aura authenticates as a server with a Hub API key (`requireApiKey`), and
 * there is no API-key-authenticated onboarding endpoint on Wasi today.
 *
 * That is a change on Wasi's side, not this one: its `requireApiKey`
 * middleware already resolves a key to exactly the `req.clientId` the
 * onboarding router expects, so mounting a Hub-API alias of it is small - but
 * it does not exist yet and Wasi is a separate product in a separate repo.
 *
 * So this client is written against the endpoint that has to exist, its path
 * is configurable (`WASI_ONBOARDING_PATH`) so a different final shape needs no
 * rebuild, and a 401/404 is reported as exactly what it is rather than as a
 * generic failure. The console then keeps the captured signup details and
 * tells the operator what to finish by hand, which is strictly better than
 * today - where nothing is captured at all.
 */

/** Where Wasi exposes Hub-API onboarding. Overridable per deployment. */
const ONBOARDING_PATH = process.env.WASI_ONBOARDING_PATH || "/api/v1/onboarding/whatsapp/connect";

export interface WasiSignupResult {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  displayName: string | null;
  /** Wasi's own `client_id`, echoed back so Aura can store the channel. */
  wasiClientId: string | null;
}

export class WasiOnboardingUnavailableError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
  }
}

/**
 * Hand a completed Embedded Signup to Wasi.
 *
 * `via_coexistence` is threaded through rather than inferred, and that matters:
 * Meta fires a distinct completion event for the Coexistence path (the business
 * keeps using the WhatsApp Business app on their phone), and Wasi skips the
 * register-with-PIN step for those - calling it would re-register a number
 * that is actively in use on somebody's handset. Nothing in the returned ids
 * distinguishes the two paths after the fact, so the browser has to say.
 */
export async function completeWasiSignup(
  channel: WasiChannel,
  signup: {
    code: string;
    wabaId: string;
    phoneNumberId: string;
    viaCoexistence: boolean;
  },
  fetchImpl: typeof fetch = fetch,
): Promise<WasiSignupResult> {
  const res = await fetchImpl(`${channel.apiBaseUrl.replace(/\/$/, "")}${ONBOARDING_PATH}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${channel.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      code: signup.code,
      waba_id: signup.wabaId,
      phone_number_id: signup.phoneNumberId,
      via_coexistence: signup.viaCoexistence,
    }),
  });

  if (res.status === 404 || res.status === 401 || res.status === 405) {
    // Named precisely, because the fix is a deployment decision rather than a
    // retry: either Wasi has not exposed Hub-API onboarding for this key yet,
    // or WASI_ONBOARDING_PATH points somewhere else. A generic "Wasi rejected
    // the request" would send somebody hunting through Meta docs for a
    // problem that is one route mount away.
    throw new WasiOnboardingUnavailableError(
      `Wasi has not accepted Hub-API onboarding at ${ONBOARDING_PATH} (HTTP ${res.status}). ` +
        "The signup details have been saved; finish the connection on Wasi's admin page, " +
        "or set WASI_ONBOARDING_PATH if the route differs.",
      res.status,
    );
  }

  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const parsed = WasiErrorResponse.safeParse(body);
    throw new WasiSendError(
      parsed.success ? parsed.data.error : `Wasi could not complete the connection (${res.status})`,
      parsed.success ? parsed.data.code : undefined,
      parsed.success ? parsed.data.metaError : undefined,
      res.status,
    );
  }

  // Wasi returns its `wabas` row. Read defensively: this is the one response
  // shape transcribed from a route that does not exist yet, so a missing
  // optional field must not throw on a connection that actually succeeded.
  const waba = (body.waba ?? body) as Record<string, unknown>;
  return {
    wabaId: String(waba.waba_id ?? signup.wabaId),
    phoneNumberId: String(waba.phone_number_id ?? signup.phoneNumberId),
    displayPhoneNumber: (waba.display_phone_number as string | null) ?? null,
    displayName: (waba.display_name as string | null) ?? null,
    wasiClientId: (waba.client_id as string | null) ?? null,
  };
}
