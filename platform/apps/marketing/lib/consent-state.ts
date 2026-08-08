/**
 * Whether the visitor has agreed to advertising tracking.
 *
 * ── WHY A VERSION IS BAKED INTO THE KEY ────────────────────────────────────
 *
 * Consent is to a SPECIFIC set of processing, not a permanent waiver. If a
 * second tracker is ever added, the thing the visitor agreed to has changed and
 * the old answer no longer covers it. Bumping `CONSENT_VERSION` re-asks
 * everyone, which is the correct behaviour and is far easier than remembering
 * to clear storage across a fleet of browsers.
 *
 * ── WHY localStorage AND NOT A COOKIE ──────────────────────────────────────
 *
 * A cookie would be sent to the server on every request, and the server has no
 * use for it: the pixel is a client-side script and the decision is enforced in
 * the browser. Storing it server-visible would mean this site set an extra
 * cookie in order to record that someone declined cookies.
 *
 * `unknown` is not the same as `denied`, and the difference is load-bearing:
 * unknown means ask, denied means do not load and do not ask again.
 */

export const CONSENT_VERSION = 1;
export const CONSENT_KEY = `aura.consent.v${CONSENT_VERSION}`;

export type ConsentChoice = "granted" | "denied" | "unknown";

export function readConsent(): ConsentChoice {
  if (typeof window === "undefined") return "unknown";
  try {
    const stored = window.localStorage.getItem(CONSENT_KEY);
    return stored === "granted" || stored === "denied" ? stored : "unknown";
  } catch {
    // Safari private mode and similar throw on access. Treat it as unknown
    // rather than as consent: the failure mode of guessing wrong here is
    // tracking somebody who never agreed.
    return "unknown";
  }
}

export function writeConsent(choice: Exclude<ConsentChoice, "unknown">): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CONSENT_KEY, choice);
  } catch {
    /* If it cannot be stored, the banner reappears next visit. Annoying, and
       still better than assuming agreement we could not record. */
  }
  window.dispatchEvent(new CustomEvent(CONSENT_EVENT, { detail: choice }));
}

/** Lets the pixel react to a decision made in the banner, without a reload. */
export const CONSENT_EVENT = "aura:consent";
