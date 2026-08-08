"use client";

import Script from "next/script";

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
 * ── CONSENT IS A DECISION NOBODY HAS MADE YET ──────────────────────────────
 *
 * An advertising pixel is not "strictly necessary", so under the DPDP Act and
 * the GDPR it normally needs consent BEFORE it loads, not a notice afterwards.
 * This component does not implement that: it loads on every page view. That was
 * the instruction, and it is a live compliance exposure rather than a
 * theoretical one, so it is written down here rather than left implicit.
 *
 * Making it consent-gated is a small change to this file plus a banner — the
 * hard part is deciding to, not building it.
 */

const PIXEL_ID = process.env.NEXT_PUBLIC_META_PIXEL_ID?.trim();

declare global {
  interface Window {
    fbq?: ((...args: unknown[]) => void) & { queue?: unknown[] };
  }
}

export function MetaPixel() {
  if (!PIXEL_ID) return null;

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
