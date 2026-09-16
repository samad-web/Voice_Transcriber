import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SequencedRealtimeEvent } from "@aura/shared";

/**
 * The fanout, exercised through the wire it actually reads.
 *
 * Everything here goes in as SSE text and comes out at a subscriber, because
 * that is where the bugs live: a frame split across two TCP reads, a proxy that
 * rewrote the line endings, a heartbeat mistaken for an event, one tenant's
 * signal delivered to another tenant's console. Testing the parser in isolation
 * would miss every one of them.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

vi.mock("@/lib/server-api", () => ({ API_URL: "http://api.test", ADMIN_KEY: "test-key" }));

let push: (chunk: string) => void;
let upstream: typeof import("./upstream");

/** Let the stream reader drain what was just pushed. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function change(over: Partial<SequencedRealtimeEvent> = {}): string {
  const event = { orgId: ORG, topic: "lead", action: "created", at: "2026-09-07T00:00:00Z", ...over };
  return `event: change\ndata: ${JSON.stringify(event)}\n\n`;
}

beforeEach(async () => {
  vi.resetModules();
  // The hub is deliberately pinned to globalThis so Next's dev server cannot
  // leak one per hot reload - which means a test has to clear it by hand.
  delete (globalThis as Record<symbol, unknown>)[Symbol.for("aura.realtime.hub")];

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      push = (chunk) => controller.enqueue(encoder.encode(chunk));
    },
  });
  // Never closes: the module reconnects on close, and a test that let it would
  // be racing its own backoff.
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body }) as unknown as Response));

  upstream = await import("./upstream");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("upstream fanout", () => {
  it("delivers a change to a subscriber on that tenant", async () => {
    const seen: SequencedRealtimeEvent[] = [];
    upstream.subscribe(ORG, (event) => seen.push(event));
    await settle();

    push(change({ id: "lead-1" }));
    await settle();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ orgId: ORG, topic: "lead", id: "lead-1", seq: 1 });
  });

  it("never delivers one tenant's signal to another tenant", async () => {
    // The single most important assertion in this file.
    const mine: SequencedRealtimeEvent[] = [];
    upstream.subscribe(OTHER, (event) => mine.push(event));
    await settle();

    push(change({ orgId: ORG }));
    await settle();

    expect(mine).toHaveLength(0);
  });

  it("gives the operator console every tenant", async () => {
    const seen: SequencedRealtimeEvent[] = [];
    upstream.subscribe(upstream.ALL_ORGS, (event) => seen.push(event));
    await settle();

    push(change({ orgId: ORG }));
    push(change({ orgId: OTHER }));
    await settle();

    expect(seen.map((e) => e.orgId)).toEqual([ORG, OTHER]);
  });

  it("ignores heartbeats and comments", async () => {
    const seen: SequencedRealtimeEvent[] = [];
    upstream.subscribe(ORG, (event) => seen.push(event));
    await settle();

    push(`event: ping\ndata: {}\n\n`);
    push(`: keepalive\n\n`);
    await settle();

    expect(seen).toHaveLength(0);
    // And nothing consumed a sequence number, so a client's cursor does not
    // drift forward past events it never saw.
    expect(upstream.currentSeq()).toBe(0);
  });

  it("reassembles a frame split across reads", async () => {
    const seen: SequencedRealtimeEvent[] = [];
    upstream.subscribe(ORG, (event) => seen.push(event));
    await settle();

    const frame = change({ id: "split" });
    push(frame.slice(0, 20));
    await settle();
    expect(seen).toHaveLength(0);

    push(frame.slice(20));
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe("split");
  });

  it("reads frames a proxy rewrote to CRLF", async () => {
    const seen: SequencedRealtimeEvent[] = [];
    upstream.subscribe(ORG, (event) => seen.push(event));
    await settle();

    push(change({ id: "crlf" }).replace(/\n/g, "\r\n"));
    await settle();

    expect(seen.map((e) => e.id)).toEqual(["crlf"]);
  });

  it("survives a frame it cannot parse", async () => {
    const seen: SequencedRealtimeEvent[] = [];
    upstream.subscribe(ORG, (event) => seen.push(event));
    await settle();

    push(`event: change\ndata: {not json\n\n`);
    push(change({ id: "after" }));
    await settle();

    // The bad frame is dropped; the stream keeps working. Tearing it down would
    // turn one malformed message into an outage for every open console.
    expect(seen.map((e) => e.id)).toEqual(["after"]);
  });

  it("drops an event with no tenant rather than broadcasting it", async () => {
    const seen: SequencedRealtimeEvent[] = [];
    upstream.subscribe(upstream.ALL_ORGS, (event) => seen.push(event));
    await settle();

    push(`event: change\ndata: ${JSON.stringify({ topic: "lead", action: "created" })}\n\n`);
    await settle();

    expect(seen).toHaveLength(0);
  });

  it("stops delivering after unsubscribe", async () => {
    const seen: SequencedRealtimeEvent[] = [];
    const off = upstream.subscribe(ORG, (event) => seen.push(event));
    await settle();

    push(change());
    await settle();
    off();
    push(change());
    await settle();

    expect(seen).toHaveLength(1);
  });

  it("keeps one subscriber's failure from silencing the others", async () => {
    const seen: SequencedRealtimeEvent[] = [];
    upstream.subscribe(ORG, () => {
      throw new Error("this console's writer is dead");
    });
    upstream.subscribe(ORG, (event) => seen.push(event));
    await settle();

    push(change());
    await settle();

    expect(seen).toHaveLength(1);
  });
});

describe("catch-up cursor", () => {
  it("replays only what came after the cursor, for that tenant alone", async () => {
    upstream.subscribe(upstream.ALL_ORGS, () => undefined);
    await settle();

    push(change({ id: "a" }));
    push(change({ id: "b", orgId: OTHER }));
    push(change({ id: "c" }));
    await settle();

    expect(upstream.eventsSince(ORG, 0).map((e) => e.id)).toEqual(["a", "c"]);
    expect(upstream.eventsSince(ORG, 1).map((e) => e.id)).toEqual(["c"]);
    expect(upstream.eventsSince(ORG, 3)).toEqual([]);
    expect(upstream.currentSeq()).toBe(3);
  });

  it("admits when a client has been away longer than it remembers", async () => {
    upstream.subscribe(ORG, () => undefined);
    await settle();

    expect(upstream.canServeFrom(0)).toBe(true);

    // Overrun the 500-event ring.
    for (let i = 0; i < 520; i += 1) push(change({ id: `e${i}` }));
    await settle();

    // A cursor whose events have fallen out of the buffer must NOT get a
    // partial list that looks complete - the client is told to re-read instead.
    expect(upstream.canServeFrom(1)).toBe(false);
    expect(upstream.canServeFrom(upstream.currentSeq())).toBe(true);
  });
});
