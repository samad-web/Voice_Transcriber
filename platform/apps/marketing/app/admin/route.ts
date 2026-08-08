import { CONSOLE_URL } from "@/lib/site";

/**
 * `/admin` — the console door.
 *
 * The public navigation no longer carries a "Sign in" link (doc 10 §2 had it
 * de-emphasised in the header; on 2026-08-08 the owner took it out entirely, so
 * that the marketing site asks a visitor for exactly one decision). Existing
 * customers and the team reach the console by typing this address instead.
 *
 * A route handler rather than a page: there is no UI here and nothing to
 * render, so this never boots React, ships no HTML and no JS, and the browser
 * is redirected before a frame is painted. A page component calling `redirect()`
 * would do the same job through a render pass it does not need.
 *
 * 307, not 308: the redirect is temporary in the HTTP sense because
 * CONSOLE_URL is a deployment fact that may change, and a 308 is cached by the
 * browser more or less permanently — a wrong 308 is very hard to take back.
 *
 * This is not an access control. It hides the door from a visitor who has no
 * reason to open it; the console's own Supabase auth and the operator allowlist
 * are what actually protect what is behind it.
 */
export function GET(): Response {
  return Response.redirect(`${CONSOLE_URL}/login`, 307);
}
