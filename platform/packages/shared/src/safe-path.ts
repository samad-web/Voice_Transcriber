/**
 * THE ONE CHECK FOR "IS THIS A PLACE INSIDE THE CONSOLE".
 *
 * Every path the console is told to go to by something it does not control -
 * `?next=` after sign-in, an OAuth handshake's stored `redirect_path`, the
 * connect flow's `?from=`, a list query remembered in sessionStorage - passes
 * through here before it becomes a redirect or an href.
 *
 * ── WHY ONE HELPER AND NOT THREE ────────────────────────────────────────────
 *
 * There were two, `safeNext` (the login form) and `safeRedirectPath` (the
 * OAuth callback), each written as "starts with `/` and not `//`". Both
 * accepted `/\evil.com`, which every browser reads as `//evil.com` - a
 * protocol-relative URL to somebody else's host. In production both happen to
 * be prefixed (the `/admin` basePath, `consoleUrl(origin, …)`), which is
 * probably what stood between that and an open redirect; "probably" is not a
 * property anyone tested. One helper, one test table, and a new caller cannot
 * forget a case the old ones forgot.
 *
 * ── WHAT IT ACCEPTS ─────────────────────────────────────────────────────────
 *
 * A single leading `/`, then path, query and fragment. It refuses `//`, any
 * backslash (raw or percent-encoded), control characters (raw or
 * percent-encoded - `%0a` is a header-splitting classic), anything that fails
 * to decode, and anything over 512 characters. With `prefixes`, the path must
 * also sit under one of them on a whole segment: `/owner` admits
 * `/owner/contacts?stage=won` and not `/ownerx`.
 *
 * It never adds a basePath. `next/link`, `redirect()` and the router add it,
 * and a stored path that already carried one would get it twice.
 */

const MAX_LENGTH = 512;

const CONTROL = /[\u0000-\u001f\u007f]/;

function shapeIsSafe(path: string): boolean {
  if (!path.startsWith("/")) return false;
  if (path.startsWith("//")) return false;
  if (path.includes("\\")) return false;
  if (CONTROL.test(path)) return false;
  return true;
}

/** Whole-segment containment: `/owner` holds `/owner`, `/owner/x` and `/owner?y`, not `/ownerx`. */
export function isUnderPrefix(path: string, prefix: string): boolean {
  if (path === prefix) return true;
  return ["/", "?", "#"].some((sep) => path.startsWith(`${prefix}${sep}`));
}

/**
 * `value` if it is a same-site console path (and under one of `prefixes`,
 * when given), else `fallback`. Never throws.
 */
export function safeConsolePath(
  value: unknown,
  fallback: string,
  prefixes?: readonly string[],
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) {
    return fallback;
  }
  if (!shapeIsSafe(value)) return fallback;

  // The same rules again after one round of decoding, so `%5c` (a backslash)
  // and `%0a` (a newline) cannot walk past the raw check and be decoded by
  // whoever reads the path next.
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  if (!shapeIsSafe(decoded)) return fallback;

  if (prefixes && !prefixes.some((prefix) => isUnderPrefix(value, prefix))) return fallback;
  return value;
}
