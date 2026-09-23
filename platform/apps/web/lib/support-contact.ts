/**
 * Who a customer asks when the answer is their provider's to give: a plan
 * change, an app the deployment does not offer, a connector only the operator
 * can set up.
 *
 * `NEXT_PUBLIC_SUPPORT_CONTACT` is an email address or an http(s) URL; this
 * returns a link to it, or null when it is unset or is neither.
 *
 * Read through a local alias on purpose: Next inlines a literal
 * `process.env.NEXT_PUBLIC_*` at BUILD time even in server code, and this value
 * is not a Dockerfile build arg - it arrives at runtime through the web
 * service's env_file. The alias is a lookup Next does not rewrite, so changing
 * it needs a restart, not a rebuild. Server code only, for the same reason.
 */
export function supportHref(): string | null {
  const env = process.env;
  const raw = (env.NEXT_PUBLIC_SUPPORT_CONTACT ?? "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) return `mailto:${raw}`;
  return null;
}

/** What the link says: the address itself, or "your provider's support page". */
export function supportLabel(href: string): string {
  return href.startsWith("mailto:") ? href.slice("mailto:".length) : "your provider's support page";
}
