# 43 — High-Converting Landing Pages & Funnels: Teardown and Provenance

**Compiled:** 2026-10-12
**Purpose:** Reference for building Aura's marketing pages. Documents the structure, funnel
architecture, copy mechanics and colour systems of the pages most often cited as
best-in-class direct-response, with an explicit record of where every claim came from.
**Audience:** Whoever writes or designs an Aura acquisition page.

---

## 0. How this document was produced — read this first

This matters more than usual, because this subject is drowning in AI-generated SEO filler.

**Method.** Four web searches were run first. They returned almost nothing usable: scraped
LDAP help pages titled "Alex Hormozi's advice on landing pages", pirated-PDF landing pages
on a `.gov.br` domain, and duplicated "Perfect Webinar" articles on unrelated corporate
hosts. **No search result was used as a primary source for any structural claim.**

Instead, the live pages were fetched directly and read section by section, and their CSS was
extracted with `curl` + `grep` to count actual colour declarations rather than eyeball
screenshots.

**Evidence tiers used throughout this document:**

| Tier | Meaning | How it's marked |
|---|---|---|
| **[LIVE]** | Fetched from the production page on 2026-10-12. Quotes are verbatim. | Highest confidence |
| **[CSS]** | Extracted by counting colour declarations in the served HTML/CSS. | Highest confidence |
| **[DATASET]** | A real published dataset, though possibly stale or vendor-owned. | Medium |
| **[VENDOR]** | Vendor blog aggregate. Direction probably right, magnitude unreliable. | Low |
| **[SUMMARY]** | Third-party summary of a book, not the book itself. | Low |
| **[SYNTH]** | My own inference from comparing the pages. Not sourced — judgement. | Flagged as opinion |

**Pages successfully fetched [LIVE]:**

- `https://www.acquisition.com/` — Hormozi, homepage
- `https://www.acquisition.com/o-vegas` — Hormozi, $5k workshop sales page
- `https://www.kingkong.co/` — Sabri Suby / King Kong, agency homepage (150,047 chars;
  first 100,000 read, final 50,047 **not read** — see Gaps)
- `https://www.clickfunnels.com/` — Brunson, SaaS homepage
- `https://russellbrunson.com/` — personal site; **turned out to be a nav/bio page only**,
  no offer, no form, footer still says "© 2023", with a leftover `"Working..."` placeholder
  heading. Contributed nothing.

**Pages that refused the fetch (HTTP 403):**

- `https://www.dotcomsecrets.com/` — the book funnel
- `https://expertsecrets.com/` — the book funnel

This is a real gap. **Both free-plus-shipping book funnels are documented in this file from
prior knowledge and third-party summaries, not from the live pages.** Section 3C's price
bands and bonus-stack mechanics are therefore the weakest part of this document.

---

## 1. Benchmark reality — what "highest converting" can and cannot be claimed

**There is no credible global dataset of the world's highest-CTR pages.** Nothing published
ranks pages worldwide by conversion. Any article claiming to is inventing it.

| Metric | Figure | Tier | Note |
|---|---|---|---|
| Median landing page, all industries | 6.6% | **[DATASET]** | Unbounce, 41,000 pages / 57M conversions |
| Median, all industries | 2.35% | **[DATASET]** | WordStream — different method (paid traffic only) |
| Top 10% of pages | 11.45%+ | **[DATASET]** | WordStream |
| Best vertical — events/entertainment | 12.3% | **[DATASET]** | Unbounce |
| Financial services | 8.4% | **[DATASET]** | Unbounce |
| SaaS | 3.8% | **[DATASET]** | Unbounce — **the band Aura sits in** |
| Ecommerce | 2.35% | **[DATASET]** | Unbounce |
| A/B tests producing a winner | ~13% (9% lose, 78% inconclusive) | **[VENDOR]** | Directional only |

### Provenance warnings on the above

1. **The 6.6% figure is from Unbounce's 2024 report, not 2026.** It is relabelled "2026
   benchmarks" by at least four vendor blogs found in search. Apexure cites the Q4 2024
   report while heading the table 2026.
2. **The per-industry "top 10%" tables circulating for 2026 are not trustworthy.** Only one
   source (CorePPC) publishes one; its own overall median of 4.3% contradicts the 6.6%
   figure it cites. Treat as fabricated until verified against Unbounce's original.
3. **Sources disagree on the overall median by nearly 3x** (2.35% to 6.6%), because they
   measure different traffic. Pick one methodology and stay in it.
4. Unbounce's older 2020 report put the all-pages median at 3.2% — don't mix editions.

### [SYNTH] The structural point

A direct-response page converting at 30–40% is not beating these benchmarks; it is measuring
a different event. Hormozi's free course converts a visitor into *an email*. His $5k
workshop page converts at a small fraction of that. **These funnels win on sequence
economics, not on any single page's rate.** Benchmarking one page against the other is a
category error — and it's the error most CRO content makes.

---

## 2. The four funnel architectures

Everything in this space is one of four shapes.

### A. Content → Opt-in → Application → Call — Hormozi **[LIVE]**

```
Free content at enormous scale (YouTube, podcast, free courses, two 1M+ selling books)
   │  no ad spend; trust pre-built before any page is seen
   ▼
Free course / "$100m Scaling Roadmap"  ──►  email captured
   ▼
Workshop page — $5,000 per seat, price stated openly on the page
   ▼
Call with "workshop concierge team"  ──►  close
```

Observed on `acquisition.com` and `/o-vegas`: four free courses offered on the homepage
("$100M MONEY MODELS", "OFFER CREATION COURSE", "LEAD GENERATION COURSE", each tagged
*"It's Free"*), and an FAQ stating registration "starts with a call to the workshop
concierge team."

**What is conspicuously absent [LIVE]:** no countdown timer, no bonus stack, no
money-back guarantee, and **no form anywhere on either page**. Every CTA is a link to a
booking widget. Front-loaded trust, back-loaded price.

### B. Proof wall → guarantee → booked call — King Kong / Suby **[LIVE]**

```
Paid ad  ──►  very long single-column "letter" page
   │  one email field, nothing else asked
   ▼
Free 30-minute "strategy session"
   │  qualification happens on the call, not on the page
   ▼
Retainer
```

**[SUMMARY]** The reasoning behind the lead magnet comes from *Sell Like Crazy*: only ~3% of
a market is actively buying at any moment; of the remaining 97%, roughly 17% are gathering
information, 20% are problem-aware, and 60% are problem-unaware. The funnel exists to
harvest the 97% with a value-first offer (the "HVCO") rather than pointing cold traffic at a
homepage or sales page — the book explicitly names that as the common failure.

*Caveat: step counts for the book's system vary by source — one lists 8 steps, another 17.
The underlying split above was consistent across two independent summaries. Not verified
against the book itself.*

### C. Value ladder / self-liquidating offer — Brunson **[SUMMARY]** + **[LIVE]**

```
Free lead magnet
   ▼
$0 + shipping book, or a $7–47 tripwire   ◄── buys the ad spend back
   │  order-form bump, then 1-click upsells
   ▼
$97–297 course
   ▼
$997–2k event / coaching
   ▼
$10k–25k+ mastermind
```

**Confidence note:** the ladder *concept* is documented in *DotCom Secrets* summaries. **The
price bands are from a third-party skill document, not from Brunson**, and both book-funnel
pages 403'd, so the bands are illustrative only.

**[LIVE] What ClickFunnels.com itself actually does now** is the soft SaaS version. Verified
on the page:

- Top banner: free community challenge, *"Join FREE!"*
- Hero: *"You're one funnel away from changing the world"* → email field → *"Get Started"*
- The ladder reframed on-page as five stages: **Attract → Sell → UpSell → Ascend → Repeat**
- Five feature tabs: Your Funnel / Your Store / Your CRM / Your Email Marketing / Your Online Courses
- **No price, no trial length, and no risk-reversal language on the page at all.** Closest
  line is *"Start for free today."* Pricing is a footer link.

**Perfect Webinar** structure (big promise → origin story → break-and-rebuild three false
beliefs: vehicle, internal, external → stack → price reveal → close) is **prior knowledge**,
not sourced here. Search returned only generic SEO content on it, and the primary pages
403'd. Treat as unverified in this document.

### D. Challenge / VSL hybrid — partial **[LIVE]**

A 5-day free challenge replacing the webinar. Evidenced only by ClickFunnels' banner
promoting one. The claim that it outperforms webinars on low-attention paid traffic is
**[SYNTH]** — my judgement, no data gathered.

---

## 3. The page skeleton, and the wording formula per section

Composite of the three pages fetched. Order is near-identical across all three; tone varies
with audience temperature.

### 1. Announcement bar — dated urgency, not a fake timer **[LIVE]**
> *"NEW 2026 Scaling Workshop Dates Announced: Find out if you are a fit"* — Hormozi

### 2. Hero headline — three patterns, not interchangeable **[LIVE]**

| Pattern | Verbatim example | Use when |
|---|---|---|
| Question that self-qualifies | *"Do You Want to Scale Your Business?"* (homepage) / *"Are you the thing limiting your business?"* (`/o-vegas`) | Warm or known audience |
| Metaphor + edge | *"Like Steroids\* For Business"*, footnoted *"\*But it's 100% legal (pinky promise)"* — King Kong | Cold paid traffic, crowded category |
| Identity / aspiration | *"You're one funnel away from changing the world"* — ClickFunnels | Product-led, self-serve |

**[SYNTH]** Hormozi's workshop headline accuses the reader. That is deliberate: the pain is
positioned as internal (*you* are the bottleneck), not external. Nobody else in the set does
this, and he can only do it because the audience arrives warm.

### 3. Hero subhead — carries the proof-loaded specific the headline doesn't **[LIVE]**
> *"Learn from the team that has scaled a portfolio to over $250m+ in annual revenue."*

### 4. Hero CTA — written in the visitor's first person **[LIVE]**
> *"I'M READY TO SCALE"* — an identity claim, not an instruction
> *"Do it."* — King Kong, beside a single email field
> *"Get Started"* / *"Try for Free"* — ClickFunnels

### 5. The number bar — four stats, immediately below the fold **[LIVE]**

| Hormozi | King Kong |
|---|---|
| 10,000 businesses advised | $10.2 Billion reported client revenue |
| **81 NPS** | 200,000 customers |
| **97.1% client retention** | 136 countries |
| 12,000 workshop participants | **1,184 industries and niches** |

**[SYNTH]** Retention and NPS are the sophisticated choices — they answer "do people stay?",
which a revenue figure does not. Industry/country counts answer "will this work for someone
like me?"

### 6. The long letter — King Kong only **[LIVE]**
Opens *"Dear business builder"*, enumerates owner pains (worry about new customers, poor
sleep, too many channels to manage), then hands over control: *"choosing your own
adventure."* **[SYNTH]** This is the most recognisably *Sell Like Crazy* artefact on any of
the pages.

### 7. Path split — two doors so the page serves both intents **[LIVE]**
> Agency: *"Hire us to do it for you."* — 4.6★ / 607 reviews
> Courses: *"Learn how to do it yourself."* — 4.8★ / 6,963 reviews

### 8. Proof stack, in escalating credibility order **[LIVE]**
Logo strip → ~25 case-study cards (Nimble, Scotland Titles, My Muscle Chef, UGG Australia) →
~20 **video** testimonials whose headline is the outcome, not praise:
> *"From $4 Million To $25,000,000+ In 18 Months"*
> *"Generated 95 to 100 Closed Jobs"*

Plus a credentials list in the FAQ: 38 millionaires created, 6× eight-figure clients, #17
fastest-growing company in Australia (AFR), #1 fastest-growing agency three years running.

### 9. Risk reversal — the highest-leverage block **[LIVE]**
> **"WE GUARANTEE TO BEAT YOUR RESULTS BY 30% OR WE WORK FOR FREE"**

Conditions, stated on the page: only for businesses already running profitable Google or
Facebook ads; target is to beat existing conversion rate, CPL or ROAS by 30% within 90 days;
the client covers ad spend; campaigns must be comparable (same product, same season).

**[SYNTH]** The conditions do double duty — they make the guarantee survivable *and* they
qualify out bad-fit buyers. The craft is in the conditions, not the promise.

**[SUMMARY]** Suby's "Godfather offer" components, per third-party summaries: strong
rationale for buying, value build, multiple pricing options, payment plans, premiums
(bonuses), a risk-eliminating guarantee, and urgency. *Unverified against the book.*

### 10. Authority artifact — the book **[LIVE]**
> *"We Literally Wrote The Book On… How To Get As Many Clients, Customers And Sales As You
> Can Possibly Handle"* → CTA *"Buy The Book"*

Hormozi's equivalent, in his founder bio: a portfolio over $250m+ annual revenue, a $46.2M
sale in 2021, two books each over 1M copies, 12M+ audience.

### 11. FAQ as objection-handling, not support **[LIVE]**
The questions *are* the sales objections:
> *"How do I know that I will get a return on my investment?"*
> *"Can you guarantee results?"*
> *"Why is King Kong the best digital marketing agency?"*
> *"Is this right for my business size/industry?"*

**And this is where Hormozi does the thing almost nobody copies — he disqualifies you:**
> Revenue under $250k/yr: *"this is **not** a fit (yet.)"*
> Revenue $1M–$100M/yr: *"then we can help."*
> *"Expect zero motivational talks."*
> On the $5k price: *"If you haven't made at least $5k from the free content, don't do it."*

### 12. Repeated CTA — identical text, 5–7 times down the page **[LIVE]**
King Kong uses *"Hit the damn button"* roughly six times, including as the final line of the
last FAQ answer. **[SYNTH]** The repetition is the mechanism; varying CTA copy dilutes it.

### 13. Footer disclaimer **[LIVE]**
> *"Alex and Leila Hormozi's results are not typical and are not a guarantee of your
> success."* … *"We cannot guarantee that you will make money."*

Legally necessary at these claim volumes; **[SYNTH]** also reads as a trust signal.

---

## 4. Copy mechanics

Rules derived by comparing the three pages' actual language. Examples **[LIVE]**, the rules
themselves **[SYNTH]**.

- **Second person, present tense, reader as grammatical subject.** "Are *you* the thing
  limiting *your* business."
- **Specific beats round.** $250m+, 97.1%, 81 NPS, 1,184 industries, $46.2M, 30% in 90 days,
  $10.2 Billion. Never "millions", never "most clients".
- **One idea per line, roughly eight words.** Fragments are fine. Line breaks carry the load
  paragraphs used to.
- **Concrete deliverable counts.** *"3-5 Tactical Next Steps"*, *"a thick packet w/ key
  takeaways & strategies"*. Not "actionable insights" — the number makes it real.
- **Negation as proof.** *"Expect zero motivational talks."* / *"No more
  'hoping-and-praying'."* Naming the category's failure mode signals you know the category.
- **Humour to reduce click risk on cold traffic.** *"pinky promise"*, *"Want some free
  money?"* (footer newsletter), *"Hit the damn button"*.
- **Mechanism language — a proprietary-sounding name for what you do.** *"The Most
  Ruthlessly Effective Platform For Rapidly Scaling Businesses On Planet Earth."* Absurd read
  cold; memorable in practice.
- **Price stated plainly where the audience is warm** ($5k per seat), **withheld where it is
  cold** (ClickFunnels shows no price at all).

### The underlying objective function **[SUMMARY / prior knowledge]**

Hormozi's value equation — **(Dream Outcome × Perceived Likelihood of Achievement) ÷ (Time
Delay × Effort & Sacrifice)**. This is from *$100M Offers*, not from any page fetched here;
it is included because every section above maps onto it: the proof stack raises perceived
likelihood, "3-5 next steps in 2 days" cuts time delay, the guarantee cuts perceived risk.

---

## 5. Colour and design — measured from served CSS

**[CSS]** Counted occurrences of colour declarations in the served HTML/CSS on 2026-10-12.
This is the most reliable section in this document — it is measurement, not interpretation.

| | Base (dominant) | Canvas | Accent — CTA only | Supporting |
|---|---|---|---|---|
| **ClickFunnels** | `#080436` deep indigo — **206 occurrences** | `#F9F6F3` warm cream (91) | `#FEB95F` amber (18) | `#98C1D9` dusty blue, `#DFDCD9` border, `#7A7774` body grey, `#F3F2FF` lavender-white |
| **King Kong** | `#003399` hard navy — **250 occurrences** | `#FFFFFF` (155) / `#F3F3F3` | `#CFF128` acid lime, `#A8D507`, `#A2DE00`; oranges `#FF9900`, `#EBAF00`, `rgb(255,105,0)` | `#373737`, `#0A0A0A`, `#A1A1A1` |
| **Acquisition.com** | `#000000` (8) | `#FAFAFA` / `#EFEFEE` | `#6F00FF` electric violet | `#6B7280`, `#607179` greys |

*Reading note: raw counts aren't comparable across sites — ClickFunnels and King Kong serve
large inline stylesheets while Acquisition.com serves most styling externally. Within a
single row, the ranking is meaningful.*

### The formula all three obey **[SYNTH, from the measurements above]**

1. **Dark, desaturated base** — navy or black. Navy specifically reads as authority without
   reading as a funeral. **None of the three uses a light brand colour as the dominant.**
2. **Warm off-white canvas, not pure white** — `#F9F6F3`, `#FAFAFA`, `#EFEFEE`. Reduces glare
   on a page people scroll for 90 seconds.
3. **Exactly one high-chroma accent, reserved for action.** Amber, acid lime, electric
   violet — each *clashes slightly* with its navy base. That is the point: maximum contrast
   against a hue appearing nowhere else. **Accent scarcity is the variable; the specific hue
   is not.** The old red-button-vs-green-button tests are noise.
4. **Near-black body copy, mid-grey for secondary.** Never grey on grey.
5. **Decoration tracks inversely with audience warmth.** Hormozi — warmest audience, highest
   price — is essentially monochrome. King Kong — coldest traffic, lowest prior trust — is
   the loudest. Palette intensity should match how little the visitor knows you.

### Layout rules observed **[LIVE]**
Single column. Full-bleed alternating light/dark bands so each section reads as a discrete
argument. One CTA per band. Stat tiles in rows of four. Testimonials as cards with a face.
FAQ as accordion. Hero headline at near-display size. All-caps section headers on King Kong.

---

## 6. What actually moves the number

Mechanism separated from cargo cult, with evidence weight stated.

### Strong and consistent in direction

- **Fewer form fields.** All sources agree on direction and disagree wildly on magnitude:
  one **[VENDOR]** study (2,000 pages, Oct 2025 – Mar 2026) claims each field past four
  roughly halves conversion; others say 4–8% per unnecessary field, or 10–15% on mobile per
  field removed. **[LIVE]** King Kong and ClickFunnels both ask for **email only** and defer
  everything else to the next step. The real pattern is not *short* forms but **staged**
  forms.
- **Speed.** ~7% conversion loss per extra second; sub-1.5s claimed to convert 2.4× better
  than 4s. **[VENDOR]** aggregates, but physically plausible and cheap to fix.
- **Message match** between ad and headline — claimed 20–40% lift, but the source cites
  "studies" without naming them **[VENDOR, weak]**. Free to implement regardless.
- **Proof density and specificity** — not isolable in a test; it is the entire middle of
  every page examined.
- **Risk reversal with explicit conditions.**

### Overrated
Button colour in isolation; hero image choice; fake countdown timers; long-form vs short-form
as a universal rule (it is audience-temperature dependent); "best practice" checklists
generally — **[VENDOR]** 78% of A/B tests come back inconclusive.

### A real defect found in the wild **[LIVE]**
King Kong's review counts contradict themselves across one page: **7,570 reviews at 4.8★**
in the hero and the "Built For Scale" block, **4,952 at 4.7★** in the FAQ, and **607** and
**6,963** on the two offer cards. Self-contradicting proof is worse than less proof. If we
build a stat bar, it gets one source of truth.

---

## 7. Application to Aura

**[SYNTH] — this section is judgement, not research.**

Aura sells an owner-facing CRM with call transcription. Best fit is **Architecture B with a
Hormozi disqualifier**:

- **Hero:** accusatory question headline. The pain is that an owner cannot hear what their
  telecallers actually said. Subhead carries one hard number from our own data.
- **Number bar:** calls transcribed, orgs live, retention %. **Retention is our strongest
  stat** — see §3.5 on why it outperforms revenue.
- **Guarantee with stated conditions** — the single biggest gap in most B2B SaaS pages, and
  the thing King Kong built a $10.2B-claim agency on. Conditions make it survivable.
- **Disqualify by team size or call volume.** We don't want orgs below a floor, and saying so
  converts the ones above it.
- **Email-only capture.** Qualification moves to the call.
- **Palette:** dark navy base, warm off-white canvas, one accent reserved for buttons. **Our
  existing constraint:** the console already uses red for MISSED and orange for errors and
  KPI warnings (see the console colour rule). Keep the marketing accent off both hues —
  amber is effectively taken. A cool accent (violet, cyan) is free.
- Expect to land in the **SaaS band, ~3.8% median [DATASET]** — not the 12.3%
  events band. Set internal targets against the right row.

---

## 8. Gaps and what to verify next

Listed so nobody treats this document as more complete than it is.

1. **Both book funnels are undocumented.** `dotcomsecrets.com` and `expertsecrets.com`
   returned 403. The free-plus-shipping mechanics, bonus stacks with stated values, order-form
   bumps and one-click upsells in §2C are **prior knowledge, not observed**. Re-fetch with a
   different client, or capture them manually.
2. **The last third of King Kong's page was never read** — 50,047 of 150,047 characters.
   Re-fetch with `offset: 100000`.
3. **No order form or application form was ever observed.** Every page fetched defers its
   form to a booking widget or a next step that wasn't fetched. We have no verbatim field
   lists, and §6's form-length guidance rests entirely on vendor data.
4. **No webinar or VSL page was examined.** The Perfect Webinar structure in §2C is
   unverified.
5. **No mobile rendering was examined**, though that's where most of this traffic converts.
6. **The Unbounce 2024 figures should be checked against the original PDF**, not the vendor
   blogs that relabel them 2026.
7. **No ecommerce/DTC archetype was examined** — the set is entirely info-product and
   agency. If Aura ever runs a self-serve low-ticket offer, that gap matters.

---

## 9. Source list

### Primary — fetched live, 2026-10-12
- https://www.acquisition.com/
- https://www.acquisition.com/o-vegas
- https://www.kingkong.co/ *(partial — first 100k chars)*
- https://www.clickfunnels.com/
- https://russellbrunson.com/ *(no usable content)*

### Refused the fetch — HTTP 403
- https://www.dotcomsecrets.com/
- https://expertsecrets.com/

### Datasets
- Unbounce Conversion Benchmark Report — https://unbounce.com/conversion-benchmark-report/
  *(the 6.6% median and all per-industry medians; 2024 edition)*
- WordStream cross-industry data *(2.35% median, 11.45% top decile — accessed via
  aggregators, not the original)*

### Secondary — vendor aggregates, low confidence
- https://www.apexure.com/blog/landing-page-conversion-rate-benchmarks-by-industry
- https://coreppc.com/blog/landing-page-conversion-rate-benchmarks-2026/
- https://colorlib.com/wp/landing-page-statistics/
- https://www.digitalapplied.com/blog/landing-page-conversion-study-2000-pages-tested-2026

### Secondary — book summaries, unverified against the books
- https://medium.com/@jegathshree/sell-like-crazy-strategies-for-beginners-to-become-savvy-digital-marketers-fcdc07f543db
- https://www.autymate.com/book-summary/dotcom-secrets

### Explicitly rejected as sources
Scraped and AI-spun pages returned prominently by search and **not used**:
`ldap.kayako.com` (two pages titled as Hormozi landing-page advice, actually LDAP/SSO
filler), `bestnightout.slugandlettuce.co.uk`, `edx.ipeindia.org` (pirated-PDF pages),
`saude.arapiraca.al.gov.br` (DotCom Secrets PDF on a municipal health domain), and duplicated
"Perfect Webinar" articles on `connect.minco.com` and `imap.compagnie-des-sens.fr`.
