/**
 * Site-wide constants and link builders.
 *
 * Everything here is build-time static: no fetch, no env read at request time,
 * nothing that would push a content page out of static rendering.
 */

/**
 * Public origin of the marketing site.
 *
 * CHANGED 2026-08-09. This used to be the apex, with a note that it was
 * emphatically NOT aura.sirahagents.com. The apex turned out to resolve to a
 * different server entirely (3.146.153.124), so there was nowhere to publish;
 * aura.sirahagents.com is the host we actually control, and it now serves both.
 * The split is by path, in nginx:
 *
 *   /v1/*     the API           - UNCHANGED, and it must stay that way
 *   /admin*   the console       - Next `basePath`, see apps/web/next.config.ts
 *   /         this site
 *
 * The /v1 line is the load-bearing one. Enrolled handsets carry this hostname
 * in their activation payload and upload recordings to it; they cannot be
 * re-pointed remotely, so that prefix is effectively permanent.
 */
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ?? "https://aura.sirahagents.com";

/**
 * The live console. Existing customers sign in here.
 *
 * Includes the /admin prefix, because the console is served under it - so
 * `${CONSOLE_URL}/login` resolves to /admin/login. Without the prefix that link
 * lands on THIS site's 404, which is a particularly bad way to greet a customer
 * trying to sign in.
 */
export const CONSOLE_URL = "https://aura.sirahagents.com/admin";

/**
 * The console door - an address, not a button.
 *
 * Signing in is not a marketing action. The visitor this site is written for
 * has no account, and a "Sign in" sitting beside the one CTA gives them a
 * second thing to weigh at the exact moment the page is asking them to decide
 * one thing. So console access moved to a URL people who need it already know:
 * `/admin` 307s to the console login (see app/admin/route.ts).
 *
 * This is discoverability, not security. Anyone may follow it; the console's
 * own auth is what protects the console. It is excluded from robots.txt and the
 * sitemap because it is a door, not a page - there is nothing there to index.
 */
export const CONSOLE_ENTRY = "/admin";

export const BRAND = "Aura";
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
  hero: "Hi, I read about Aura and I'd like to know if it works for my team.",
  customCrm:
    "Hi, I saw the custom CRM section on your site. Here's how we sell today:",
  compatibility: "Hi, I want to check whether Aura works on my team's phones.",
  pricing: "Hi, I'd like to understand Aura's pricing for my team.",
  footer: "Hi, I have a question about Aura.",
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
export const NAV: ReadonlyArray<{ href: string; label: string }> = [];
