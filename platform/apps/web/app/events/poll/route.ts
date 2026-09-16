import { NextResponse } from "next/server";
import { resolveListenScope } from "@/lib/realtime/scope";
import { canServeFrom, currentSeq, eventsSince } from "@/lib/realtime/upstream";

/**
 * The fallback for a browser that cannot hold a stream open.
 *
 * That is not a hypothetical. A corporate proxy that buffers responses, an
 * extension that breaks EventSource, a network that kills long-lived
 * connections, a browser that has hit its per-origin connection limit across
 * six open tabs - in every one of those the stream never delivers and the
 * console silently stops updating, which is exactly the failure this whole
 * feature exists to remove.
 *
 * So the client falls back to asking. Same authorisation, same payload, same
 * cursor semantics - only the transport differs, which keeps this from being a
 * second implementation of anything that matters.
 *
 * `stale: true` means the caller has been away longer than the ring buffer
 * holds. The events it missed are genuinely gone, and the honest answer is
 * "re-read everything" rather than a partial list that would look complete.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const orgId = await resolveListenScope();
  if (!orgId) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const raw = new URL(request.url).searchParams.get("since");
  const parsed = Number(raw);
  const cursor = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;

  // No cursor: hand back where we are now so the caller can start watching.
  // Returning events here instead would make every first poll look like a burst
  // of change and refresh a page that had just finished rendering.
  if (cursor === null) {
    return NextResponse.json({ seq: currentSeq(), events: [], stale: false });
  }

  if (!canServeFrom(cursor)) {
    return NextResponse.json({ seq: currentSeq(), events: [], stale: true });
  }

  const events = eventsSince(orgId, cursor);
  return NextResponse.json({ seq: currentSeq(), events, stale: false });
}
