/**
 * How many logged activities one composed timeline may hold (CRM dashboard
 * Phase 8) - the ceiling the interactions route enforces (limit max 200).
 *
 * It lives HERE, in the pure module, and not beside the loader that uses it:
 * `lib/crm-activity.ts` imports "server-only", so a Client Component reading a
 * value from it turns the whole page into a 500. Types from that module are
 * fine (erased at compile time); values are not.
 */
export const INTERACTION_LIMIT_MAX = 200;

/**
 * One person's history across every channel, as the 360° record reads it -
 * and, the part that matters most, WHO did each thing.
 *
 * ── WHY "WHO" IS THE HARD PART ──────────────────────────────────────────────
 *
 * A timeline that mixes "Logesh called Priya" with "a rule added a note" in the
 * same typeface teaches people to trust neither. The data already knows the
 * difference - it just says so in four different columns, depending on which
 * of six writers produced the row:
 *
 *   interactions.actor_user_id  a person logged it, or sent it from the console
 *   interactions.actor_label    'automation' = a rule (worker automation.ts);
 *                               otherwise a handset's telecaller on a call
 *                               (crm-projection.ts)
 *   interactions.connection_id  a synced mailbox or calendar (email-sync.ts,
 *                               calendar-sync.ts) - still a person's own mail
 *   conversation_messages       incoming = the contact; outgoing carries
 *                               sent_by_user_id (nothing automated sends -
 *                               Track A safety rule 3)
 *   deal_stage_transitions      source: console = a person; pipeline = the
 *                               call projection; automation = a rule;
 *                               backfill = reconstructed by a migration
 *
 * Everything below turns those into one `ActivityActor`, so the feed, the deal
 * drawer and the account page cannot each invent their own reading.
 *
 * ── THE THREE KINDS ─────────────────────────────────────────────────────────
 *
 *   human      a member of the team did it (made the call, wrote the note,
 *              moved the stage, sent the reply) - even if a machine RECORDED
 *              it. A handset recording a call does not make the call automated.
 *   automated  no person decided it at that moment: a rule, the AI projection
 *              of a call, a migration's reconstruction.
 *   contact    the customer did it: an inbound message or email.
 *
 * Pure and backend-agnostic: a tenant on another CRM maps its own rows into
 * `ActivityItem` in its own adapter (lib/crm-activity.ts) and every surface
 * here renders it unchanged.
 */

export type ActivityChannel = "call" | "email" | "sms" | "whatsapp" | "meeting" | "note" | "stage";
export type ActorKind = "human" | "automated" | "contact";

export interface ActivityActor {
  kind: ActorKind;
  /** Display name, or null when the record does not say. */
  name: string | null;
  /** How it reached the CRM, when that is worth a word: "recorded on a handset", "synced". */
  via: string | null;
}

export interface ActivityItem {
  /** Unique across sources: `${source}:${id}`. */
  key: string;
  channel: ActivityChannel;
  direction: "incoming" | "outgoing" | null;
  occurredAt: string;
  actor: ActivityActor;
  /** The one-line sentence: "Logesh logged a call", "Automation added a note". */
  summary: string;
  subject: string | null;
  body: string | null;
  durationS: number | null;
  dealId: string | null;
  dealName: string | null;
}

// ── raw shapes, as the Aura API returns them ────────────────────────────────

export interface InteractionRow {
  id: string;
  type: "call" | "email" | "sms" | "whatsapp" | "meeting" | "note";
  direction: "incoming" | "outgoing" | null;
  deal_id: string | null;
  call_id: string | null;
  subject: string | null;
  body: string | null;
  occurred_at: string;
  duration_s: number | null;
  actor_user_id: string | null;
  /** COALESCE(users.name, actor_label). */
  actor: string | null;
  actor_label?: string | null;
  connection_id?: string | null;
  /** `logged_by_hand` + `outcome` on a hand-logged call (@aura/shared HAND_LOGGED_CALL_METADATA). */
  metadata?: Record<string, unknown> | null;
}

/** How a hand-logged call went, in words. */
export const CALL_OUTCOME_LABEL: Record<string, string> = {
  connected: "connected",
  no_answer: "no answer",
  busy: "busy",
  voicemail: "left a voicemail",
  wrong_number: "wrong number",
};

export interface MessageRow {
  id: string;
  direction: "incoming" | "outgoing";
  channel: string;
  subject: string | null;
  body: string | null;
  sent_by_user_id: string | null;
  sent_by_name?: string | null;
  occurred_at: string;
}

export interface StageTransitionInput {
  id: string;
  from_stage: string | null;
  to_stage: string;
  source: "console" | "pipeline" | "automation" | "backfill";
  occurred_at: string;
  actor: string | null;
}

const NOUN: Record<Exclude<ActivityChannel, "stage">, string> = {
  call: "a call",
  email: "an email",
  sms: "a text message",
  whatsapp: "a WhatsApp message",
  meeting: "a meeting",
  note: "a note",
};

/** "Someone" for a person the record does not name - never an id, never blank. */
const who = (name: string | null | undefined, fallback: string) => name?.trim() || fallback;

export function interactionActor(row: InteractionRow, contactName: string | null): ActivityActor {
  if (row.actor_label === "automation") return { kind: "automated", name: "Automation", via: "rule" };

  if (row.type === "call" && row.metadata?.logged_by_hand === true) {
    // Typed in by the person who made it - a phone the platform does not
    // record. Human, and saying so, so it never passes for a recording.
    return { kind: "human", name: row.actor, via: "logged by hand - not a recording" };
  }

  if (row.type === "call") {
    // A person made or answered it; the handset only recorded it. Keyed on the
    // TYPE, not on call_id: the only writer of call rows is the recording
    // pipeline (a hand-logged call is a 400), and call_id is ON DELETE SET
    // NULL - once retention or erasure removes the recording, the row stays and
    // the telecaller who made the call must not turn into "Automated".
    return {
      kind: "human",
      name: row.actor,
      via: row.call_id ? "recorded on a handset" : "recording no longer kept",
    };
  }

  if (row.connection_id) {
    // A synced mailbox or calendar. Incoming mail is the customer writing.
    if (row.direction === "incoming") {
      return { kind: "contact", name: contactName, via: "synced from a mailbox" };
    }
    return { kind: "human", name: row.actor, via: row.type === "meeting" ? "synced from a calendar" : "synced" };
  }

  if (row.actor_user_id) return { kind: "human", name: row.actor, via: null };

  // No user, no rule label, no connection: written by the system with nothing
  // to attribute it to. Calling that a person would be the exact confusion this
  // module exists to prevent.
  return { kind: "automated", name: row.actor ?? "System", via: null };
}

export function interactionToActivity(
  row: InteractionRow,
  context: { contactName: string | null; dealNames?: Record<string, string> },
): ActivityItem {
  const actor = interactionActor(row, context.contactName);
  const noun = NOUN[row.type];
  let summary: string;
  if (actor.kind === "contact") {
    summary = `${who(actor.name, "The contact")} sent ${noun}`;
  } else if (actor.kind === "automated") {
    summary = `${who(actor.name, "Automation")} added ${noun}`;
  } else if (row.type === "call" && row.metadata?.logged_by_hand === true) {
    const outcome = CALL_OUTCOME_LABEL[String(row.metadata.outcome)] ?? null;
    summary = `${who(actor.name, "A teammate")} logged a call to ${who(context.contactName, "the contact")}${
      outcome ? ` - ${outcome}` : ""
    }`;
  } else if (row.type === "call") {
    const name = who(actor.name, "A teammate");
    summary =
      row.direction === "incoming"
        ? `${name} took a call from ${who(context.contactName, "the contact")}`
        : `${name} called ${who(context.contactName, "the contact")}`;
  } else if (row.connection_id || (row.type === "email" && row.direction === "outgoing")) {
    summary = `${who(actor.name, "A teammate")} ${row.type === "meeting" ? "scheduled" : "sent"} ${noun}`;
  } else {
    summary = `${who(actor.name, "A teammate")} logged ${noun}`;
  }

  return {
    key: `interaction:${row.id}`,
    channel: row.type,
    direction: row.direction,
    occurredAt: row.occurred_at,
    actor,
    summary,
    subject: row.subject,
    body: row.body,
    durationS: row.duration_s,
    dealId: row.deal_id,
    dealName: row.deal_id ? (context.dealNames?.[row.deal_id] ?? null) : null,
  };
}

export function messageToActivity(message: MessageRow, context: { contactName: string | null }): ActivityItem {
  const channel: ActivityChannel =
    message.channel === "whatsapp" || message.channel === "sms" || message.channel === "email"
      ? message.channel
      : "whatsapp";
  const noun = NOUN[channel];
  const incoming = message.direction === "incoming";
  const actor: ActivityActor = incoming
    ? { kind: "contact", name: context.contactName, via: null }
    : message.sent_by_user_id
      ? { kind: "human", name: message.sent_by_name ?? null, via: null }
      : // Outgoing with no sender recorded: still a person (nothing automated
        // sends), just not one the record names.
        { kind: "human", name: null, via: "sender not recorded" };

  return {
    key: `message:${message.id}`,
    channel,
    direction: message.direction,
    occurredAt: message.occurred_at,
    actor,
    summary: incoming
      ? `${who(actor.name, "The contact")} sent ${noun}`
      : `${who(actor.name, "A teammate")} replied with ${noun}`,
    subject: message.subject,
    body: message.body,
    durationS: null,
    dealId: null,
    dealName: null,
  };
}

export function transitionToActivity(
  row: StageTransitionInput,
  deal: { id: string; name: string },
  stageLabel: (key: string) => string,
): ActivityItem {
  const move =
    row.from_stage === null
      ? `into ${stageLabel(row.to_stage)}`
      : `from ${stageLabel(row.from_stage)} to ${stageLabel(row.to_stage)}`;

  let actor: ActivityActor;
  let summary: string;
  switch (row.source) {
    case "console":
      actor = { kind: "human", name: row.actor, via: null };
      summary = `${who(row.actor, "A teammate")} moved ${deal.name} ${move}`;
      break;
    case "automation":
      actor = { kind: "automated", name: "Automation", via: "rule" };
      summary = `Automation moved ${deal.name} ${move}`;
      break;
    case "pipeline":
      actor = { kind: "automated", name: "Call analysis", via: "from a recorded call" };
      summary = `Call analysis moved ${deal.name} ${move}`;
      break;
    default:
      actor = { kind: "automated", name: null, via: "reconstructed, not observed" };
      summary = `${deal.name} was ${row.from_stage === null ? "entered" : "moved"} ${move}`;
  }

  return {
    key: `stage:${row.id}`,
    channel: "stage",
    direction: null,
    occurredAt: row.occurred_at,
    actor,
    summary,
    subject: null,
    body: null,
    durationS: null,
    dealId: deal.id,
    dealName: deal.name,
  };
}

/** Newest first; ties keep their input order so a refresh never reshuffles equal timestamps. */
export function mergeActivity(...lists: ActivityItem[][]): ActivityItem[] {
  const seen = new Set<string>();
  return lists
    .flat()
    .map((item, index) => ({ item, index, at: Date.parse(item.occurredAt) || 0 }))
    .filter(({ item }) => (seen.has(item.key) ? false : (seen.add(item.key), true)))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map(({ item }) => item);
}
