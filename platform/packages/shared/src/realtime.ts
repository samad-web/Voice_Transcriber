/**
 * The change-signal vocabulary shared by the API, the worker and the console.
 *
 * ── WHAT AN EVENT IS, AND WHAT IT DELIBERATELY IS NOT ─────────────────────
 *
 * An event says "something of kind X changed in org Y". It carries NO row
 * content - no name, no number, no value, not even a status.
 *
 * That is the whole security argument for this feature. The console's record
 * scoping lives in SQL (owner-scope.ts intersected with crm-scope.ts), and a
 * telecaller's payload is narrowed before it ever leaves the API. A push
 * channel carrying rows would need a second copy of that intersection, written
 * at every emit site, and the second copy is the one that drifts - a manager's
 * deal value arriving in a telecaller's browser is not a rendering bug, it is a
 * disclosure. So the signal carries an id at most, and the browser re-reads
 * through the same authorised path it already uses. Re-fetching costs a round
 * trip; getting the scope wrong costs a customer.
 *
 * ── TOPICS ARE OPEN, NOT AN ENUM ──────────────────────────────────────────
 *
 * `RealtimeTopic` accepts any string. `topicForApiPath` derives one from the
 * route that changed, so a controller added next month emits a sensible topic
 * with nobody having to remember this file exists. A closed enum would fail the
 * other way: the new route emits nothing, its page silently stops updating, and
 * the symptom (stale numbers, no error) is the hardest kind to notice.
 *
 * `KNOWN_TOPICS` exists for the subscriber's benefit - autocomplete and a
 * spelling check on the topics that exist today - without closing the set.
 */

/** The topics emitted today. Not exhaustive: see the header. */
export const KNOWN_TOPICS = [
  "account",
  "agent",
  "apikey",
  "automation",
  "call",
  "campaign",
  "connection",
  "contact",
  "conversation",
  "deal",
  "device",
  "duplicate",
  "import",
  "interaction",
  "invoice",
  "lead",
  "member",
  "message",
  "notification",
  "org",
  "pipeline",
  "product",
  "project",
  "quotation",
  "report",
  "role",
  "sop",
  "tag",
  "target",
  "task",
] as const;

export type KnownTopic = (typeof KNOWN_TOPICS)[number];

/**
 * A change topic. Known values get autocomplete; any other string is still
 * valid, which is what keeps a new controller from going silent.
 */
export type RealtimeTopic = KnownTopic | (string & {});

export type RealtimeAction = "created" | "updated" | "deleted" | "changed";

export interface RealtimeEvent {
  /** The tenant this happened in. The only routing key that matters. */
  orgId: string;
  topic: RealtimeTopic;
  action: RealtimeAction;
  /** The record's id when the emitter knows it. Never required. */
  id?: string | null;
  /** ISO timestamp, set by the emitter. */
  at: string;
}

/**
 * An event as the console receives it. `seq` is assigned by the web tier's
 * fanout, monotonically per process, and is what the polling fallback and a
 * reconnecting stream use to ask "what did I miss".
 */
export interface SequencedRealtimeEvent extends RealtimeEvent {
  seq: number;
}

/**
 * How often an idle stream must emit something. Below every proxy read timeout
 * in front of this system (nginx 300s, Caddy's default) with room to spare, so
 * a quiet tenant's connection is never mistaken for a dead one.
 */
export const REALTIME_HEARTBEAT_MS = 20_000;

/**
 * Route namespaces that are console/area prefixes rather than entities.
 * `/v1/owner/calls` and `/v1/calls` are the same subject seen by two audiences.
 */
const AREA_PREFIXES = new Set(["owner", "admin", "public", "v1"]);

/**
 * Routes whose mutations must NOT become events.
 *
 * Two reasons only, and both are about noise rather than secrecy:
 *
 *   - the handset fleet talks to `app` and `devices/me` constantly (update
 *     checks, nonces, heartbeats) and none of it changes anything a console
 *     is displaying; and
 *   - `auth` mints and refreshes sessions, which every open tab does on its
 *     own schedule - an event there would have every console in the tenant
 *     re-rendering because somebody's cookie rotated.
 */
const SILENT_PREFIXES = ["app", "auth", "devices/me", "health"];

/**
 * Where a route's natural first segment is not the subject anybody is
 * watching. Keyed on the path as it appears after the area prefix is dropped.
 */
const TOPIC_ALIASES: Record<string, RealtimeTopic> = {
  "call-integrity-flags": "call",
  "conversation-qualifications": "conversation",
  // A web form, an inbound email or a CTI pop. All of them exist to produce a
  // lead, and the lead board is what somebody is actually watching.
  intake: "lead",
  "marketing-sources": "campaign",
  members: "member",
  "messaging/webhook": "message",
  "messaging/channels": "connection",
  // The distribution backfill (0105) reassigns leads in bulk, so the board and
  // the leads list are what somebody is watching - not the rules page they
  // pressed the button on. Deliberately the TWO-segment key: editing a rule
  // changes no lead, and aliasing the whole controller would wake every open
  // board in the tenant every time somebody renamed a rule.
  "lead-routing/backfill": "lead",
  // Meta's webhook delivers lead-ad submissions.
  "meta/webhook": "lead",
  "meta/oauth": "connection",
  "webhooks/razorpay": "invoice",
  workspaces: "org",
};

/** `accounts` → `account`, `companies` → `company`, `mcp` → `mcp`. */
function singular(segment: string): string {
  if (segment.endsWith("ies")) return `${segment.slice(0, -3)}y`;
  if (segment.endsWith("ss")) return segment;
  if (segment.endsWith("s")) return segment.slice(0, -1);
  return segment;
}

/**
 * The topic a mutating request to `path` should announce, or null when that
 * route is deliberately silent.
 *
 * Accepts the path with or without the `/v1` global prefix, with or without a
 * query string - it is called from an interceptor that sees `req.path` and from
 * tests that pass the URL a human would write.
 */
export function topicForApiPath(path: string): RealtimeTopic | null {
  const clean = path.split("?")[0].replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
  if (clean === "") return null;

  const segments = clean.split("/").filter(Boolean);
  // `/v1/owner/calls/:id` → ["calls", ":id"]. Drop area prefixes only while
  // something is left after them, so `/v1/owner` itself still has a subject.
  let i = 0;
  while (i < segments.length - 1 && AREA_PREFIXES.has(segments[i])) i += 1;
  const rest = segments.slice(i);

  const joined = rest.join("/");
  if (SILENT_PREFIXES.some((p) => joined === p || joined.startsWith(`${p}/`))) return null;

  // Aliases are matched longest-first: `messaging/webhook` must win over
  // `messaging` before the generic singularisation gets a look in.
  const twoSegments = rest.slice(0, 2).join("/");
  if (TOPIC_ALIASES[twoSegments]) return TOPIC_ALIASES[twoSegments];
  if (TOPIC_ALIASES[rest[0]]) return TOPIC_ALIASES[rest[0]];

  return singular(rest[0]);
}

/**
 * The action a verb implies. Coarse on purpose: subscribers branch on the
 * topic, and nothing in the console needs to tell a PUT from a PATCH.
 */
export function actionForMethod(method: string): RealtimeAction {
  switch (method.toUpperCase()) {
    case "POST":
      return "created";
    case "DELETE":
      return "deleted";
    case "PUT":
    case "PATCH":
      return "updated";
    default:
      return "changed";
  }
}
