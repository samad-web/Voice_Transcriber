import "server-only";
import type { RealtimeEvent, SequencedRealtimeEvent } from "@aura/shared";
import { ADMIN_KEY, API_URL } from "@/lib/server-api";

/**
 * ONE connection to the API's change stream, fanned out to every open console.
 *
 * ── WHY THE WEB TIER AND NOT THE BROWSER ──────────────────────────────────
 *
 * Nothing in the browser can talk to the platform API: the console is server
 * rendered and calls it with ADMIN_API_KEY, a cross-tenant root credential
 * (lib/server-api.ts). So the browser's stream has to be served from here,
 * where the Supabase session is readable and the org can be resolved from it
 * rather than from anything the client could set.
 *
 * That leaves this module holding exactly one upstream connection however many
 * consoles are open, which is the arrangement worth having anyway: the API sees
 * one subscriber, and the per-session filtering happens once, in the only tier
 * that knows who is signed in.
 *
 * ── THE RING BUFFER IS THE CATCH-UP STORY ─────────────────────────────────
 *
 * Every event gets a sequence number as it arrives. A browser that reconnects
 * sends the last one it saw back as `Last-Event-ID` (EventSource does this by
 * itself), and a browser that cannot hold a stream at all polls with the same
 * cursor. Both then get exactly what they missed instead of a blind refresh -
 * which matters because the blind refresh is what a laptop waking from sleep
 * would otherwise do to every tenant at once.
 *
 * The buffer is deliberately small and in memory. Its job is to cover a
 * reconnect measured in seconds; a browser away for longer is told to resync
 * wholesale, which is correct and cheap.
 */

const RING_SIZE = 500;

/** Reconnect backoff for the upstream. Capped: the API comes back. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

export type Listener = (event: SequencedRealtimeEvent) => void;

export type UpstreamStatus = "connecting" | "live" | "down";

interface Hub {
  listeners: Set<{ orgId: string; fn: Listener }>;
  ring: SequencedRealtimeEvent[];
  seq: number;
  status: UpstreamStatus;
  started: boolean;
  reconnectMs: number;
}

/**
 * Held on `globalThis` rather than in a module-level `let`.
 *
 * Next's dev server re-evaluates modules on every edit, and a per-module
 * singleton would leak one upstream connection per hot reload - each still
 * consuming, each still filling its own ring. In production it is simply one
 * object; in development it is the difference between one connection and forty.
 */
const KEY = Symbol.for("aura.realtime.hub");
const store = globalThis as unknown as { [KEY]?: Hub };

function hub(): Hub {
  const existing = store[KEY];
  if (existing) return existing;
  const created: Hub = {
    listeners: new Set(),
    ring: [],
    seq: 0,
    status: "connecting",
    started: false,
    reconnectMs: RECONNECT_MIN_MS,
  };
  store[KEY] = created;
  return created;
}

/** The wildcard org: the operator console, which legitimately watches them all. */
export const ALL_ORGS = "*";

/**
 * Listen for changes in one tenant, or in every tenant with `ALL_ORGS`.
 *
 * Returns the unsubscribe, which callers MUST run when their stream closes - a
 * leaked listener is a leaked reference to a response nobody is reading.
 */
export function subscribe(orgId: string, fn: Listener): () => void {
  const h = hub();
  const entry = { orgId, fn };
  h.listeners.add(entry);
  start();
  return () => {
    h.listeners.delete(entry);
  };
}

/** Everything after `cursor` that this process still holds, oldest first. */
export function eventsSince(orgId: string, cursor: number): SequencedRealtimeEvent[] {
  return hub().ring.filter(
    (event) => event.seq > cursor && (orgId === ALL_ORGS || event.orgId === orgId),
  );
}

/** The newest sequence number issued. A client with no cursor starts here. */
export function currentSeq(): number {
  return hub().seq;
}

export function upstreamStatus(): UpstreamStatus {
  return hub().status;
}

/**
 * Whether this process still holds everything after `cursor`.
 *
 * False means the client has been away longer than the ring, so the events it
 * missed are gone and the honest answer is "re-read everything" rather than a
 * partial list that looks complete.
 */
export function canServeFrom(cursor: number): boolean {
  const h = hub();
  if (h.ring.length === 0) return cursor <= h.seq;
  return cursor >= h.ring[0].seq - 1;
}

function emit(event: RealtimeEvent): void {
  const h = hub();
  h.seq += 1;
  const sequenced: SequencedRealtimeEvent = { ...event, seq: h.seq };
  h.ring.push(sequenced);
  if (h.ring.length > RING_SIZE) h.ring.splice(0, h.ring.length - RING_SIZE);

  for (const { orgId, fn } of h.listeners) {
    // A wildcard on either side matches: an operator listening to everything,
    // and the synthetic resync below, which is addressed to everyone.
    if (orgId !== ALL_ORGS && event.orgId !== ALL_ORGS && event.orgId !== orgId) continue;
    try {
      fn(sequenced);
    } catch {
      // One console's dead writer must not stop the others being told.
    }
  }
}

/**
 * Tell every console to re-read from scratch.
 *
 * Published after the upstream reconnects. The browsers never noticed the gap -
 * their own connections to THIS process stayed up throughout - so without this
 * they would sit on stale data believing they were live, which is worse than
 * knowing they are offline.
 */
function resync(): void {
  emit({ orgId: ALL_ORGS, topic: "*", action: "changed", at: new Date().toISOString() });
}

function start(): void {
  const h = hub();
  if (h.started) return;
  h.started = true;
  void run();
}

async function run(): Promise<void> {
  const h = hub();

  for (;;) {
    const controller = new AbortController();
    let connected = false;

    try {
      h.status = "connecting";
      const res = await fetch(`${API_URL}/v1/internal/events`, {
        headers: { "x-admin-key": ADMIN_KEY, accept: "text/event-stream" },
        signal: controller.signal,
        cache: "no-store",
      });

      if (!res.ok || !res.body) throw new Error(`upstream answered ${res.status}`);

      connected = true;
      h.status = "live";
      // Not on the first connect: there was nothing to miss. Only a RE-connect
      // implies a gap, and a backoff above its floor is how we know this is one.
      if (h.reconnectMs > RECONNECT_MIN_MS) resync();
      h.reconnectMs = RECONNECT_MIN_MS;

      await readStream(res.body);
      throw new Error("upstream closed the stream");
    } catch (err) {
      h.status = "down";
      controller.abort();
      if (connected) {
        console.warn("[realtime] upstream dropped; reconnecting:", err);
      } else {
        // Quieter than an error: a cold start where the API is still booting
        // hits this once or twice on every deploy and is not a fault.
        console.warn(`[realtime] upstream unavailable (${String(err)}); retrying`);
      }
      await sleep(h.reconnectMs);
      h.reconnectMs = Math.min(h.reconnectMs * 2, RECONNECT_MAX_MS);
    }
  }
}

/**
 * Parse the SSE framing the API sends.
 *
 * Written out rather than pulled from a library because the shape is four lines
 * of protocol and the alternative is a new dependency in the tier that holds
 * the admin key. Frames are separated by a blank line; `data:` accumulates.
 */
async function readStream(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });

    // A blank line ends a frame. CRLF too, because a proxy may rewrite endings.
    for (;;) {
      const match = /\r?\n\r?\n/.exec(buffer);
      if (!match) break;
      const frame = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      handleFrame(frame);
    }

    // A frame that never terminates is a stuck or hostile upstream. Bound it
    // rather than growing this string until the process dies.
    if (buffer.length > 1_000_000) throw new Error("upstream frame exceeded 1MB");
  }
}

function handleFrame(frame: string): void {
  let type = "message";
  const data: string[] = [];

  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith(":")) continue; // comment / keepalive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") type = value;
    else if (field === "data") data.push(value);
  }

  // Heartbeats keep the connection open and carry nothing worth forwarding.
  if (type !== "change" || data.length === 0) return;

  try {
    const parsed = JSON.parse(data.join("\n")) as RealtimeEvent;
    if (parsed && typeof parsed.orgId === "string" && parsed.orgId) emit(parsed);
  } catch {
    // A frame we cannot read is not a reason to tear down a working stream.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
