/**
 * Send the browser to an OAuth consent screen, or report why not.
 *
 * A full-page redirect, not a popup: the provider's consent screen refuses to
 * render in an iframe, and a popup gets blocked as often as not. Shared by
 * connections-manager.tsx (Google/Microsoft) and meta-ads-client.tsx
 * (Facebook) - same reasoning, same one-liner, previously copy-pasted in
 * both.
 *
 * Returns the message to show on failure, or null once the redirect is under
 * way (there is nothing left to render - the browser is leaving this page).
 */
export function startOAuthRedirect(
  result: { authorizeUrl?: string; error?: string },
  fallbackError: string,
): string | null {
  if (result.error || !result.authorizeUrl) {
    return result.error ?? fallbackError;
  }
  window.location.href = result.authorizeUrl;
  return null;
}
