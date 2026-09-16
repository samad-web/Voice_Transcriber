/**
 * The API's public origin, as seen from OUTSIDE the deployment.
 *
 * The API knows its own routes but not the hostname the internet reaches it
 * on: behind Caddy it answers on `api:4000` inside the compose network and on
 * `https://<app domain>/v1` publicly, and only the deployment's own env knows
 * which. So any page showing a caller (a tenant's website, an integration's
 * developer) a URL to call has to build it here rather than take it from the
 * API. `INTAKE_PUBLIC_URL` if set, otherwise `https://<APP_DOMAIN>`, otherwise
 * the local `API_URL` for development. Getting this wrong shows a URL that
 * 404s from the outside world, which is the most confusing failure this class
 * of feature can have - originally written for the lead-intake webhook URL
 * (`/owner/lead-sources`), reused here for the same reason.
 */
export function publicApiOrigin(): string {
  const explicit = process.env.INTAKE_PUBLIC_URL;
  if (explicit) return explicit.replace(/\/+$/u, "");
  const domain = process.env.APP_DOMAIN;
  if (domain) return `https://${domain}`;
  return (process.env.API_URL ?? "http://localhost:4000").replace(/\/+$/u, "");
}
