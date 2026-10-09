import { NextResponse } from "next/server";
import { IsoDate } from "@aura/shared";
import { getOwner } from "@/lib/owner-context";
import { API_URL, orgHeaders } from "@/lib/server-api";

/**
 * Download proxy for the organization chart PDF (§5.2).
 *
 * The same shape as `insights/export/route.ts`, for the same two reasons: a
 * Route Handler because the browser needs bytes with a Content-Disposition
 * rather than a value handed to JS, and a proxy at all because the API is
 * reached with the root ADMIN_API_KEY, which must never leave the server.
 *
 * SECURITY: the tenant is re-derived from the session here and never read from
 * the URL - the query carries only the date, the orientation and an optional
 * branch. The API's own guards still run behind this (`position:view`, the
 * `aura` module), so a reader the page would not show gets the API's 403
 * passed through as-is.
 *
 * ── WHY THE PNG IS NOT ALSO PROXIED ────────────────────────────────────────
 *
 * The PNG is made in the browser from the live SVG, because §5.2's "of the
 * current view" means exactly that: whatever the person has collapsed, filtered
 * and zoomed to. A server render cannot know any of it. The PDF is the other
 * thing - the whole chart, vector, printable - and that is better made where
 * the data is. See `chart-canvas.tsx`'s `exportPng` and the API's
 * `org-chart-pdf.ts`.
 */
export async function GET(request: Request) {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Not signed in to a workspace" }, { status: 401 });
  }

  const incoming = new URL(request.url).searchParams;
  const forwarded = new URLSearchParams();

  // Validated with the API's own schema, so nothing this route has not vetted
  // is appended upstream.
  const asOf = incoming.get("asOf");
  if (asOf) {
    const parsed = IsoDate.safeParse(asOf);
    if (!parsed.success) {
      return NextResponse.json({ error: "That date is not a date." }, { status: 400 });
    }
    forwarded.set("asOf", parsed.data);
  }

  const orientation = incoming.get("orientation");
  if (orientation === "horizontal" || orientation === "vertical") {
    forwarded.set("orientation", orientation);
  }

  const branch = incoming.get("rootPositionId");
  if (branch) {
    if (!/^[0-9a-f-]{36}$/i.test(branch)) {
      return NextResponse.json({ error: "That is not a position." }, { status: 400 });
    }
    forwarded.set("rootPositionId", branch);
  }

  let upstream: Response;
  try {
    upstream = await fetch(
      `${API_URL}/v1/org-chart/export.pdf${forwarded.toString() ? `?${forwarded}` : ""}`,
      {
        headers: orgHeaders(owner.membership.orgId, {
          ownerRole: owner.membership.ownerRole,
          userId: owner.userId,
        }),
        cache: "no-store",
      },
    );
  } catch {
    return NextResponse.json(
      { error: "The chart service did not answer. Try again in a minute." },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    // The API's own refusal, not a flattened one: a 403 must read as "you may
    // not export this", which is a different conversation from an outage.
    const body = await upstream.text().catch(() => "");
    return new NextResponse(body || JSON.stringify({ error: `API ${upstream.status}` }), {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  }

  const pdf = await upstream.arrayBuffer();
  return new NextResponse(pdf, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-length": String(pdf.byteLength),
      "content-disposition":
        upstream.headers.get("content-disposition") ?? 'attachment; filename="org-chart.pdf"',
      "cache-control": "no-store",
    },
  });
}
