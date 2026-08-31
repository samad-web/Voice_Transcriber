import { getAdminPool } from "@aura/db";
import {
  capitalizeName,
  fillTemplate,
  firstNameOf,
  getMessageTemplateSpec,
  getTemplateFallback,
  missingRequiredPlaceholders,
  titleNameOf,
  type MessageChannel,
} from "@aura/shared";

/**
 * Reading the operator's message copy at send time.
 *
 * The copy lives in `marketing.message_templates` (migration 0026) so it can be
 * edited from the console without a deploy. This is the read side.
 *
 * ── THE FALLBACK IS THE POINT ──────────────────────────────────────────────
 *
 * Every failure mode here - table not migrated, row deleted, database briefly
 * unreachable - resolves to the copy compiled into `@aura/shared`, not to an
 * error. A rejection sent in last month's wording is a minor annoyance. A
 * rejection that dead-letters because a SELECT timed out is a person who
 * enquired, was turned down, and never heard anything at all. Only one of those
 * is worth failing over.
 *
 * The single exception is a template an operator has switched OFF. That is a
 * deliberate instruction, not a failure, and falling back to the code copy
 * would override it - so it is reported as terminal and the outbox records why.
 *
 * ── BOTH CHANNELS, ONE CACHE ───────────────────────────────────────────────
 *
 * The table has always been keyed (key, channel); until migration 0053 only
 * whatsapp rows existed and this module only rendered them. It now renders
 * email from the same rows and the same catalogue, so the two channels cannot
 * drift into separate mechanisms - the only difference between them is that an
 * email also carries a subject.
 *
 * ── WHY IT IS CACHED ───────────────────────────────────────────────────────
 *
 * The drain processes up to 100 rows a tick and would otherwise issue one query
 * per message for text that changes a few times a year. 60 seconds is short
 * enough that an operator who edits a message and immediately rejects someone
 * sees their new wording, and long enough that the query is invisible.
 */

const TTL_MS = 60_000;

type StoredTemplate = { subject: string | null; body: string; enabled: boolean };

let cache: Map<string, StoredTemplate> | null = null;
let cachedAt = 0;

/** Tests only - module state outlives a database change. */
export function resetMessageTemplateCacheForTests(): void {
  cache = null;
  cachedAt = 0;
}

function cacheKey(key: string, channel: MessageChannel): string {
  return `${channel}:${key}`;
}

/**
 * Load every template in one query.
 *
 * All of them, not the one being sent: there are a few dozen rows totalling a
 * few kilobytes, and a per-key cache would issue one query per key in the first
 * second after every expiry instead of one.
 *
 * A failed load caches NOTHING and leaves the previous map in place, so a
 * transient error falls back to slightly stale copy rather than to the compiled
 * defaults. Only a cold start with a broken database reaches the defaults.
 */
async function load(): Promise<Map<string, StoredTemplate>> {
  const now = Date.now();
  if (cache && now - cachedAt < TTL_MS) return cache;

  try {
    const pool = getAdminPool();

    // Same tolerance as the follow-up outbox: an environment where 0026 has not
    // run must fall back quietly, not throw once per message forever.
    const { rows: exists } = await pool.query<{ reg: string | null }>(
      `SELECT to_regclass('marketing.message_templates')::text AS reg`,
    );
    if (!exists[0]?.reg) {
      cache = new Map();
      cachedAt = now;
      return cache;
    }

    const { rows } = await pool.query<{
      key: string;
      channel: MessageChannel;
      subject: string | null;
      body: string;
      enabled: boolean;
    }>(`SELECT key, channel, subject, body, enabled FROM marketing.message_templates`);

    const next = new Map<string, StoredTemplate>();
    for (const r of rows) {
      next.set(cacheKey(r.key, r.channel), {
        subject: r.subject,
        body: r.body,
        enabled: r.enabled,
      });
    }
    cache = next;
    cachedAt = now;
    return cache;
  } catch (err) {
    console.error(
      `[message-templates] load failed, using ${cache ? "the previous copy" : "built-in copy"}: ` +
        `${(err as Error).message}`,
    );
    // Deliberately does NOT stamp cachedAt: the next send retries the load
    // rather than sitting on a failure for a full minute.
    return cache ?? new Map();
  }
}

export type TemplateVars = {
  name: string;
  /** What they chose on the form, when they chose anything. Drives {{title_name}}. */
  salutation?: string | null;
  /** Only for the booking stages. Absent elsewhere. */
  slot?: string;
  /**
   * The Google Meet URL, when the calendar produced one.
   *
   * Genuinely optional, and not merely "usually present": a booking made while
   * the calendar is misconfigured, or before domain-wide delegation was
   * authorised, is a real booking with no Meet link at all. `fillTemplate`
   * treats `meet_link` as an OPTIONAL placeholder and deletes the sentence
   * containing it rather than substituting a word, so those people get a
   * correct confirmation that simply does not mention joining online - instead
   * of "Join on Google Meet here: there ." on their phone.
   */
  meetLink?: string;
  /**
   * The link that lets somebody move their own booking. Optional in the same
   * sentence-dropping sense as `meetLink`: a reminder that could not mint one
   * still needs to say when the call is. See REQUIRED_PLACEHOLDERS in
   * @aura/shared for why this differs from `resumeLink`.
   */
  rescheduleLink?: string;
  /**
   * The link back into a half-finished form. Only for `resume_form` and
   * `resume_form_2`.
   *
   * REQUIRED where the copy uses it, unlike the two above - see the check in
   * `renderMessage`. A nudge with no link has nothing for the reader to do, so
   * its absence fails the send rather than trimming the sentence.
   */
  resumeLink?: string;
};

export type RenderedMessage =
  | { ok: true; text: string; subject?: string }
  | { ok: false; reason: string };

/** The values every placeholder resolves to, built once per render. */
function placeholderValues(vars: TemplateVars): Record<string, string | undefined> {
  return {
    first_name: firstNameOf(vars.name),
    name: capitalizeName(vars.name),
    // Degrades title → first name → the neutral word, so a template that greets
    // with {{title_name}} never renders "Hi ,".
    title_name: titleNameOf(vars.salutation, vars.name) ?? firstNameOf(vars.name),
    slot: vars.slot,
    meet_link: vars.meetLink,
    reschedule_link: vars.rescheduleLink,
    resume_link: vars.resumeLink,
  };
}

/**
 * Render one stage on one channel.
 *
 * Returns `ok: false` for exactly three things, all terminal and all worth an
 * operator seeing: a stage that does not exist (a bug - an outbox row for a
 * stage nobody defined), a stage with no copy for this channel (a WhatsApp-only
 * stage queued on email), and one that has been switched off.
 */
export async function renderMessage(
  key: string,
  channel: MessageChannel,
  vars: TemplateVars,
): Promise<RenderedMessage> {
  const spec = getMessageTemplateSpec(key);
  if (!spec) return { ok: false, reason: `no copy is defined for "${key}"` };

  const fallback = getTemplateFallback(key, channel);
  if (!fallback) {
    return {
      ok: false,
      reason: `"${spec.label}" has no ${channel} copy - it is a ${
        channel === "email" ? "WhatsApp" : "email"
      }-only stage`,
    };
  }

  const stored = (await load()).get(cacheKey(key, channel));
  if (stored && !stored.enabled) {
    return { ok: false, reason: `the "${spec.label}" message is switched off in the console` };
  }

  const body = stored?.body ?? fallback.body;
  const subject = stored?.subject ?? fallback.subject;
  const vals = placeholderValues(vars);

  /**
   * Refuse rather than substitute when a REQUIRED placeholder has no value.
   *
   * `fillTemplate` replaces anything unresolved with the neutral word, which is
   * right for a name and catastrophic for a resume link: "pick up where you
   * left off: there" is an instruction the reader cannot follow, sent to
   * someone who already declined to finish once.
   *
   * Terminal, so the outbox records the reason instead of retrying six times.
   * The realistic cause is a deployment with no SITE_DOMAIN, which no amount of
   * retrying fixes.
   */
  const missing = missingRequiredPlaceholders(body, vals);
  if (missing.length > 0) {
    return {
      ok: false,
      reason:
        `the "${spec.label}" message needs ${missing.map((m) => `{{${m}}}`).join(", ")} ` +
        "and no value was available - check SITE_DOMAIN is set",
    };
  }

  return {
    ok: true,
    text: fillTemplate(body, vals),
    // A subject is substituted too: "Your Aura call is confirmed for {{slot}}"
    // is the whole reason a subject line is worth having here.
    ...(channel === "email" && subject ? { subject: fillTemplate(subject, vals) } : {}),
  };
}

/** Convenience wrapper for the WhatsApp path, which is most call sites. */
export async function renderWhatsAppMessage(
  key: string,
  vars: TemplateVars,
): Promise<RenderedMessage> {
  return renderMessage(key, "whatsapp", vars);
}
