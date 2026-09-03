import { NextResponse } from "next/server";
import { getOwner } from "@/lib/owner-context";
import { API_URL, orgHeaders } from "@/lib/server-api";

/**
 * Download proxy for a widget's underlying data.
 *
 * A Route Handler rather than a Server Action, for the same reason
 * `/owner/reports/export/[report]` is one: this has to be a plain `<a href>`
 * the browser downloads, and an action returns a value to JS rather than a
 * file with a `Content-Disposition`.
 *
 * SECURITY: the tenant is re-derived from the session here - the URL carries
 * only ids, so there is nothing tenant-scoped for a caller to forge - and the
 * API's own `deal:export` grant plus the report's share role are both still
 * checked behind this. A proxy that authenticated but did not authorize would
 * be a way around the permission grid, which is the failure mode this comment
 * exists to keep visible.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; widgetId: string }> },
) {
  const { id, widgetId } = await params;

  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Not signed in as an instance owner" }, { status: 401 });
  }

  // Both ids are path segments on the upstream URL, so they are encoded rather
  // than interpolated raw - a widget id containing a slash would otherwise
  // reach a different API route entirely.
  const upstreamPath =
    `/v1/report-builder/${encodeURIComponent(id)}` +
    `/widgets/${encodeURIComponent(widgetId)}/export`;

  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}${upstreamPath}`, {
      headers: orgHeaders(owner.membership.orgId, {
        ownerRole: owner.membership.ownerRole,
        userId: owner.userId,
      }),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "API unreachable" }, { status: 502 });
  }

  if (!upstream.ok) {
    const message = await upstream.text().catch(() => "");
    return NextResponse.json(
      { error: message.slice(0, 300) || "Export failed" },
      { status: upstream.status },
    );
  }

  // The upstream already set a filename; pass its headers through rather than
  // inventing a second name that would disagree with the fixed-report exports.
  return new NextResponse(await upstream.text(), {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/csv; charset=utf-8",
      "content-disposition":
        upstream.headers.get("content-disposition") ?? 'attachment; filename="widget.csv"',
      "cache-control": "no-store",
    },
  });
}
