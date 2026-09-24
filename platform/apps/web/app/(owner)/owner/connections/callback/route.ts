import { NextResponse } from "next/server";
import type { ConnectErrorCode } from "@aura/shared";
import { consoleUrl } from "@/lib/console-url";
import { getOwner } from "@/lib/owner-context";
import { consolePublicOrigin } from "@/lib/public-url";
import { API_URL, orgHeaders } from "@/lib/server-api";

/**
 * Where Google and Microsoft send the browser back after sign-in.
 *
 * ── THIS PATH NEVER MOVES ───────────────────────────────────────────────────
 *
 * `/owner/connections/callback` is the exact-match redirect URI registered in
 * every organisation's own Google and Microsoft app (migration 0120). Moving
 * it would break every one of them at once, silently, at the provider. The
 * Connections PAGE became a redirect into the Integrations store; this route
 * stays exactly where it is. What changes is where it sends people on: the
 * `redirect_path` the API stored when the sign-in began - the store's connect
 * step, for a sign-in the store started.
 *
 * ── FAILURES GO BACK TO WHERE THEY STARTED, AS A CODE ───────────────────────
 *
 * A person who pressed Cancel at Google used to land on a fixed page with the
 * provider's own text in the URL. Now the callback asks the API to retire the
 * pending sign-in and name its return path (`oauth/abandon`), and sends them
 * there with one of the store's fixed error codes (`CONNECT_ERRORS`). Nothing
 * the provider wrote travels in a URL.
 */

const FALLBACK = "/owner/integrations";

async function redirectTo(_request: Request, path: string, params: Record<string, string>): Promise<NextResponse> {
  // Through consoleUrl, not `new URL(path, origin)`: a redirect does not get
  // the /admin basePath on its own - see lib/console-url.ts. And the PUBLIC
  // origin, not request.url's: behind nginx a route handler sees the address
  // the server is bound to (https://0.0.0.0:3000), not aura.sirahagents.com.
  const url = consoleUrl(await consolePublicOrigin(), path, undefined, FALLBACK);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}

async function callerHeaders(): Promise<Record<string, string> | null> {
  const owner = await getOwner();
  if (!owner) return null;
  return orgHeaders(owner.membership.orgId, {
    ownerRole: owner.membership.ownerRole,
    userId: owner.userId,
  });
}

/** Back into the flow the sign-in came from, on its method step, with a code. */
async function failed(request: Request, code: ConnectErrorCode, state: string | null): Promise<NextResponse> {
  let path = FALLBACK;
  const headers = state ? await callerHeaders() : null;
  if (state && headers) {
    try {
      const res = await fetch(`${API_URL}/v1/connections/oauth/abandon`, {
        method: "POST",
        headers,
        cache: "no-store",
        body: JSON.stringify({ state }),
      });
      if (res.ok) {
        const data = (await res.json()) as { redirectPath?: string };
        if (data.redirectPath) path = data.redirectPath;
      }
    } catch {
      // The store is a fine place to land when the API cannot say where else.
    }
  }
  // A connect route resumes at its method step; anything else just shows the code.
  const pathname = path.split("?")[0] ?? path;
  return redirectTo(request, path, pathname.endsWith("/connect") ? { step: "auth", error: code } : { error: code });
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const state = query.get("state");

  // The person pressed Cancel, or the provider refused.
  const refused = query.get("error");
  if (refused) {
    return failed(request, refused === "access_denied" ? "denied" : "provider_error", state);
  }

  const code = query.get("code");
  if (!code || !state) return failed(request, "expired", state);

  const headers = await callerHeaders();
  if (!headers) return failed(request, "expired", null);

  try {
    const res = await fetch(`${API_URL}/v1/connections/oauth/complete`, {
      method: "POST",
      headers,
      cache: "no-store",
      body: JSON.stringify({ state, code }),
    });

    // A used, expired or foreign state is refused as 4xx; anything else is
    // the provider or the API failing. `complete` has already consumed the
    // state either way, so there is no return path left to ask for.
    if (!res.ok) return failed(request, res.status < 500 ? "expired" : "provider_error", null);

    const data = (await res.json()) as {
      connection?: { account_email?: string };
      redirectPath?: string;
    };

    // The API re-validates redirectPath as a console path before returning it,
    // so this cannot be pointed off-origin by anything stored earlier.
    return redirectTo(
      request,
      data.redirectPath ?? FALLBACK,
      data.connection?.account_email ? { connected: data.connection.account_email } : {},
    );
  } catch {
    return failed(request, "provider_error", null);
  }
}
