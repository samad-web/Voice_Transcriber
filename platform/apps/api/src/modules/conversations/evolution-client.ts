import { type ChannelProbeOutcome } from "@aura/shared";

/**
 * PERSONAL WHATSAPP, VIA EVOLUTION GO.
 *
 * ── WHAT THIS ACTUALLY IS ───────────────────────────────────────────────────
 *
 * Evolution GO (github.com/EvolutionAPI/evolution-go) is a WhatsApp Web client
 * that runs on a server. It speaks the same multi-device protocol a browser
 * speaks at web.whatsapp.com, through the `whatsmeow` library, and it links to
 * an account exactly the way WhatsApp Web does: a QR code, or an eight-character
 * pairing code typed into the phone.
 *
 * That is the whole reason this path exists. A business WhatsApp number goes
 * through a WABA - Meta's API, an approved business, templates, the 24-hour
 * window. A PERSONAL number cannot: Meta offers no API for one, and there is no
 * approval to apply for. The only way to reach it is to be a linked device.
 *
 * ── WHY NOT EMBED web.whatsapp.com IN AN IFRAME ─────────────────────────────
 *
 * Measured, not assumed: `web.whatsapp.com` answers with `X-Frame-Options:
 * DENY` and `cross-origin-embedder-policy: require-corp`. It cannot be framed.
 *
 * And it should not be even if it could. A cross-origin frame is opaque to the
 * page holding it, so Aura's JavaScript could not read one message out of it -
 * the inbox would stay empty, nothing would thread against a contact, and the
 * lead qualifier would have nothing to read. The session would also live in one
 * browser tab: close the laptop and messages stop arriving. Running the client
 * server-side is what makes the connection outlive the browser, which is the
 * entire point of putting it in a CRM.
 *
 * ── THE HONEST WARNING ──────────────────────────────────────────────────────
 *
 * This is unofficial. Meta does not sanction it, the account can be
 * rate-limited or banned, and there is no support channel when it happens. That
 * belief is not buried in this file - `messaging-providers.ts` marks the
 * provider `unofficial: true` and the console states it at the moment somebody
 * links a number. Use it to answer people who wrote to you first; the existing worker
 * (apps/worker/src/pipeline/whatsapp.ts) has carried that same caveat for a
 * year and its reasoning applies here unchanged.
 *
 * ── TWO CREDENTIALS, AND THEY ARE NOT INTERCHANGEABLE ───────────────────────
 *
 *   The ADMIN key (`EVOLUTION_ADMIN_API_KEY`) may create and delete instances.
 *     It is deployment-wide, belongs to the operator, and is never stored on a
 *     tenant row or returned to a browser.
 *   An INSTANCE token is minted by Aura per org, handed to Evolution at create
 *     time, and stored encrypted on that org's `messaging_channels.api_key`. It
 *     selects the instance server-side - which is why almost nothing below
 *     takes an instance name in the path.
 *
 * That split is what makes this multi-tenant. The pre-existing worker uses ONE
 * process-level key for the whole platform, so every tenant shared a single
 * WhatsApp account; per-instance tokens give each org its own, and one org's
 * ban or logout cannot touch another's.
 *
 * ── VERIFIED AGAINST THE LIVE HOST, NOT THE DOCUMENTATION ───────────────────
 *
 * Endpoint list and request bodies transcribed from the OpenAPI document served
 * by the real deployment (`GET /swagger/doc.json`, "Evolution GO - whatsmeow",
 * 88 paths). Responses are typed `gin.H` in that spec - an untyped map - so no
 * response shape here is contractual and every one is parsed defensively. Where
 * a shape HAS been confirmed against a real call it is marked as such below;
 * where it has not, the parser reads several plausible keys and the failure is
 * visible rather than silent.
 */

/** Where the operator's Evolution GO deployment lives. */
export interface EvolutionAdmin {
  baseUrl: string;
  /** Deployment-wide. Creates and deletes instances; never leaves the server. */
  adminKey: string;
}

/** One tenant's own instance. `token` is decrypted by the caller. */
export interface EvolutionInstance {
  baseUrl: string;
  token: string;
}

export class EvolutionError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message);
  }
}

/**
 * A request against Evolution, with the one header that matters.
 *
 * `apikey` - lower case, not `Authorization: Bearer`. Confirmed against the
 * live instance by the code that already talks to it
 * (apps/worker/src/pipeline/whatsapp.ts and
 * apps/api/src/modules/leads/whatsapp-check.controller.ts, both of which were
 * checked against the real thing rather than the docs).
 *
 * The timeout is not optional garnish. A settings page is waiting on most of
 * these, and a pairing screen that hangs for the default socket timeout is
 * indistinguishable from a broken one.
 */
async function call(
  baseUrl: string,
  apiKey: string,
  path: string,
  init: { method: string; body?: unknown; timeoutMs?: number },
): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, "")}${path}`, {
      method: init.method,
      headers: {
        apikey: apiKey,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
    });
  } catch (err) {
    // undici puts the real reason (ENOTFOUND, ECONNREFUSED, a TLS failure) on
    // `err.cause` and leaves `err.message` as the useless "fetch failed". The
    // Wasi client learned this the same way; reporting two words here would
    // make "the host name is wrong" indistinguishable from "the box is down"
    // at exactly the moment the difference decides who gets called.
    throw new EvolutionError(networkReason(err), 0);
  }

  const text = (await res.text().catch(() => "")).trim();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* Non-JSON body. `text` is kept for the error message. */
  }
  return { status: res.status, json, text };
}

function networkReason(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === "TimeoutError") return "Evolution did not answer in time";
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    return code ? `${code}: ${cause.message}` : cause.message;
  }
  return err.message;
}

/** Evolution's own words out of a failure body, bounded. */
function evolutionMessage(json: Record<string, unknown>, text: string): string {
  const candidate =
    (typeof json.message === "string" && json.message) ||
    (typeof json.error === "string" && json.error) ||
    text;
  const trimmed = (candidate || "").trim();
  if (!trimmed) return "no detail";
  return trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed;
}

function expectOk(
  result: { status: number; json: Record<string, unknown>; text: string },
  what: string,
): Record<string, unknown> {
  if (result.status < 200 || result.status >= 300) {
    throw new EvolutionError(
      `${what} failed (HTTP ${result.status}): ${evolutionMessage(result.json, result.text)}`,
      result.status,
    );
  }
  return result.json;
}

/**
 * `data` is where Evolution puts everything, but not consistently - some
 * handlers answer flat. Read through both rather than picking one and being
 * wrong for half the endpoints.
 */
function payload(json: Record<string, unknown>): Record<string, unknown> {
  const data = json.data;
  return data !== null && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : json;
}

function firstString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/* ── Instance lifecycle ──────────────────────────────────────────────────── */

/**
 * `POST /instance/create` - body `{name, token}`.
 *
 * The token is OURS: Aura generates it, hands it over here, and stores it
 * encrypted against the org. Evolution does not mint one for us, so there is no
 * "fetch the key later" call and losing it means deleting the instance and
 * starting again - which is why the caller writes the channel row before it
 * ever gets here.
 */
export async function createEvolutionInstance(
  admin: EvolutionAdmin,
  input: { name: string; token: string },
): Promise<void> {
  const result = await call(admin.baseUrl, admin.adminKey, "/instance/create", {
    method: "POST",
    body: { name: input.name, token: input.token },
  });
  // Already there is success, not failure. A tenant who abandons pairing and
  // comes back an hour later must not be met with "that instance exists" - the
  // instance existing is precisely the state the next call needs.
  if (result.status === 409) return;
  expectOk(result, "Creating the WhatsApp instance");
}

/**
 * `POST /instance/connect` - body `{webhookUrl, subscribe, immediate}`.
 *
 * This is the call that points Evolution at Aura. Until it runs, the instance
 * is live but delivers nowhere, and a paired number whose messages go nowhere
 * is the worst of the possible half-states: the customer sees a linked device
 * in their WhatsApp and believes it is working.
 *
 * `subscribe` values are Evolution's event CATEGORIES, not whatsmeow's internal
 * event names. `MESSAGE` carries inbound messages; `CONNECTION` is how the
 * pairing screen learns the phone linked, or later logged out, without polling
 * forever. Deliberately NOT `ALL`: history sync alone would replay a customer's
 * entire chat archive - including private conversations that have nothing to do
 * with the business - into the CRM inbox the moment they linked their phone.
 */
export const EVOLUTION_EVENTS = ["MESSAGE", "CONNECTION"] as const;

export async function connectEvolutionInstance(
  instance: EvolutionInstance,
  input: { webhookUrl: string; phone?: string },
): Promise<void> {
  const result = await call(instance.baseUrl, instance.token, "/instance/connect", {
    method: "POST",
    body: {
      webhookUrl: input.webhookUrl,
      subscribe: [...EVOLUTION_EVENTS],
      immediate: true,
      ...(input.phone ? { phone: input.phone } : {}),
    },
  });
  expectOk(result, "Pointing the WhatsApp instance at Aura");
}

/**
 * `POST /instance/pair` - body `{phone}` - the eight-character code.
 *
 * Offered ahead of the QR because it is the better experience for the people
 * who actually use this: the code is typed into the phone that is already in
 * their hand, which needs no second device and no camera, and it works when
 * somebody is on a desktop with their phone beside them. The QR remains as a
 * fallback for people who expect it.
 *
 * RESPONSE SHAPE IS NOT CONFIRMED against a live pairing - `gin.H` is untyped
 * and this could not be exercised without linking a real WhatsApp account. So
 * several plausible keys are read, and a success whose code cannot be found
 * raises rather than returning an empty string: a pairing screen showing a
 * blank code is a dead end, while an error names the shape to fix.
 */
export async function requestEvolutionPairingCode(
  instance: EvolutionInstance,
  phone: string,
): Promise<string> {
  const result = await call(instance.baseUrl, instance.token, "/instance/pair", {
    method: "POST",
    body: { phone, subscribe: [...EVOLUTION_EVENTS] },
  });
  const json = expectOk(result, "Requesting a pairing code");
  const data = payload(json);
  const code =
    firstString(data, ["code", "pairingCode", "pairing_code", "PairingCode", "linkingCode"]) ??
    firstString(json, ["code", "pairingCode", "pairing_code"]);
  if (!code) {
    throw new EvolutionError(
      `Evolution accepted the pairing request but returned no code. Body keys: ${Object.keys(data).slice(0, 12).join(", ") || "none"}`,
      result.status,
    );
  }
  return code;
}

/**
 * `GET /instance/qr`.
 *
 * Returns whatever Evolution gives, normalised to a data URI where possible so
 * the console can put it straight in an `<img src>`. Some builds answer with a
 * base64 PNG, some with the raw pairing string for the client to render - both
 * are handled, and the raw string is returned separately rather than being
 * jammed into the image field, because rendering it is the browser's job.
 */
export interface EvolutionQr {
  /** `data:image/png;base64,…` when Evolution supplied an image. */
  imageDataUri: string | null;
  /** The raw QR payload, when it supplied that instead. */
  code: string | null;
}

export async function getEvolutionQr(instance: EvolutionInstance): Promise<EvolutionQr> {
  const result = await call(instance.baseUrl, instance.token, "/instance/qr", { method: "GET" });
  const json = expectOk(result, "Fetching the QR code");
  const data = payload(json);

  const raw = firstString(data, ["qrcode", "qrCode", "QRCode", "qr", "code", "base64"]);
  if (!raw) return { imageDataUri: null, code: null };
  if (raw.startsWith("data:image")) return { imageDataUri: raw, code: null };
  // A bare base64 PNG has no business being mistaken for a QR payload string,
  // and vice versa: the WhatsApp QR payload is short and comma-separated, a
  // PNG is long and base64. Length plus alphabet separates them reliably here.
  if (raw.length > 256 && /^[A-Za-z0-9+/=]+$/.test(raw)) {
    return { imageDataUri: `data:image/png;base64,${raw}`, code: null };
  }
  return { imageDataUri: null, code: raw };
}

/**
 * `GET /instance/status`.
 *
 * SHAPE CONFIRMED against the live deployment and documented in
 * apps/worker/src/pipeline/whatsapp.ts, which records the real response:
 *   {"data":{"Connected":true,"LoggedIn":true,"Name":"…"},"message":"success"}
 *
 * The two booleans are not the same question and the difference is the whole
 * value of this call. `Connected` is the socket to WhatsApp; `LoggedIn` is
 * whether the account is still linked. A phone that revoked the linked device
 * leaves an instance that reconnects happily and can send nothing - connected,
 * not logged in - which reads as healthy to anything that checks only the first.
 */
export interface EvolutionStatus {
  connected: boolean;
  loggedIn: boolean;
  name: string | null;
}

export async function getEvolutionStatus(instance: EvolutionInstance): Promise<EvolutionStatus> {
  const result = await call(instance.baseUrl, instance.token, "/instance/status", {
    method: "GET",
    timeoutMs: 8_000,
  });
  const json = expectOk(result, "Checking the WhatsApp connection");
  const data = payload(json);
  return {
    connected: readBool(data, ["Connected", "connected"]),
    loggedIn: readBool(data, ["LoggedIn", "loggedIn", "logged_in"]),
    name: firstString(data, ["Name", "name"]),
  };
}

function readBool(source: Record<string, unknown>, keys: string[]): boolean {
  for (const key of keys) {
    if (typeof source[key] === "boolean") return source[key] as boolean;
  }
  return false;
}

/**
 * `DELETE /instance/logout` - unlink the account, keep the instance.
 *
 * Logout rather than delete, because they are different promises. Logging out
 * ends Aura's access to the person's WhatsApp immediately, which is what
 * "disconnect" has to mean; deleting the instance would also discard the
 * server-side session store, so re-linking later would be a fresh pairing
 * rather than a resumption. The destructive one belongs behind an explicit
 * removal of the channel, not behind a disconnect button.
 */
export async function logoutEvolutionInstance(instance: EvolutionInstance): Promise<void> {
  const result = await call(instance.baseUrl, instance.token, "/instance/logout", {
    method: "DELETE",
  });
  // Not logged in is the state this call is trying to reach.
  if (result.status === 404 || result.status === 409) return;
  expectOk(result, "Disconnecting WhatsApp");
}

/* ── Sending ─────────────────────────────────────────────────────────────── */

/**
 * `POST /send/text` - body `{number, text}`.
 *
 * The same endpoint and body the worker has been sending funnel nudges through
 * since it was corrected against the live OpenAPI spec, with one difference
 * that is the point of this whole change: the credentials come from the CHANNEL
 * ROW rather than from `process.env`. The worker sends as the platform's single
 * shared account; this sends as the tenant's own linked number.
 *
 * `number` is bare digits. Stored addresses are E.164 with a leading `+`, and
 * the gateway wants it stripped - done here rather than at the call site,
 * because a number that silently fails to send looks exactly like a customer
 * who did not reply.
 */
export interface EvolutionSendResult {
  externalId: string | null;
}

export async function sendEvolutionText(
  instance: EvolutionInstance,
  to: string,
  text: string,
): Promise<EvolutionSendResult> {
  const number = to.replace(/\D/g, "");
  if (!number) throw new EvolutionError("that recipient has no usable phone number", 0);

  const result = await call(instance.baseUrl, instance.token, "/send/text", {
    method: "POST",
    body: { number, text },
    timeoutMs: 20_000,
  });
  const json = expectOk(result, "Sending the WhatsApp message");

  // CONFIRMED live (whatsapp.ts, 2026-08-09): Evolution GO returns whatsmeow's
  // envelope, `{"data":{"Info":{"ID":…}}}`. The fallbacks below are kept for
  // the same reason that file keeps them - `gin.H` is untyped, so a version
  // bump can move the id - and a send whose id cannot be read is STILL a send.
  // Reporting it as a failure would message the person twice.
  const data = payload(json);
  const info = (data.Info ?? data.info) as Record<string, unknown> | undefined;
  const externalId =
    (info ? firstString(info, ["ID", "Id", "id"]) : null) ??
    firstString(data, ["id", "ID", "Id", "messageId"]);
  return { externalId };
}

/* ── Probing ─────────────────────────────────────────────────────────────── */

/**
 * Is this personal channel actually usable right now?
 *
 * Maps onto the same `ChannelProbeOutcome` vocabulary Wasi's probe uses, so
 * `readChannel()` and the watchdog need to know nothing about which provider
 * produced a measurement. The mapping that matters:
 *
 *   connected + logged in   → `ok`
 *   reachable, NOT logged in → `credentials_rejected`
 *
 * The second is the interesting one. Somebody removing Aura from Linked Devices
 * on their phone is not a network problem and will never heal on its own - it
 * needs a person to pair again, which is exactly what `credentials_rejected`
 * means to the console ("retrying will not help"). Calling it `unreachable`
 * would tell them to wait, forever.
 */
export async function probeEvolutionChannel(
  instance: EvolutionInstance,
): Promise<{ outcome: ChannelProbeOutcome; detail: string | null }> {
  try {
    const status = await getEvolutionStatus(instance);
    if (status.connected && status.loggedIn) return { outcome: "ok", detail: null };
    if (!status.loggedIn) {
      return {
        outcome: "credentials_rejected",
        detail:
          "This WhatsApp account is no longer linked to Aura. Somebody removed it from Linked Devices on the phone, so it has to be paired again.",
      };
    }
    return {
      outcome: "unreachable",
      detail: "The instance is logged in but not currently connected to WhatsApp.",
    };
  } catch (err) {
    if (err instanceof EvolutionError) {
      // A refused key is the host answering, and answering no.
      if (err.httpStatus === 401 || err.httpStatus === 403) {
        return { outcome: "credentials_rejected", detail: err.message };
      }
      if (err.httpStatus === 0) return { outcome: "unreachable", detail: err.message };
      return { outcome: "provider_error", detail: err.message };
    }
    return { outcome: "provider_error", detail: (err as Error).message };
  }
}

/* ── Deployment configuration ────────────────────────────────────────────── */

/**
 * The operator's Evolution deployment, or null when this deployment has none.
 *
 * Null is a first-class answer rather than a throw: a deployment that never
 * configured Evolution is a normal deployment, and the console has to render
 * "your provider has not set this up" instead of a 500. Same three-state
 * treatment `integrations.controller.ts` gives every other integration -
 * `unavailable` is a different sentence from `not connected`.
 *
 * `EVOLUTION_BASE_URL` is reused deliberately: the worker already points at
 * this host for funnel nudges, and two variables naming one server is how they
 * end up pointing at different ones.
 */
export function evolutionAdminFromEnv(): EvolutionAdmin | null {
  const baseUrl = process.env.EVOLUTION_BASE_URL?.trim();
  const adminKey = process.env.EVOLUTION_ADMIN_API_KEY?.trim() || process.env.EVOLUTION_API_KEY?.trim();
  if (!baseUrl || !adminKey) return null;
  return { baseUrl, adminKey };
}
