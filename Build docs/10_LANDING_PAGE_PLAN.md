# 10 — Enterprise-grade landing page & marketing site

**Written 2026-08-06.** Companion to `08_ROAD_TO_10.md` and `09_FEATURE_CATALOGUE.md`.

The console at `https://aura.sirahagents.com` currently has **no public front door at all** —
[`apps/web/app/page.tsx`](../platform/apps/web/app/page.tsx) is a three-line redirect to
`/dashboard`, and [`middleware.ts`](../platform/apps/web/middleware.ts) bounces every
unauthenticated visitor to `/login`. Someone who hears about Aura and types the domain sees a login
form for a product they cannot evaluate. This plan fixes that.

---

## 0. One positioning decision to make first

"Enterprise-level" can mean two different things, and they lead to different sites:

| Reading | Means | Consequence |
|---|---|---|
| **A — enterprise-grade craft** *(recommended)* | An SMB-facing site built to the standard of an enterprise product site: real proof, real security documentation, sub-second load, no stock photography, no lorem. | Messaging stays direct and price-transparent. Buyer is the owner of a 5–50 person telecalling team. |
| **B — enterprise buyer** | Targeting 200+ seat companies with procurement, security review, SSO and MSA. | Requires SOC 2, SSO/SAML, uptime SLA, a sales team. None of these exist yet, and 08's plan does not produce them for ~8 months. |

**Recommend A, built so it can grow into B.** Your customers are RD Interlock Brick and Fortune
Innovatives — Tamil Nadu SMBs. Writing enterprise-procurement copy for them reads as evasive, and
hiding pricing is the fastest way to lose an SMB buyer. But every trust artefact B needs (security
page, DPA, sub-processor list, data residency, audit trail) is *also* what makes an SMB owner
comfortable letting you record their customers' calls. Build those now; they serve both.

Structurally: one extra nav item — **"For teams of 50+"** → a page with the enterprise proof points
as they land. That is the on-ramp to B without pretending to be there.

---

## 1. What the site has to overcome

Not "explain the features." Three specific objections, in this order:

1. **"You're recording my customers' calls and sending them to an AI."** The single largest
   conversion blocker, and the one no competitor page has to answer as directly. It must be handled
   on the homepage, not buried in a footer link.
2. **"Will this actually work on my team's phones?"** Legitimate — capture is device-dependent, and
   Google Dialer handsets genuinely cannot be ingested from. Answer it with a public compatibility
   matrix rather than a hedge. Naming your limits precisely buys credibility on everything else.
3. **"Another dashboard nobody will open."** Answer with WhatsApp-first delivery
   (`09_FEATURE_CATALOGUE.md` §2.2, §2.4) — the product comes to them.

Everything else — features, pricing, integrations — is downstream of these three.

---

## 2. Conversion model

**Primary CTA: "Talk to us on WhatsApp"**, with a real number and a pre-filled message.

This is not a stylistic choice. For Indian SMB buyers, a WhatsApp button converts several times
better than a "Book a demo" calendar form, because it matches how this segment already transacts.
Put it in the sticky header, the hero, and after the demo section.

| Priority | CTA | Placement |
|---|---|---|
| 1 | **WhatsApp us** (deep link, pre-filled) | Sticky header, hero, post-demo, footer |
| 2 | **See it work** → the interactive demo (§4) | Hero secondary — an anchor, not a page load |
| 3 | **Book a 20-min walkthrough** (Cal.com embed) | After the case study; for the more formal buyer |
| 4 | **Sign in** | Header, visually de-emphasised — this is for existing customers |

**Deliberately not** a self-serve free trial. Aura cannot be self-served today: it needs a handset
enrolled, an extraction agent configured and a CRM connected. Offering a trial you cannot deliver
converts a warm lead into a bad first impression. Revisit after `08_ROAD_TO_10.md` §4.4.

---

## 3. Information architecture

### Homepage, in order

| # | Section | Job | Notes |
|---|---|---|---|
| 1 | **Hero** | State the product in one line; offer WhatsApp + demo | Copy in §5.1 |
| 2 | **The problem, in their words** | Three sentences the owner recognises | No illustration; typography only |
| 3 | **Interactive demo** ⭐ | *Show* the pipeline on a real call | The most important element on the site — §4 |
| 4 | **How it works — 4 steps** | Handset → Upload → AI → CRM/console | Horizontal on desktop, stacked on mobile |
| 5 | **What you get** | 6 outcome cards, not feature names | "Know why you lose deals", not "objection extraction" |
| 6 | **Language proof** | Tamil / Hindi / Telugu / Kannada / English, code-switched | Real transcript excerpts, side by side with translation |
| 7 | **Trust block** ⭐ | Encryption, tenant isolation, consent, retention, erasure | Answers objection #1 inline, links to `/security` |
| 8 | **Phone compatibility** | Live matrix, honest about Google Dialer | Answers objection #2; links to `/compatibility` |
| 9 | **Case study** | RD Interlock Brick, with real numbers | Needs their sign-off — §11 |
| 10 | **Integrations** | The 15-provider CRM catalogue, as a logo grid | Reads as maturity. Mark the four OAuth-pending ones honestly |
| 11 | **Pricing** | Transparent, per handset per month | §6 |
| 12 | **FAQ** | 10 questions, schema.org markup | SEO + objection handling |
| 13 | **Final CTA** | WhatsApp, repeated | |

### Supporting pages

| Route | Purpose | Priority |
|---|---|---|
| `/security` | Encryption at rest/in transit, per-tenant Postgres RLS isolation, access control, audit log, sub-processor list, data residency, retention, breach process | **P0** — objection #1 |
| `/compatibility` | The OEM matrix, maintained as data. Also strong organic SEO ("which phones record calls") | **P0** — objection #2 |
| `/consent` | How call-recording consent works in India, what Aura enforces (consent tone / TTS / prohibited), what the customer is responsible for | **P0** |
| `/privacy`, `/dpa`, `/terms` | DPA downloadable as PDF | **P0** — Stage 4.3 of 08 produces these |
| `/pricing` | Expanded from the homepage block | P1 |
| `/industries/{building-materials,interiors,real-estate,education,clinics}` | One page per vertical, each with its agent template from `09` §4.4 | P1 — the SEO engine |
| `/for-teams-of-50` | The enterprise on-ramp from §0 | P1 |
| `/compare/{manual-call-monitoring,generic-crm,call-recorder-apps}` | Comparison pages | P2 |
| `/blog` | Vernacular-sales-ops content | P2 |
| `/status` | Public uptime, fed by 08 §3.9 | P2 — a real trust signal once measured |

---

## 4. The interactive demo — build this first

**One element does more conversion work than the rest of the site combined**: showing a real Tamil
sales call becoming a structured lead, in about 40 seconds, without a signup.

### Shape

A three-panel sequence that advances on scroll or autoplay:

1. **Audio** — waveform of a real (anonymised, consented) RD-Interlock-style call, with a play
   button. Optional; the demo works muted.
2. **Transcript** — types in, diarized Agent/Customer, Tamil with English translation toggled by a
   `BrutalButton`. Per-turn intent captions, exactly as the call drawer already renders them.
3. **Extraction** — the typed fields populate one by one: `customer_name`, `place`, `brick_type`,
   `quantity`, `cost_per_unit`, `total_budget`, `follow_up`, `quotation` — then a lead card slides
   into the board column, and a CRM sync chip flips to delivered.

A three-tab switcher lets the visitor pick the industry (Building materials / Interiors / Real
estate), swapping the fixture. That is the `09` §4.4 agent-template marketplace, previewed.

### Non-negotiable: it must be canned

**Do not wire the marketing site to the live API.** Ship a JSON fixture per industry, generated from
a real anonymised call through the real pipeline and then frozen. Reasons: no public surface on the
production API, no LLM cost per visitor, no dependency on provider uptime for your conversion path,
and total control over the narrative timing. The data is real; the delivery is static.

### Accessibility & weight

Respect `prefers-reduced-motion` (show the completed end-state immediately). Total demo payload
under 300 KB excluding the optional audio; audio lazy-loads on interaction only.

---

## 5. Copy direction

The brand already has a line, on the login page today: **"Every call, accounted for."** It is good.
Build the site on it rather than inventing a new one.

### 5.1 Hero

> ### Every call, accounted for.
>
> Aura records your telecallers' calls, transcribes them in Tamil, Hindi and English, and turns
> every conversation into a qualified lead — in your CRM, without anyone typing a note.
>
> **[ Talk to us on WhatsApp ]**  [ See it work ↓ ]
>
> `Works on Samsung, Xiaomi, Realme, Oppo & Vivo handsets · No new phone number · No app for your customers`

That third line does a lot of quiet work: it pre-empts "do I need new hardware / a new number / will
my customer have to install something", which are the first three questions every buyer in this
segment asks.

### 5.2 The problem section

> Your team made 400 calls last month.
> You listened to none of them.
>
> You know the total. You don't know why eleven deals died, which objection keeps landing, what
> your competitor is quoting, or who promised a customer a callback and never made it.

### 5.3 Outcome cards — write outcomes, not features

| Don't write | Write |
|---|---|
| "AI-powered objection extraction" | **Know why you lose.** The objection behind every dead deal, counted. |
| "Configurable extraction agents" | **Your fields, not ours.** Tell Aura what matters in your business; it pulls exactly that from every call. |
| "Lead projection pipeline" | **No more manual entry.** Every qualified call becomes a lead in your CRM, by itself. |
| "Telecaller analytics module" | **See who's actually selling.** Not who logged the most calls — who moved the most pipeline, and why. |
| "Commitment tracking" | **Nothing gets dropped.** Every "I'll call you Monday" is tracked until it happens. |
| "Multilingual ASR" | **Built for how India actually sells.** Tamil, Hindi, Telugu and English — including the half-and-half sentences. |

### 5.4 Trust block — say the specifics

Vagueness here reads as evasion. Say the actual mechanism:

> **Your calls are yours.**
> Encrypted on the handset before they leave it, encrypted in transit and at rest. Every customer's
> data is isolated at the database level — not by application code, but by Postgres row-level
> security enforced on a role that cannot bypass it. Deleted on your schedule, with a signed erasure
> receipt. Every access to your data is written to an audit log you can read.
> [ How Aura handles your data → ]

Each of those claims is true of the current build. Do not add one that isn't — and revisit this
block after 08 Stage 2, because several claims get materially stronger.

### 5.5 Voice

Match the console: short declarative sentences, no exclamation marks, no "revolutionary", no
"unlock". Numbers over adjectives. The design language is severe and confident; the copy should be
too.

---

## 6. Pricing

**Show it.** Hiding pricing behind "Contact us" is standard for enterprise and fatal for SMB — this
buyer will simply close the tab.

Structure: **per handset, per month**, because that is the unit customers already think in and it
maps to the real cost driver (a handset generates calls; calls generate ASR and LLM spend).

| Tier | Shape | Notes |
|---|---|---|
| **Starter** | Up to 5 handsets, ₹X/handset/month | Transcription + leads + one CRM connector |
| **Growth** | Up to 25 handsets | + telecaller performance, objection & price intelligence, WhatsApp digests |
| **Business** | 25+ | + multi-branch, API, BYO AI keys, priority support |
| **Enterprise** | Talk to us | SSO, DPA negotiation, custom retention, capture SLA |

Show what is included **per call**, not just per seat — a fair-use minutes allowance with a clear
overage rate. This is honest about the real cost structure and prevents the unbounded-spend problem
that 08 §3.3 and §4.2 exist to fix. Do not publish tier numbers until §4.1 billing can actually
enforce them.

Add an **ROI calculator**: handsets × calls/day × average deal value → "leads currently falling
through" — a single number, with the assumptions shown. This segment responds strongly to arithmetic
and distrusts adjectives.

---

## 7. Design direction

### Keep the neo-brutalist system — with three adjustments

The Aura language (`ui-design/`, `@aura/ui`) is distinctive, already built, and works: Space Grotesk
black uppercase headings, `border-2`/`border-4 border-black`, `rounded-none`, offset shadows
`4px 4px 0px rgba(0,0,0,1)`, off-white `#F9F9F9` ground, `MonoLabel` for ids and micro-labels, red
reserved for destructive, green only inside the black `ConsolePanel`. **Reuse it.** A marketing site
that looks like the product is a trust signal; a generic SaaS-gradient page that opens into a
brutalist console is a bait-and-switch.

Three marketing-specific adjustments:

1. **More air.** Console density is correct for daily operators and wrong for first-time visitors.
   Roughly double the vertical rhythm between sections.
2. **One accent, sparingly.** The console is deliberately monochrome. A single accent — used *only*
   on the primary CTA and the demo's live indicator — measurably lifts CTA conversion without
   breaking the system. Red stays destructive-only, so pick something else and use it perhaps four
   times on the whole page.
3. **Real product screenshots, never mockups.** The console is good-looking; show it. Annotate with
   the same `MonoLabel` style so the annotations feel native. No laptop-on-a-desk stock imagery, no
   illustrated abstractions, no AI-generated people.

### Components to add to `@aura/ui`

`@aura/ui` currently exports seven primitives (`BrutalButton`, `Card`, `ConsolePanel`, `MonoLabel`,
`ProgressBar`, `StatCard`, `StatusChip`). Marketing needs, and they belong in the shared package so
the console can use them later:

`SectionHeading` · `FeatureCard` · `PricingCard` · `LogoGrid` · `FAQAccordion` (details/summary,
no JS) · `Testimonial` · `ComparisonTable` · `StepFlow` · `CTABanner`

---

## 8. Technical architecture

### Recommendation: a separate `apps/marketing` app

| | Option A — `(marketing)` group in `apps/web` | Option B — separate `apps/marketing` ✅ |
|---|---|---|
| Deploys | Coupled to the console image | Independent; marketing ships hourly, console weekly |
| Middleware | Every public visit runs `supabase.auth.getUser()` — latency on every hit and a rate-limit surface on your auth provider | No auth middleware at all |
| Caching | Dynamic, `cache: "no-store"` conventions everywhere | Fully static export, CDN-cacheable |
| Blast radius | A marketing bug can take down the customer console | Isolated |
| Build coupling | `NEXT_PUBLIC_API_URL` is baked at image build time; a copy fix means rebuilding the console | None |
| Design tokens | Shared trivially | Shared via `@aura/ui` workspace import |

**Choose B.** Next.js 15 with `output: "export"` (fully static — no server needed), Tailwind v4,
importing `@aura/ui` from the workspace. Deploy to **Cloudflare Pages or Vercel free tier**, not the
VPS: it costs nothing, gives you a global CDN and DDoS protection, and keeps public traffic entirely
off the box that runs your customers' pipeline.

### Domain plan — and one thing not to touch

* Marketing → **apex** (`sirahagents.com` / `www`), or a dedicated product domain if you want Aura
  to have its own brand.
* Console + API → **stay exactly where they are** at `aura.sirahagents.com`.

**Do not move the API domain.** The enrolled handsets carry the server URL in their activation
payload, `S3_PUBLIC_ENDPOINT` presigns upload URLs against it, and the Android release ships an
HTTPS-only `network_security_config.xml`. Changing it means re-enrolling every device in the field.
Marketing gets a new domain; the platform keeps its own.

### Forms

Static export means no server actions. The WhatsApp CTA is a plain `wa.me` deep link (no backend at
all). For the demo-request form use Cal.com's embed or a Cloudflare Worker posting into the existing
API behind a scoped service credential (08 §2.3) — never the admin key, and never from the browser.

---

## 9. Performance, SEO and accessibility targets

Non-negotiable, and easy to hit with a static export:

| Metric | Target |
|---|---|
| Lighthouse Performance / Accessibility / Best Practices / SEO | ≥ 95 each, **on throttled 4G** |
| LCP | < 1.5 s on a mid-range Android over 4G — *this is the actual device your buyer holds* |
| CLS | < 0.05 |
| Total JS | < 100 KB gzipped (the demo is the only interactive element) |
| Fonts | Self-hosted woff2, subset, `font-display: swap` |
| Images | AVIF/WebP, explicit dimensions, lazy below the fold |

**SEO.** Every page: unique title/description, OpenGraph + Twitter cards, JSON-LD
(`SoftwareApplication`, `FAQPage`, `Organization`), sitemap, robots.txt, canonicals.

The highest-intent organic traffic will come from three places, none of them the homepage:

* **`/compatibility`** — "which phones record calls automatically", "Samsung call recording folder",
  "does Pixel record calls". High intent, low competition, and you have hardware-verified answers
  nobody else publishes.
* **`/industries/*`** — "call tracking for building materials", "telecaller software for real
  estate".
* **Vernacular queries** — "Tamil call transcription software", "call recording software for sales
  team India".

**Accessibility.** WCAG 2.1 AA. The brutalist palette is high-contrast by nature — the risk is
elsewhere: keyboard navigation through the demo, focus rings (do not remove them on a black-border
design), and `prefers-reduced-motion` on every animation.

---

## 10. Localisation

Ship English first. Then Tamil and Hindi for the homepage, pricing and consent pages only — not the
whole site.

A product that transcribes Tamil and whose own site is English-only undercuts its central claim.
Human-translate; do not machine-translate the page that sells your translation quality.
`next-intl` with static generation per locale, `hreflang` tags, and a language switcher in the
header.

---

## 11. Content and proof assets to produce

The site is blocked on these more than on code. Start them in parallel with the build.

| Asset | Blocked on | Notes |
|---|---|---|
| **RD Interlock Brick case study** | Their written permission | Get real numbers: calls/month, leads captured, time saved, deals traced to a call. One customer quote is worth the entire features section. |
| **Anonymised demo call + fixture** | Consent from both parties | Re-record with your own team if consent is difficult — a scripted-but-real call is better than a fabricated transcript, and far better than a blocked launch. |
| **Console screenshots** | Nothing | Seed a demo tenant with realistic synthetic data. Never screenshot real customer data — that would contradict the trust block three sections above. |
| **Security page content** | 08 §4.3 | Sub-processor list: Supabase (Seoul), Google Gemini, Sarvam, Backblaze, Hostinger. **Be upfront that Postgres is currently in `ap-northeast-2`, not India** — an Indian buyer with any compliance function will ask, and being volunteered beats being caught. |
| **DPA + privacy policy** | 08 §4.3 | Legal review. Not optional for a product that processes third-party voice data under DPDP. |
| **Compatibility matrix** | Nothing — data exists | Publish as data, keep it current, and state the Google Dialer limitation plainly. |
| **Customer logos** | Permission | Two is enough if they are real. Never use placeholder logos. |

---

## 12. Build phases

| Phase | Scope | Effort | Depends on |
|---|---|---|---|
| **P0 — Foundation** | `apps/marketing` scaffold, static export, `@aura/ui` wired, deploy pipeline, domain + DNS, analytics | 3 days | — |
| **P1 — Homepage v1** | Sections 1, 2, 4, 5, 7, 11, 13. Real copy, real screenshots. Ship it. | 5 days | Screenshots |
| **P2 — The demo** ⭐ | Interactive demo with one industry fixture | 4 days | Anonymised call |
| **P3 — Trust surface** | `/security`, `/consent`, `/privacy`, `/dpa`, `/compatibility` | 4 days | 08 §4.3 legal docs |
| **P4 — Proof** | Case study, testimonials, integration grid, FAQ + JSON-LD | 3 days | Customer permission |
| **P5 — Pricing** | Pricing block + page + ROI calculator | 2 days | 08 §4.1 (don't publish tiers you can't enforce) |
| **P6 — SEO engine** | 5 industry pages, 3 comparison pages, 2 more demo fixtures | 6 days | P2 |
| **P7 — Localisation** | Tamil + Hindi on the core pages | 3 days | Human translation |
| **P8 — Enterprise on-ramp** | `/for-teams-of-50`, `/status` | 2 days | 08 §3.9 uptime data |

**~6 weeks total**, and P0–P2 (≈2 weeks) is a launchable site that is already better than having no
front door. Run this **in parallel with `08_ROAD_TO_10.md` Stage 1** — the marketing site touches no
platform code, so it is genuinely concurrent work rather than a distraction.

---

## 13. Analytics and instrumentation

Privacy-respecting, because the site's central claim is that you take data seriously:

* **Plausible** or **Umami** — cookieless, no consent banner needed, no contradiction with the trust
  block. **Do not put Google Analytics on a page that promises data minimisation.**
* Events: `whatsapp_click` (by placement), `demo_started`, `demo_completed`, `demo_industry_switch`,
  `pricing_view`, `roi_calculated`, `security_page_view`, `booking_started`.
* The one number that matters: **WhatsApp clicks per 100 visitors**, segmented by whether the
  visitor reached the demo. That single comparison tells you whether the demo is worth its build
  cost — and if it isn't, cut it.
* Scroll depth on the homepage to find where the page loses people.
* No session recording. It would be indefensible on this of all products.

---

## 14. Launch checklist

* [ ] Every claim on the page is true of the deployed build today — audit line by line
* [ ] No real customer data in any screenshot
* [ ] WhatsApp link opens with the pre-filled message on both Android and iOS
* [ ] Lighthouse ≥ 95 on all four axes, throttled 4G
* [ ] Tested on a real mid-range Android over mobile data, not just a desktop emulator
* [ ] `/security`, `/privacy`, `/dpa`, `/consent` live and linked from the footer
* [ ] Compatibility matrix matches `05_FLEET_ONBOARDING.md` and the tested-hardware list
* [ ] Sitemap + robots.txt + canonicals; Search Console verified
* [ ] 404 and 500 pages designed
* [ ] Analytics firing; a conversion goal defined before launch, not after
* [ ] Console `/login` reachable from the header for existing customers
* [ ] `apps/web/app/page.tsx` — decide whether the console root keeps redirecting to `/dashboard` or
      redirects to the marketing domain for signed-out visitors

---

## 15. What not to do

* **No fake social proof.** No invented logo walls, no "trusted by 500+ businesses", no stock
  testimonials. Two real customers stated plainly beats twenty fictional ones, and this buyer
  segment is small enough that a lie gets found.
* **No claims 08 hasn't delivered.** Not "SOC 2", not "99.9% uptime", not "enterprise-grade
  security" as a bare phrase. Claim the mechanisms you actually have — they are strong on their own.
* **No gated content before the demo.** Nobody in this segment fills a form to learn what a product
  does.
* **No chat widget that nobody staffs.** An unanswered chat bubble is worse than none. WhatsApp,
  which you already answer, is the better channel.
* **No promising VoIP or WhatsApp *call* recording.** It is an OS block, confirmed on hardware. One
  overstated capability in a demo becomes a refund and a bad reference.
* **No auto-playing audio.** The demo works silently by default; sound is opt-in.
