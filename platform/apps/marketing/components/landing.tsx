import Link from "next/link";
import { Proof } from "@/components/proof";

/**
 * The landing page, in five sections.
 *
 * Cut down from thirteen on 2026-08-08 at the owner's instruction: explain the
 * application, and give it one way in. Everything that used to sit here and is
 * not one of these five — pricing, integrations grid, FAQ, language proof,
 * compatibility teaser, the trust block, the custom-CRM fork — still exists as
 * components and on its own pages. It is off the homepage, not deleted.
 *
 * The single conversion target is the form at /start. Every CTA on this page
 * points there and nowhere else; a landing page with four competing next steps
 * has none.
 */

const CTA_HREF = "/start";

/* ── 1 · Hero ──────────────────────────────────────────────────────────────
   The claim, one button, and the product's actual sequence — a call becoming a
   row — rather than stock illustration, because the sequence IS the pitch and
   a drawing of shopping bags would not be.

   The logo lockup that used to open this section is gone. The sticky header
   carries the identical mark and wordmark about sixty pixels above it, and on
   a phone the two sat close enough to read as a bug rather than as branding.
   Repeating a logo does not make it register harder.

   Padding steps three times instead of twice. `pt-20 pb-24` is 80/96px, which
   is right on a 1440px canvas and is a fifth of the screen on a 390px phone —
   space a mobile visitor pays for in scrolling before they reach anything. */

function Hero() {
  return (
    <section className="relative overflow-x-clip">
      <div className="mk-wash" />
      <div className="relative z-10 mx-auto grid max-w-6xl items-center gap-10 px-5 pt-6 pb-14 sm:gap-12 sm:px-6 sm:pt-10 sm:pb-20 lg:grid-cols-[1.05fr_0.95fr] lg:gap-14 lg:pt-16 lg:pb-32">
        {/* Capped at a readable measure below `lg`. Without it, the headline
            runs the full 768px of a tablet — around 90 characters, well past
            the 45-75 that stays comfortable to read — while the lede stops at
            56ch and leaves a ragged column of dead space beside it. */}
        {/* HEADLINE = the dream outcome, and the effort removed from it.
            "The data that's worth saving" named what we sell; an owner does not
            want data, they want to know which telecaller is losing them deals.
            The second clause kills the objection the first one raises — "so I
            have to listen to all of them?" — before it is asked. */}
        <div className="max-w-[36rem] lg:max-w-none">
          <h1 className="mk-display mk-h1">
            Know what your team is really saying{" "}
            <span className="mk-gradient-text">without listening to a single call.</span>
          </h1>

          <p className="mk-lede mt-5 sm:mt-6">
            Aura writes down every call your telecallers make, in Tamil and English, and
            tells you what they add up to: which days convert, which people convert, and
            which objection keeps ending the conversation.
          </p>

          <div className="mt-8 sm:mt-10">
            {/* THE ASK NAMES WHAT HAPPENS NEXT. "Get started" describes the
                button's mechanics; this names the thing the visitor ends up
                with, which is the only reason anyone presses anything.

                First person on purpose — "Book my call", not "Book your call".
                It reads as the visitor's own words rather than the site giving
                an instruction. */}
            <Link href={CTA_HREF} className="mk-cta">
              Book my call now
              <span aria-hidden="true">→</span>
            </Link>

            {/* RISK REVERSAL, directly under the ask and not buried beside it.
                Money-back guarantees are off the table here by instruction, so
                this reverses the other risks a stranger is actually weighing:
                effort, commitment, and being sold to. */}
            <ul className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-sm" style={{ color: "var(--mk-muted)" }}>
              {[
                "Nothing to install",
                "No obligation",
                "We'll tell you honestly if it isn't a fit",
              ].map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: "var(--brand-gradient)" }}
                    aria-hidden="true"
                  />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <CallToLeadVisual />
      </div>
    </section>
  );
}

/**
 * The alt text carries the whole point of the image, because for anyone who
 * cannot see it the animation IS the argument. It is long on purpose — an
 * image that makes a claim needs alt text that makes the same claim.
 */
const VISUAL_ALT =
  "An incoming sales call playing back. The transcript switches between Tamil, " +
  "“20,000 bricks venum, Perundurai site-ku. Rate enna irukku?”, then the same " +
  "exchange in English, while the panel underneath stays unchanged: quantity 20,000 " +
  "units, product interlock brick, site Perundurai, rate ₹32 per unit, value ₹6,40,000, " +
  "next step advance by Friday. Aura extracts the same details from either language.";

/**
 * The product's own sequence — a live call becoming a CRM row.
 *
 * Shipped as an animated image at the owner's instruction (2026-08-08), after
 * the CSS version turned out to be invisible on their machine: Windows had
 * animation effects switched off, so Chromium reported
 * prefers-reduced-motion: reduce and froze it. A raster plays regardless of
 * that setting, which is the real reason this format wins here.
 *
 * The source of truth is still components/call-card.tsx, rendered by the
 * dev-only route /capture/hero-card and recorded by scripts/capture-hero-gif.mjs.
 * The image is generated from the product, never drawn by hand.
 *
 * SIX FILES, and the browser downloads exactly one:
 *
 *   hero-card-sm.webp       460 KB   phones (≤640px), 700px wide
 *   hero-card.webp          770 KB   tablet and up, 1064px wide — retina
 *   hero-card.gif          2.04 MB   fallback, light
 *   hero-card-dark-sm.webp  290 KB   phones, dark
 *   hero-card-dark.webp     430 KB   tablet and up, dark
 *   hero-card-dark.gif     2.67 MB   fallback, dark
 *
 * Why each split exists:
 *
 * · TWO WIDTHS, because the card renders about 330px on a phone and up to
 *   554px on desktop. Sending 1064px of retina detail to a phone on 4G costs
 *   300 KB to paint pixels that screen cannot resolve — and a phone on 4G in
 *   Tamil Nadu is precisely who this page is written for.
 * · TWO THEMES, because a raster cannot re-colour itself. Without the dark
 *   pair a dark-mode visitor gets a white slab in the middle of a black page.
 * · WEBP THEN GIF, because the same six seconds cost 770 KB as WebP and
 *   2.04 MB as GIF, at better colour. The GIF is the fallback for a browser
 *   without animated WebP; in practice nothing modern fetches it.
 *
 * Source order matters: the browser takes the FIRST source whose media and
 * type it can satisfy, so narrow-and-dark has to be listed before wide-and-dark,
 * and every WebP before the GIF.
 *
 * Quality notes, both learned the hard way:
 * · Captured at 2x. Playwright encodes video at recordVideo.size and will not
 *   supersample, so the page is zoomed 2x into a doubled surface. A 1x capture
 *   looked soft on every retina screen.
 * · Palette is undithered. Bayer dithering scatters pixels to fake missing
 *   colours; on 11px uppercase labels that reads as the text being out of
 *   focus. This card is flat fills plus one gradient, so 256 entries cover it
 *   without any dithering at all.
 */
function CallToLeadVisual() {
  return (
    <picture>
      <source
        srcSet="/hero-card-dark-sm.webp"
        type="image/webp"
        media="(prefers-color-scheme: dark) and (max-width: 640px)"
      />
      <source srcSet="/hero-card-dark.webp" type="image/webp" media="(prefers-color-scheme: dark)" />
      <source srcSet="/hero-card-dark.gif" type="image/gif" media="(prefers-color-scheme: dark)" />
      <source srcSet="/hero-card-sm.webp" type="image/webp" media="(max-width: 640px)" />
      <source srcSet="/hero-card.webp" type="image/webp" />
      <img
        src="/hero-card.gif"
        alt={VISUAL_ALT}
        width={700}
        height={737}
        // Intrinsic size declared so the browser reserves the box before the
        // file lands — without it the hero reflows on load, which is both a
        // Core Web Vitals penalty and visibly janky.
        //
        // The radius and shadow are applied HERE rather than baked into the
        // image. Baking them meant capturing a flat page-ground around the
        // card, which then showed as a hard-edged rectangle sitting on top of
        // the hero's gradient wash — a visible vertical seam beside the card.
        // The raster is now the card face only; CSS clips the corners and
        // draws the lift, so it stays theme-aware and seamless.
        className="mx-auto block h-auto w-full"
        style={{
          maxWidth: "554px",
          borderRadius: "var(--mk-radius)",
          boxShadow: "var(--mk-shadow-lift)",
        }}
        loading="eager"
        fetchPriority="high"
        decoding="async"
      />
    </picture>
  );
}

/* ── 2 · The problem ──────────────────────────────────────────────────────── */

function Problem() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-20 lg:py-24">
      <div className="grid gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-20">
        <div>
          <p className="mk-eyebrow mb-4">The problem</p>
          {/* Restored 2026-08-09 at the owner's request, from the earlier
              version in components/home/problem.tsx. The 400 figure is
              illustrative and reads as such in context ("your team"); doc 10
              §15 bans invented numbers presented as proof, and this is a
              scenario attributed to nobody. It replaced
              "You want to fix what isn't working. Nobody can tell you what
              that is." */}
          {/* The gradient sits on "400 calls", not on the second sentence.
              The number is the thing that makes an owner stop, and one
              highlight per heading is the whole point of having one, so it
              moved rather than being added alongside. */}
          <h2 className="mk-display mk-h2">
            Your team made <span className="mk-gradient-text">400 calls</span> last month. You
            listened to none of them.
          </h2>
        </div>
        <div className="space-y-5">
          <p className="mk-lede">
            To know where your team needs to improve, you need the data. The data is
            four hundred phone calls nobody wrote down. So you go on impressions,
            and you train everyone on the same generic advice.
          </p>
          <p className="mk-lede">
            What you actually need is someone to sit through every call, consolidate
            it, and hand you the answer. That is a full-time job nobody has time to do
           , which is why it never gets done.
          </p>
          <ul className="mt-8 space-y-4">
            {[
              "You cannot see which days convert and which ones your team wastes",
              "You cannot see which telecaller closes and which one only dials",
              "The objection that killed the deal was handled well by somebody, and nobody else heard it",
            ].map((t) => (
              <li key={t} className="flex gap-3 text-[0.9375rem]">
                <span
                  className="mt-2 h-1.5 w-1.5 flex-none rounded-full"
                  style={{ background: "var(--brand-gradient)" }}
                  aria-hidden="true"
                />
                <span style={{ color: "var(--mk-ink)" }}>{t}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/* ── 3 · How it works ─────────────────────────────────────────────────────
   Numbered, because this is genuinely a sequence — a call cannot be extracted
   before it has been transcribed. Numbering a set of unordered feature cards
   would be decoration; here the order carries information. */

const STEPS = [
  {
    t: "Your team keeps using their phones",
    d: "No new number, no new app for anyone to learn, nothing for your customer to install. The handset records the call the way it already does.",
  },
  {
    t: "The recording uploads by itself",
    d: "Encrypted in transit, over whatever connection the phone has. If it drops, it retries. Nobody has to remember to send anything.",
  },
  {
    t: "It gets transcribed and read",
    d: "Tamil and English, including the half-and-half sentences people actually speak. Then the details you care about are pulled out of it.",
  },
  {
    // Named connectors, and ONLY the eleven that are actually live. Zoho,
    // Salesforce, monday.com and Dynamics are OAuth-pending in the catalogue —
    // naming Zoho here would be the single most damaging thing on the page,
    // because it is the CRM most of this market already runs.
    t: "It becomes a lead in your CRM",
    d: "LeadSquared, HubSpot, Freshsales, Pipedrive and seven more. The lead is created for you with the fields already in the right boxes. No CRM? Use Aura’s own board. Either way nobody types it twice.",
  },
];

function HowItWorks() {
  return (
    <section
      id="how-it-works"
      className="mk-anchor border-y py-16 sm:py-20 lg:py-24"
      style={{ borderColor: "var(--mk-line)", background: "var(--mk-surface)" }}
    >
      <div className="mx-auto max-w-6xl px-5 sm:px-6">
        <p className="mk-eyebrow mb-4">How it works</p>
        <h2 className="mk-display mk-h2 max-w-2xl">
          Four steps, and your team does none of them.
        </h2>

        {/* A connected timeline, filling as you scroll. The rail and the reveal
            are CSS scroll-driven animation (brand.css) — no IntersectionObserver,
            so the homepage stays a server component with no hydration bundle.
            Four across at `lg` keeps the section shorter than the 2x2 grid it
            replaced. */}
        <ol className="mk-timeline mt-10 sm:mt-14">
          {STEPS.map((s, i) => (
            <li key={s.t} className="mk-tl-step">
              <span className="mk-step-num" aria-hidden="true">
                {i + 1}
              </span>
              <div>
                <h3 className="text-lg font-semibold">{s.t}</h3>
                <p className="mt-2 text-[0.9375rem] leading-relaxed" style={{ color: "var(--mk-muted)" }}>
                  {s.d}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ── 4 · What you get ─────────────────────────────────────────────────────
   Outcomes, not feature names. "Know why you lose" is what an owner buys;
   "objection extraction" is how it is built. */

/* Every claim here is a thing the product does today.
     · calls and leads per day    owner dashboard
     · telecaller attribution     leads carry the telecaller who made the call
     · objections                 an extracted field, pulled per call
   Nothing aspirational, per doc 10 §15. */
const OUTCOMES = [
  {
    t: "Which days actually convert",
    d: "Calls and leads, day by day. So you stop guessing whether Monday mornings are worth staffing and start knowing.",
  },
  {
    t: "Which telecaller actually converts",
    d: "Not who dialled the most. Who turned calls into leads, and, because every call is written down, what they say that the others do not.",
  },
  {
    t: "The objections, counted",
    d: "What people actually push back on, across every call, ranked. Not the one objection your loudest telecaller mentioned in the meeting.",
  },
  {
    t: "Something to train on",
    d: "A real call where the objection was handled well, in writing, ready to read out in Monday's huddle. Coaching from evidence instead of opinion.",
  },
  {
    t: "Consolidated, not raw",
    d: "You are not being handed four hundred recordings to listen to. You are handed what they add up to.",
  },
  {
    t: "Built for how Tamil Nadu sells",
    d: "Tamil and English, including code-switching mid-sentence. Not an English product with a translation bolted on.",
  },
];

function Outcomes() {
  return (
    <section id="what-you-get" className="mk-anchor mx-auto max-w-6xl px-5 py-16 sm:px-6 sm:py-20 lg:py-24">
      <p className="mk-eyebrow mb-4">What you get</p>
      <h2 className="mk-display mk-h2 max-w-2xl">
        Six answers a call log will never give you.
      </h2>

      <div className="mt-10 grid gap-4 sm:mt-14 sm:gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {OUTCOMES.map((o) => (
          <div key={o.t} className="mk-card p-7">
            <span
              className="mb-5 block h-1 w-10 rounded-full"
              style={{ background: "var(--brand-gradient)" }}
              aria-hidden="true"
            />
            <h3 className="text-lg font-semibold">{o.t}</h3>
            <p className="mt-2.5 text-[0.9375rem] leading-relaxed" style={{ color: "var(--mk-muted)" }}>
              {o.d}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ── 5 · The way in ───────────────────────────────────────────────────────── */

function FinalCta() {
  return (
    <section className="px-5 pb-16 sm:px-6 sm:pb-24 lg:pb-28">
      <div
        className="relative mx-auto max-w-5xl overflow-hidden px-6 py-14 text-center sm:px-14 sm:py-20"
        style={{ background: "var(--brand-gradient)", borderRadius: "32px" }}
      >
        {/* THE OFFER, STATED. This section used to ask for a click and describe
            the offer in passing underneath it. The offer was always the strong
            part — a read of your own calls, before you buy anything — and it
            was doing none of the work because it was never named. */}
        <p
          className="mb-4 text-xs font-semibold uppercase tracking-widest"
          style={{ color: "rgb(255 255 255 / 0.75)" }}
        >
          What you get for asking
        </p>
        <h2 className="mk-display mk-h2" style={{ color: "#fff" }}>
          A read of your own calls, before you decide anything.
        </h2>
        <p
          className="mx-auto mt-5 max-w-xl text-[1.0625rem] leading-relaxed"
          style={{ color: "rgb(255 255 255 / 0.92)" }}
        >
          Tell us how your team sells today. We&rsquo;ll come back with what Aura would have
          pulled out of a week of your calls, the objections, the commitments, and who
          on your team is actually converting.
        </p>

        <Link
          href={CTA_HREF}
          className="mt-9 inline-flex items-center gap-2 rounded-full bg-white px-9 py-4 text-base font-semibold transition-transform duration-150 hover:-translate-y-0.5"
          style={{ color: "#0b1220" }}
        >
          Book my call now
          <span aria-hidden="true">→</span>
        </Link>

        {/* OBJECTION KILLERS at the point of decision. These are the three
            things a stranger silently asks before handing over a phone number,
            and each one is answerable in five words because there is a real
            page behind it (/compatibility, /security, /consent). Answering them
            here rather than making someone go and find the page is the whole
            point — an unanswered objection at the button is a closed tab. */}
        <ul
          className="mx-auto mt-8 flex max-w-2xl flex-wrap justify-center gap-x-6 gap-y-2 text-sm"
          style={{ color: "rgb(255 255 255 / 0.85)" }}
        >
          {[
            "Works on the phones you already have",
            "Your recordings stay yours",
            "A real person replies, not a sequence",
            "We'll tell you honestly if it isn't a fit",
          ].map((t) => (
            <li key={t} className="flex items-center gap-2">
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full"
                style={{ background: "rgb(255 255 255 / 0.7)" }}
              />
              {t}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function Landing() {
  return (
    <div className="mk-page">
      <Hero />
      <Problem />
      <HowItWorks />
      <Outcomes />
      {/* Renders only when there is a real quote to show — see components/proof.tsx. */}
      <Proof />
      <FinalCta />
    </div>
  );
}
