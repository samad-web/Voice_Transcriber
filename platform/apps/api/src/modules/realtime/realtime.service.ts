import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { Observable, Subject } from "rxjs";
import { closeEvents, consumeEvents, publishEvent } from "@aura/queue";
import type { RealtimeEvent } from "@aura/shared";

/**
 * The API's change-signal hub.
 *
 * Everything that changes tenant data announces it here; everything holding a
 * console stream open reads from here. The bus in between is RabbitMQ, because
 * the writers are in three different processes (this one, the worker, and
 * whatever a webhook lands on) and only the broker sees all of them.
 *
 * ── PUBLISH GOES OUT AND COMES BACK ───────────────────────────────────────
 *
 * `publish` does NOT hand the event to local subscribers directly. It goes to
 * the exchange and arrives back through this process's own subscription, the
 * same way another process's event does. That costs a hop to a broker on the
 * same box - microseconds - and buys the property that there is exactly ONE
 * delivery path to reason about. The alternative (emit locally AND publish)
 * delivers twice to the process that originated the event, which shows up as a
 * console refreshing twice per change, and the fix for that is a dedupe table
 * nobody wants to own.
 *
 * ── COALESCING IS NOT OPTIONAL ────────────────────────────────────────────
 *
 * A CSV import inserts ten thousand contacts. Without coalescing that is ten
 * thousand signals, each one telling every open console to re-render the whole
 * page - which is how a live-updates feature becomes a self-inflicted denial of
 * service on the tenant who was only trying to upload their address book.
 *
 * So signals are coalesced per (org, topic) into one leading send plus, if more
 * changes arrive inside the window, one trailing send carrying the newest. The
 * trailing half matters: dropping it would mean the LAST change of a burst is
 * the one nobody hears about, and the last one is the one that leaves the
 * console wrong until somebody navigates.
 */

/** The coalescing window. Long enough to fold a burst, short enough to feel live. */
const COALESCE_MS = Number(process.env.REALTIME_COALESCE_MS ?? 400);

/**
 * Cap on the bookkeeping maps, so a very large fleet of tenants cannot turn
 * this into a slow memory leak. Well above tenants x topics in practice.
 */
const MAX_TRACKED_KEYS = 5_000;

/** The kill switch. Set REALTIME_DISABLED=1 and the console falls back to polling. */
export function realtimeDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.REALTIME_DISABLED?.trim().toLowerCase();
  return value === "1" || value === "true";
}

@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly events = new Subject<RealtimeEvent>();
  private readonly lastSentAt = new Map<string, number>();
  private readonly pending = new Map<string, RealtimeEvent>();
  private readonly trailing = new Map<string, NodeJS.Timeout>();
  private readonly disabled = realtimeDisabled();

  async onModuleInit(): Promise<void> {
    if (this.disabled) {
      console.log("[realtime] disabled by REALTIME_DISABLED; consoles will poll instead");
      return;
    }
    try {
      await consumeEvents<RealtimeEvent>((event) => {
        // The broker hands us whatever was published. Anything without an org
        // cannot be routed to a console and is dropped rather than broadcast.
        if (event && typeof event.orgId === "string" && event.orgId.length > 0) {
          this.events.next(event);
        }
      });
    } catch (err) {
      // A broker that is down at boot must not stop the API from serving. The
      // subscriber redials on its own (packages/queue/events.ts); until it
      // succeeds, consoles fall back to polling and nothing else is affected.
      console.error("[realtime] could not subscribe at startup; will retry:", err);
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const timer of this.trailing.values()) clearTimeout(timer);
    this.trailing.clear();
    this.events.complete();
    await closeEvents();
  }

  /** Every change signal reaching this process, from any process. */
  stream(): Observable<RealtimeEvent> {
    return this.events.asObservable();
  }

  /**
   * Announce a change. Never throws, never awaits the broker - the caller has
   * already done the work that matters and is not waiting on this.
   */
  publish(event: RealtimeEvent): void {
    if (this.disabled) return;
    if (!event.orgId) return;

    const key = `${event.orgId}:${event.topic}`;
    const now = Date.now();
    const last = this.lastSentAt.get(key) ?? 0;

    if (now - last >= COALESCE_MS) {
      this.send(key, event, now);
      return;
    }

    // Inside the window: hold the newest and let one trailing send carry it.
    this.pending.set(key, event);
    if (this.trailing.has(key)) return;

    const timer = setTimeout(() => {
      this.trailing.delete(key);
      const latest = this.pending.get(key);
      this.pending.delete(key);
      if (latest) this.send(key, latest, Date.now());
    }, COALESCE_MS - (now - last));
    timer.unref?.();
    this.trailing.set(key, timer);
  }

  private send(key: string, event: RealtimeEvent, at: number): void {
    this.lastSentAt.set(key, at);
    if (this.lastSentAt.size > MAX_TRACKED_KEYS) this.prune(at);
    publishEvent(event);
  }

  /** Forget keys that have been quiet for far longer than the window. */
  private prune(now: number): void {
    for (const [key, at] of this.lastSentAt) {
      if (now - at > 60_000 && !this.trailing.has(key)) this.lastSentAt.delete(key);
    }
  }
}
