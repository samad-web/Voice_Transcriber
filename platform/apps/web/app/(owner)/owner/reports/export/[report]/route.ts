import { NextResponse } from "next/server";
import { getOwner } from "@/lib/owner-context";
import { API_URL, orgHeaders } from "@/lib/server-api";

/**
 * Download proxy for the Layer 3 CSV exports.
 *
 * A Route Handler rather than a Server Action, because this has to be a plain
 * `<a href>` a browser downloads — an action returns a value to JS, not a file
 * with a Content-Disposition. The proxy exists at all because the API is
 * reached with the root ADMIN_API_KEY, which must never leave the server; the
 * browser gets the bytes, never the credential.
 *
 * SECURITY: the tenant is re-derived from the session here, exactly as
 * `ownerHeaders()` does for every owner action — the URL carries only the
 * report name, so there is nothing tenant-scoped for a caller to forge. The
 * API's own `deal:export` permission check still runs behind this; a proxy
 * that authenticated but did not authorize would be a way around the grid.
 */

const REPORTS = new Set(["pipeline", "performance", "conversion"]);

export async function GET(
  request: Request,
  { params }: { params: Promise<{ report: string }> },
) {
  const { report } = await params;
  // Validated against an allowlist before it reaches the upstream path, so a
  // report name can never be used to reach a different API route.
  if (!REPORTS.has(report)) {
    return NextResponse.json({ error: "unknown report" }, { status: 404 });
  }

  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Not signed in as an instance owner" }, { status: 401 });
  }

  // Only the window is forwarded — never the whole query string, which would
  // let a caller append parameters this route has not vetted.
  const incoming = new URL(request.url).searchParams;
  const forwarded = new URLSearchParams();
  for (const key of ["from", "to", "pipelineId"]) {
    const value = incoming.get(key);
    if (value) forwarded.set(key, value);
  }

  const headers = orgHeaders(owner.membership.orgId, {
    ownerRole: owner.membership.ownerRole,
    userId: owner.userId,
  });

  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/v1/reports/${report}/export?${forwarded}`, {
      headers,
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "API unreachable" }, { status: 502 });
  }

  if (!upstream.ok) {
    // Pass the API's own refusal through rather than flattening it: a 403 from
    // the permission grid should read as "you may not export", not as a
    // generic failure.
    const body = await upstream.text().catch(() => "");
    return new NextResponse(body || JSON.stringify({ error: `API ${upstream.status}` }), {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  }

  const csv = await upstream.text();
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      // Reuse the API's filename, which already sanitises it.
      "content-disposition":
        upstream.headers.get("content-disposition") ?? `attachment; filename="${report}.csv"`,
      "cache-control": "no-store",
    },
  });
}
