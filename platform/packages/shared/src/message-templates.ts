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
 */

export const MESSAGE_TEMPLATE_KEYS = [
  "rejected",
  "disqualified_neutral",
  "custom_crm_info",
  "booking_confirmed",
  "reminder_followup",
] as const;

export type MessageTemplateKey = (typeof MESSAGE_TEMPLATE_KEYS)[number];

export type MessageChannel = "whatsapp" | "email";

/**
 * Every placeholder the renderer understands, and where its value comes from.
 *
 * `{{first_name}}` and `{{name}}` always resolve — see `fillTemplate`, which
 * falls back to "there" rather than leaving a hole. `{{slot}}` does NOT: it is
 * only meaningful once a slot is booked, so a template that uses it outside
 * `booking_confirmed` would render a blank on every send. That is what
 * `allowedPlaceholders` prevents, at save time, where a human can still fix it.
 */
export const PLACEHOLDER_HELP: Record<string, string> = {
  first_name: "Their first name, or “there” if we don’t have a usable one",
  name: "Their full name as they typed it",
  slot: "The booked call time, e.g. “Tue 12 Aug, 6:30 pm”",
  meet_link: "The Google Meet link, when the calendar produced one",
};

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
}

export const MESSAGE_TEMPLATES: readonly MessageTemplateSpec[] = [
  {
    key: "rejected",
    label: "Rejected",
    when: "Sent when an operator presses Reject on a lead.",
    allowedPlaceholders: ["first_name", "name"],
    live: true,
    whatsapp:
      "Hi {{first_name}}, thanks for your interest in Aura and for telling us about your business. " +
      "Having looked at it properly we don't think we're the right fit for you at the moment, " +
      "so we won't take this further. If things change, do come back to us.",
  },
  {
    key: "disqualified_neutral",
    label: "Didn’t qualify",
    when: "For an enquiry the funnel’s own budget and intent rules answered no to.",
    allowedPlaceholders: ["first_name", "name"],
    live: false,
    blockedBy:
      "Nothing queues this yet. The website role holds no write access to the outbox " +
      "(deliberately), so the enqueue has to come from the worker.",
    whatsapp:
      "Hi {{first_name}}, thanks for your enquiry about Aura. Someone from the team will get back to you. " +
      "If anything changes on your side in the meantime, we'd be glad to hear from you.",
  },
  {
    key: "custom_crm_info",
    label: "Asked about a custom CRM",
    when: "For someone who chose “tell me more” about a CRM built around their business.",
    allowedPlaceholders: ["first_name", "name"],
    live: false,
    blockedBy: "Nothing queues this yet — same reason as “Didn’t qualify”.",
    whatsapp:
      "Hi {{first_name}}, thanks for asking about a CRM built around your business. Reply here and tell us " +
      "how you sell today, and we'll say honestly whether you need a new system or just a " +
      "connector to the one you have.",
  },
  {
    key: "booking_confirmed",
    label: "Booked a call",
    when: "Sent the moment someone picks a slot on the website.",
    allowedPlaceholders: ["first_name", "name", "slot", "meet_link"],
    live: false,
    blockedBy:
      "Booking works, but it sends nothing. This copy is new — the stage has never had a message.",
    whatsapp:
      "Hi {{first_name}}, your call with Aura is confirmed for {{slot}}. " +
      "Join here: {{meet_link}} . If that time stops working, reply here and we'll move it.",
  },
  {
    key: "reminder_followup",
    label: "Follow-up reminder",
    when: "A nudge to an enquirer who went quiet without booking, sent once.",
    allowedPlaceholders: ["first_name", "name"],
    // Not `live: true` even though the job now exists, because it ships OFF.
    // Marking it live would tell an operator their quiet enquiries are being
    // chased when, on a default deployment, nothing is happening at all.
    live: false,
    blockedBy:
      "The reminder job is built but switched off. It only runs where the worker has " +
      "FUNNEL_REMINDERS_ENABLED=true — this is the one message nobody asked us to send, so " +
      "turning it on is a deliberate decision rather than a default.",
    whatsapp:
      "Hi {{first_name}}, following up on your enquiry about Aura. " +
      "If you'd still like to see what your calls are saying, reply here and we'll set up a time.",
  },
];

export function getMessageTemplateSpec(key: string): MessageTemplateSpec | undefined {
  return MESSAGE_TEMPLATES.find((t) => t.key === key);
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
 * `{{meet_link}}` is the case. A Meet URL exists only when Google Calendar is
 * configured and returned one, and the neutral-word fallback below would
 * otherwise produce "Join here: there ." on a real customer's phone — which is
 * worse than saying nothing about joining at all.
 */
const OPTIONAL_PLACEHOLDERS = new Set(["meet_link"]);

/**
 * Substitute placeholders. Never leaves `{{…}}` in the output.
 *
 * `first_name` and `name` fall back to "there" rather than to an empty string,
 * because "Hi , thanks for your interest" is the exact kind of message that
 * tells the reader they are talking to a script. Anything unresolved — which
 * `validateTemplateBody` should have caught at save time — is replaced with the
 * same neutral word rather than left as literal braces on someone's phone.
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
    const token = new RegExp(`[^.!?]*\{\{\s*${name}\s*\}\}[^.!?]*[.!?]\s*`, "g");
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
 * First word of a name, if it is usable as a greeting.
 *
 * A single letter is not — "Hi R," reads as a mail merge that went wrong — so
 * it falls through to the neutral form.
 */
export function firstNameOf(name: string): string | undefined {
  const first = name.trim().split(/\s+/)[0];
  return first && first.length >= 2 ? first : undefined;
}

export const MESSAGE_BODY_MAX = 1200;

export type TemplateValidation = { ok: true } | { ok: false; error: string };

/**
 * Check a body before it is stored.
 *
 * Validating on save rather than on send is the whole point: a bad placeholder
 * caught here is a red line under a textarea, and caught at send time it is a
 * dead-lettered message to a real person nobody notices for a week.
 *
 * The length cap is not arbitrary. Evolution drives an ordinary WhatsApp
 * account over the unofficial web protocol, and long, uniform, business-shaped
 * messages are what gets an account flagged. 1200 characters is already far
 * longer than anything here needs to be.
 */
export function validateTemplateBody(key: string, body: string): TemplateValidation {
  const spec = getMessageTemplateSpec(key);
  if (!spec) return { ok: false, error: `Unknown template "${key}"` };

  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: "The message cannot be empty. To stop sending this stage, switch it off instead.",
    };
  }
  if (trimmed.length > MESSAGE_BODY_MAX) {
    return { ok: false, error: `Keep it under ${MESSAGE_BODY_MAX} characters.` };
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
