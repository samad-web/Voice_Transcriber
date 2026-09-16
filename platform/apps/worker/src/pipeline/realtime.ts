import { publishEvent } from "@aura/queue";
import type { RealtimeAction, RealtimeEvent, RealtimeTopic } from "@aura/shared";

/**
 * The worker's half of the console's live updates.
 *
 * Everything the API publishes comes out of a request somebody made. Everything
 * here comes out of work nobody is watching a spinner for - a transcript that
 * lands four minutes after a call ended, a lead the extraction produced - which
 * is precisely the case where a console that only refreshes on navigation
 * leaves somebody looking at a stale number for as long as they stay on the
 * page. Without this the pipeline's whole output arrives invisibly.
 *
 * Best effort by construction: `publishEvent` never throws and never awaits the
 * broker (packages/queue/events.ts). A pipeline stage must not fail, or slow
 * down, because a notification bus is unavailable - the database write already
 * happened and it is the record.
 */
export function announce(
  orgId: string,
  topic: RealtimeTopic,
  action: RealtimeAction,
  id?: string | null,
): void {
  if (!orgId) return;
  const event: RealtimeEvent = { orgId, topic, action, id: id ?? null, at: new Date().toISOString() };
  publishEvent(event);
}
