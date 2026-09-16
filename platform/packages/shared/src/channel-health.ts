/**
 * WHAT STATE IS THIS WHATSAPP CHANNEL ACTUALLY IN.
 *
 * ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
 *
 * `messaging_channels.status` is a two-value operator switch - 'active' or
 * 'disabled' (migration 0056). It is NOT a health signal, and the console has
 * been rendering it as one: a channel created with a typo'd Hub API key, or
 * with `forward_secret` never entered, shows a chip reading "active" and looks
 * finished. Neither channel can carry a message. The first cannot send (Wasi
 * rejects the key); the second cannot receive (messaging-webhook.controller.ts
 * answers `signature verification failed` and drops every delivery, correctly
 * and silently).
 *
 * Nothing anywhere says so. The failure surfaces days later as "customers say
 * they replied and we never saw it".
 *
 * So readiness is DERIVED here, from measured facts, and the operator switch is
 * only one of them.
 *
 * ── WHY THE STATE IS COMPUTED AND NOT STORED ────────────────────────────────
 *
 * A stored readiness column would be a second truth that ages on its own -
 * authoritative-looking at exactly the moment it goes stale. The inputs are all
 * already on the row (`status`, `api_key`, `forward_secret`, the verification
 * columns added by migration 0099, `last_inbound_at`), and this is arithmetic
 * over them. The only thing worth storing is the RESULT OF A PROBE, which is a
 * measurement with a timestamp rather than a conclusion.
 *
 * ── THE SPLIT THAT MATTERS MOST ─────────────────────────────────────────────
 *
 * "We could not reach the provider" and "the provider answered and refused our
 * key" are not the same condition, and the fix for one does nothing for the
 * other. Collapsing them into a single "connection problem" is the failure
 * this module is shaped to prevent: the rejected-credential case needs somebody
 * to re-paste a key, and no amount of waiting or retrying will help, while the
 * unreachable case is frequently a blip that resolves itself.
 *
 * Adapted from DeskcommCRM (MIT, Rafael Melgaco) - `lib/channels/estado.ts` and
 * `lib/channels/health.ts`, where the distinction was learned the expensive way:
 * a rotated provider key took every channel down for three days behind a
 * warning that read "could not verify the connection", which is the phrasing
 * used for a network hiccup.
 */

/** What a probe against the provider found. Stored, because it is a measurement. */
export const CHANNEL_PROBE_OUTCOMES = [
  /** The provider answered and accepted our credentials. */
  "ok",
  /** The provider answered and refused them. 401/403. */
  "credentials_rejected",
  /** The provider answered, but not in a way we understand. Wrong host, a proxy, a 5xx. */
  "provider_error",
  /** No answer at all: DNS, timeout, connection refused. */
  "unreachable",
] as const;

export type ChannelProbeOutcome = (typeof CHANNEL_PROBE_OUTCOMES)[number];

export function isChannelProbeOutcome(v: unknown): v is ChannelProbeOutcome {
  return typeof v === "string" && (CHANNEL_PROBE_OUTCOMES as readonly string[]).includes(v);
}

/**
 * Everything the reading is computed from. All of it lives on the
 * `messaging_channels` row; nothing here requires a second query.
 */
export interface ChannelFacts {
  /** The operator switch. 'disabled' wins over everything else. */
  status: "active" | "disabled";
  /** An outbound credential is stored (never the value - only whether). */
  hasApiKey: boolean;
  /** The provider's webhook-signing secret is stored. Without it, inbound is dropped. */
  hasForwardSecret: boolean;
  /** When the last probe ran. Null means it has never been probed. */
  lastProbeAt: string | null;
  lastProbeOutcome: ChannelProbeOutcome | null;
  /** Free text from the last failing probe, for the person who has to fix it. */
  lastProbeDetail?: string | null;
  /** Last time a customer message arrived on this channel. */
  lastInboundAt: string | null;
}

/**
 * The vocabulary, closed by the type.
 *
 * `Record<ChannelReadiness, ...>` below is what forces the compiler to reject
 * the day somebody adds a state and forgets to write its sentence. The
 * alternative - a lookup with `?? status` on the end - is precisely how a raw
 * transport enum ends up on a customer's screen.
 */
export const CHANNEL_READINESS = [
  /** Proven in both directions. The only state where the number simply works. */
  "connected",
  /** Outbound proven, inbound cannot arrive: no forward secret. */
  "send_only",
  /** Credentials stored but never proven. Not a failure - an unknown. */
  "unverified",
  /** The provider refused our credentials. Somebody must re-enter one. */
  "credentials_rejected",
  /** The provider did not answer. Possibly nothing is wrong. */
  "unreachable",
  /** Set up incompletely - no outbound credential at all. */
  "incomplete",
  /** Switched off on purpose. */
  "disabled",
] as const;

export type ChannelReadiness = (typeof CHANNEL_READINESS)[number];

/**
 * Tones are @aura/ui `StatusChip` tones, and there are only four of them on
 * purpose. `danger` is the console's error orange (state.tsx: red means MISSED
 * and only missed), and it is spent ONLY on a state where the system is
 * currently failing at something - never on "not finished yet", which is a
 * category, and categories are grey.
 */
export type ChannelTone = "solid" | "muted" | "outline" | "danger";

export interface ChannelReading {
  readiness: ChannelReadiness;
  /** Short enough for a chip. Never the stored enum. */
  label: string;
  /** One sentence: what is true, and what it costs. */
  detail: string;
  tone: ChannelTone;
  /** Can a message leave through this channel right now? */
  canSend: boolean;
  /** Can a customer's reply arrive through it right now? */
  canReceive: boolean;
  /**
   * What a person should do next, or null when there is nothing to do. Separate
   * from `detail` because the console renders it as the button, and a sentence
   * that mixes diagnosis with instruction reads as neither.
   */
  action: string | null;
}

const READING: Record<ChannelReadiness, Omit<ChannelReading, "readiness">> = {
  connected: {
    label: "Connected",
    detail: "Messages send and customer replies arrive.",
    tone: "solid",
    canSend: true,
    canReceive: true,
    action: null,
  },
  send_only: {
    label: "Replies not arriving",
    // Stated as the consequence, not as the cause. "No forward secret" means
    // nothing to the owner; "their replies are being discarded" is the thing
    // they would want woken up for.
    detail:
      "This number can send, but customer replies are being discarded before they reach the inbox - the provider's forward secret has not been entered.",
    tone: "danger",
    canSend: true,
    canReceive: false,
    action: "Enter the forward secret",
  },
  unverified: {
    label: "Not checked yet",
    // NOT an error tone. Nothing has failed; nothing has been proven either,
    // and saying so plainly is better than a green chip that is a guess.
    detail: "The credentials are saved but have never been tried against the provider.",
    tone: "outline",
    canSend: true,
    canReceive: true,
    action: "Check this number now",
  },
  credentials_rejected: {
    label: "Key refused",
    detail:
      "The provider answered and refused the API key stored here. Nothing sends until it is replaced - retrying will not help.",
    tone: "danger",
    canSend: false,
    canReceive: true,
    action: "Re-enter the Hub API key",
  },
  unreachable: {
    label: "No answer",
    // Deliberately does NOT assert that the channel is down: we do not know
    // that, and a message that overstates its certainty gets ignored the third
    // time it is wrong.
    detail:
      "The provider did not answer the last check. That is often temporary, so this is not yet a failure - but nothing can be sent while it lasts.",
    tone: "muted",
    canSend: false,
    canReceive: true,
    action: "Check again",
  },
  incomplete: {
    label: "Not finished",
    detail: "This number has no API key, so it cannot send anything.",
    tone: "outline",
    canSend: false,
    canReceive: false,
    action: "Finish connecting this number",
  },
  disabled: {
    label: "Switched off",
    detail: "Turned off here. History is kept; nothing sends or arrives.",
    tone: "muted",
    canSend: false,
    canReceive: false,
    action: "Switch it back on",
  },
};

/**
 * The reading, in the order the questions actually matter.
 *
 * Disabled first because it is a decision somebody made and it overrides every
 * diagnosis - telling an owner their key was refused on a channel they
 * deliberately switched off is a true sentence answering no question.
 *
 * A rejected key beats a missing forward secret because it is the harder stop:
 * a send-only channel is half-working, a refused key is nothing working. The
 * console shows one chip, so the order here is what decides which problem the
 * owner is told about first.
 */
export function readChannel(facts: ChannelFacts): ChannelReading {
  const readiness = classify(facts);
  return { readiness, ...READING[readiness] };
}

function classify(facts: ChannelFacts): ChannelReadiness {
  if (facts.status === "disabled") return "disabled";
  if (!facts.hasApiKey) return "incomplete";

  switch (facts.lastProbeOutcome) {
    case "credentials_rejected":
      return "credentials_rejected";
    case "provider_error":
    case "unreachable":
      return "unreachable";
    case "ok":
      // The probe only ever proves the SEND half - it is an outbound call with
      // our key. Inbound is proven by a different fact entirely, and conflating
      // them is what let a send-only channel look finished.
      return facts.hasForwardSecret ? "connected" : "send_only";
    case null:
    case undefined:
      // Never probed. A missing forward secret is still worth saying, because
      // it is knowable without any network call at all.
      return facts.hasForwardSecret ? "unverified" : "send_only";
  }
}

/* ── Alerting ───────────────────────────────────────────────────────────────
 *
 * A state written on a settings page nobody has open is not a warning. The
 * reading above is what the page renders; this is what gets pushed at a person.
 */

export interface ChannelAlert {
  /** Feeds `notifications.kind`. */
  kind: "channel_needs_attention";
  severity: "warn" | "critical";
  title: string;
  body: string;
  /**
   * Collapses repeats of the SAME episode. `notify()` dedupes on
   * (user_id, dedupe_key), so a watchdog running every five minutes against an
   * unchanged fault writes one row, not 288 a day. Changing readiness changes
   * the key, which is what lets a genuine escalation through.
   */
  dedupeKey: string;
}

/**
 * Does this reading deserve to interrupt somebody? Null when it does not.
 *
 * `nickname` is in the title because an org with two numbers reads "WhatsApp
 * needs attention" and immediately asks "which one" - which is the whole
 * content of the alert for them.
 *
 * WHAT DELIBERATELY DOES NOT ALERT:
 *
 *   `unverified`  - nothing has failed. An alert here would fire on every
 *                   channel the moment it is created, which teaches people
 *                   that this alert means "ignore me".
 *   `incomplete`  - the person is mid-setup. The checklist already covers it.
 *   `disabled`    - they did that.
 *   `unreachable` - warns rather than criticals, for the same reason: a network
 *                   blip must not sound like an outage.
 */
export function channelAlert(reading: ChannelReading, nickname: string): ChannelAlert | null {
  switch (reading.readiness) {
    case "credentials_rejected":
      return {
        kind: "channel_needs_attention",
        severity: "critical",
        title: `WhatsApp "${nickname}": the provider refused the API key`,
        body: "Nothing sends from this number until the Hub API key is replaced. Waiting will not fix it - the provider answered, and its answer was no.",
        dedupeKey: `channel:${nickname}:credentials_rejected`,
      };
    case "send_only":
      return {
        kind: "channel_needs_attention",
        severity: "critical",
        title: `WhatsApp "${nickname}": customer replies are not arriving`,
        body: "Messages sent from this number are going out, but replies are being discarded before they reach the inbox. Enter the provider's forward secret to fix it.",
        dedupeKey: `channel:${nickname}:send_only`,
      };
    case "unreachable":
      return {
        kind: "channel_needs_attention",
        severity: "warn",
        title: `WhatsApp "${nickname}": the provider did not answer`,
        body: "The last check got no response. This is often temporary; if it persists, whoever runs the provider account needs to look.",
        dedupeKey: `channel:${nickname}:unreachable`,
      };
    case "connected":
    case "unverified":
    case "incomplete":
    case "disabled":
      return null;
  }
}

/**
 * A channel that was working and has now gone quiet for an unusually long time.
 *
 * Separate from the probe because the two catch different failures and neither
 * catches both: the probe asks the provider a question and therefore sees a
 * refused key within minutes, but it cannot see a WABA that is technically fine
 * and silently receiving nothing. Silence is the only signal for that, and
 * silence takes time to become evidence.
 *
 * `quietDays` is deliberately generous. A small business genuinely gets no
 * WhatsApp for three days over a long weekend, and a false alarm on a Tuesday
 * morning costs more than a day's delay in noticing a real one.
 */
export function channelHasGoneQuiet(
  facts: Pick<ChannelFacts, "status" | "lastInboundAt">,
  now: Date,
  quietDays = 7,
): boolean {
  if (facts.status !== "active") return false;
  // Never had a single inbound message: that is a channel that has not started,
  // not one that stopped. Nothing to compare against, and claiming it "went
  // quiet" would fire on every channel a week after it is created.
  if (!facts.lastInboundAt) return false;
  const last = new Date(facts.lastInboundAt).getTime();
  if (!Number.isFinite(last)) return false;
  return now.getTime() - last > quietDays * 24 * 60 * 60 * 1000;
}
