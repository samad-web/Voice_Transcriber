/**
 * The catalogue of messages Aura sends to a funnel enquirer.
 *
 * Shared by all three apps because all three need the SAME answer to different
 * questions, and three copies of it would drift on the first edit:
 *
 *   apps/web      which stages to show in the editor, and what each one means
 *   apps/api      whether a submitted body is valid before it is stored
 *   apps/worker   which placeholders to substitute, and what copy to fall back
 *                 to when the database has no row
 *
 * The stored copy lives in `marketing.message_templates` (migration 0026). The
 * bodies below are the FALLBACK, not the source of truth — but they are a real
 * fallback, not a formality. If the table is unreachable or a row is missing, a
 * rejection still goes out in slightly older words rather than dead-lettering,
 * which would leave a person who enquired never hearing back at all.
 *
 * ── BOTH CHANNELS LIVE HERE NOW ────────────────────────────────────────────
 *
 * Until migration 0053 the email copy lived in
 * `apps/worker/src/pipeline/funnel-followup.ts` as three TypeScript functions,
 * editable only by a developer with a deploy, while WhatsApp copy was editable
 * from the console. 0026's own header set out the fix — "when email goes live,
 * seed it here and delete the literals there, in that order" — and this is it:
 * every stage carries an optional `email` variant alongside its `whatsapp`
 * body, both stored per (key, channel) in the same table, both editable in the
 * same console screen.
 *
 * A stage with no `email` entry is WhatsApp-only by decision, not by omission.
 */

export const MESSAGE_TEMPLATE_KEYS = [
  "rejected",
  "disqualified_neutral",
  "custom_crm_info",
  "booking_confirmed",
  "reminder_followup",
  "resume_form",
  "resume_form_2",
  "reminder_call_24h",
  "reminder_call_1h",
  "reminder_call_5m",
  "call_attended",
  "call_no_show",
  "nurture_1",
  "nurture_2",
  "nurture_3",
] as const;

export type MessageTemplateKey = (typeof MESSAGE_TEMPLATE_KEYS)[number];

export type MessageChannel = "whatsapp" | "email";

export const MESSAGE_CHANNELS: readonly MessageChannel[] = ["whatsapp", "email"];

/**
 * Every placeholder the renderer understands, and where its value comes from.
 *
 * `{{first_name}}`, `{{name}}` and `{{title_name}}` always resolve — see
 * `fillTemplate`, which falls back to "there" rather than leaving a hole.
 *
 * Every stage's default copy greets with `{{title_name}}`, so a lead who chose
 * a title is addressed with it ("Hi Mr. Ramesh Kumar,") and one who did not is
 * greeted exactly as before ("Hi Ramesh,"). `{{first_name}}` stays available
 * for an operator who wants the shorter form back.
 * `{{slot}}` does NOT: it is only meaningful once a slot is booked, so a
 * template that uses it outside a booking stage would render a blank on every
 * send. That is what `allowedPlaceholders` prevents, at save time, where a
 * human can still fix it.
 */
export const PLACEHOLDER_HELP: Record<string, string> = {
  first_name: "Their first name, or “there” if we don’t have a usable one",
  name: "Their full name as they typed it",
  title_name:
    "Their name with the salutation they chose, e.g. “Mr. Ramesh Kumar”. " +
    "Falls back to just the first name when they didn’t give one.",
  slot: "The booked call time, e.g. “Tue 12 Aug, 6:30 pm”",
  meet_link: "The Google Meet link, when the calendar produced one",
  reschedule_link:
    "A private link that lets this person move their own booking to another " +
    "open slot. The sentence is dropped when there is no link to give.",
  resume_link:
    "A private link back into this person’s own half-finished form. " +
    "Required — a nudge without it has nothing to click.",
};

/**
 * Placeholders a message is POINTLESS without.
 *
 * Distinct from OPTIONAL_PLACEHOLDERS below, and the opposite rule. An optional
 * one that is missing takes its sentence away and the message still reads. A
 * REQUIRED one that is missing means the message has no reason to exist: "you
 * didn't finish, pick up where you left off" with no link is an instruction the
 * reader cannot follow, and worse than silence.
 *
 * The renderer refuses rather than substituting, so the outbox dead-letters the
 * row with a reason an operator can act on instead of sending "pick up where
 * you left off: there".
 *
 * `reschedule_link` is deliberately NOT here even though it looks similar. A
 * reminder whose link could not be minted still says the one thing it exists to
 * say — your call is tomorrow at 6:30 — so dropping the offer to move it is far
 * better than dead-lettering the reminder entirely and letting someone miss the
 * call. A resume nudge has no such residue: without its link it is only an
 * accusation that you did not finish something.
 */
export const REQUIRED_PLACEHOLDERS = new Set(["resume_link"]);

/** Placeholders in `body` that must have a value and do not. */
export function missingRequiredPlaceholders(
  body: string,
  vars: Record<string, string | undefined>,
): string[] {
  return placeholdersIn(body).filter(
    (name) => REQUIRED_PLACEHOLDERS.has(name) && !vars[name]?.trim(),
  );
}

/** The email variant of a stage. Absent means the stage is WhatsApp-only. */
export interface EmailCopy {
  subject: string;
  /** Plain text. No HTML — it renders everywhere and cannot carry a tracker. */
  body: string;
}

export interface MessageTemplateSpec {
  key: MessageTemplateKey;
  /** Shown as the heading in the console editor. */
  label: string;
  /** When this fires, in the operator's terms. One sentence. */
  when: string;
  allowedPlaceholders: readonly string[];
  /**
   * Whether anything in the system actually queues this today.
   *
   * Surfaced in the editor on purpose. An operator who carefully words a
   * message that nothing sends, and is not told, will assume their enquirers
   * are being contacted. That is a worse failure than an ugly badge.
   */
  live: boolean;
  /** Why it does not fire yet. Only meaningful when `live` is false. */
  blockedBy?: string;
  /** Fallback copy — see the module header. */
  whatsapp: string;
  /** Fallback copy for the email variant. Absent = WhatsApp-only stage. */
  email?: EmailCopy;
}

/**
 * The signature every email ends with. One constant rather than fifteen copies,
 * because a company that renames itself should not have to find them all.
 */
const SIGN_OFF = ["", "Aura", "Sirah Digital"].join("\n");

export const MESSAGE_TEMPLATES: readonly MessageTemplateSpec[] = [
  {
    key: "rejected",
    label: "Rejected",
    when: "Sent when an operator presses Reject on a lead.",
    allowedPlaceholders: ["first_name", "name", "title_name"],
    live: true,
    whatsapp:
      "Hi {{title_name}}, thanks for your interest in Aura and for telling us about your business. " +
      "Having looked at it properly we don't think we're the right fit for you at the moment, " +
      "so we won't take this further. If things change, do come back to us.",
    /**
     * Transcribed from `rejected()` in funnel-followup.ts, which this replaces.
     * What it deliberately does NOT do, carried over from that file: it does not
     * explain the reason (the operator's note is for the operator, and a reason
     * in writing is a reason to argue with), and it does not promise to keep
     * them on file, because nothing in this system re-surfaces a rejected lead.
     */
    email: {
      subject: "About your Aura enquiry",
      body: [
        "Hi {{title_name}},",
        "",
        "Thanks for taking the time to tell us about your business, and for your",
        "interest in Aura.",
        "",
        "Having looked at it properly, we do not think we are the right fit for",
        "you at the moment, so we will not take this further. We would rather say",
        "that now than take you through a sales process that ends the same way.",
        "",
        "If things change on your side, you are very welcome to come back to us.",
        SIGN_OFF,
      ].join("\n"),
    },
  },
  {
    key: "disqualified_neutral",
    label: "Didn’t qualify",
    when: "For an enquiry the funnel’s own budget and intent rules answered no to.",
    allowedPlaceholders: ["first_name", "name", "title_name"],
    live: false,
    blockedBy:
      "Nothing queues this yet. The website role holds no write access to the outbox " +
      "(deliberately), so the enqueue has to come from the worker.",
    whatsapp:
      "Hi {{title_name}}, thanks for your enquiry about Aura. Someone from the team will get back to you. " +
      "If anything changes on your side in the meantime, we'd be glad to hear from you.",
    email: {
      subject: "Following up on your enquiry",
      body: [
        "Hi {{title_name}},",
        "",
        "Thank you for getting in touch about Aura. We have your details and our",
        "team will be in touch as things line up on your end.",
        "",
        "In the meantime, if it is useful: our compatibility page lists exactly",
        "which handsets record reliably, and our consent page explains what the",
        "app records and what it does not. Both are worth five minutes before any",
        "call recording rollout.",
        "",
        "If your requirements change, or you would like to talk sooner, just reply",
        "to this email — it reaches a person.",
        SIGN_OFF,
      ].join("\n"),
    },
  },
  {
    key: "custom_crm_info",
    label: "Asked about a custom CRM",
    when: "For someone who chose “tell me more” about a CRM built around their business.",
    allowedPlaceholders: ["first_name", "name", "title_name"],
    live: false,
    blockedBy: "Nothing queues this yet — same reason as “Didn’t qualify”.",
    whatsapp:
      "Hi {{title_name}}, thanks for asking about a CRM built around your business. Reply here and tell us " +
      "how you sell today, and we'll say honestly whether you need a new system or just a " +
      "connector to the one you have.",
    /**
     * No price, because there is no published price and inventing one here
     * would be the same failure as inventing one on the pricing page.
     */
    email: {
      subject: "Following up on your enquiry",
      body: [
        "Hi {{title_name}},",
        "",
        "Thanks for asking about a CRM built around your business — here is the",
        "short version, since you asked to hear more rather than to book a call.",
        "",
        "Most CRMs make you describe your business in someone else's words: deals,",
        "opportunities, sales cycles. We build yours around what you actually",
        "track — brick type and quantity, site location, quotation status,",
        "follow-up date. Whatever your calls are already about.",
        "",
        "Aura then feeds it automatically. Every qualified call becomes a record",
        "with the details already filled in, in Tamil or English. Nobody types",
        "anything.",
        "",
        "If you would like the specifics for how you sell today, reply to this",
        "email and describe it in a couple of lines. We will tell you honestly",
        "whether you need a new system or just a connector to the one you have.",
        SIGN_OFF,
      ].join("\n"),
    },
  },
  {
    key: "booking_confirmed",
    // Names the Meet link, because that is what an operator comes here looking
    // for. "Booked a call" is accurate and was unfindable: somebody hunting for
    // the message that carries the join link scanned five headings, saw nothing
    // with "Meet" in it, and concluded the template did not exist.
    label: "Booked a call — sends the Google Meet link",
    when:
      "Sent on WhatsApp within a minute of someone picking a slot on the website. " +
      "Carries the time and the Google Meet link. Google also emails them a calendar invite.",
    allowedPlaceholders: [
      "first_name",
      "name",
      "title_name",
      "slot",
      "meet_link",
      "reschedule_link",
    ],
    // Live since 2026-08-10, reversing the 2026-08-09 decision not to message
    // bookers. The worker sweep in booking-confirmations.ts queues it; migration
    // 0032 settled the bookings that predate it so nobody who booked under the
    // old promise is messaged retrospectively.
    live: true,
    // Must stay character-identical to the body migration 0029 wrote into
    // `marketing.message_templates`, which is what production actually sends —
    // the stored row wins over this fallback. message-templates.test.ts holds
    // the two together; rewording here alone would change nothing that is sent
    // and quietly break "Restore original".
    whatsapp:
      "Hi {{title_name}}, your call with Aura is confirmed for {{slot}}. " +
      "Join here: {{meet_link}} . If that time stops working, move it here: {{reschedule_link}}",
    email: {
      subject: "Your Aura call is confirmed for {{slot}}",
      body: [
        "Hi {{title_name}},",
        "",
        "Your call with Aura is confirmed for {{slot}}.",
        "",
        "Join here: {{meet_link}}",
        "",
        "If that time stops working, you can move it yourself: {{reschedule_link}}",
        "",
        "We will walk through what your calls are already saying, and what Aura",
        "would pick up from them. Thirty minutes, no preparation needed.",
        SIGN_OFF,
      ].join("\n"),
    },
  },
  {
    key: "reminder_followup",
    label: "Follow-up reminder",
    when: "A nudge to an enquirer who went quiet without booking, sent once.",
    allowedPlaceholders: ["first_name", "name", "title_name"],
    // Not `live: true` even though the job now exists, because it ships OFF.
    // Marking it live would tell an operator their quiet enquiries are being
    // chased when, on a default deployment, nothing is happening at all.
    live: false,
    blockedBy:
      "The reminder job is built but switched off. It only runs where the worker has " +
      "FUNNEL_REMINDERS_ENABLED=true — this is the one message nobody asked us to send, so " +
      "turning it on is a deliberate decision rather than a default.",
    whatsapp:
      "Hi {{title_name}}, following up on your enquiry about Aura. " +
      "If you'd still like to see what your calls are saying, reply here and we'll set up a time.",
    email: {
      subject: "Following up on your enquiry",
      body: [
        "Hi {{title_name}},",
        "",
        "Following up on your enquiry about Aura — we never heard back, which is",
        "completely fine, but we did not want to let it go unanswered either.",
        "",
        "If you would still like to see what your own calls are saying, reply to",
        "this email and we will find a time that suits.",
        SIGN_OFF,
      ].join("\n"),
    },
  },
  {
    key: "resume_form",
    label: "Didn’t finish the form — first nudge",
    when:
      "Sent about 2 hours after someone gives their details and never answers the " +
      "qualifying questions. Carries a private link back into their own half-finished form.",
    allowedPlaceholders: ["first_name", "name", "title_name", "resume_link"],
    live: true,
    // Short on purpose. Evolution drives an ordinary WhatsApp account over the
    // unofficial web protocol, and this is the least-engaged audience the
    // funnel messages, so brevity is a deliverability decision.
    whatsapp:
      "Hi {{title_name}}, you started telling us about your business on Aura but didn't finish. " +
      "It takes under a minute — pick up where you left off: {{resume_link}}",
    email: {
      subject: "You didn’t quite finish",
      body: [
        "Hi {{title_name}},",
        "",
        "You started telling us about your business on Aura but did not finish.",
        "It takes under a minute, and your answers are still saved:",
        "",
        "{{resume_link}}",
        SIGN_OFF,
      ].join("\n"),
    },
  },
  {
    key: "resume_form_2",
    label: "Didn’t finish the form — final nudge",
    when:
      "Sent about 2 days after the first nudge, and only if they still haven’t finished. " +
      "Nobody gets more than these two.",
    allowedPlaceholders: ["first_name", "name", "title_name", "resume_link"],
    live: true,
    whatsapp:
      "Hi {{title_name}}, your Aura enquiry is still open. Answer the last few questions and " +
      "we'll tell you honestly whether we can help: {{resume_link}}",
    email: {
      subject: "Your Aura enquiry is still open",
      body: [
        "Hi {{title_name}},",
        "",
        "Your Aura enquiry is still open. Answer the last few questions and we",
        "will tell you honestly whether we can help:",
        "",
        "{{resume_link}}",
        "",
        "This is the last we will write about it either way.",
        SIGN_OFF,
      ].join("\n"),
    },
  },

  /* ── The booking lifecycle (migration 0053) ─────────────────────────────────
     Everything below is keyed on a BOOKING rather than on a person, and queued
     through `marketing.booking_notifications` rather than `funnel_followups`.
     See that migration's header for why the two outboxes are separate. */

  {
    key: "reminder_call_24h",
    label: "Call reminder — the day before",
    when: "Sent 24 hours before a booked call. Carries the time and a link to move it.",
    allowedPlaceholders: [
      "first_name",
      "name",
      "title_name",
      "slot",
      "meet_link",
      "reschedule_link",
    ],
    live: false,
    blockedBy:
      "Seeded switched off. The reminder sweep is new and these go to people with a real " +
      "appointment days away — read the wording and turn it on when you are happy with it.",
    whatsapp:
      "Hi {{title_name}}, a reminder that your call with Aura is tomorrow at {{slot}}. " +
      "Need a different time? Reschedule here: {{reschedule_link}}",
    email: {
      subject: "Your Aura call is tomorrow, {{slot}}",
      body: [
        "Hi {{title_name}},",
        "",
        "A reminder that your call with Aura is tomorrow at {{slot}}.",
        "",
        "Join here: {{meet_link}}",
        "",
        "If tomorrow no longer works, you can move it yourself: {{reschedule_link}}",
        SIGN_OFF,
      ].join("\n"),
    },
  },
  {
    key: "reminder_call_1h",
    label: "Call reminder — an hour before",
    when: "Sent about an hour before a booked call.",
    allowedPlaceholders: [
      "first_name",
      "name",
      "title_name",
      "slot",
      "meet_link",
      "reschedule_link",
    ],
    live: false,
    blockedBy: "Seeded switched off — same reason as the day-before reminder.",
    whatsapp:
      "Hi {{title_name}}, your call with Aura is in about an hour, at {{slot}}. " +
      "Can't make it? Reschedule here: {{reschedule_link}}",
    email: {
      subject: "Your Aura call is in about an hour",
      body: [
        "Hi {{title_name}},",
        "",
        "Your call with Aura is in about an hour, at {{slot}}.",
        "",
        "Join here: {{meet_link}}",
        "",
        "If something has come up, move it here: {{reschedule_link}}",
        SIGN_OFF,
      ].join("\n"),
    },
  },
  {
    key: "reminder_call_5m",
    label: "Call reminder — five minutes before",
    when: "Sent five minutes before a booked call. The last nudge before it starts.",
    allowedPlaceholders: [
      "first_name",
      "name",
      "title_name",
      "slot",
      "meet_link",
      "reschedule_link",
    ],
    live: false,
    blockedBy: "Seeded switched off — same reason as the day-before reminder.",
    // No email variant, deliberately: five minutes is not enough notice for
    // mail to be read, and a message that arrives after the thing it announces
    // is worse than none. WhatsApp only.
    whatsapp:
      "Hi {{title_name}}, your call with Aura starts in a few minutes. " +
      "Join here: {{meet_link}} . Running late or need a new time? {{reschedule_link}}",
  },
  {
    key: "call_attended",
    label: "Call happened",
    when: "Sent when an operator marks a booked call as attended.",
    allowedPlaceholders: ["first_name", "name", "title_name", "slot"],
    live: true,
    whatsapp:
      "Hi {{title_name}}, thanks for the call today. It was good to talk through what you're " +
      "looking for — we'll follow up with next steps shortly.",
    email: {
      subject: "Thanks for your time today",
      body: [
        "Hi {{title_name}},",
        "",
        "Thanks for the call today — it was good to talk through what you are",
        "looking for.",
        "",
        "We will follow up shortly with the next steps. In the meantime, if",
        "anything else comes to mind, just reply to this email.",
        SIGN_OFF,
      ].join("\n"),
    },
  },
  {
    key: "call_no_show",
    label: "Call missed",
    when: "Sent when an operator marks a booked call as not attended. Offers a new time.",
    allowedPlaceholders: ["first_name", "name", "title_name", "slot", "reschedule_link"],
    live: true,
    // No blame, and no "you missed it". The commonest reason someone does not
    // join is that something at work came up, and a message that reads as a
    // complaint is how a recoverable lead becomes a lost one.
    whatsapp:
      "Hi {{title_name}}, we had a call scheduled today and didn't manage to connect. " +
      "No trouble at all — pick a new time whenever suits: {{reschedule_link}}",
    email: {
      subject: "Sorry we missed you",
      body: [
        "Hi {{title_name}},",
        "",
        "We had a call scheduled today and did not manage to connect — no trouble",
        "at all, these things happen.",
        "",
        "Pick a new time whenever it suits you: {{reschedule_link}}",
        SIGN_OFF,
      ].join("\n"),
    },
  },

  /* ── The no-show nurture drip ───────────────────────────────────────────────
     ⚠️  The first two quote the landing page's testimonials, and
     apps/marketing/components/proof.tsx states plainly that their WORDING was
     written from what the owner reported, not transcribed from what the
     customer said, and has never been approved in writing by either company.
     Repeating an unapproved quotation on a public page is one exposure;
     sending it one-to-one to a named stranger, attributed, is another. Both
     ship switched off. */

  {
    key: "nurture_1",
    label: "After a no-show — first note",
    when: "Sent 24 hours after a call is marked not attended, if they haven’t converted.",
    allowedPlaceholders: ["first_name", "name", "title_name", "reschedule_link"],
    live: false,
    blockedBy:
      "Switched off, and it must stay off until the quote in it is approved. This message " +
      "attributes a specific claim (“five times”) to RD Interlock Bricks in a one-to-one " +
      "message — see the warning in apps/marketing/components/proof.tsx. Get it in writing " +
      "from the customer, or reword it, before enabling.",
    whatsapp:
      "Hi {{title_name}}, following up after the call we missed. One of our customers, " +
      "RD Interlock Bricks, told us: \"Our conversion rate is five times what it was. We are " +
      "not calling more people, we finally know which calls are worth following up.\" " +
      "Still worth a look? {{reschedule_link}}",
    email: {
      subject: "What one of our customers said",
      body: [
        "Hi {{title_name}},",
        "",
        "Following up after the call we missed — no rush on your side.",
        "",
        "One of our customers, RD Interlock Bricks, put it this way:",
        "",
        "  \"Our conversion rate is five times what it was. We are not calling",
        "  more people, we finally know which calls are worth following up.\"",
        "",
        "If that is the problem you were hoping to solve, the offer of a call",
        "stands: {{reschedule_link}}",
        SIGN_OFF,
      ].join("\n"),
    },
  },
  {
    key: "nurture_2",
    label: "After a no-show — second note",
    when: "Sent 48 hours after a call is marked not attended, if they haven’t converted.",
    allowedPlaceholders: ["first_name", "name", "title_name", "reschedule_link"],
    live: false,
    blockedBy:
      "Switched off for the same reason as the first note — the quote attributed to Fortune " +
      "Innovatives has not been approved by them in writing.",
    whatsapp:
      "Hi {{title_name}}, another quick note. Fortune Innovatives told us: \"The insights are " +
      "what we train the team on now. Our objection handling is a different thing from what " +
      "it was.\" If you'd still like to see this on your own calls: {{reschedule_link}}",
    email: {
      subject: "The part customers didn’t expect",
      body: [
        "Hi {{title_name}},",
        "",
        "One more note, then we will leave you to it.",
        "",
        "The thing customers tell us they did not expect is what happens to the",
        "rest of the team. Fortune Innovatives put it this way:",
        "",
        "  \"The insights are what we train the team on now. Our objection",
        "  handling is a different thing from what it was, because everyone can",
        "  see what actually worked on a real call.\"",
        "",
        "Happy to show you what that looks like on your calls: {{reschedule_link}}",
        SIGN_OFF,
      ].join("\n"),
    },
  },
  {
    key: "nurture_3",
    label: "After a no-show — last note",
    when: "Sent 72 hours after a call is marked not attended, if they haven’t converted.",
    allowedPlaceholders: ["first_name", "name", "title_name", "reschedule_link"],
    live: false,
    blockedBy:
      "Switched off with the rest of the drip. This one quotes nobody, so it is the safest " +
      "of the three to enable first if you want the sequence running before the quotes are " +
      "approved.",
    // Quotes nobody and asks for nothing. A drip that ends without saying it
    // has ended is how a prospect starts ignoring the sender rather than the
    // message.
    whatsapp:
      "Hi {{title_name}}, last note from us on this — the offer to talk stands whenever " +
      "you're ready, no pressure. Pick a time here if that changes: {{reschedule_link}}",
    email: {
      subject: "Leaving this with you",
      body: [
        "Hi {{title_name}},",
        "",
        "Last note from us on this one. The offer to talk stands whenever you are",
        "ready, and there is no pressure either way.",
        "",
        "If that changes, pick a time here: {{reschedule_link}}",
        SIGN_OFF,
      ].join("\n"),
    },
  },
];

export function getMessageTemplateSpec(key: string): MessageTemplateSpec | undefined {
  return MESSAGE_TEMPLATES.find((t) => t.key === key);
}

/** The fallback copy for one (key, channel), or undefined if there is none. */
export function getTemplateFallback(
  key: string,
  channel: MessageChannel,
): { subject?: string; body: string } | undefined {
  const spec = getMessageTemplateSpec(key);
  if (!spec) return undefined;
  if (channel === "whatsapp") return { body: spec.whatsapp };
  return spec.email ? { subject: spec.email.subject, body: spec.email.body } : undefined;
}

/** Matches `{{ name }}` with or without inner spacing. */
const PLACEHOLDER_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

/** Every distinct placeholder used in a body, in order of first appearance. */
export function placeholdersIn(body: string): string[] {
  const found: string[] = [];
  for (const m of body.matchAll(PLACEHOLDER_RE)) {
    const namePart = m[1];
    if (namePart && !found.includes(namePart)) found.push(namePart);
  }
  return found;
}

/**
 * Placeholders that may legitimately have no value, where the right answer is
 * to DELETE THE SENTENCE rather than substitute anything.
 *
 * `{{meet_link}}` is the original case. A Meet URL exists only when Google
 * Calendar is configured and returned one, and the neutral-word fallback below
 * would otherwise produce "Join here: there ." on a real customer's phone —
 * which is worse than saying nothing about joining at all.
 *
 * `{{reschedule_link}}` behaves the same way and for the same reason: a
 * reminder that could not mint one still needs to say when the call is.
 */
const OPTIONAL_PLACEHOLDERS = new Set(["meet_link", "reschedule_link"]);

/**
 * Substitute placeholders. Never leaves `{{…}}` in the output.
 *
 * `first_name`, `name` and `title_name` fall back to "there" rather than to an
 * empty string, because "Hi , thanks for your interest" is the exact kind of
 * message that tells the reader they are talking to a script. Anything
 * unresolved — which `validateTemplateBody` should have caught at save time —
 * is replaced with the same neutral word rather than left as literal braces on
 * someone's phone.
 *
 * An OPTIONAL placeholder with no value takes its whole sentence with it. The
 * sentence is found by scanning to the nearest full stop on either side, which
 * is crude and adequate: these are two-line WhatsApp messages, not prose.
 */
export function fillTemplate(body: string, vars: Record<string, string | undefined>): string {
  let text = body;

  for (const name of OPTIONAL_PLACEHOLDERS) {
    const value = vars[name];
    if (value && value.trim()) continue;
    const token = new RegExp(`[^.!?]*\{\{\s*${name}\s*\}\}[^.!?]*[.!?]?\s*`, "g");
    text = text.replace(token, "");
  }

  return text
    .replace(PLACEHOLDER_RE, (_full, namePart: string) => {
      const value = vars[namePart];
      return value && value.trim() ? value.trim() : "there";
    })
    // Removing a sentence can leave a double space behind it.
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Capitalise the first letter of each word, and change nothing else.
 *
 * People type their name into a web form in whatever case is convenient —
 * "aakash kummar" is extremely common on a phone keyboard — and "Hi aakash,"
 * reads as sloppy in a message from a company they are considering paying.
 *
 * ── WHY ONLY THE FIRST LETTER ──────────────────────────────────────────────
 *
 * The tempting version lowercases the rest, turning "AAKASH" into "Aakash".
 * It also turns "McDonald" into "Mcdonald", "D'Souza" into "D'souza" and
 * "MD Imran" into "Md Imran" — mangling names that were typed correctly in
 * order to fix ones that were not. Getting somebody's name wrong in the first
 * word of a sales message is worse than leaving it shouty, so the rest of each
 * word is left exactly as the person typed it.
 *
 * Word-initial after whitespace only. Hyphenated and apostrophed names are left
 * alone for the same reason: every rule that reaches inside a word is wrong for
 * somebody.
 */
export function capitalizeName(name: string): string {
  // \p{L} rather than [a-z]: Tamil, Devanagari and accented Latin all appear in
  // this funnel, and a plain ASCII test would silently skip them. Scripts
  // without letter case are unaffected — toUpperCase() is a no-op there.
  return name.replace(/(^|\s)(\p{L})/gu, (_m, lead: string, letter: string) => lead + letter.toUpperCase());
}

/**
 * First word of a name, capitalised, if it is usable as a greeting.
 *
 * A single letter is not — "Hi R," reads as a mail merge that went wrong — so
 * it falls through to the neutral form.
 */
export function firstNameOf(name: string): string | undefined {
  const first = name.trim().split(/\s+/)[0];
  return first && first.length >= 2 ? capitalizeName(first) : undefined;
}

/** How each salutation is written in front of a name. */
const SALUTATION_PREFIX: Record<string, string> = {
  mr: "Mr.",
  mrs: "Mrs.",
  ms: "Ms.",
  dr: "Dr.",
};

/**
 * "Mr. Ramesh Kumar" — the salutation the person chose, in front of their name.
 *
 * The WHOLE name, not a surname. Picking one out means guessing which word it
 * is, and in Tamil Nadu — this funnel's actual market — the last word is
 * frequently a father's name or an initial rather than a family name, so
 * "Mr. Kumar" is a coin flip where "Mr. Ramesh Kumar" is always correct and is
 * ordinary Indian business register besides.
 *
 * Returns undefined when they chose no salutation, or chose "prefer not to
 * say". The caller then falls back to `firstNameOf`, which falls back to the
 * neutral word — so a template using `{{title_name}}` degrades to "Hi Ramesh,"
 * and then to "Hi there," rather than to "Hi ,".
 */
export function titleNameOf(salutation: string | null | undefined, name: string): string | undefined {
  const prefix = salutation ? SALUTATION_PREFIX[salutation] : undefined;
  if (!prefix) return undefined;
  const full = capitalizeName(name.trim());
  return full ? `${prefix} ${full}` : undefined;
}

export const MESSAGE_BODY_MAX = 1200;

/**
 * Email gets a bigger ceiling than WhatsApp, and the difference is the point.
 *
 * 1200 characters is a WhatsApp DELIVERABILITY limit — Evolution drives an
 * ordinary account over the unofficial web protocol, and long, uniform,
 * business-shaped chat messages are what gets one flagged. Email has no such
 * exposure and its templates are legitimately five paragraphs with a signature.
 * Applying the chat limit to mail would force the email copy to be as terse as
 * the WhatsApp copy, which is the wrong register for the channel.
 */
export const EMAIL_BODY_MAX = 5000;
export const EMAIL_SUBJECT_MAX = 150;

export function bodyMaxFor(channel: MessageChannel): number {
  return channel === "email" ? EMAIL_BODY_MAX : MESSAGE_BODY_MAX;
}

export type TemplateValidation = { ok: true } | { ok: false; error: string };

/**
 * Check a body before it is stored.
 *
 * Validating on save rather than on send is the whole point: a bad placeholder
 * caught here is a red line under a textarea, and caught at send time it is a
 * dead-lettered message to a real person nobody notices for a week.
 */
export function validateTemplateBody(
  key: string,
  body: string,
  channel: MessageChannel,
): TemplateValidation {
  const spec = getMessageTemplateSpec(key);
  if (!spec) return { ok: false, error: `Unknown template "${key}"` };

  if (channel === "email" && !spec.email) {
    // Not a validation quibble — it means somebody is about to store email copy
    // for a stage nothing will ever read on that channel.
    return {
      ok: false,
      error: `“${spec.label}” has no email version. It is sent on WhatsApp only.`,
    };
  }

  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: "The message cannot be empty. To stop sending this stage, switch it off instead.",
    };
  }
  const max = bodyMaxFor(channel);
  if (trimmed.length > max) {
    return { ok: false, error: `Keep it under ${max} characters.` };
  }

  const unknown = placeholdersIn(trimmed).filter((p) => !spec.allowedPlaceholders.includes(p));
  if (unknown.length > 0) {
    return {
      ok: false,
      error:
        `${unknown.map((u) => `{{${u}}}`).join(", ")} ` +
        `${unknown.length === 1 ? "is not a value" : "are not values"} we have at this stage. ` +
        `Available here: ${spec.allowedPlaceholders.map((p) => `{{${p}}}`).join(", ")}.`,
    };
  }

  return { ok: true };
}

/**
 * Check an email subject before it is stored.
 *
 * Separate from the body check because the failure modes differ: a subject has
 * a much tighter length budget (most clients truncate around 70 characters on a
 * phone) and a newline in one is a header-injection attempt, not a typo.
 */
export function validateTemplateSubject(key: string, subject: string): TemplateValidation {
  const spec = getMessageTemplateSpec(key);
  if (!spec) return { ok: false, error: `Unknown template "${key}"` };
  if (!spec.email) {
    return { ok: false, error: `“${spec.label}” has no email version.` };
  }

  const trimmed = subject.trim();
  if (trimmed.length === 0) return { ok: false, error: "An email needs a subject line." };
  if (trimmed.length > EMAIL_SUBJECT_MAX) {
    return { ok: false, error: `Keep the subject under ${EMAIL_SUBJECT_MAX} characters.` };
  }
  if (/[\r\n]/.test(subject)) {
    // A stored newline is what turns a subject into two headers the first time
    // it is handed to a mail API that builds MIME itself.
    return { ok: false, error: "A subject line cannot contain a line break." };
  }

  const unknown = placeholdersIn(trimmed).filter((p) => !spec.allowedPlaceholders.includes(p));
  if (unknown.length > 0) {
    return {
      ok: false,
      error:
        `${unknown.map((u) => `{{${u}}}`).join(", ")} ` +
        `${unknown.length === 1 ? "is not a value" : "are not values"} we have at this stage.`,
    };
  }

  return { ok: true };
}
