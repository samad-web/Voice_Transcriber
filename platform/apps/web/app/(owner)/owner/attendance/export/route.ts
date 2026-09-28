import { NextResponse } from "next/server";
import { isCalendarDate } from "@aura/shared";
import { getOwner } from "@/lib/owner-context";
import { API_URL, orgHeaders } from "@/lib/server-api";

/**
 * Download proxy for the timesheet CSV (`GET /v1/owner/attendance/timesheets.csv`).
 *
 * A Route Handler for the reason reports/export/[report]/route.ts gives: it has
 * to be a plain `<a href>` the browser downloads, and the API is reached with
 * the admin key, which must never leave this server. The tenant and the
 * persona are re-derived from the session, so a telecaller's download is
 * scoped to their own rows by the API exactly as their page is.
 *
 * Only `from`, `to` and `telecallerId` are forwarded, each checked for shape -
 * never the raw query string.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  const owner = await getOwner();
  if (!owner) {
    return NextResponse.json({ error: "Not signed in to a workspace" }, { status: 401 });
  }

  const incoming = new URL(request.url).searchParams;
  const forwarded = new URLSearchParams();
  for (const key of ["from", "to"] as const) {
    const value = incoming.get(key);
    if (value && isCalendarDate(value)) forwarded.set(key, value);
  }
  const telecallerId = incoming.get("telecallerId");
  if (telecallerId && UUID.test(telecallerId)) forwarded.set("telecallerId", telecallerId);

  const headers = orgHeaders(owner.membership.orgId, {
    ownerRole: owner.membership.ownerRole,
    userId: owner.userId,
  });

  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/v1/owner/attendance/timesheets.csv?${forwarded}`, {
      headers,
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "API unreachable" }, { status: 502 });
  }

  if (!upstream.ok) {
    // The API's own refusal, passed through: a 403 should read as "you may
    // not", not as a generic failure.
    const body = await upstream.text().catch(() => "");
    return new NextResponse(body || JSON.stringify({ error: `API ${upstream.status}` }), {
      status: upstream.status,
      headers: { "content-type": "application/json" },
    });
  }

  const csv = await upstream.text();
  const from = forwarded.get("from") ?? "";
  const to = forwarded.get("to") ?? "";
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition":
        upstream.headers.get("content-disposition") ??
        `attachment; filename="timesheets${from ? `-${from}` : ""}${to ? `-to-${to}` : ""}.csv"`,
      "cache-control": "no-store",
    },
  });
}
