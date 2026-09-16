/**
 * THE 24-HOUR WINDOW, FROM THE SIDE OF THE PERSON TYPING.
 *
 * ── WHAT IS MISSING TODAY ───────────────────────────────────────────────────
 *
 * The rule is real and hard: on WhatsApp through a Business Solution Provider,
 * free text only leaves while the customer has written within the last 24
 * hours. Outside that, only an approved template goes out, and Meta refuses the
 * rest with error 131047.
 *
 * Wasi enforces this correctly on its own side and answers Aura with
 * `session_window_closed` (wasi.ts). That is the right place for the rule to
 * LIVE - it is the BSP, it holds the WABA - but it means today the only way a
 * telecaller discovers the window closed is by writing a reply and watching it
 * fail. They do not learn that twenty minutes were left; they learn it after.
 *
 * This module is the same arithmetic, run locally, purely so the console can
 * say it BEFORE the message is typed. It never authorises a send: Wasi still
 * decides, and a disagreement between the two is resolved in Wasi's favour by
 * construction, because Aura's copy is advisory and Wasi's is enforcement.
 *
 * ── WHY NOTHING IS STORED ───────────────────────────────────────────────────
 *
 * There is no `window_expires_at` column and there must not be one. The window
 * is a subtraction over `conversations.last_inbound_at`, which the inbox
 * already selects. A stored expiry would be a second truth that goes wrong on
 * its own and looks authoritative while doing it - and it would go wrong in the
 * worst direction, telling somebody the window is open after it has shut.
 *
 * Adapted from DeskcommCRM (MIT, Rafael Melgaco), `lib/channels/janela.ts`.
 */

/** Meta's session window. Not configurable, so not a setting. */
export const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Close enough to closing that it changes what a person does.
 *
 * Two hours because that is the horizon in which somebody can still ACT - ask
 * the question, confirm the appointment - without building a template. Warning
 * at twenty hours left is noise; warning at five minutes left arrives after the
 * decision has been made.
 */
export const WINDOW_URGENT_MS = 2 * 60 * 60 * 1000;

export type MessagingWindow =
  /** This channel has no window rule. There is no clock to show. */
  | { kind: "unrestricted" }
  /** Free text goes out. `remainingMs` is how long that stays true. */
  | { kind: "open"; remainingMs: number; urgent: boolean }
  /**
   * Only an approved template leaves.
   *
   * `closedForMs` is how long ago it SHUT - not when the customer last wrote.
   * The two differ by exactly 24 hours, and the question an operator actually
   * asks is "how far past am I", because that is what decides whether a
   * template is still worth sending. `null` when the customer has never
   * written: no window ever opened, and inventing an elapsed time would be
   * describing a deadline that never ran.
   */
  | { kind: "closed"; closedForMs: number | null };

/**
 * Which channels carry the rule.
 *
 * Keyed on the channel and the provider together, because it is the PROVIDER's
 * restriction, not the medium's: WhatsApp through Meta's graph has the window,
 * and so does anyone reselling it. A relay that bridges a personal handset does
 * not, because there is no Business API in the path.
 *
 * An unknown provider is treated as UNRESTRICTED rather than as restricted.
 * Both defaults are wrong sometimes and the failure modes are not symmetric: a
 * false "closed" puts a countdown and a warning on a conversation that has
 * neither, and trains people to ignore the badge that matters; a false "open"
 * costs one rejected send with a clear reason from Wasi, which the composer
 * already surfaces.
 */
const WINDOWED_PROVIDERS = new Set(["wasi", "meta_cloud"]);

export function channelHasWindow(channel: string, provider: string | null | undefined): boolean {
  if (channel !== "whatsapp") return false;
  return WINDOWED_PROVIDERS.has((provider ?? "").toLowerCase());
}

/**
 * The state of this conversation's window, now.
 *
 * `now` is passed rather than read, because a clock read inside a pure function
 * is a test that can only be written by moving the system clock.
 */
export function messagingWindow(
  channel: string,
  provider: string | null | undefined,
  lastInboundAt: string | Date | null | undefined,
  now: Date,
): MessagingWindow {
  if (!channelHasWindow(channel, provider)) return { kind: "unrestricted" };
  if (!lastInboundAt) return { kind: "closed", closedForMs: null };

  const last = lastInboundAt instanceof Date ? lastInboundAt : new Date(lastInboundAt);
  const lastMs = last.getTime();
  // An unparseable timestamp is not evidence of anything. Reporting "closed"
  // from a parse failure would block the composer over a data bug.
  if (!Number.isFinite(lastMs)) return { kind: "unrestricted" };

  const remainingMs = lastMs + WINDOW_MS - now.getTime();
  if (remainingMs > 0) {
    return { kind: "open", remainingMs, urgent: remainingMs <= WINDOW_URGENT_MS };
  }
  return { kind: "closed", closedForMs: Math.max(0, -remainingMs) };
}

/**
 * "23h 40m", "40m", "3m".
 *
 * No seconds. A number that ticks on screen pulls the eye to the clock instead
 * of the conversation, and the decision it supports - write now, or build a
 * template - does not turn on thirty seconds.
 *
 * Under a minute reads "less than 1m" and never "0m", which looks like closed
 * when it is not.
 */
export function formatRemaining(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return "less than 1m";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * "3d", "5h", "20m" - how long ago it shut.
 *
 * One unit, unlike the remaining time. Here the number supports no fine
 * decision (it has closed; the way out is the same either way), so "2d 7h 13m"
 * would demand reading to say what "2d" already says. In the remaining time the
 * minutes DO matter, because they decide between typing and templating.
 */
export function formatElapsed(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * The one line the composer puts above the text box, or null when there is
 * nothing worth saying.
 *
 * Null for `unrestricted` AND for a window with plenty of time left: a
 * permanent banner reading "22h 14m remaining" on every open conversation is
 * decoration, and decoration is what people stop seeing before the day the
 * banner has something to tell them.
 */
export function windowNotice(w: MessagingWindow): string | null {
  switch (w.kind) {
    case "unrestricted":
      return null;
    case "open":
      return w.urgent
        ? `${formatRemaining(w.remainingMs)} left to reply in your own words. After that only an approved template can go out.`
        : null;
    case "closed":
      return w.closedForMs === null
        ? "This customer has never written to you, so only an approved template can be sent."
        : `The reply window closed ${formatElapsed(w.closedForMs)} ago. Only an approved template can be sent now.`;
  }
}
