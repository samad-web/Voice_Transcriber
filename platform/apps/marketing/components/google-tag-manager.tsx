import Script from "next/script";

/**
 * Google Tag Manager.
 *
 * ── OFF UNLESS A CONTAINER ID IS CONFIGURED ────────────────────────────────
 *
 * `NEXT_PUBLIC_GTM_ID` (a `GTM-XXXXXXX` value) gates the whole thing, for the
 * same reason the Meta pixel is gated on its id: a container firing from a
 * developer machine sends events into the same property a real visitor's do,
 * and the numbers an ad account optimises against are then wrong in a way
 * nobody can see. It is a NEXT_PUBLIC_ value baked at BUILD time, so it has to
 * be a Docker build arg — setting it only at runtime does nothing.
 *
 * ── IT FIRES ON LOAD ───────────────────────────────────────────────────────
 *
 * No consent gate, on the owner's instruction. See the note in meta-pixel.tsx
 * for what that trades away; the short version is that GTM typically loads
 * advertising tags, which DPDP/GDPR expect to be consented to first, and this
 * is the site owner's call to make as data controller.
 *
 * ── WHY `afterInteractive` AND NOT `beforeInteractive` ─────────────────────
 *
 * GTM is not needed to render anything. Google's own snippet goes in <head>,
 * but blocking first paint on a tag manager is how a fast landing page stops
 * being one, and `afterInteractive` still fires well before any visitor
 * finishes reading the hero. The trade is that a tag configured to rewrite the
 * page above the fold would flicker — none is, and none should be.
 *
 * ── THE `noscript` IFRAME ──────────────────────────────────────────────────
 *
 * Google's snippet includes one so that a visitor with JavaScript disabled is
 * still counted. It is included here for the same reason, and it is a real
 * request to Google in its own right — worth knowing, given it is the one part
 * that runs when nothing else does.
 */

const GTM_ID = process.env.NEXT_PUBLIC_GTM_ID?.trim();

/** Goes in <body>. Loads the container and starts the dataLayer. */
export function GoogleTagManager() {
  if (!GTM_ID) return null;

  return (
    <>
      <Script id="gtm" strategy="afterInteractive">
        {`(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':
new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],
j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src=
'https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);
})(window,document,'script','dataLayer','${GTM_ID}');`}
      </Script>
      <noscript>
        <iframe
          src={`https://www.googletagmanager.com/ns.html?id=${GTM_ID}`}
          height="0"
          width="0"
          style={{ display: "none", visibility: "hidden" }}
          title="Google Tag Manager"
        />
      </noscript>
    </>
  );
}
