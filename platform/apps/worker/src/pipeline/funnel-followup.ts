import { randomUUID } from "node:crypto";

/**
 * The email delivery seam - doc 16 §3.6, `lead-funnel-spec.md` "Follow-up
 * Message Template".
 *
 * ── THE TEMPLATES USED TO LIVE HERE, AND NO LONGER DO ──────────────────────
 *
 * This module once held three email bodies as TypeScript functions
 * (`disqualifiedNeutral`, `customCrmInfo`, `rejected`) plus a `renderFollowUp`
 * switch. That made email the one channel an operator could not edit: WhatsApp
 * copy moved into `marketing.message_templates` in migration 0026, and email
 * stayed behind because there was no mail provider and no editor for it.
 * Migration 0026's own header set the exit condition - "when email goes live,
 * seed it here and delete the literals there, in that order" - and 0053 did
 * exactly that. The copy is now in the `@aura/shared` catalogue with its
 * WhatsApp sibling, stored per (key, channel), rendered by
 * `./message-templates.ts`, and editable from the console.
 *
 * What remains here is the part that was always right: the transport.
 *
 * ── NO MAIL PROVIDER IS CONFIGURED, AND THE DEFAULT ONLY LOGS ───────────────
 *
 * There is no SMTP server, no Resend/Postmark/Brevo account and no mail
 * credential anywhere in this repository. `getFollowUpDispatcher()` therefore
 * returns `LogOnlyFollowUpDispatcher` unless `FUNNEL_FOLLOWUP_ENDPOINT` is set.
 * It prints the rendered message and reports success, so the queue drains
 * instead of growing forever - but **nothing is delivered to anybody**.
 *
 * That success is recorded honestly. Every log-only delivery stamps
 * `provider_message_id` with a `log-only:` prefix, so the rows that were never
 * actually sent are one query away:
 *
 *     SELECT * FROM marketing.funnel_followups
 *      WHERE provider_message_id LIKE 'log-only:%';
 *
 * When a provider is configured, that query is the backfill list. Without the
 * prefix the database would claim these leads were contacted, which is exactly
 * the kind of quiet untruth doc 10 §14 exists to prevent.
 */

export type FollowUpMessage = {
  to: { name: string; email: string };
  subject: string;
  /** Plain text. No HTML: it renders everywhere, it cannot leak a tracking
   *  pixel, and it does not need a template engine to be safe. */
  text: string;
};

/* ── Delivery seam ───────────────────────────────────────────────────────── */

export type DeliveryResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string; terminal?: boolean };

export interface FollowUpDispatcher {
  /** Shown in logs so an operator can tell which one ran. */
  readonly name: string;
  send(message: FollowUpMessage): Promise<DeliveryResult>;
}

/**
 * The default. Prints the message and reports success - see the module header
 * for why that is honest and how the never-delivered rows are found later.
 *
 * The recipient's address is logged in full and deliberately: this only runs in
 * a deployment with no mail provider, the log is the only record that the
 * message existed, and a redacted address would make the backfill impossible.
 * If that ever stops being an acceptable trade, configure a provider - which is
 * the correct fix anyway.
 */
export class LogOnlyFollowUpDispatcher implements FollowUpDispatcher {
  readonly name = "log-only";

  async send(message: FollowUpMessage): Promise<DeliveryResult> {
    console.warn(
      `[funnel follow-up] NOT DELIVERED - no mail provider configured.\n` +
        `  to:      ${message.to.name} <${message.to.email}>\n` +
        `  subject: ${message.subject}\n` +
        message.text.replace(/^/gm, "  | "),
    );
    return { ok: true, messageId: `log-only:${randomUUID()}` };
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   ⚠️  UNVERIFIED - no mail provider account exists, so this has never run.

   A provider-agnostic HTTP sender. Resend, Postmark, Brevo and Mailgun all
   accept a JSON POST with a bearer token, they just disagree on field names, so
   the field names are configuration rather than code:

     FUNNEL_FOLLOWUP_ENDPOINT   e.g. https://api.resend.com/emails   (required -
                                its presence is what selects this dispatcher)
     FUNNEL_FOLLOWUP_TOKEN      bearer token
     FUNNEL_FOLLOWUP_FROM       e.g. "Aura <hello@sirahagents.com>"
     FUNNEL_FOLLOWUP_FIELDS     JSON rename map, default
                                {"from":"from","to":"to","subject":"subject","text":"text"}
                                Postmark, for instance, wants From/To/Subject/TextBody.

   Verify with one real send to a mailbox you control before pointing it at a
   lead. The likeliest failure is an unverified sending domain, which most
   providers answer with a 403 that looks like an auth problem.
   ════════════════════════════════════════════════════════════════════════════ */
export class HttpFollowUpDispatcher implements FollowUpDispatcher {
  readonly name = "http";

  constructor(
    private readonly endpoint: string,
    private readonly token: string | undefined,
    private readonly from: string,
    private readonly fields: Record<string, string>,
  ) {}

  async send(message: FollowUpMessage): Promise<DeliveryResult> {
    const body: Record<string, unknown> = {
      [this.fields.from ?? "from"]: this.from,
      [this.fields.to ?? "to"]: [message.to.email],
      [this.fields.subject ?? "subject"]: message.subject,
      [this.fields.text ?? "text"]: message.text,
    };

    let res: Response;
    try {
      res = await fetch(this.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      // Network-level: always retryable. A DNS blip must not burn a lead.
      return { ok: false, error: `network: ${(err as Error).message}` };
    }

    if (res.ok) {
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const id = json.id ?? json.MessageID ?? json.messageId;
      return { ok: true, messageId: typeof id === "string" ? id : `sent:${randomUUID()}` };
    }

    const text = await res.text().catch(() => "");
    return {
      ok: false,
      error: `${res.status} ${text.slice(0, 300)}`,
      // 4xx other than 408/429 means the request itself is wrong - a bad
      // address, an unverified domain, a revoked key. Retrying it six times
      // changes nothing and just delays the dead state that tells an operator
      // to look.
      terminal: res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429,
    };
  }
}

let cached: FollowUpDispatcher | null = null;

/**
 * Whether mail can actually be delivered, as opposed to logged.
 *
 * The presence of an endpoint is the whole test, mirroring
 * `getFollowUpDispatcher` below - one condition, so the two can never disagree
 * about whether email is real.
 *
 * Callers use this to decide whether to QUEUE an email at all. That is a
 * different question from whether to SEND one: a rejection is queued regardless
 * and logged if it cannot go, because the row is the record that the message
 * was owed. A reminder is not - a second, undeliverable copy of every reminder
 * would double the outbox and make "what did we send this person" harder to
 * read, for no gain.
 */
export function emailConfigured(): boolean {
  return Boolean(process.env.FUNNEL_FOLLOWUP_ENDPOINT?.trim());
}

/** Selected by env, exactly like the marketing app's scheduler. Absent config
 *  means log-only, never a crash and never a silent drop. */
export function getFollowUpDispatcher(): FollowUpDispatcher {
  if (cached) return cached;

  const endpoint = process.env.FUNNEL_FOLLOWUP_ENDPOINT?.trim();
  if (!endpoint) {
    cached = new LogOnlyFollowUpDispatcher();
    return cached;
  }

  let fields: Record<string, string> = {};
  try {
    fields = JSON.parse(process.env.FUNNEL_FOLLOWUP_FIELDS ?? "{}") as Record<string, string>;
  } catch {
    console.error("[funnel follow-up] FUNNEL_FOLLOWUP_FIELDS is not valid JSON, using defaults");
  }

  cached = new HttpFollowUpDispatcher(
    endpoint,
    process.env.FUNNEL_FOLLOWUP_TOKEN?.trim(),
    process.env.FUNNEL_FOLLOWUP_FROM?.trim() || "Aura <hello@sirahagents.com>",
    fields,
  );
  return cached;
}

/** Tests only - module state outlives an env change. */
export function resetFollowUpDispatcherForTests(): void {
  cached = null;
}
