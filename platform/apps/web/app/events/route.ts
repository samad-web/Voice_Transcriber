import { REALTIME_HEARTBEAT_MS } from "@aura/shared";
import { resolveListenScope } from "@/lib/realtime/scope";
import { canServeFrom, currentSeq, eventsSince, subscribe } from "@/lib/realtime/upstream";

/**
 * The console's live-update stream.
 *
 * One per open tab. It authenticates the Supabase session, resolves the tenant
 * from the membership behind it, and forwards only that tenant's change
 * signals - which is why this lives in the Next tier and not on the API, where
 * the only credential available is the cross-tenant admin key.
 *
 * Deliberately NOT under `(owner)` or `(platform)`: both consoles use it, and a
 * route group would tie one shared endpoint to one of them. Route groups add no
 * URL segment, so `/events` is free either way.
 *
 * ── WHAT GOES DOWN THE WIRE ───────────────────────────────────────────────
 *
 *   event: change     one signal - { orgId, topic, action, id, at, seq }
 *   event: ping       keepalive, every REALTIME_HEARTBEAT_MS
 *   id: <seq>         on every change, so EventSource sends `Last-Event-ID`
 *                     back on reconnect and gets exactly what it missed
 *   event: resync     "you were away too long, re-read everything"
 *
 * No row content, ever. See packages/shared/src/realtime.ts.
 */

// A stream is the definition of a dynamic response. Without these Next would
// try to render it at build time and serve a cached, closed, empty body.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const orgId = await resolveListenScope();
  if (!orgId) {
    // 401 rather than a stream that never emits: EventSource retries on a
    // non-200 anyway, and a signed-out tab should stop asking, not sit there
    // looking connected.
    return new Response("not signed in", { status: 401 });
  }

  // EventSource resends the last id it saw. A tab that reconnected inside the
  // ring's window gets the gap replayed rather than a blind full refresh.
  const lastEventId = Number(request.headers.get("last-event-id") ?? "");
  const cursor = Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : null;

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      // Reassigned to `close` once that exists below. A failed write has to be
      // able to tear the whole thing down, and it is defined before it. Until
      // then there is nothing to tear down but the writing itself.
      let cleanup: () => void = () => {
        open = false;
      };

      const write = (chunk: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // The client went away between the check above and this write, and
          // the abort event may never arrive (a dropped socket rather than a
          // clean close). Tear down here too, or this connection's heartbeat
          // and its subscription outlive it - one leaked timer and one leaked
          // listener per dropped tab, for the life of the process.
          cleanup();
        }
      };

      // `retry` is how long the browser waits before redialling after a drop.
      // Left to the default (3s in most browsers) a redeploy has every open tab
      // reconnecting in the same second.
      write(`retry: 5000\n\n`);

      if (cursor !== null) {
        if (canServeFrom(cursor)) {
          for (const event of eventsSince(orgId, cursor)) {
            write(`event: change\nid: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
          }
        } else {
          // The gap is longer than this process remembers. Say so plainly
          // instead of replaying a partial list that would look complete.
          write(`event: resync\nid: ${currentSeq()}\ndata: {}\n\n`);
        }
      } else {
        // A first connection needs a cursor to fall back to if it ever has to
        // switch to polling. Nothing has been missed, so nothing is replayed.
        write(`event: ready\ndata: ${JSON.stringify({ seq: currentSeq() })}\n\n`);
      }

      const unsubscribe = subscribe(orgId, (event) => {
        write(`event: change\nid: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
      });

      // Two things depend on this: proxies close an idle connection (nginx at
      // 300s), and a browser cannot otherwise tell a quiet tenant from a dead
      // stream. A comment frame would do for the first; a named event lets the
      // client show "live" honestly, which is what the second needs.
      const heartbeat = setInterval(() => {
        write(`event: ping\ndata: {}\n\n`);
      }, REALTIME_HEARTBEAT_MS);

      const close = () => {
        if (!open) return;
        open = false;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime when the socket went away.
        }
      };

      cleanup = close;
      request.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      // `no-transform` as well as `no-cache`: it asks intermediaries not to
      // compress or otherwise rewrite the body, which is what turns a stream
      // into a response that arrives all at once at the end.
      "cache-control": "no-cache, no-store, no-transform, must-revalidate",
      connection: "keep-alive",
      // nginx buffers proxied responses by default, which would hold every
      // event until the buffer filled - i.e. forever, for a stream this small.
      // This header turns that off per response, so no nginx config has to
      // change on the deployed box. Caddy detects text/event-stream by itself.
      "x-accel-buffering": "no",
    },
  });
}
