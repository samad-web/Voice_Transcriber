import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { AUTH_ENABLED, SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";

/** Paths reachable without a session. Everything else requires sign-in.
 *
 *  `/docs` is the API reference. Its audience is a tenant's own developer,
 *  who typically has no console login at all - gating it behind one would
 *  shut out the only people it is written for, and it discloses nothing:
 *  the credential that matters is the API key, never a session. */
const PUBLIC_PREFIXES = ["/login", "/auth", "/docs"];

function isPublic(pathname: string) {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Refreshes the Supabase session on every request and gates the app.
 *
 * Two rules keep this from locking anyone out or leaking pages:
 *  - no session on a private path  → redirect to /login?next=<path>
 *  - a session on /login           → redirect to the dashboard
 */
export async function updateSession(request: NextRequest) {
  // Cookies must be mirrored onto the response we ultimately return, so build
  // it up front and let the Supabase client write refreshed tokens into it.
  let response = NextResponse.next({ request });

  if (!AUTH_ENABLED) return response;

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Must run before any redirect below - this is what refreshes an expired
  // access token and writes the new cookies onto `response`.
  //
  // getClaims(), not getUser(): this runs on EVERY request that reaches the
  // matcher, and getUser() means a round trip to the auth server for each one.
  // Supabase is in AWS Seoul and this app runs in Mumbai, so that round trip
  // costs ~125ms each way - paid before a single byte of any page is rendered.
  // getClaims() verifies the ES256 signature locally against the cached JWKS
  // instead, which is the same verification without the flight. See
  // lib/supabase/server.ts for the full reasoning and the HS256 fallback.
  //
  // Refresh still happens: getClaims() with no argument goes through
  // getSession(), which renews an expired access token and writes the new
  // cookies through the setAll callback above exactly as before.
  const { data, error } = await supabase.auth.getClaims();
  const user = error ? null : (data?.claims ?? null);

  const { pathname, search } = request.nextUrl;

  if (!user && !isPublic(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = "";
    // Bounce back to where they were headed once signed in.
    if (pathname !== "/") url.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  if (user && pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return response;
}
