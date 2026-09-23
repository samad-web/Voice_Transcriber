/**
 * Send the browser to an OAuth consent screen, or report why not.
 *
 * A full-page redirect, not a popup: the provider's consent screen refuses to
 * render in an iframe, and a popup gets blocked as often as not. Shared by
 * every sign-in the Integrations store's connect flow starts - Google,
 * Microsoft, Facebook, LinkedIn - and the Sheets step's "connect Google first".
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
