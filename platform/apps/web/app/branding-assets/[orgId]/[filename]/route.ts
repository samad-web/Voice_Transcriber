import { API_URL } from "@/lib/server-api";

/**
 * The browser-facing half of the branding-upload pipeline. Every uploaded
 * logo/favicon/banner URL the branding form saves points here
 * (`/branding-assets/<orgId>/<filename>`), never at the API directly - nothing
 * else in this console is ever loaded straight off `API_URL` from a browser,
 * and this asset is no exception: it is a same-origin proxy to
 * `branding-assets.controller.ts`, which is itself the one API route with no
 * auth guard of its own.
 *
 * `middleware.ts`'s matcher already excludes image extensions
 * (`\.(?:svg|png|jpg|...)$`), so a request here never triggers the Supabase
 * session refresh that ordinary navigations do - it behaves like any other
 * static asset, which matches what it is.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ orgId: string; filename: string }> },
): Promise<Response> {
  const { orgId, filename } = await params;

  const upstream = await fetch(`${API_URL}/v1/branding-assets/${orgId}/${filename}`, {
    cache: "no-store",
  });
  if (!upstream.ok || !upstream.body) {
    return new Response(null, { status: upstream.status === 404 ? 404 : 502 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
      "Cache-Control":
        upstream.headers.get("Cache-Control") ?? "public, max-age=31536000, immutable",
    },
  });
}
