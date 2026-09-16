import { Controller, type MessageEvent, Sse, UseGuards } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { type Observable, interval, map, merge } from "rxjs";
import { REALTIME_HEARTBEAT_MS } from "@aura/shared";
import { InternalStreamGuard } from "./internal-stream.guard";
import { RealtimeService } from "./realtime.service";

/**
 * The cross-tenant change stream the web tier subscribes to.
 *
 * ── ONE CONNECTION, NOT ONE PER BROWSER ───────────────────────────────────
 *
 * This is not the endpoint a browser talks to. Nothing in the browser holds the
 * admin key, and nothing in the browser may see another tenant's events, so the
 * console's own stream is served by the Next.js tier (apps/web/app/events),
 * which authenticates the session, resolves the org from it, and filters.
 *
 * That leaves this API with exactly ONE subscriber however many consoles are
 * open - which is the point. A per-browser connection here would mean the web
 * tier proxying N streams, N sockets into this process, and a filter decision
 * repeated N times; instead the fanout happens once, in the tier that already
 * knows who is signed in.
 *
 * Events carry no row content (packages/shared/realtime.ts explains why), so
 * "cross-tenant" here means a stream of "org X had a Y change" and nothing an
 * eavesdropper could turn into a customer's data.
 */
@Controller("internal")
@UseGuards(InternalStreamGuard)
// A stream that stays open for hours is not a request rate. Without this the
// global ThrottlerGuard counts a reconnect storm - the exact thing that happens
// after a redeploy, when every console redials at once - as an attack and locks
// the web tier out of its own event feed.
@SkipThrottle()
export class RealtimeController {
  constructor(private readonly realtime: RealtimeService) {}

  @Sse("events")
  events(): Observable<MessageEvent> {
    return merge(
      this.realtime.stream().pipe(map((event): MessageEvent => ({ type: "change", data: event }))),
      // The keepalive. Every proxy in front of this closes an idle connection
      // eventually, and a tenant with nothing happening is precisely the case
      // where a silently dead stream would go unnoticed for hours.
      interval(REALTIME_HEARTBEAT_MS).pipe(
        map((): MessageEvent => ({ type: "ping", data: { at: new Date().toISOString() } })),
      ),
    );
  }
}
