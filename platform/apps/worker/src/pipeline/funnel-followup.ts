import { randomUUID } from "node:crypto";

/**
 * Follow-up messages for funnel submissions — doc 16 §3.6, `lead-funnel-spec.md`
 * "Follow-up Message Template".
 *
 * Two halves live here: the templates (pure, tested) and the delivery seam. The
 * queue that drives them is `funnel-followup-outbox.ts`, modelled on
 * `outbox.ts` — the same table-as-queue with attempts, backoff and a dead state,
 * because doc 16 §3.6 says to reuse that pattern rather than invent a second
 * delivery mechanism, and because it is the proven one in this codebase.
 *
 * ── NO MAIL PROVIDER IS CONFIGURED, AND THE DEFAULT ONLY LOGS ───────────────
 *
 * There is no SMTP server, no Resend/Postmark/Brevo account and no mail
 * credential anywhere in this repository. `getFollowUpDispatcher()` therefore
 * returns `LogOnlyFollowUpDispatcher` unless `FUNNEL_FOLLOWUP_ENDPOINT` is set.
 * It prints the rendered message and reports success, so the queue drains
 * instead of growing forever — but **nothing is delivered to anybody**.
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

/* ── Templates ───────────────────────────────────────────────────────────── */

export type FollowUpTemplate = "disqualified_neutral" | "custom_crm_info" | "rejected";

export type FollowUpRecipient = {
  submissionId: string;
  name: string;
  email: string;
};

export type FollowUpMessage = {
  to: { name: string; email: string };
  subject: string;
  /** Plain text. No HTML: it renders everywhere, it cannot leak a tracking
   *  pixel, and it does not need a template engine to be safe. */
  text: string;
};

/** First name only, for a greeting. Falls back to the whole string, and to a
 *  neutral opener when there is nothing usable — never "Hi undefined". */
function greetingName(name: string): string | null {
  const first = name.trim().split(/\s+/)[0];
  return first && first.length >= 2 ? first : null;
}

/**
 * The disqualified follow-up.
 *
 * The spec is precise about what this must NOT contain: no mention of budget,
 * no reference to a rule, nothing that reads as a rejection. Doc 16 §3.2 adds
 * the reason it matters — at a ₹30,000/month threshold against a per-handset
 * SMB price point, this is likely the message MOST enquiries receive, so it is
 * the main path's copy, not a consolation note. It says the team will be in
 * touch, and it leaves the door open on the reader's own terms.
 *
 * It also does not ask them to book anything. A disqualified lead being sent
 * back to a calendar is how the qualified path stops being worth having.
 */
function disqualifiedNeutral(to: FollowUpRecipient): FollowUpMessage {
  const hi = greetingName(to.name);
  return {
    to: { name: to.name, email: to.email },
    subject: "Following up on your enquiry",
    text: [
      hi ? `Hi ${hi},` : "Hello,",
      ``,
      `Thank you for getting in touch about Aura. We have your details and our`,
      `team will be in touch as things line up on your end.`,
      ``,
      `In the meantime, if it is useful: our compatibility page lists exactly`,
      `which handsets record reliably, and our consent page explains what the`,
      `app records and what it does not. Both are worth five minutes before any`,
      `call recording rollout.`,
      ``,
      `If your requirements change, or you would like to talk sooner, just reply`,
      `to this email — it reaches a person.`,
      ``,
      `Aura`,
      `Sirah Digital`,
    ].join("\n"),
  };
}

/**
 * The `wants_custom_crm = 'tell_me_more'` follow-up.
 *
 * Doc 16 §3.2: `tell_me_more` deliberately does not book a slot — it is an
 * information request, not a buying signal — and "the follow-up template should
 * answer the question rather than push a call". So this one answers it, with
 * the same claim doc 16 §4.1 establishes is true rather than aspirational: a
 * custom CRM here is a configuration of machinery that already exists (the
 * Agent Studio compiles a tenant's typed field schema into the provider's
 * response schema; the connector catalogue already maps fields).
 *
 * No price, because there is no published price and inventing one here would be
 * the same failure as inventing one on the pricing page.
 */
function customCrmInfo(to: FollowUpRecipient): FollowUpMessage {
  const hi = greetingName(to.name);
  return {
    to: { name: to.name, email: to.email },
    subject: "Following up on your enquiry",
    text: [
      hi ? `Hi ${hi},` : "Hello,",
      ``,
      `Thanks for asking about a CRM built around your business — here is the`,
      `short version, since you asked to hear more rather than to book a call.`,
      ``,
      `Most CRMs make you describe your business in someone else's words: deals,`,
      `opportunities, sales cycles. We build yours around what you actually`,
      `track — brick type and quantity, site location, quotation status,`,
      `follow-up date. Whatever your calls are already about.`,
      ``,
      `Aura then feeds it automatically. Every qualified call becomes a record`,
      `with the details already filled in, in Tamil or English. Nobody types`,
      `anything.`,
      ``,
      `It is built on the same extraction engine your calls would already run`,
      `through, so this is a configuration of something that exists rather than`,
      `a rebuild from scratch — which is why it is affordable at your size.`,
      ``,
      `If you would like the specifics for how you sell today, reply to this`,
      `email and describe it in a couple of lines. We will tell you honestly`,
      `whether you need a new system or just a connector to the one you have.`,
      ``,
      `Aura`,
      `Sirah Digital`,
    ].join("\n"),
  };
}

/**
 * The rejection follow-up — sent when a HUMAN has decided not to proceed.
 *
 * Different from `disqualified_neutral`, which the funnel sends automatically
 * when the budget/intent rules say no. Someone read this enquiry and made a
 * decision, so the message says so plainly rather than trailing off.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * · It does not explain the reason. The operator's note is for the operator;
 *   an unsolicited critique of somebody's business is not a kindness, and any
 *   reason given in writing is a reason to argue with.
 * · It does not say "we will keep you on file" unless that is true. Nothing in
 *   this system re-surfaces a rejected lead, so promising it would be a lie
 *   with a two-year fuse.
 * · It leaves the door open in the one honest way available: an invitation to
 *   come back if things change, which costs nothing and is true.
 *
 * A rejection that reads like a form letter is worse than a short human one.
 * This is four sentences.
 */
function rejected(to: FollowUpRecipient): FollowUpMessage {
  const hi = greetingName(to.name);
  return {
    to: { name: to.name, email: to.email },
    subject: "About your Aura enquiry",
    text: [
      hi ? `Hi ${hi},` : "Hello,",
      ``,
      `Thanks for taking the time to tell us about your business, and for your`,
      `interest in Aura.`,
      ``,
      `Having looked at it properly, we do not think we are the right fit for`,
      `you at the moment, so we will not take this further. We would rather say`,
      `that now than take you through a sales process that ends the same way.`,
      ``,
      `If things change on your side, you are very welcome to come back to us.`,
      ``,
      `Aura`,
      `Sirah Digital`,
    ].join("\n"),
  };
}

const TEMPLATES: Record<FollowUpTemplate, (to: FollowUpRecipient) => FollowUpMessage> = {
  disqualified_neutral: disqualifiedNeutral,
  custom_crm_info: customCrmInfo,
  rejected,
};

export function renderFollowUp(
  template: FollowUpTemplate,
  to: FollowUpRecipient,
): FollowUpMessage {
  const render = TEMPLATES[template];
  if (!render) throw new Error(`Unknown follow-up template "${template}"`);
  return render(to);
}

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
 * The default. Prints the message and reports success — see the module header
 * for why that is honest and how the never-delivered rows are found later.
 *
 * The recipient's address is logged in full and deliberately: this only runs in
 * a deployment with no mail provider, the log is the only record that the
 * message existed, and a redacted address would make the backfill impossible.
 * If that ever stops being an acceptable trade, configure a provider — which is
 * the correct fix anyway.
 */
export class LogOnlyFollowUpDispatcher implements FollowUpDispatcher {
  readonly name = "log-only";

  async send(message: FollowUpMessage): Promise<DeliveryResult> {
    console.warn(
      `[funnel follow-up] NOT DELIVERED — no mail provider configured.\n` +
        `  to:      ${message.to.name} <${message.to.email}>\n` +
        `  subject: ${message.subject}\n` +
        message.text.replace(/^/gm, "  | "),
    );
    return { ok: true, messageId: `log-only:${randomUUID()}` };
  }
}

/* ════════════════════════════════════════════════════════════════════════════
   ⚠️  UNVERIFIED — no mail provider account exists, so this has never run.

   A provider-agnostic HTTP sender. Resend, Postmark, Brevo and Mailgun all
   accept a JSON POST with a bearer token, they just disagree on field names, so
   the field names are configuration rather than code:

     FUNNEL_FOLLOWUP_ENDPOINT   e.g. https://api.resend.com/emails   (required —
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
      // 4xx other than 408/429 means the request itself is wrong — a bad
      // address, an unverified domain, a revoked key. Retrying it six times
      // changes nothing and just delays the dead state that tells an operator
      // to look.
      terminal: res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429,
    };
  }
}

let cached: FollowUpDispatcher | null = null;

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

/** Tests only — module state outlives an env change. */
export function resetFollowUpDispatcherForTests(): void {
  cached = null;
}
