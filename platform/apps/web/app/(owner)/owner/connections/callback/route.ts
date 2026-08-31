import { NextResponse } from "next/server";
import { getOwner } from "@/lib/owner-context";
import { API_URL, orgHeaders } from "@/lib/server-api";

/**
 * Where OAuth providers send the browser back (PRD Layer 1).
 *
 * This URL is what gets registered in the provider's app console, so it is
 * fixed and lives in the web app rather than the API - which also keeps the
 * root ADMIN_API_KEY behind the server boundary. The browser arrives here with
 * `code` and `state`; this hands both to the API, which is the only place that
 * knows whether the state was ever issued.
 *
 * Everything that could go wrong ends as a redirect back to the connections
 * page with a readable message, never as a stack trace: the person looking at
 * this has just been bounced through a consent screen, and a raw 500 gives
 * them nothing to do next.
 */

function back(request: Request, params: Record<string, string>): NextResponse {
  const url = new URL("/owner/connections", new URL(request.url).origin);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;

  // The user pressed Cancel, or the provider refused. `error_description` is
  // theirs, so it is passed through as a message rather than interpreted.
  const denied = query.get("error");
  if (denied) {
    return back(request, {
      error: query.get("error_description") ?? `The provider refused the connection (${denied}).`,
    });
  }

  const code = query.get("code");
  const state = query.get("state");
  if (!code || !state) {
    return back(request, { error: "That sign-in did not complete. Please try again." });
  }

  const owner = await getOwner();
  if (!owner) {
    return back(request, { error: "Your session expired during sign-in. Please try again." });
  }

  const headers = orgHeaders(owner.membership.orgId, {
    ownerRole: owner.membership.ownerRole,
    userId: owner.userId,
  });

  try {
    const res = await fetch(`${API_URL}/v1/connections/oauth/complete`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({ state, code }),
    });

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: unknown };
      const detail =
        typeof body.message === "string" ? body.message : "The connection could not be completed.";
      return back(request, { error: detail });
    }

    const data = (await res.json()) as {
      connection?: { account_email?: string };
      redirectPath?: string;
    };

    // The API re-validates redirectPath as same-site before returning it, so
    // this cannot be pointed off-origin by anything stored earlier.
    const target = new URL(data.redirectPath ?? "/owner/connections", new URL(request.url).origin);
    if (data.connection?.account_email) {
      target.searchParams.set("connected", data.connection.account_email);
    }
    return NextResponse.redirect(target);
  } catch {
    return back(request, { error: "Could not reach the platform API. Please try again." });
  }
}
