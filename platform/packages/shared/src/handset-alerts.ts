import { z } from "zod";

/**
 * Phone alerts (migration 0150): something put in front of a telecaller ON
 * THEIR HANDSET while the app is closed - a full-screen popup over the lock
 * screen, or a heads-up notification.
 *
 * ── WHY THIS IS NOT THE BELL ────────────────────────────────────────────────
 *
 * `notifications` (0048) reaches a person signed in to the console, and its
 * header keeps it that way on purpose. Most telecallers never sign in: they
 * carry a paired phone and nothing else, so a bell item addressed to them is
 * addressed to nobody (lead routing silently skips them for exactly that
 * reason). This table is keyed on the TELECALLER, which is what a handset is
 * bound to, so it reaches the people the bell cannot.
 *
 * It still reaches nobody outside the business: every row is addressed to a
 * telecaller of the org and is only ever readable by a device bound to them.
 *
 * ── THE PUSH CARRIES NO CONTENT ─────────────────────────────────────────────
 *
 * FCM wakes the phone with `{ action: "alert" }` and nothing else; the phone
 * then fetches the text from our own API. A lead's name in a push payload
 * would pass through Google, and the payload limit would decide how much of a
 * manager's message survives. Fetching also gives the console its delivery
 * receipt: an alert is "delivered" when a phone collected it, not when FCM
 * said it accepted the push - the 2026-09-21 wake test had FCM accept a push
 * that a sleeping Samsung never saw.
 */

export const HandsetAlertKind = z.enum([
  /** A lead was given to this telecaller (routing, a manager, an import). */
  "lead_assigned",
  /** Somebody in the console gave this telecaller's login a task. */
  "task_assigned",
  /** A follow-up with a time (`tasks.due_at`) has reached it. */
  "followup_due",
  /** Their lead rang a DIFFERENT phone and nobody answered. */
  "missed_callback",
  /** An owner or manager typed it on the Phones page. */
  "manager_message",
  /**
   * A call was escalated to this person (migration 0151, doc 38). Only reaches
   * a recipient who is also a telecaller with a phone - a senior on the floor,
   * a manager who takes calls. They answer it in the console.
   */
  "escalation_received",
  /** An escalation this telecaller raised was answered. */
  "escalation_update",
  /**
   * A CALLBACK THEY PROMISED IS DUE NOW (§10A.4, migrations 0186/0187).
   *
   * NOT `missed_callback` above, which is 0134's "their lead rang a DIFFERENT
   * phone and nobody answered". This one is "you told this customer you would
   * ring them at five, and it is five".
   */
  "callback_due",
  /**
   * A callback they missed has been escalated, and somebody senior now knows.
   * Reaches the telecaller, so the first they hear of it is not their manager.
   */
  "callback_escalated",
]);
export type HandsetAlertKind = z.infer<typeof HandsetAlertKind>;

/**
 * `popup`: full-screen over the lock screen, wakes the display.
 * `notify`: heads-up banner and sound, then the shade.
 */
export const HandsetAlertStyle = z.enum(["popup", "notify"]);
export type HandsetAlertStyle = z.infer<typeof HandsetAlertStyle>;

/**
 * Mixed on purpose (the user's choice, 2026-10-01): only what cannot wait
 * takes over the screen. A popup for every task would train people to dismiss
 * popups unread, and then the one about a hot lead goes the same way.
 * A manager may send a message as `notify` instead; nothing else is a choice.
 */
export const HANDSET_ALERT_STYLE: Record<HandsetAlertKind, HandsetAlertStyle> = {
  lead_assigned: "popup",
  manager_message: "popup",
  task_assigned: "notify",
  followup_due: "notify",
  missed_callback: "notify",
  // A customer may still be waiting on the other end of an escalation, and the
  // answer to one is a manager's instruction - the manager_message case.
  escalation_received: "popup",
  escalation_update: "popup",
  // Both POPUP, and both a deliberate departure from the rule above that only
  // what cannot wait takes over the screen:
  //
  //   · a callback at 17:00 IS the thing that cannot wait. It is the one alert
  //     in this product where five minutes late is a broken promise.
  //   · an escalation means somebody senior is now waiting on this person
  //     about a customer who has already been let down once.
  //
  // `followup_due` stays `notify`, which is the right contrast: a follow-up has
  // a day, a callback has a minute.
  callback_due: "popup",
  callback_escalated: "popup",
};

/**
 * How long an alert is worth delivering. A phone that was off all day should
 * not wake up to "follow-up due now" from the morning: past this, the alert is
 * left undelivered and the console says the phone was not reached.
 */
export const HANDSET_ALERT_TTL_MINUTES: Record<HandsetAlertKind, number> = {
  lead_assigned: 24 * 60,
  manager_message: 24 * 60,
  task_assigned: 24 * 60,
  followup_due: 2 * 60,
  missed_callback: 12 * 60,
  escalation_received: 12 * 60,
  escalation_update: 24 * 60,
  // SHORTER than `followup_due`'s two hours, and that is the point. A popup
  // saying "ring this customer now" that arrives three hours late is actively
  // misleading - the telecaller rings at 20:00 about a 17:00 promise with no
  // idea they are late. Past the window the alert is dropped and the callback
  // is handled by the escalation ladder instead, which is the path designed for
  // "this did not happen".
  callback_due: 90,
  callback_escalated: 12 * 60,
};

/**
 * How far back the sweep looks for a new assignment, a due time or a missed
 * call. Wide enough to survive a worker restart; narrow enough that a deploy
 * does not pop up a morning's worth of old assignments. The dedupe key, not
 * this window, is what stops a repeat.
 */
export const HANDSET_ALERT_LOOKBACK_MINUTES = 15;

/**
 * Missed calls get longer: a missed call is linked to its lead by a later
 * sweep (call-lead-link.ts), so it may only become visible here some minutes
 * after it was created.
 */
export const HANDSET_MISSED_CALL_LOOKBACK_MINUTES = 60;

/** Pushes per alert before the sweep stops trying. The phone's hourly poll still collects it. */
export const HANDSET_ALERT_MAX_PUSHES = 12;

/**
 * Seconds to wait before the next push, after `attempts` pushes so far.
 *
 * Fast at first - a phone that missed the first push because it was changing
 * networks should not wait half an hour - then backing off, because a phone
 * in Samsung's deep sleep will not wake for the tenth push either.
 */
export function nextPushDelaySeconds(attempts: number): number {
  const ladder = [60, 120, 300, 600, 900];
  if (attempts < 1) return 0;
  return ladder[attempts - 1] ?? 1800;
}

/**
 * The first Android build that understands the `alert` push (1.2.1).
 *
 * Older apps log the action as unknown and never ack, so pushing to them only
 * wakes a phone up to HANDSET_ALERT_MAX_PUSHES times per alert for nothing.
 * A phone that never reported a version (`devices.app_version` NULL, which is
 * the whole fleet as of 2026-09-21) counts as able - the same rule attendance
 * uses - because guessing "too old" would silence a phone that can show it.
 */
export const HANDSET_ALERTS_MIN_VERSION_CODE = 11;

/**
 * SQL predicate: device `alias` is not KNOWN to be older than the first build
 * with phone alerts. The CASE guards the cast - `app_version` is free text the
 * update check writes, and a junk value must read as unknown, not throw.
 */
export function deviceUnderstandsAlertsSql(alias: string): string {
  return `COALESCE(CASE WHEN ${alias}.app_version ~ '^[0-9]{1,9}$' THEN ${alias}.app_version::int END, ${HANDSET_ALERTS_MIN_VERSION_CODE}) >= ${HANDSET_ALERTS_MIN_VERSION_CODE}`;
}

/** Days a row is kept, delivered or not - the console's sent list reads back this far. */
export const HANDSET_ALERT_RETENTION_DAYS = 30;

/** A manager's message to one, several or every telecaller with a phone. */
export const SendHandsetMessageInput = z
  .object({
    everyone: z.boolean().default(false),
    telecallerIds: z.array(z.string().uuid()).max(500).default([]),
    title: z.string().trim().max(80).optional(),
    body: z.string().trim().min(1, "Write a message").max(500),
    /** false = a heads-up notification rather than a full-screen popup. */
    popup: z.boolean().default(true),
  })
  .refine((v) => v.everyone || v.telecallerIds.length > 0, {
    message: "Choose who to send it to",
    path: ["telecallerIds"],
  });
export type SendHandsetMessageInput = z.infer<typeof SendHandsetMessageInput>;

/** The phone reporting what it did with the alerts it fetched. */
export const HandsetAlertAckInput = z.object({
  /** Shown on the phone (a popup or a notification was posted). */
  delivered: z.array(z.string().uuid()).max(200).default([]),
  /** The person tapped it or pressed "Got it". Implies delivered. */
  opened: z.array(z.string().uuid()).max(200).default([]),
});
export type HandsetAlertAckInput = z.infer<typeof HandsetAlertAckInput>;

/** One alert as the phone receives it. */
export interface DeviceHandsetAlert {
  id: string;
  kind: HandsetAlertKind;
  style: HandsetAlertStyle;
  title: string;
  body: string | null;
  createdAt: string;
  /** The manager's name on a manager message; null for everything a machine raised. */
  sentBy: string | null;
}

/**
 * What the console says about one recipient of a message.
 *
 *  - `read`: they tapped it or pressed "Got it".
 *  - `delivered`: it is on their phone.
 *  - `sending`: not collected yet, still inside its lifetime and being pushed.
 *  - `not_reached`: its lifetime ran out first - the phone was off, offline,
 *    or asleep in a way no push could wake.
 *  - `no_phone`: the telecaller has no active paired phone, so nothing can
 *    collect it.
 */
export type HandsetAlertDelivery = "read" | "delivered" | "sending" | "not_reached" | "no_phone";

export function handsetAlertDelivery(
  row: { deliveredAt: string | null; openedAt: string | null; expiresAt: string; hasPhone: boolean },
  now: number = Date.now(),
): HandsetAlertDelivery {
  if (row.openedAt) return "read";
  if (row.deliveredAt) return "delivered";
  if (!row.hasPhone) return "no_phone";
  if (Date.parse(row.expiresAt) <= now) return "not_reached";
  return "sending";
}

/** Words for `leads.source_channel`, for the "New lead" popup. Unknown values read as nothing. */
export const LEAD_SOURCE_WORDS: Record<string, string> = {
  call: "a phone call",
  missed_call: "a missed call",
  web_form: "a web form",
  email: "an email",
  telephony: "the phone line",
  meta_ads: "a Meta ad",
  linkedin_ads: "a LinkedIn ad",
  api: "the API",
  import: "an import",
  manual: "added by hand",
  whatsapp: "WhatsApp",
  sheets: "a Google Sheet",
};

/**
 * The "New lead" popup's body: who, and where they came from.
 * `title` is the lead's display title, which is already the name or the
 * masked number - the platform keeps no customer number in clear, so a
 * masked one is all the phone can show.
 */
export function leadAlertBody(title: string, sourceChannel: string | null): string {
  const from = sourceChannel ? LEAD_SOURCE_WORDS[sourceChannel] : undefined;
  return from ? `${title} · from ${from}` : title;
}
