/**
 * The two pages a customer lands on after a Stripe Checkout (doc 26 P2/P3):
 * `/pay/thanks` and `/pay/cancelled`.
 *
 * ── WHY THEY LIVE IN THE MARKETING APP ──────────────────────────────────────
 *
 * They are customer-facing and anonymous: the person paying is a TENANT'S
 * customer, has no account and must never meet a sign-in. Doc 26 puts such
 * pages on the public origin, never under the console's `/admin` basePath.
 * nginx (docker/nginx-aura.conf) sends everything on APP_DOMAIN outside /admin,
 * /v1 and /login to this app, and the API builds Stripe's success/cancel URLs
 * on that origin (apps/api/src/modules/invoices/stripe.ts, publicSiteOrigin).
 *
 * ── WHY A ROUTE HANDLER AND NOT A PAGE ──────────────────────────────────────
 *
 * A page would render inside the site's root layout: Aura's own header and
 * footer, and the Meta Pixel, GTM and Clarity tags. None of that belongs in
 * front of somebody else's customer - least of all trackers they never agreed
 * to, on a payment confirmation. A route handler returns this document and
 * nothing else, so the page carries no chrome, no script and no third party.
 *
 * ── WHAT THE PAGE MAY CLAIM ─────────────────────────────────────────────────
 *
 * A browser arriving here proves only that a browser arrived. The invoice is
 * marked paid by the signed Stripe webhook and nothing else, so "thanks" says
 * the payment is being confirmed - never that the invoice is settled.
 */

export type PayResult = "thanks" | "cancelled";

const CONTENT: Record<PayResult, { title: string; heading: string; body: string }> = {
  thanks: {
    title: "Payment received",
    heading: "Thank you - your payment is being confirmed",
    body:
      "It can take a minute for the payment to show against the invoice. " +
      "You can close this page. The business you paid will send a receipt if they issue one.",
  },
  cancelled: {
    title: "Payment cancelled",
    heading: "Payment cancelled",
    body:
      "No payment was taken. If this was a mistake, open the payment link you were sent " +
      "and try again, or contact the business that sent it.",
  },
};

function html(result: PayResult): string {
  const c = CONTENT[result];
  // Static text only - nothing from the request is interpolated, so there is
  // nothing to escape and nothing a crafted URL can inject.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${c.title}</title>
<style>
  :root { --bg: #ffffff; --text: #0a0a0a; --muted: #525252; --border: #e5e5e5; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0a0a0a; --text: #fafafa; --muted: #a3a3a3; --border: #262626; }
  }
  html, body { margin: 0; background: var(--bg); color: var(--text); }
  body {
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    min-height: 100dvh; display: flex; align-items: center; justify-content: center;
    padding: 24px 16px; box-sizing: border-box;
  }
  main { max-width: 32rem; width: 100%; border: 1px solid var(--border); border-radius: 12px; padding: 28px 24px; }
  h1 { font-size: 1.35rem; line-height: 1.3; margin: 0 0 12px; font-weight: 600; }
  p { margin: 0; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>${c.heading}</h1>
<p>${c.body}</p>
</main>
</body>
</html>`;
}

export function payResultResponse(result: PayResult): Response {
  return new Response(html(result), {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      // Doc 26 adds `?t=<share token>` to these URLs in F1; the token must not
      // leak to anything this page might link to.
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      // No script, no external anything: inline styles are the only resource.
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}
