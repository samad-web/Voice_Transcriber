import { getAdminPool } from "@aura/db";
import {
  capitalizeName,
  fillTemplate,
  firstNameOf,
  getMessageTemplateSpec,
  missingRequiredPlaceholders,
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
 * Every failure mode here — table not migrated, row deleted, database briefly
 * unreachable — resolves to the copy compiled into `@aura/shared`, not to an
 * error. A rejection sent in last month's wording is a minor annoyance. A
 * rejection that dead-letters because a SELECT timed out is a person who
 * enquired, was turned down, and never heard anything at all. Only one of those
 * is worth failing over.
 *
 * The single exception is a template an operator has switched OFF. That is a
 * deliberate instruction, not a failure, and falling back to the code copy
 * would override it — so it is reported as terminal and the outbox records why.
 *
 * ── WHY IT IS CACHED ───────────────────────────────────────────────────────
 *
 * The drain processes up to 100 rows a tick and would otherwise issue one query
 * per message for text that changes a few times a year. 60 seconds is short
 * enough that an operator who edits a message and immediately rejects someone
 * sees their new wording, and long enough that the query is invisible.
 */

const TTL_MS = 60_000;

type StoredTemplate = { body: string; enabled: boolean };

let cache: Map<string, StoredTemplate> | null = null;
let cachedAt = 0;

/** Tests only — module state outlives a database change. */
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
 * All of them, not the one being sent: there are five rows totalling a few
 * kilobytes, and a per-key cache would issue five queries in the first second
 * after every expiry instead of one.
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
      body: string;
      enabled: boolean;
    }>(`SELECT key, channel, body, enabled FROM marketing.message_templates`);

    const next = new Map<string, StoredTemplate>();
    for (const r of rows) next.set(cacheKey(r.key, r.channel), { body: r.body, enabled: r.enabled });
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

export type WhatsAppVars = {
  name: string;
  /** Only for `booking_confirmed`. Absent elsewhere. */
  slot?: string;
  /**
   * The Google Meet URL, when the calendar produced one. Only for
   * `booking_confirmed`.
   *
   * Genuinely optional, and not merely "usually present": a booking made while
   * the calendar is misconfigured, or before domain-wide delegation was
   * authorised, is a real booking with no Meet link at all. `fillTemplate`
   * treats `meet_link` as an OPTIONAL placeholder and deletes the sentence
   * containing it rather than substituting a word, so those people get a
   * correct confirmation that simply does not mention joining online — instead
   * of "Join on Google Meet here: there ." on their phone.
   */
  meetLink?: string;
  /**
   * The link back into a half-finished form. Only for `resume_form` and
   * `resume_form_2`.
   *
   * REQUIRED where the copy uses it, unlike meetLink — see the check in
   * `renderWhatsAppMessage`. A nudge with no link has nothing for the reader to
   * do, so its absence fails the send rather than trimming the sentence.
   */
  resumeLink?: string;
};

export type RenderedMessage =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/**
 * Render the WhatsApp copy for a stage.
 *
 * Returns `ok: false` for exactly two things, both terminal and both worth an
 * operator seeing: a template that does not exist (a bug — an outbox row for a
 * stage nobody defined) and one that has been switched off.
 */
export async function renderWhatsAppMessage(
  key: string,
  vars: WhatsAppVars,
): Promise<RenderedMessage> {
  const spec = getMessageTemplateSpec(key);
  if (!spec) return { ok: false, reason: `no WhatsApp copy is defined for "${key}"` };

  const stored = (await load()).get(cacheKey(key, "whatsapp"));
  if (stored && !stored.enabled) {
    return { ok: false, reason: `the "${spec.label}" message is switched off in the console` };
  }

  const body = stored?.body ?? spec.whatsapp;

  const vals = {
    first_name: firstNameOf(vars.name),
    name: capitalizeName(vars.name),
    slot: vars.slot,
    meet_link: vars.meetLink,
    resume_link: vars.resumeLink,
  };

  /**
   * Refuse rather than substitute when a REQUIRED placeholder has no value.
   *
   * `fillTemplate` replaces anything unresolved with the neutral word, which is
   * right for a name and catastrophic for a link: "pick up where you left off:
   * there" is an instruction the reader cannot follow, sent to someone who
   * already declined to finish once.
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
        "and no value was available — check SITE_DOMAIN is set",
    };
  }

  // `vals` above is the single source of what each placeholder resolves to —
  // built once so the required-placeholder check and the substitution can never
  // disagree about whether a value was present.
  return { ok: true, text: fillTemplate(body, vals) };
}
