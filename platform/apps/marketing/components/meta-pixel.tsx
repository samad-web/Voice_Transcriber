"use client";

import { useEffect, useState } from "react";
import Script from "next/script";
import { CONSENT_EVENT, readConsent, type ConsentChoice } from "@/lib/consent-state";

/**
 * Meta (Facebook) Pixel.
 *
 * ── IT IS OFF UNLESS AN ID IS CONFIGURED ───────────────────────────────────
 *
 * `NEXT_PUBLIC_META_PIXEL_ID` gates the whole thing. Without it nothing loads
 * and `trackLead()` is a no-op, which is what every developer machine and
 * preview build should do — a PageView fired from localhost lands in the same
 * dataset as a real visitor's and quietly corrupts the conversion numbers the
 * ad account optimises against. It is a NEXT_PUBLIC_ value baked at build time,
 * so the container build sets it and nothing else does.
 *
 * ── THIS CHANGES WHAT THE PRIVACY POLICY CAN SAY ───────────────────────────
 *
 * The site previously had no analytics, no pixel and no third-party embed, and
 * the drafted privacy policy said so in those words. It no longer can, and §3
 * of app/privacy/page.tsx has been rewritten to match. That page is still gated
 * behind lib/legal.ts so nothing false has been published — but if the pixel
 * ships before the policy does, the site is tracking visitors while telling
 * them nothing, which is the wrong order.
 *
 * ── IT DOES NOT LOAD UNTIL THE VISITOR AGREES ──────────────────────────────
 *
 * An advertising pixel is not "strictly necessary", so under India's DPDP Act
 * and the GDPR it needs consent BEFORE it runs, not a notice afterwards. It
 * shipped without a gate on 2026-08-09 and this closes that, same day.
 *
 * Nothing here renders while the answer is unknown or denied: no script tag, no
 * `noscript` tracking pixel, no request to Meta at all. The common pattern is to
 * load the tracker and ask afterwards, which makes the question decorative and
 * the consent worthless; if the answer arrives later, the `CONSENT_EVENT`
 * listener mounts the script then, with no page reload.
 *
 * The `noscript` <img> is inside the gate too, and that is not an oversight to
 * fix — it is a tracking request in its own right, and a visitor with
 * JavaScript disabled is precisely the one who cannot have clicked Accept.
 */

const PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID?.trim();

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & { queue?: unknown[] };
  }
}

export function MetaPixel() {
  const [choice, setChoice] = useState<ConsentChoice>("unknown");

  useEffect(() => {
    setChoice(readConsent());
    const onChange = (e: Event) => setChoice((e as CustomEvent).detail as ConsentChoice);
    window.addEventListener(CONSENT_EVENT, onChange);
    return () => window.removeEventListener(CONSENT_EVENT, onChange);
  }, []);

  // Two independent gates. The id is a deployment decision (production only);
  // the choice is the visitor's. Either one alone is enough to load nothing.
  if (!PIXEL_ID || choice !== "granted") return null;

  return (
    <>
      {/* `afterInteractive` rather than `beforeInteractive`: the pixel is not
          needed to render anything, and blocking first paint on an ad script is
          how a fast landing page stops being one. */}
      <Script id="meta-pixel" strategy="afterInteractive">
        {`!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '${PIXEL_ID}');
fbq('track', 'PageView');`}
      </Script>
      <noscript>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          height="1"
          width="1"
          style={{ display: "none" }}
          alt=""
          src={`https://www.facebook.com/tr?id=${PIXEL_ID}&ev=PageView&noscript=1`}
        />
      </noscript>
    </>
  );
}

/**
 * The conversion: a meeting actually booked.
 *
 * Fired from the funnel's booking success path, NOT from the /booked page and
 * NOT from reaching the slot picker. Those are both cheaper to trigger and
 * neither means what "Lead" is supposed to mean — /booked is reachable by
 * typing the URL, and seeing the picker only means somebody qualified. An
 * optimisation target that counts near-misses teaches the ad account to buy
 * near-misses.
 *
 * Guarded on `window.fbq` because it is absent whenever the pixel is
 * unconfigured or still loading, and an unguarded call would throw inside the
 * success handler — turning a completed booking into an error the visitor sees.
 */
export function trackLead(): void {
  if (typeof window === "undefined") return;
  try {
    window.fbq?.("track", "Lead");
  } catch {
    // Analytics must never be able to break a booking that has already
    // happened. The row is in the database either way.
  }
}
