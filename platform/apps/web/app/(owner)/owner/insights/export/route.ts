import { NextResponse } from "next/server";
import { CallInsightsQuery } from "@aura/shared";
import { getOwner } from "@/lib/owner-context";
import { API_URL, orgHeaders } from "@/lib/server-api";

/**
 * Download proxy for the call insights PDF.
 *
 * The same shape as reports/export/[report]/route.ts, for the same reasons: a
 * Route Handler because the browser needs bytes with a Content-Disposition,
 * not a value handed to JS; and a proxy at all because the API is reached with
 * the root ADMIN_API_KEY, which must never leave the server.
 *
 * SECURITY: the tenant is re-derived from the session here, never read from
 * the URL - the query carries only the window. The API's own guards still run
 * behind this (owner/manager, the `call_insights` feature, and its module), so
 * a persona the page would not show gets the API's 403, passed through as-is.
 */
export async function GET(request: Request) {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Not signed in as an instance owner" }, { status: 401 });
  }

  // Only the four parameters the report takes, validated with the API's own
  // schema, so nothing this route has not vetted is ever appended upstream.
  const incoming = new URL(request.url).searchParams;
  const picked: Record<string, string> = {};
  for (const key of ["days", "from", "to", "calls"]) {
    const value = incoming.get(key);
    if (value) picked[key] = value;
  }
  const parsed = CallInsightsQuery.safeParse(picked);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid range" }, { status: 400 });
  }
  const forwarded = new URLSearchParams(picked);

  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/v1/owner/call-insights/pdf?${forwarded}`, {
      headers: orgHeaders(owner.membership.orgId, {
        ownerRole: owner.membership.ownerRole,
        userId: owner.userId,
      }),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "The report service did not answer. Try again in a minute." }, { status: 502 });
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
      // The API's filename, which it already made ASCII-safe.
      "content-disposition": upstream.headers.get("content-disposition") ?? 'attachment; filename="call-insights.pdf"',
      "cache-control": "no-store",
    },
  });
}
