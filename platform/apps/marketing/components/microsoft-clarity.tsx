import Script from "next/script";

/**
 * Microsoft Clarity - session recordings and heatmaps.
 *
 * ── OFF UNLESS A PROJECT ID IS CONFIGURED ──────────────────────────────────
 *
 * `NEXT_PUBLIC_CLARITY_PROJECT_ID` gates the whole thing, same reason as the
 * Meta pixel and GTM: a developer machine or preview build recording sessions
 * into the same project as real traffic pollutes the heatmaps and replay
 * list with noise nobody can filter out. Baked in at BUILD time, so it is a
 * Docker build arg - setting it only at runtime does nothing.
 *
 * ── IT FIRES ON LOAD, WITH NO CONSENT PROMPT ───────────────────────────────
 *
 * Same owner decision as meta-pixel.tsx and google-tag-manager.tsx, and it
 * trades away the same thing: Clarity records pages, clicks and (masked)
 * input, which is not "strictly necessary" for the site to function, so
 * DPDP/GDPR normally expect consent before it starts rather than a notice
 * after. /security discloses it; nothing here asks first.
 */

const CLARITY_PROJECT_ID = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID?.trim();

export function MicrosoftClarity() {
  if (!CLARITY_PROJECT_ID) return null;

  return (
    <Script id="ms-clarity" strategy="afterInteractive">
      {`(function(c,l,a,r,i,t,y){
c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;
y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);
})(window, document, "clarity", "script", "${CLARITY_PROJECT_ID}");`}
    </Script>
  );
}
