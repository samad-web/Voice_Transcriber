/**
 * The client's IP address, as the production edge proxy reports it
 * (doc 27 §5.3). Used for Login activity - a security log, where a spoofable
 * address is worse than none.
 *
 * ── WHICH HEADER, AND WHY ─────────────────────────────────────────────────
 *
 * Checked 2026-09-21 against the two edges this repo ships:
 *
 *   - docker/nginx-aura.conf (production: host nginx in front of the
 *     docker-compose.nginx.yml loopback ports) sets
 *       X-Real-IP        $remote_addr                 - REPLACES any client value
 *       X-Forwarded-For  $proxy_add_x_forwarded_for   - APPENDS $remote_addr to
 *                                                      whatever the client sent
 *   - docker/Caddyfile (the caddy profile) uses Caddy 2's reverse_proxy
 *     defaults: X-Forwarded-For is set to the peer address and an incoming one
 *     is ignored (no trusted_proxies configured), and X-Real-IP is NOT touched,
 *     so a client-supplied X-Real-IP passes straight through.
 *
 * So X-Real-IP is trustworthy behind nginx and forgeable behind Caddy. The
 * right-most X-Forwarded-For hop is the proxy's own observation of the peer
 * behind BOTH: nginx appends it last, and Caddy writes only it. That is the
 * value used. Never the left-most, which is whatever the client typed.
 *
 * If another proxy is ever put in front of these (a CDN), the right-most hop
 * becomes that proxy's address and this must learn to skip it.
 */
export function clientIpFrom(headers: { get(name: string): string | null }): string | null {
  const forwarded = headers.get("x-forwarded-for");
  if (!forwarded) return null;
  const hops = forwarded
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  const last = hops[hops.length - 1];
  if (!last) return null;
  // nginx can hand over an IPv4-mapped IPv6 address; store the plain form.
  const ip = last.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, "$1");
  return /^[0-9a-fA-F:.]{2,45}$/.test(ip) ? ip : null;
}
