"use client";

import { useEffect, useState } from "react";
import { CONSENT_EVENT, readConsent, writeConsent, type ConsentChoice } from "@/lib/consent-state";

/**
 * Asks before the advertising pixel loads.
 *
 * ── WHY IT EXISTS ──────────────────────────────────────────────────────────
 *
 * The Meta pixel is not "strictly necessary" for the site to work, so under
 * India's DPDP Act and the GDPR it needs consent BEFORE it runs, not a notice
 * afterwards. It shipped without one; this closes that.
 *
 * ── WHAT MAKES IT AN HONEST BANNER RATHER THAN A DARK PATTERN ──────────────
 *
 * · Decline is a real button, styled the same as accept and sitting next to it.
 *   A greyed-out "manage preferences" three clicks deep is a refusal to take no
 *   for an answer.
 * · Nothing loads while it is open. The usual pattern sets the tracker on page
 *   load and asks afterwards, which makes the question decorative.
 * · Declining is remembered. Re-asking on every page is how a "no" is worn down
 *   into a "yes".
 * · It says what the pixel actually does, in one sentence, rather than
 *   "we value your privacy".
 *
 * It renders nothing until mounted, so the server HTML and the first client
 * render agree — reading localStorage during render would hydrate-mismatch.
 */
/** Nothing to consent to when no pixel is configured, so nothing is asked. */
const PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID?.trim();

export function ConsentBanner() {
  const [choice, setChoice] = useState<ConsentChoice>("unknown");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setChoice(readConsent());
    setMounted(true);
  }, []);

  useEffect(() => {
    const onChange = (e: Event) => setChoice((e as CustomEvent).detail as ConsentChoice);
    window.addEventListener(CONSENT_EVENT, onChange);
    return () => window.removeEventListener(CONSENT_EVENT, onChange);
  }, []);

  if (!PIXEL_ID || !mounted || choice !== "unknown") return null;

  return (
    <div
      role="dialog"
      aria-label="Advertising cookies"
      className="fixed inset-x-0 bottom-0 z-[60] p-3 sm:p-4"
    >
      <div
        className="mx-auto flex max-w-3xl flex-col gap-3 rounded-2xl p-4 sm:flex-row sm:items-center sm:gap-4 sm:p-5"
        style={{
          background: "var(--mk-surface)",
          border: "1px solid var(--mk-line)",
          boxShadow: "var(--mk-shadow)",
        }}
      >
        <p className="text-[0.9375rem] leading-relaxed" style={{ color: "var(--mk-ink)" }}>
          We&rsquo;d like to use the Meta advertising pixel to see which of our ads bring people
          here. It tells Meta that a browser visited this site. Nothing on this site needs it,
          and declining changes nothing about how it works.{" "}
          <a href="/security#advertising" className="underline underline-offset-2">
            What this means
          </a>
        </p>

        <div className="flex shrink-0 gap-2">
          {/* Same size, same prominence. The decision should not be nudged. */}
          <button
            type="button"
            onClick={() => writeConsent("denied")}
            className="h-11 flex-1 rounded-xl border px-4 text-sm font-medium sm:flex-none"
            style={{ borderColor: "var(--mk-line)", color: "var(--mk-ink)" }}
          >
            Decline
          </button>
          <button
            type="button"
            onClick={() => writeConsent("granted")}
            className="mk-cta h-11 flex-1 justify-center px-4 text-sm sm:flex-none"
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  );
}
