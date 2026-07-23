import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { AUTH_ENABLED, SUPABASE_ANON_KEY, SUPABASE_URL } from "./config";

/** Paths reachable without a session. Everything else requires sign-in. */
const PUBLIC_PREFIXES = ["/login", "/auth"];

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

  // Must run before any redirect below — this is what refreshes an expired
  // access token and writes the new cookies onto `response`.
  const {
    data: { user },
  } = await supabase.auth.getUser();

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
