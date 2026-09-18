/**
 * An absolute URL for a console page, for a server-side redirect.
 *
 * `NextResponse.redirect(new URL("/owner/x", origin))` does NOT get Next's
 * basePath - only <Link>, `redirect()` and the router add it. In production the
 * console is mounted at /admin (docker-compose.prod.yml), so a bare path sends
 * the browser to the marketing site's root instead, which 404s. The OAuth
 * callback did exactly that: the connection saved, and the person who had just
 * approved it landed on a "page not found".
 *
 * `target` may carry a query string (the callback appends `?connected=`); it is
 * kept, and anything absolute or protocol-relative is refused in favour of
 * `fallback`, so this cannot be turned into an open redirect.
 */
export function consoleUrl(
  origin: string,
  target: string,
  basePath: string = process.env.NEXT_PUBLIC_BASE_PATH ?? "",
  fallback = "/owner/connections",
): URL {
  const path = target.startsWith("/") && !target.startsWith("//") ? target : fallback;
  const prefix = basePath.replace(/\/+$/, "");
  // Already prefixed (a caller that built it from a basePath-aware source)
  // must not become /admin/admin/...
  const full = prefix && (path === prefix || path.startsWith(`${prefix}/`)) ? path : `${prefix}${path}`;
  return new URL(full, origin);
}
