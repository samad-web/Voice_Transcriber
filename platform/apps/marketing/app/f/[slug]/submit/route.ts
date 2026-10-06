import { forwardSubmission } from "../api";

/**
 * The hosted form's submit endpoint (Build docs/39 §16).
 *
 * ── IT IS A PROXY, AND BOTH HALVES OF THAT MATTER ─────────────────────────
 *
 * It does no validation, maps no fields, writes nothing and knows nothing
 * about leads. It takes the browser's body, adds the two things only this hop
 * can know, and hands it to the API - where the SAME validator the browser
 * ran is applied again and the existing lead-intake pipeline does the rest.
 *
 * The two things:
 *
 *   THE VISITOR'S ADDRESS, as `x-forwarded-for`. The API throttles these at
 *   300/min per source IP and `main.ts` sets `trust proxy`, so without this
 *   every tenant's forms would be counted into one bucket and a busy
 *   afternoon on one form would throttle everybody else's.
 *
 *   THE BROWSER'S ORIGIN, separately from the request's own `Origin` header.
 *   That header belongs to THIS container when it proxies, which would report
 *   our own origin for every tenant and make the source's allowed-origins list
 *   meaningless. Forwarded as a field so the API applies it to the right
 *   thing.
 *
 * ── WHY THE BROWSER DOES NOT POST STRAIGHT AT THE API ──────────────────────
 *
 * It would need the form's intake token in the page to do that, and it would
 * flatten the throttle as above. One hop buys both, and keeps the token on the
 * server where 0078 put it.
 */

export const dynamic = "force-dynamic";

/** Bigger than any real submission; small enough that nothing can be parked here. */
const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const raw = await request.text().catch(() => "");
  if (raw.length > MAX_BODY_BYTES) {
    return Response.json({ ok: false, error: "too large" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return Response.json({ ok: false, error: "bad request" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return Response.json({ ok: false, error: "bad request" }, { status: 400 });
  }

  try {
    const outcome = await forwardSubmission(
      slug,
      { ...(body as Record<string, unknown>), origin: request.headers.get("origin") },
      clientAddress(request),
    );
    return Response.json(outcome.body, { status: outcome.status });
  } catch {
    // A timeout or a dead upstream. 502 rather than a 200 with no lead behind
    // it: the renderer turns a non-2xx into "we couldn't send this just now",
    // which is true and leaves the person's typing on screen to try again.
    return Response.json({ ok: false, error: "upstream unavailable" }, { status: 502 });
  }
}

/**
 * The visitor, as nginx reported them.
 *
 * Leftmost entry of `x-forwarded-for`: nginx appends, so the first is the
 * client and the rest are hops. `x-real-ip` as a fallback for a deployment
 * that sets only that one. Nothing is read from the body - an address a client
 * can choose is not an address worth throttling on.
 */
function clientAddress(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
  return request.headers.get("x-real-ip")?.trim() || null;
}
