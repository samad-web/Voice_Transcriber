/**
 * SOMEBODY ASKED TO BE LEFT ALONE - the rule, in one place.
 *
 * ── THE MISTAKE THIS IS SHAPED TO AVOID ─────────────────────────────────────
 *
 * The obvious implementation is a keyword hunt: look for "stop" or "cancel"
 * anywhere in the message. DeskcommCRM shipped exactly that and measured the
 * result in a live dental clinic - these are their real rows, translated:
 *
 *     "is there any way to stop the pain?"        -> patient BLOCKED
 *     "can I leave before 3pm?"                   -> patient BLOCKED
 *     "I need to leave the appointment early"     -> patient BLOCKED
 *     "I don't want to receive anything any more" -> NOT blocked (a real opt-out)
 *
 * Every line is the same error twice over: hunting the WORD instead of the
 * INTENT, and doing it in a business where "stop", "cancel" and "leave" are
 * ordinary customer vocabulary. In English it is worse, not better - "cancel my
 * appointment" and "cancel my order" are among the most common things anybody
 * ever writes to a business on WhatsApp, and neither is a request to stop being
 * contacted.
 *
 * The first failure is the expensive one because it fails SILENTLY: the person
 * disappears from the conversation, nobody is told, and the stored reason
 * ("stop_keyword") looks perfectly legitimate in an audit.
 *
 * ── THE RULE: A VERB OF CESSATION PLUS AN OBJECT OF COMMUNICATION ───────────
 *
 * "stop" is only an opt-out when the thing being stopped is the MESSAGING. So
 * every pattern below requires the object - "stop messaging me", "stop sending
 * me", "take me off your list", "unsubscribe" - or the keyword ALONE as the
 * entire message, which is the universal convention of the channel and is what
 * the footer of a template tells people to send.
 *
 * ── TWO LEVELS, AND THE DIFFERENCE DECIDES WHO ACTS ─────────────────────────
 *
 * `isOptOut` (UNAMBIGUOUS) is what may suppress outbound automatically. Note
 * which direction that runs: it only ever STOPS Aura from sending. It cannot
 * send anything, cannot change a lead, and cannot contact anybody - so it does
 * not touch the rule that nothing automated reaches a person without a human
 * saying yes. Suppression is the safe half of that rule, not an exception to it.
 *
 * `isProbableOptOut` adds the AMBIGUOUS cases - "leave me alone", "enough" -
 * and is the conservative runtime signal: hold outbound and put it in front of
 * a person, who decides. Letting the ambiguous half silence somebody on its own
 * would invert the policy, because the power to stop talking to a customer for
 * good belongs to a person.
 *
 * Adapted from DeskcommCRM (MIT, Rafael Melgaco), `lib/opt-out/deteccao.ts`.
 *
 * ── LANGUAGE COVERAGE, STATED HONESTLY ──────────────────────────────────────
 *
 * English only, plus the handful of romanised Hindi/Hinglish forms that are
 * near-universal in this market. That is a real limit and it is better written
 * down than guessed at: a regex over a language nobody on the team reads is how
 * the clinic bug above gets reintroduced in a script where nobody can see it
 * happening. Adding a language means a native speaker writing the patterns AND
 * the false-positive cases for the test file - the second half is the part that
 * catches the damage.
 */

import { z } from "zod";

/** Lower-cased, unaccented, punctuation-trimmed - the form every pattern runs on. */
export function normalizeMessage(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * A keyword sent ON ITS OWN - the whole message is the word.
 *
 * This is the convention the channel runs on and the one an approved template's
 * footer instructs ("Reply STOP to opt out"), so honouring it is not optional:
 * a business whose template promises it and whose CRM ignores it is generating
 * spam reports, and on WhatsApp a spam report costs the quality rating that
 * gates every future template approval.
 *
 * These words are ONLY read as opt-outs when they stand alone. "cancel" inside
 * a sentence is almost always an appointment or an order.
 */
export const OPT_OUT_KEYWORDS: ReadonlySet<string> = new Set([
  "stop",
  "stopall",
  "unsubscribe",
  "optout",
  "opt out",
  "remove me",
  "no more messages",
  // Romanised Hindi/Hinglish, common in this market and unambiguous standing
  // alone: "band karo" (stop it), "mat bhejo" (don't send).
  "band karo",
  "band kijiye",
  "mat bhejo",
  "message mat bhejo",
]);

/**
 * The verb of cessation with its object attached.
 *
 * Each of these names the MESSAGING as the thing to stop. That is the entire
 * design: drop the object requirement and "stop" matches "stop the pain".
 */
const UNAMBIGUOUS_PHRASES: readonly RegExp[] = [
  // stop / quit / cease + sending / messaging / texting / contacting / calling
  /\b(stop|quit|cease)\s+(sending|messaging|texting|contacting|calling|whatsapping)\b/u,
  // stop sending me ... / don't send me any more ...
  /\b(stop|quit)\s+(these|the|your|all)?\s*(messages|msgs|texts|sms|whatsapps|notifications|promotions|ads|offers)\b/u,
  /\b(do ?n'?t|dont|never)\s+(send|message|text|contact|call|whatsapp)\s+me\b/u,
  // "no more messages/calls" - the object is what lifts this out of the
  // ambiguous tier, where a bare "no more" has to stay.
  /\bno\s+more\s+(messages|msgs|texts|sms|whatsapps|calls|notifications|promotions|ads|offers)\b/u,
  // "no longer wish to receive", "don't want to receive anything"
  /\b(do ?n'?t|dont|no longer|not)\s+(want|wish)\s+(to\s+)?(receive|get)\b/u,
  /\bnot\s+interested\s+in\s+(receiving|any\s+more|further)\b/u,
  // list removal, in the several ways people phrase it
  /\b(remove|delete|take)\s+(me|my (number|contact|details))\s+(from|off|out of)\b/u,
  /\b(unsubscribe|opt[\s-]?out)\s+(me\s+)?(from|of)\b/u,
  /\b(remove|delete)\s+me\s+from\s+(your|this|the)\s+(list|database|group|broadcast)\b/u,
  // the explicit request
  /\bstop\s+(all\s+)?(communication|correspondence)\b/u,
  /\b(band karo|band kijiye|mat bhejo)\b/u,
];

/**
 * The ambiguous half. A person decides what these mean.
 *
 * "leave me alone" is nearly always an opt-out and occasionally an exasperated
 * customer mid-complaint who very much wants a reply - from a human. Silencing
 * them permanently on a guess is the one outcome that cannot be undone by the
 * person who would have known the difference.
 */
const AMBIGUOUS_PHRASES: readonly RegExp[] = [
  /\bleave me alone\b/u,
  /\b(do ?n'?t|dont) (bother|disturb) me\b/u,
  /\bnot interested\b/u,
  // "why do you keep messaging ME" - the object is required for the same
  // reason it is required above: without it this matches "why do you send it
  // by courier?", which is a question about the business's own service.
  /\bwhy (do|are) you (keep |keeps |constantly |always )?(messag\w+|text\w+|send\w+|call\w+) me\b/u,
  /*
   * ANCHORED TO THE END OF THE MESSAGE, and the first draft of this file was
   * not - which the test file caught on "please stop by the shop tomorrow",
   * flagged as a probable opt-out by a bare `\bplease stop\b`.
   *
   * That is the clinic bug reappearing in the ambiguous tier, and it is worth
   * naming rather than quietly fixing: "stop", "this" and "enough" are only
   * about the CONVERSATION when they are the last thing in the message. Once
   * a sentence continues past them, the continuation is what they are about -
   * "stop by the shop", "stop this pain", "enough sugar", "no more delays".
   */
  /\b(please stop|stop please|stop now)\s*[.!?]*$/u,
  /\b(stop|quit) (it|this|that)\s*[.!?]*$/u,
  /\bno more\s*[.!?]*$/u,
  /^(that'?s |thats |ok |okay )?enough\s*[.!?]*$/u,
];

/** Strips the punctuation people put around a bare keyword: "STOP." / "Stop!" */
function bareWord(normalized: string): string {
  return normalized.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Unambiguous. This is the only level that may suppress outbound on its own.
 */
export function isOptOut(text: string): boolean {
  const normalized = normalizeMessage(text);
  if (!normalized) return false;
  if (OPT_OUT_KEYWORDS.has(bareWord(normalized))) return true;
  return UNAMBIGUOUS_PHRASES.some((rx) => rx.test(normalized));
}

/**
 * Unambiguous OR ambiguous. Hold outbound and put it in front of a person.
 *
 * Always true where `isOptOut` is true, so a caller can use this alone as the
 * "should the machine go quiet" question and reach for `isOptOut` only when
 * deciding whether the suppression may be recorded without asking anybody.
 */
export function isProbableOptOut(text: string): boolean {
  if (isOptOut(text)) return true;
  const normalized = normalizeMessage(text);
  if (!normalized) return false;
  return AMBIGUOUS_PHRASES.some((rx) => rx.test(normalized));
}

export type OptOutVerdict =
  | { level: "none" }
  /** Hold outbound; a person confirms. Nothing is recorded against the contact. */
  | { level: "probable" }
  /** Suppress outbound now; record it. Only a person can undo it. */
  | { level: "certain" };

/**
 * One call for the webhook path, so the two questions are asked in one place
 * and can never disagree about the same message.
 */
export function readOptOut(text: string): OptOutVerdict {
  if (isOptOut(text)) return { level: "certain" };
  if (isProbableOptOut(text)) return { level: "probable" };
  return { level: "none" };
}

/**
 * THE CHANNELS AN OPT-OUT CAN BE RECORDED ON - the twin of a database CHECK.
 *
 * `messaging_opt_outs.channel` (0111) is a text column with a CHECK, and
 * migration 0158 widens it by one value:
 *
 *     ALTER TABLE messaging_opt_outs DROP CONSTRAINT IF EXISTS messaging_opt_outs_channel_check;
 *     ALTER TABLE messaging_opt_outs ADD CONSTRAINT messaging_opt_outs_channel_check
 *       CHECK (channel IN ('whatsapp', 'sms', 'email', 'call'));
 *
 * 'call' is there because somebody who says "stop calling me" belongs on the
 * table that already models being left alone - with its two levels, its
 * `source_message_id` provenance and its release-by-update path - rather than
 * on a parallel list that would have to re-earn all three. Calling is a
 * channel, not a new concept.
 *
 * ── WHY THE SET IS SPELLED IN TYPESCRIPT AT ALL ─────────────────────────────
 *
 * It was not, until now: the ingest path inserts the channel it was handed and
 * nothing here named the permitted values. A CHECK and an implicit set of
 * strings drift, in both directions, and the failure is a bare 23514 from
 * Postgres that reads like a bug in whoever called the endpoint. That exact
 * thing has already happened on this codebase with `notifications.kind` - both
 * directions at once - and it silently broke lead routing. So the set is named,
 * and opt-out.test.ts pins it against the constraint twice over - once as a
 * transcribed literal and once read out of the migration itself, because those
 * two fail in opposite directions. Widening either side alone now fails the
 * suite instead of production.
 *
 * ── FOR A CALL OPT-OUT, peer_address IS THE NUMBER KEY ──────────────────────
 *
 * Not an E.164. The number vault (0157) holds the only copy of the number, and
 * a suppression list that stores numbers defeats the point of the vault. The
 * key is `sha256(phoneMatchDigits(n))`, the same value leads and calls join on.
 *
 * ── A LIVE BUG THIS CLOSES ──────────────────────────────────────────────────
 *
 * 'instagram' and 'facebook' are here to repair something that predates the
 * dialer entirely. `ConversationChannel` has both; `recordOptOut` in
 * conversations.service.ts inserts the inbound message's channel straight into
 * `messaging_opt_outs.channel` with no filtering; and 0111's CHECK allowed only
 * whatsapp/sms/email. So an Instagram or Messenger user typing "unsubscribe"
 * threw 23514 and their request to stop being contacted was never recorded.
 *
 * Dropping the request is the worst of the three options that were available.
 * The request is the same request whichever inbox it arrives in, and
 * `peer_address` has always been channel-relative - a number key for a call, an
 * address for email, a page-scoped id for these two - so there was never a
 * shape problem here, only a missing literal.
 *
 * This enum and 0158's CHECK therefore carry all six, and the test below
 * asserts `OptOutChannel` is now a strict superset of `ConversationChannel`.
 * That assertion is the thing to update if a seventh inbox channel is ever
 * added - a new `ConversationChannel` value with no matching CHECK literal
 * reintroduces exactly this bug, and it will read like a caller error.
 */
export const OptOutChannel = z.enum([
  "whatsapp",
  "sms",
  "email",
  "call",
  "instagram",
  "facebook",
]);
export type OptOutChannel = z.infer<typeof OptOutChannel>;
