/**
 * WhatsApp delivery via Evolution GO.
 *
 * ── WHICH EVOLUTION THIS TALKS TO ──────────────────────────────────────────
 *
 * There are two unrelated products called Evolution and they do NOT share an
 * API. This targets **Evolution GO** (github.com/EvolutionAPI/evolution-go),
 * which is what runs at the deployment this connects to. Verified against its
 * live OpenAPI spec at `/swagger/doc.json`, not from documentation:
 *
 *                      Evolution GO (this)          Evolution API (TypeScript)
 *   endpoint           POST /send/text              POST /message/sendText/{instance}
 *   instance           identified BY THE API KEY    in the URL path
 *   auth header        apikey                       apikey
 *   body               { number, text }             { number, text } (v2)
 *
 * The first version of this file was written for the TypeScript API and would
 * have 404'd on every single message — same header, same body, wrong URL, and
 * an instance name in a path that does not take one. It was never sent a real
 * message, so nothing was lost; the lesson is that "Evolution" alone does not
 * identify an API.
 *
 * ── CONFIGURATION ──────────────────────────────────────────────────────────
 *
 *   EVOLUTION_BASE_URL   e.g. https://chat.sirahagents.com   (required — its
 *                        presence is what enables sending at all)
 *   EVOLUTION_API_KEY    the instance's key, sent as the `apikey` header
 *
 * EVOLUTION_INSTANCE is NOT used and is not required. The key selects the
 * instance server-side; a name here would be decorative and would imply a
 * control that does not exist.
 *
 * Confirm an instance is live before relying on it:
 *
 *   curl -H "apikey: $KEY" $BASE/instance/status
 *   → {"data":{"Connected":true,"LoggedIn":true,"Name":"…"},"message":"success"}
 *
 * ── WHY NOT META'S OFFICIAL API ────────────────────────────────────────────
 *
 * Evolution drives a real WhatsApp account over the web protocol, so it can
 * send the free-form replies this funnel needs. Meta's Cloud API cannot:
 * outside a 24-hour reply window it permits only pre-approved template
 * messages. The trade is that this is unofficial — the account can be
 * rate-limited or banned for behaviour that looks like bulk messaging, with no
 * support channel when it happens. Use it to reply to people who contacted you
 * first, which is exactly what a rejection or a booking confirmation is, and
 * not for outbound campaigns.
 */

export interface WhatsAppMessage {
  /** E.164 with or without the leading +; normalised below. */
  to: string;
  text: string;
}

export type WhatsAppResult =
  | { ok: true; providerMessageId: string }
  | { ok: false; retryable: boolean; error: string };

export interface WhatsAppSender {
  readonly name: string;
  send(msg: WhatsAppMessage): Promise<WhatsAppResult>;
}

/**
 * Digits only.
 *
 * Stored numbers are E.164 (`+919876543210`) and the gateway wants bare digits.
 * Done in one place rather than at each call site, because a number that
 * silently fails to send is indistinguishable from a message nobody replied to.
 */
export function toWaNumber(e164: string): string {
  return e164.replace(/\D/g, "");
}

/** Used when EVOLUTION_BASE_URL is unset: logs, sends nothing, says so. */
export class LogOnlyWhatsAppSender implements WhatsAppSender {
  readonly name = "log-only";
  async send(msg: WhatsAppMessage): Promise<WhatsAppResult> {
    console.warn(
      `[whatsapp] NOT SENT (EVOLUTION_BASE_URL unset). to=${msg.to} text=${msg.text.slice(0, 80)}…`,
    );
    return { ok: true, providerMessageId: `log-only:${Date.now()}` };
  }
}

export class EvolutionGoSender implements WhatsAppSender {
  readonly name = "evolution-go";

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string | undefined,
  ) {}

  async send(msg: WhatsAppMessage): Promise<WhatsAppResult> {
    const number = toWaNumber(msg.to);
    if (!number) return { ok: false, retryable: false, error: "recipient has no usable number" };

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/send/text`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.apiKey ? { apikey: this.apiKey } : {}),
        },
        body: JSON.stringify({ number, text: msg.text }),
        // A hung gateway must not hold an outbox worker open indefinitely.
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      // Network-level failure: worth retrying, the message may still be valid.
      return { ok: false, retryable: true, error: `network: ${(err as Error).message}` };
    }

    const text = await res.text().catch(() => "");

    if (!res.ok) {
      // 4xx is ours and will fail identically forever — a wrong key, a number
      // not on WhatsApp, a disconnected instance. Retrying burns attempts and
      // delays the dead-letter that tells a human to look. 5xx and 429 are the
      // gateway's problem and may clear on their own.
      const retryable = res.status >= 500 || res.status === 429;
      return { ok: false, retryable, error: `evolution ${res.status}: ${text.slice(0, 300)}` };
    }

    // The 200 body is an untyped `gin.H` in the spec, so the id location is not
    // contractual. Parsed defensively across the shapes it is known to take —
    // and a successful send whose id we cannot read is STILL a successful send,
    // so it must never be reported as a failure and retried.
    // `data.Info.ID` first, because that is what a real 200 actually contains.
    // Confirmed 2026-08-09 from a live send: Evolution GO returns whatsmeow's
    // envelope, `{"data":{"Info":{"ID":…,"Chat":"…@s.whatsapp.net","Sender":…,
    // "IsFromMe":true,…}}}`. The earlier guesses below are kept as fallbacks —
    // the spec types this as an untyped `gin.H`, so the shape is not
    // contractual and a version bump could move it.
    let id = "";
    try {
      const json = JSON.parse(text) as {
        data?: {
          Info?: { ID?: string; Id?: string; id?: string };
          id?: string;
          key?: { id?: string };
          Id?: string;
          ID?: string;
        };
        id?: string;
      };
      id =
        json.data?.Info?.ID ??
        json.data?.Info?.Id ??
        json.data?.Info?.id ??
        json.data?.id ??
        json.data?.key?.id ??
        json.data?.Id ??
        json.data?.ID ??
        json.id ??
        "";
    } catch {
      /* non-JSON success body; keep the empty id */
    }

    if (!id) {
      // The first live send fell through to the timestamp fallback, so none of
      // the keys above matched. Log the body ONCE per shape so the next send
      // reveals where the id actually lives and this can be tightened — without
      // it we would keep storing synthetic ids and lose the ability to trace a
      // message back to WhatsApp.
      //
      // Truncated hard: the body may echo the recipient's number, and the log
      // is not the place for it.
      console.warn(`[whatsapp] no message id in 200 body, shape was: ${text.slice(0, 200)}`);
    }

    // A successful send whose id we cannot read is STILL a successful send. It
    // must never be reported as a failure and retried — that would message the
    // person twice.
    return { ok: true, providerMessageId: id || `evolution-go:${Date.now()}` };
  }
}

let cached: WhatsAppSender | null = null;

export function getWhatsAppSender(): WhatsAppSender {
  if (cached) return cached;
  const baseUrl = process.env.EVOLUTION_BASE_URL?.trim();
  if (!baseUrl) {
    cached = new LogOnlyWhatsAppSender();
    return cached;
  }
  cached = new EvolutionGoSender(baseUrl, process.env.EVOLUTION_API_KEY?.trim());
  return cached;
}

/** Tests only — module state outlives an env change. */
export function resetWhatsAppSenderForTests(): void {
  cached = null;
}

/*
 * ── WHERE THE COPY LIVES ───────────────────────────────────────────────────
 *
 * Not here, since migration 0026. This file is transport; the words are in
 * `marketing.message_templates`, edited from the console, read by
 * ./message-templates.ts with the compiled copy in @aura/shared as the
 * fallback. `renderWhatsApp()` used to be a switch statement at the bottom of
 * this module — its replacement is `renderWhatsAppMessage()`.
 *
 * What did NOT change is the rule that shaped that copy, and it still governs
 * anything an operator types into the editor: one short paragraph, no
 * signature, no subject line. The email templates are five paragraphs with a
 * signature block; pasted into WhatsApp, that reads as a form letter somebody
 * automated — exactly the impression a rejection should avoid. Long, uniform,
 * business-shaped messages are also what gets an unofficial gateway's account
 * flagged.
 */
