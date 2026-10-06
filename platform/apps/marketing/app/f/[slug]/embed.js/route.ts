import { WEB_FORM_SLUG_RE } from "@aura/shared/dist/web-forms";
import { SITE_URL } from "@/lib/site";

/**
 * The `<script>` embed (Build docs/39 §16).
 *
 *   <script src="https://example.com/f/diwali-offer/embed.js" async></script>
 *
 * ── IT INJECTS AN IFRAME. IT DOES NOT RENDER A FORM. ──────────────────────
 *
 * §16 is explicit - "no second rendering engine" - and the reason is not
 * tidiness. A widget that rebuilt the fields in the host document would be a
 * second validator, a second conditional-logic evaluator and a second consent
 * renderer, drifting from the hosted page's. The visible failure would be
 * numbers collected under a consent sentence nobody can reproduce, which is
 * the one thing the vault's evidence exists to prevent.
 *
 * It would also put our JavaScript, our CSS and our fonts inside a customer's
 * page, where it inherits their stylesheet, competes with their framework and
 * takes their site down with it when it throws. An iframe is a boundary in
 * both directions.
 *
 * ── THE CONTRACT ──────────────────────────────────────────────────────────
 *
 * The script creates one `<iframe>` pointing at `/f/<slug>?embed=1`, placed
 * where the `<script>` tag sits, or inside `data-target="#some-id"` when the
 * host page says where.
 *
 * The framed page posts to `window.parent`:
 *
 *   { type: "aura-form:height",    slug, height }  on every size change
 *   { type: "aura-form:submitted", slug }          once, after a submission
 *   { type: "aura-form:redirect",  slug, url }     when the form has a
 *                                                  thank-you page of its own
 *
 * This script acts on the first and re-dispatches all three on `window` as
 * `CustomEvent`s of the same name, so a host page can hang analytics off them
 * without talking to us.
 *
 * It does NOT navigate the host page on `redirect`. The visitor is on somebody
 * else's site and did not ask to leave it; the framed page renders a visible
 * link instead, and a host page that genuinely wants the jump can listen for
 * the event and do it itself, having decided to.
 *
 * ── WHY IT IS GENERATED HERE AND NOT A STATIC FILE ────────────────────────
 *
 * The slug and the origin are baked in, so the snippet a tenant copies is one
 * line with nothing to configure and nothing to get wrong. A static
 * `embed.js` would need the slug as a `data-` attribute and would silently do
 * nothing when somebody pasted the tag without it.
 */

export const dynamic = "force-dynamic";

/**
 * The origin the browser reached us on.
 *
 * Read from the forwarded headers rather than `NEXT_PUBLIC_SITE_URL` alone,
 * because the iframe URL has to match the host this script was fetched from -
 * a mismatch is a second origin, a second cookie jar and, on a deployment
 * behind a preview domain, an iframe that does not load at all. `SITE_URL` is
 * the fallback for a request that arrives with neither header.
 */
function originFor(request: Request): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!host) return SITE_URL;
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  return `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`;
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // The slug is interpolated into a JavaScript string literal below. Nothing
  // but the published shape gets that far - this is the same expression the
  // database's own CHECK carries, so a value that reached here with a quote in
  // it could not have come from a form row.
  if (!WEB_FORM_SLUG_RE.test(slug) || slug.length > 60) {
    return new Response("/* no such form */\n", {
      status: 404,
      headers: { "content-type": "application/javascript; charset=utf-8" },
    });
  }

  const src = `${originFor(request)}/f/${slug}?embed=1`;
  return new Response(script(slug, src), {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      // Five minutes. Long enough that a busy page is not refetching it,
      // short enough that a tenant who changes the form's address is not stuck
      // behind somebody else's CDN for a day.
      "cache-control": "public, max-age=300",
      // It is meant to be loaded by any site. That is the feature.
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
    },
  });
}

/**
 * Deliberately ES5-ish and dependency-free.
 *
 * It runs in whatever browser the tenant's own visitors use, inside a page we
 * do not control, possibly alongside a framework that has monkey-patched
 * things. No arrow functions, no `const`, no optional chaining, no polyfill
 * assumptions, and every listener removed once it has done its job.
 */
function script(slug: string, src: string): string {
  return `(function () {
  "use strict";
  var SLUG = ${JSON.stringify(slug)};
  var SRC = ${JSON.stringify(src)};
  var FLAG = "__auraForm_" + SLUG.replace(/[^a-z0-9]/g, "_");

  // Two copies of the same snippet on one page would draw two forms and fight
  // over the height messages. The first one wins; the second does nothing.
  if (window[FLAG]) return;
  window[FLAG] = true;

  var tag = document.currentScript;
  var target = null;
  if (tag && tag.getAttribute("data-target")) {
    try { target = document.querySelector(tag.getAttribute("data-target")); } catch (e) { target = null; }
  }

  var frame = document.createElement("iframe");
  frame.src = SRC;
  frame.title = "Form";
  frame.loading = "lazy";
  frame.setAttribute("scrolling", "no");
  frame.style.width = "100%";
  frame.style.border = "0";
  // A first height before any message arrives, so the form is not a 0px slot
  // while it loads. Replaced by the real one within a frame of it rendering.
  frame.style.minHeight = "520px";
  frame.style.transition = "height 120ms ease-out";

  if (target) target.appendChild(frame);
  else if (tag && tag.parentNode) tag.parentNode.insertBefore(frame, tag);
  else document.body.appendChild(frame);

  function relay(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent(name, { detail: detail }));
    } catch (e) {
      // CustomEvent's constructor is missing on very old engines. The iframe
      // still works; only the host page's optional hook is lost.
    }
  }

  window.addEventListener("message", function (event) {
    // The frame we created, and nothing else on the page. Without this check
    // any other frame could resize ours, and any script could fake a
    // "submitted" event into the host page's analytics.
    if (!frame.contentWindow || event.source !== frame.contentWindow) return;
    var data = event.data;
    if (!data || typeof data !== "object" || data.slug !== SLUG) return;

    if (data.type === "aura-form:height") {
      var height = Number(data.height);
      // Bounded: a bad number would either collapse the form or make the host
      // page scroll for a mile.
      if (isFinite(height) && height > 0 && height < 20000) {
        frame.style.minHeight = "0px";
        frame.style.height = Math.ceil(height) + "px";
      }
      return;
    }
    if (data.type === "aura-form:submitted") { relay("aura-form:submitted", { slug: SLUG }); return; }
    if (data.type === "aura-form:redirect") {
      // Relayed, never acted on - see this file's header. The host page owns
      // the decision to navigate itself.
      relay("aura-form:redirect", { slug: SLUG, url: String(data.url || "") });
    }
  });
})();
`;
}
