/**
 * Site-wide constants and link builders.
 *
 * Everything here is build-time static: no fetch, no env read at request time,
 * nothing that would push a content page out of static rendering.
 */

/**
 * Public origin of the marketing site.
 *
 * CHANGED 2026-10-14 to the brand domain, auratel.sirahdigital.in. Before that
 * it was aura.sirahagents.com (itself a change from the apex on 2026-08-09,
 * when the apex turned out to resolve to a different server entirely —
 * 3.146.153.124 — so there was nowhere to publish).
 *
 * One host still serves all three surfaces, split by path in nginx:
 *
 *   /v1/*     the API           - also answers on the legacy host, forever
 *   /admin*   the console       - Next `basePath`, see apps/web/next.config.ts
 *   /         this site
 *
 * aura.sirahagents.com has NOT gone away and cannot: handsets enrolled before
 * the cutover carry that hostname in their activation payload and upload
 * recordings to /v1 on it, with no remote way to re-point them. It keeps
 * serving /v1 and the console, and 301s the marketing root here — so this is
 * the one canonical origin for the public pages. See docker/nginx-aura.conf.
 */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://auratel.sirahdigital.in";

/**
 * The live console. Existing customers sign in here.
 *
 * Includes the /admin prefix, because the console is served under it - so
 * `${CONSOLE_URL}/login` resolves to /admin/login. Without the prefix that link
 * lands on THIS site's 404, which is a particularly bad way to greet a customer
 * trying to sign in.
 */
export const CONSOLE_URL = "https://auratel.sirahdigital.in/admin";

/**
 * The one console sign-in, shown as a quiet "Log in" link in the header and
 * footer (owner's request, 2026-09-17 - reversing the 2026-08-08 "address, not
 * a button" decision). Operators and customers share it on purpose: the console
 * routes by role after sign-in (app/(platform)/layout.tsx sends an owner to
 * their CRM at /owner), so no visitor has to know which console is theirs.
 */
export const CONSOLE_LOGIN_URL = `${CONSOLE_URL}/login`;

export const BRAND = "Auratel";
export const BRAND_LINE = "Every call, accounted for.";
export const LEGAL_ENTITY = "Sirah Digital";

/* ────────────────────────────────────────────────────────────────────────────
   WhatsApp - the primary CTA (doc 10 §2).

   There is no WhatsApp number anywhere in this repository, and inventing one
   would ship a dead primary CTA to production. It is configured, not hardcoded.

   Set NEXT_PUBLIC_WHATSAPP_NUMBER to the number in international format with no
   `+`, spaces or dashes - e.g. 919876543210. Until it is set, every WhatsApp
   CTA renders as a visibly unconfigured placeholder rather than a link that
   goes nowhere. That is deliberate: a broken CTA that looks fine is worse than
   one that announces itself.
   ──────────────────────────────────────────────────────────────────────────── */

const RAW_WHATSAPP = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER?.replace(/[^\d]/g, "") ?? "";

/** null when unconfigured - callers must handle it. */
export const WHATSAPP_NUMBER: string | null =
  RAW_WHATSAPP.length >= 10 ? RAW_WHATSAPP : null;

/**
 * A `wa.me` deep link with a pre-filled message. No backend, no SDK, no script
 * tag - it is an `<a href>`, which is why it works identically on Android and
 * iOS and costs nothing in the JS budget.
 */
export function whatsappHref(message: string): string | null {
  if (!WHATSAPP_NUMBER) return null;
  return `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;
}

/** Pre-filled openers, one per placement, so replies arrive with context. */
export const WA_MESSAGES = {
  hero: "Hi, I read about Auratel and I'd like to know if it works for my team.",
  customCrm:
    "Hi, I saw the custom CRM section on your site. Here's how we sell today:",
  compatibility: "Hi, I want to check whether Auratel works on my team's phones.",
  pricing: "Hi, I'd like to understand Auratel's pricing for my team.",
  footer: "Hi, I have a question about Auratel.",
} as const;

/**
 * Sent once a visitor actually claims a slot on `/start` - replaces the
 * instant "Hi" that used to fire the moment someone finished qualifying
 * (owner's decision, 2026-08-12). The handoff now happens only after a real
 * slot is booked, and the message carries their name and the time they
 * picked so the reply on WhatsApp already has enough context to confirm.
 */
export function slotBookedMessage(name: string, dayLabel: string, timeLabel: string): string {
  return `Hi, I am ${name} and I've booked the slot ${timeLabel} on ${dayLabel}`;
}

/* ────────────────────────────────────────────────────────────────────────────
   The funnel (slice 4/5). `/start` is the form-first variant's entry route and
   does not exist yet - these builders exist now so the links written across the
   homepage carry correct UTM attribution from day one.
   ──────────────────────────────────────────────────────────────────────────── */

export function startHref(source: string, campaign = "homepage"): string {
  const q = new URLSearchParams({
    utm_source: "site",
    utm_medium: "cta",
    utm_campaign: campaign,
    utm_content: source,
  });
  return `/start?${q.toString()}`;
}

/**
 * Gates the funnel CTA on the reference pages (/compatibility, /security, …).
 *
 * `/start` now exists, so this is no longer about a 404. It stays false because
 * the route cannot yet persist a submission - FUNNEL_DATABASE_URL is unset, so
 * step 1 fails loud rather than dropping a real person's details. Flip it to
 * true once the funnel database is wired up; until then the homepage and header
 * carry the only two entrances, which are the ones being watched.
 */
export const FUNNEL_LIVE = false;

/* ──────────────────────────────────────────────────────────────────────────── */

/**
 * Header navigation - EMPTY, deliberately.
 *
 * Emptied on 2026-08-08 at the owner's instruction. This is a landing page with
 * one job, and every nav link is an invitation to do something other than that
 * job. "How it works" and "What you get" both scrolled to sections the visitor
 * reaches anyway by scrolling, so the links bought nothing and cost the one
 * decision the page is asking for.
 *
 * The sections keep their ids (#how-it-works, #what-you-get) so they stay
 * addressable from a campaign link or an email - they are simply not advertised
 * in the header.
 *
 * Restoring nav is one line: put the entries back. Every href must resolve to
 * an id in components/landing.tsx.
 */
/**
 * RESTORED 2026-10-13, at the owner's instruction, after being empty since
 * 2026-08-08.
 *
 * The 2026-08-08 reasoning is left above because it was correct for what the
 * site was then: one landing page with one job, where every nav link is an
 * invitation to do something other than that job. The site is no longer that.
 * There are now four pages a stranger has a real reason to want - what the
 * product does, what it costs, whether their handsets work, and what happens
 * to their recordings - and with no nav the only route to any of them was the
 * footer or a search result. An empty nav stops being focus and starts being
 * a dead end once the site has somewhere to go.
 *
 * Four items, not seven. Every href is a real page, never an in-page anchor:
 * the anchors were what made the old nav scroll people to the footer when the
 * homepage was cut, and a nav that lies about where it goes is worse than no
 * nav at all. These are also the four pages carrying breadcrumbs, so the
 * header, the crumb trail and the sitemap all describe the same structure.
 */
export const NAV: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/call-tracking-dashboard", label: "What it does" },
  { href: "/pricing", label: "Pricing" },
  { href: "/compatibility", label: "Phones" },
  { href: "/security", label: "Your data" },
];

/* ────────────────────────────────────────────────────────────────────────────
   The handset app.

   Hardcoded for the same reason CONSOLE_URL is: this is where the API lives,
   and nginx has routed `/v1/*` on the primary host since before this site
   existed.

   This is the DOWNLOAD origin for a human clicking a link in a browser, which
   is why it moved to the brand domain on 2026-10-14. It is not the origin a
   handset uploads to — that one is stored per-device in the app's own prefs
   (ActivationStore.kt) and for every phone enrolled before the cutover it is
   still aura.sirahagents.com. Do not collapse the two: they look like the same
   fact and are not, and the legacy host serves /v1 precisely so they can
   disagree safely.

   Absolute rather than relative even though this site is served from the SAME
   origin today. A relative `/v1/...` would silently 404 the day the marketing
   site is served from somewhere nginx has no /v1 block - and it would fail as
   a broken download rather than as a broken page, which is the kind of
   breakage nobody reports.
   ──────────────────────────────────────────────────────────────────────────── */

export const API_ORIGIN = "https://auratel.sirahdigital.in";

/** The public APK. 302s to a presigned URL that expires in fifteen minutes,
 *  so this link is the shareable one - never the address it redirects to. */
export const APP_DOWNLOAD_URL = `${API_ORIGIN}/v1/app/download`;
