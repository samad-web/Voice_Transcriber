# 48 — How Top SaaS Sellers Build Pages: Wording, Type, Flow

**Status: research reference. Three recommendations have since been applied to
`/call-tracking-dashboard` only; everything else here is unbuilt, uncommitted
and undeployed.**

Applied 2026-10-13:

- **§7.2** The figure band moved from the middle of the pipeline section to
  directly under the hero, so a hard number lands inside the first two
  screenfuls. Position changed, content unchanged.
- **§4.4** A new "The problem" section before "What it does", on Ramp's
  before-state pattern: the stock Android call log drawn with the one column
  that matters empty, under a visible flat caption. New `CallLogSurface` in
  `components/explainer/surfaces.tsx`.
- **§3.4** The closing heading returns to the hero's own words ("Your team
  already sells on the phone."), with the old heading demoted to the lede.

**Not applied, and why:** recommendation 6 was withdrawn as already satisfied
(see 5.3). Everything in §11.3 needs an owner decision. §11.4's second door
needs a seeded demo tenant. The `/pricing` and `/start` items in §11.1 and
§11.2 were left alone because only this one page was in scope.

Companion to **doc 43**, not a replacement for it. Doc 43 tore down
direct-response funnels (Hormozi, King Kong, Brunson): proof walls, risk
reversal, repeated identical CTAs. This document tears down the other genre,
the **product-led SaaS vendor page**, and section 1 explains where the two
genres give opposite advice. Auratel currently sits between them, which is why
both documents exist.

---

## 0. How this was produced

Read this before citing anything below.

25 pages were fetched live on **2026-10-13**, with a browser user agent.
Two corpora:

**Corpus A, general SaaS craft reference (13):** linear.app, stripe.com,
vercel.com, notion.com, figma.com, ramp.com, attio.com, posthog.com, cal.com,
resend.com, supabase.com, retool.com, clay.com.

**Corpus B, Auratel's actual category (12):** callrail.com, invoca.com,
gong.io, observe.ai, convin.ai, dialpad.com, aircall.io, balto.ai, exotel.com,
myoperator.com, justcall.io, salesken.ai.

Also fetched: `callrail.com/pricing`, `linear.app/pricing`.

Three kinds of evidence, tagged throughout:

- **[MEASURED]** — extracted from the served HTML or the served CSS with
  `curl` + `grep`. Font file names, `font-family` declarations, design tokens,
  `clamp()` values, letter-spacing, heading text, meta descriptions, button
  labels. This is the most reliable material here because it is what the
  browser actually receives.
- **[LIVE]** — section order and copy read off the fetched page. Reliable for
  structure. Less reliable for completeness, because two pages (gong.io, and
  partially ramp.com) were truncated before the footer, and callrail.com
  returned a 29 KB JavaScript shell whose content had to be read through a
  second fetch.
- **[SYNTH]** — my inference across the corpus. Where I say "all" or "every
  page", it means every page in this 25-page corpus, which is a convenience
  sample of well-regarded vendors, not a random sample of SaaS.

**Provenance warnings.**

- The conversion statistics in section 10 are **mostly vendor and agency
  blogs**. Two large-sample studies disagree with each other by a factor of
  two on the same question. Treat every percentage in that section as a
  direction, never as a target. The primary sources I could not reach are
  named so they can be bought or requested later.
- No A/B test result in this document is mine. None of it has been tested on
  Auratel traffic. The corpus tells you what good vendors **believe**, which
  is a different thing from what converts on a Tamil Nadu telecalling buyer.
- Corpus B is where the money is for us, and corpus B is noticeably **worse
  built** than corpus A. See section 9.3 for the defects found in it.

---

## 1. The genre split, and where doc 43 and this document disagree

Both genres are trying to get a stranger to give up a phone number. They
disagree on how. **[SYNTH]**

| | Direct response (doc 43) | SaaS vendor (this doc) |
|---|---|---|
| Hero job | Promise an outcome | Name a capability |
| Proof | Wall of it, early, escalating | One number, then product panels |
| Product shown? | Rarely, late | **Immediately, as the main visual** |
| CTA count | Same CTA 5 to 7 times | 2 or 3 doors, repeated 3 to 4 times |
| Price | Hidden until the call | **Published, usually linked in the nav** |
| Risk reversal | Load-bearing guarantee | A trial, or nothing |
| Register | Urgent, second person | Calm, declarative |
| Page length | Very long | Medium, dense |

**Where they actively conflict, and which to follow:**

1. **Doc 43 says repeat one identical CTA. Corpus A pairs two different
   CTAs.** Follow corpus A. The reason is intent spread: a SaaS page is hit by
   both a self-serve buyer and a committee buyer, and one button cannot serve
   both. Every page in corpus A except one offers a low-commitment door and a
   high-commitment door side by side. See section 4.2.
2. **Doc 43 puts a stat bar immediately below the fold. Corpus A puts a logo
   strip there and defers stats.** Follow corpus A **only if you have logos**.
   We have three customers, so a logo strip is thin and a figure band is
   honest. This is already how `/call-tracking-dashboard` is built, and it was
   the right call.
3. **Doc 43's guarantee block is the highest-leverage element. Corpus A has
   no equivalent.** Corpus A substitutes a free tier or a credit-card-free
   trial, which Auratel does not have (the gateway is a placeholder, see
   `capture-pricing-0197`). So we have **neither** mechanism. This is the
   single biggest structural hole on our site and section 11.4 addresses it.

---

## 2. The section skeleton, measured across the corpus

Order and prevalence. Percentages are out of the 25 pages. **[LIVE]**

| # | Section | Prevalence | Notes |
|---|---|---|---|
| 1 | Announcement bar | ~40% | Attio, Ramp, Gong. Always a dated product or event link, never urgency |
| 2 | Nav: product menu, Pricing, 2 CTAs | 100% | "Pricing" is visible in the nav on 11 of 13 in corpus A |
| 3 | **Hero: headline, subhead, 2 CTAs, product visual** | 100% | |
| 4 | **Logo strip or customer count** | ~90% | Directly under the hero, before any explanation |
| 5 | **Product tiles that contain a UI panel** | 100% of corpus A | The core pattern. Section 6.1 |
| 6 | Mechanism / platform diagram | ~70% | "How the pieces fit" |
| 7 | Stats band | ~75% | 3 to 6 figures |
| 8 | Testimonials: name, title, company | 100% | |
| 9 | Integrations logo row | ~80% | Always with a count: "250+", "200+", "50+" |
| 10 | Security and compliance badges | ~25% corpus A, ~60% corpus B | Category tell. Section 9.2 |
| 11 | Industry or persona split | ~55% | Heavier in corpus B |
| 12 | Resources / changelog | ~45% | Proof of being alive |
| 13 | **Closing CTA, often repeating the hero headline** | 100% | Section 3.4 |
| 14 | Footer: 5 to 6 link columns, legal | 100% | |

**The ordering principle. [SYNTH]** Claim, borrowed credibility, then evidence
you built the thing, then earned credibility, then price, then the ask. The
logo strip at position 4 is doing one job: buying permission to be explained
to. It appears *before* explanation on nearly every page because explanation
is expensive attention and nobody spends it on an unknown vendor.

---

## 3. Wording: headlines

### 3.1 The five headline patterns **[LIVE]**

Verbatim from the corpus, grouped.

**A. Capability statement.** Names what the product *is*, for whom.

- "The product development system for teams and agents." (Linear)
- "The backbone of global commerce" (Stripe)
- "A Complete CX Communication Platform" (MyOperator)
- "One platform for all of finance." (Ramp, section head)
- "The enterprise Agentic AI platform built for scale" (Dialpad)

**B. Outcome imperative.** A verb aimed at the reader's number.

- "Make every conversation count" (CallRail)
- "Time is money. Save both." (Ramp)
- "Build systems to grow revenue" (Clay)
- "Win more revenue with AI" (Gong, closing)
- "Handle every conversation faster with JustCall"
- "Turn your growth ideas into reality today" (Clay, closing)

**C. Ranked category claim.** Requires a citable source, and corpus B abuses it.

- "#1 AI OS for Revenue Teams" (Gong)
- "The #1-rated AI platform for revenue teams" (Invoca)
- "Balto is the #1 Contact Center AI software" (Balto, meta description)
- "#1 Inbound Call Tracking for 8 years" (CallRail, **with no source label on
  the page**, see 9.3)

**D. Declared shift.** Positions the category as having just moved.

- "Welcome to agentic revenue." (Attio)
- "Email reimagined." (Resend)
- "Customer communications, evolved" (Aircall)
- "AI where your team works." (Notion)
- "First in AI. Best in Agentic." (Dialpad)

**E. Short noun phrase with a pun.** High risk, needs brand equity.

- "Apps that mean business" (Retool)
- "We've got the receipts." (Ramp, section head)

### 3.2 Measured properties of hero headlines **[MEASURED]**

- **Length: 3 to 9 words.** Median 5. The longest in the corpus is Linear's 9.
  Nothing is a sentence with a subordinate clause.
- **Full stops are common** in corpus A and rare in corpus B. Attio, Linear,
  Ramp, Resend and Notion all end the headline with a period. It reads as
  settled rather than shouted.
- **No headline in corpus A contains a number.** Numbers live in the subhead,
  the logo strip and the stats band. Corpus B puts "#1" and "5,000+" in the
  headline, and it reads cheaper.
- **No question marks.** Zero in 25 heroes.
- **No exclamation marks** except cal.com's "…and so much more!", which is a
  minor section head.

### 3.3 The headline and subhead division of labour **[SYNTH, strong in the data]**

This is the most transferable finding in the document. The headline is short
and carries almost no information. The **subhead carries the mechanism**, and
it is where the specifics go.

CallRail, the cleanest example in our own category:

> Headline: "Make every conversation count"
> Subhead: "CallRail connects the dots between campaigns, conversations, and
> customers for faster growth and better ROI."

Five vague words, then a sentence that names three nouns the buyer recognises
and the outcome. Compare Linear:

> Headline: "The product development system for teams and agents."
> Subhead: purpose-built for planning and building, designed for the AI era.

And Ramp:

> Headline: "Time is money. Save both."
> Subhead: cards, expenses, bill payments and banking, "in the blink of AI."

The pattern is consistent: **headline earns the next three seconds, subhead
earns the scroll.** A headline trying to do both ends up long and does
neither.

### 3.4 The closing headline repeats the hero **[LIVE]**

Several pages literally repeat their hero headline in the final CTA block.

- **Ramp** opens with "Time is money. Save both." and closes with "Time is
  money. Save both.", same email field, same "Get started for free" button.
- **Linear** closes with "Built for the future. Available today." and uses the
  **same block on `/pricing`**, so the two pages end identically.
- **Attio** opens "Welcome to agentic revenue." and closes "Agentic revenue
  runs on Attio." The variation is deliberate: same phrase, now with the
  product as subject.

**[SYNTH]** This is cheap and we are not doing it. The reader who scrolled the
whole page should be returned to the one sentence you want them to remember,
not handed a new one.

---

## 4. Wording: CTAs, section heads, microcopy

### 4.1 Every CTA label in the corpus **[MEASURED]**

Pulled from anchor and button text in the served HTML.

**Self-serve, primary:** "Start for free" (Attio), "Get started" (Linear,
Resend), "Get started for free" (Ramp), "Sign up free" (CallRail), "Get Notion
free", "Try for Free" / "TRY FOR FREE" (Aircall), "Start Free Trial"
(JustCall), "Try For Free" (Exotel), "Start free trial" (CallRail header),
"Start 14-day trial" (CallRail pricing), "Sign up" (Linear nav).

**Assisted, secondary:** "Talk to sales" (Attio), "Contact sales" (Linear,
Stripe), "Get a demo" (CallRail, Balto), "Book a Demo" (Gong, Exotel,
JustCall, Convin), "Request a demo" (Notion, Dialpad, Salesken), "Request
Demo" (Exotel), "Let's Talk" (Salesken), "TALK TO SALES" (Aircall).

**Low-friction third door:** "Send me a demo" (Attio), "See Gong in action",
"See what you've been missing" (CallRail), "Try AI Call" (Convin), "Call now"
(Balto), "Watch Now" (JustCall).

**Already-a-customer:** "Sign in", "Log in", "Open app" (Linear), "Open Attio".

**Navigational, inside sections:** "Learn more→" (Linear, used four times),
"Learn about Ramp Intelligence", "Discover Call Tracking", "Explore Premium
Conversation Intelligence™", "See all integrations", "Read the success story",
"Customer stories→", "View all→", "See pricing", "Compare all features",
"View docs", "Explore the ecosystem", "Read more", "Read the report".

**Observations. [SYNTH]**

- **"Submit" appears nowhere in 25 pages.** Not once.
- The primary CTA is **first person or outcome-shaped**, never a form verb.
- Section-level CTAs use **"Learn more" plus an arrow glyph**, visibly
  lower-weight than the hero buttons. Linear uses the identical "Learn more→"
  on all four product tiles, which makes the tiles read as peers.
- Corpus B shouts. Aircall ships all-caps "TRY FOR FREE" and "TALK TO SALES"
  next to title-case versions of the same labels, which is a consistency bug,
  not a style.

### 4.2 The two-door rule **[LIVE, 24 of 25 pages]**

Every page but one presents a **low-commitment door and a high-commitment
door adjacent in the hero**, styled so the primary one is obvious.

- Attio runs **three**: "Talk to sales", "Start for free", "Send me a demo".
  "Send me a demo" is the interesting one, an email-me-a-recording door that
  costs the visitor nothing and costs Attio no sales time.
- CallRail: "Sign up free" + "Get a demo", with the risk line directly under
  them: "Try a free 14-day trial, no credit card required."
- Gong, Invoca, Observe, Balto, Salesken, Convin: **demo only, no self-serve
  door at all.** This is the enterprise sales-led shape and it is the shape
  Auratel currently has.

**The split is the business model, not a design choice. [SYNTH]** Published
self-serve pricing plus "Start for free" means the product can be entered
without a human. Demo-only means it cannot. We are demo-only because
provisioning needs an operator to grant modules (`org-modules-and-features`)
and the payment gateway is a placeholder. So our one door is correct **today**
and section 11 does not recommend faking a second one.

### 4.3 Section heading style **[MEASURED]**

Corpus A writes section heads as **short declarative sentences with full
stops**, in the product's voice:

- "Your team, amplified." / "Agents dig. You close." / "Speed to lead, every
  time." / "Skip the review scramble." / "Keep more. Grow more." / "Spot the
  shift early." / "The move's ready. You make the call." (all Attio)
- "Cards & Expenses that handle themselves" / "Accounting automation
  eliminates month-end madness" / "Systems that never spoke" / "Scale the
  team. Shrink the paperwork." (all Ramp)
- "See what drives customers" / "Capture every opportunity" / "Turn insights
  into impact" (CallRail, the three feature cards)

**[SYNTH]** Note what these are not. They are not feature names. "Call
Intelligence" is a feature name; "Spot the shift early." is what the feature
is for. CallRail's three cards are the clearest template available to us
because they are in our category and each one is a **verb plus the buyer's
object**: drives customers, every opportunity, insights into impact.

### 4.4 Microcopy worth stealing **[LIVE]**

- "Try a free 14-day trial, no credit card required." (CallRail, under the
  hero CTAs, not in the headline)
- "No credit card required." (CallRail, repeated at the closing CTA)
- "plus additional usage" (CallRail pricing, under every price. Honest, and it
  pre-empts the single biggest objection to usage billing)
- "Save up to 10% with a yearly plan" (CallRail billing toggle)
- "Free for everyone" (Linear's $0 tier, instead of "Free")
- "Billed yearly" / "Annual billing only" (Linear, per plan)
- "This is what five separate systems to reimburse a flight looks like."
  (Ramp, as a **caption on a deliberately ugly diagram of the problem**)
- "Don't just take our word for it" (cal.com, testimonial section head)

Ramp's caption is the one to study. It is the only page in the corpus that
draws the **before** state as a diagram and captions it in plain language.
That is a technique available to us and currently unused: the state of a floor
with no call data is genuinely drawable.

---

## 5. Typography, measured from served CSS

This is the most solid section in the document because it is extracted from
what the browser was sent, not from a style guide. **[MEASURED]**

### 5.1 Font families actually served

| Site | Body / UI | Display | Serif accent | Mono |
|---|---|---|---|---|
| Linear | **Inter Variable** | same, tightened | **Tiempos Headline** | Berkeley Mono |
| Stripe | **sohne-var** (Söhne) | same | none | Source Code Pro |
| Vercel | **Geist Variable** | same | none | Geist Mono + GeistPixel |
| Attio | **Inter** | **Inter Display** | **Tiempos Text** | JetBrains Mono |
| Resend | **ABC Favorit** + Inter | ABC Favorit | **Domaine** | Commit Mono |
| Retool | **Px Grotesk** | Px Grotesk Bold | none | Saans VF |
| Notion | **NotionInter** (custom cut) | same | none | none served |
| Ramp | **Lausanne** | Lausanne | none | IBM Plex Sans |
| PostHog | **RoundHog** (custom) | same | Charter, Fairytale Serif | IBM Plex |
| Figma, Supabase, Cal.com | hash-named subsets, family not recoverable from the HTML | | | |

**Findings. [SYNTH]**

1. **Nine of ten recoverable sites ship a licensed or custom typeface, not a
   Google font.** The exceptions are Inter (free) and IBM Plex (free). Notion
   went as far as shipping its own cut of Inter named `NotionInter`.
2. **Nobody uses more than three families on a homepage.** The maximum is
   sans + serif accent + mono.
3. **The separate display cut is a real pattern.** Attio serves
   `inter_display_bold`, `inter_display_medium`, `inter_display_semibold`
   alongside the text cuts. Inter Display has tighter spacing and smaller
   apertures, drawn for large sizes. Using the text cut at 4 rem is the single
   most common amateur typography mistake and the corpus does not make it.
4. **The serif is for editorial, not product.** Linear's Tiempos Headline,
   Attio's Tiempos Text and Resend's Domaine appear in blog and changelog
   contexts, not in the product UI. It signals "we write" rather than "we are
   a bank".
5. **Mono is credibility texture.** Four sites serve a mono that the marketing
   page barely uses. It appears in version numbers, labels, API snippets.

### 5.2 Linear's full type scale, as served **[MEASURED]**

Extracted from `static.linear.app/web/_next/static/css/layout.BJy9RiM8.css`.
This is a complete, production-tested scale, and it is worth having written
down.

**Display, 9 steps:**

| Token | Size | Line height | Letter spacing |
|---|---|---|---|
| `--title-1` | 1.0625rem (17px) | 1.4 | -0.012em |
| `--title-2` | 1.25rem (20px) | 1.33 | -0.012em |
| `--title-3` | 1.5rem (24px) | 1.33 | -0.012em |
| `--title-4` | 2rem (32px) | 1.125 | **-0.022em** |
| `--title-5` | 2.5rem (40px) | 1.1 | -0.022em |
| `--title-6` | 3rem (48px) | — | -0.022em |
| `--title-7` | 3.5rem (56px) | 1.1 | -0.022em |
| `--title-8` | 4rem (64px) | 1.06 | -0.022em |
| `--title-9` | 4.5rem (72px) | — | -0.022em |

**Body:**

| Token | Size | Line height | Letter spacing |
|---|---|---|---|
| `--text-tiny` | 0.625rem (10px) | — | — |
| `--text-micro` | 0.75rem (12px) | 1.4 | — |
| `--text-mini` | 0.8125rem (13px) | 1.5 | -0.01em |
| `--text-small` | 0.875rem (14px) | 21/14 = 1.5 | -0.013em |
| `--text-regular` | **0.9375rem (15px)** | **1.6** | -0.011em |
| `--text-large` | 1.0625rem (17px) | 1.6 | — |

**Three things to take from this. [SYNTH]**

1. **Body text is 15px, not 16px.** Linear, and our own marketing app, both
   land on `0.9375rem`. Ours got there independently (`text-[0.9375rem]` is
   all over `apps/marketing`), which is reassuring.
2. **Negative tracking scales with size, in two plateaus.** Everything from
   32px up is -0.022em; everything below is between -0.01em and -0.013em.
   There is no smooth ramp. This is a simple, copyable rule: **one tracking
   value for display, one for text.**
3. **Line height inverts against size.** 1.6 at body, 1.06 at 64px. Display
   line height below 1.1 is what makes a big headline read as a single object
   rather than stacked lines.

**Linear's weights are non-integer: 300 / 400 / **510** / **590** / **680**.**
Those are variable-font axis positions, not the usual 500/600/700. 590 instead
of 600 is slightly lighter than the standard semibold, which is why Linear's
headings read crisp rather than heavy. It also serves
`font-feature-settings: "cv01", "ss03"` (single-storey `a` and an alternate
`g`) and `font-variation-settings: "opsz" auto`.

### 5.3 Other measured type facts **[MEASURED]**

**Stripe:** `--hds-font-family: "sohne-var", "SF Pro Display", sans-serif`,
mono `"SourceCodePro", "SFMono-Regular", monospace`. **Dominant letter spacing
is -0.01em, in 26 separate declarations** — a single global tightening rather
than per-size tuning. Simpler than Linear and it works.

**Vercel:** letter spacing is authored **in pixels, scaling hard with size**:
-0.32, -0.4, -0.96, -1.28, -2.88, -3.84px. At -3.84px the headline is set very
tight. Hero sizing:

```
font-size: clamp(36px, 6.25vw - 26px, 64px)
font-size: clamp(24px, 3.75vw, 48px)
```

The `- 26px` offset in the `vw` term is worth noting: it delays growth so the
headline stays at its floor across small viewports instead of creeping.

**Ramp** uses **container query units**, not viewport units:

```
font-size: clamp(2.75rem, 12cqi + .5rem, 4.5rem)
font-size: clamp(3.25rem, 17vw, 5rem)
```

`cqi` sizes against the container, so the same component is correct in a
narrow column and a wide one. This is the current best practice and neither our
marketing app nor the console uses it.

**Resend** runs the largest hero in the corpus: `clamp(4rem, 10.26vw, 7.5rem)`,
so 120px at full width, with `letter-spacing: -.1rem`.

**Our own app, measured. [MEASURED]** `apps/marketing` ships exactly five
fluid sizes:

```
clamp(2.125rem, 6.2vw, 4.25rem)      display, 34px to 68px
clamp(1.75rem,  3.8vw, 2.75rem)      section head, 28px to 44px
clamp(1.5rem,   4.5vw, 3rem)         /start h1, 24px to 48px
clamp(1.0625rem,1.6vw, 1.1875rem)    lede, 17px to 19px
```

**Our display ceiling of 68px is already at the top of the corpus**, just under
Linear's 72px and above Vercel's 64px. So the worry that we are quieter than
the category is wrong.

**And the tracking rule is already there, tighter than Linear's.**
`.mk-display` in `app/brand.css` sets `letter-spacing: -0.035em` with
`font-weight: 800` and `line-height: 1.05`, against Linear's -0.022em at weight
590. Heavier and tighter rather than lighter and looser: a different but
internally consistent choice, and `text-wrap: balance` is on it too, which
nothing measured in the corpus bothers with. **There is nothing to do here.**
Both typography recommendations I first drafted for section 11 were already
satisfied, which is the argument for measuring our own tree before writing a
recommendation about it.

**Fonts, measured:** `app/layout.tsx` loads **Inter alone**, via
`next/font/google`, one family for everything (doc 16 §1.2), self-hosted at
build time. No display cut, no mono, no serif. Against the corpus that is the
minimum viable configuration: defensible, and the single highest-value addition
would be Inter's display cut for the sizes above 32px.

---

## 6. Design flow and layout

### 6.1 The product panel is the hero image **[LIVE, 100% of corpus A]**

Not a screenshot of a dashboard in a laptop frame. Not an illustration. **A
rendering of the actual interface, cropped to the one thing the section
claims.**

- **Linear**: hero is an issue view with a comment thread. Then four tiles,
  each containing a different panel: a backlog with status counts, a roadmap
  timeline labelled Alpha / Beta / Public Beta / GA, an agent chat creating
  issues, a code-review list with PR numbers.
- **Attio**: a Slack thread where an agent answers "which deals should I
  prioritise", an agent run log, a company table with ICP scores (98, 98, 97,
  96, 96, 92, 91, 91, 88), a workflow diagram, a Kanban pipeline with deal
  values, a natural-language query shown resolving to SQL.
- **CallRail**: a pie chart with Google Ads at 45%, a call transcript for
  "Alice Mills" requesting an appointment becoming a "New Prioritized Lead"
  card, a call summary for "Henry Coleman".

**[SYNTH] Two properties make these work.**

**Panels are populated with plausible, specific, consistent fake data.**
CallRail names people. Attio uses real company names and non-round scores (97,
96, 92, not 95, 90, 85). Round numbers read as placeholder; 10.9M and 6,278
read as measured.

**Each panel is cropped to exactly the claim.** The roadmap tile shows a
roadmap, not the whole app with a roadmap in it.

Our `components/explainer/surfaces.tsx` already does this, hand-built in HTML,
theme-aware, no images, and it shares one fixture across all five panels
(20,000 interlock bricks, Perundurai, ₹32/unit). That shared-fixture decision
matches Attio and CallRail and should be kept.

### 6.2 Layout mechanics **[LIVE / SYNTH]**

- **Two columns for narrative, three for peers.** Feature sections alternate
  text and panel in two columns. Equivalent items go in a three-up grid.
- **Alternating sides**, text-left then text-right, down the feature run.
- **Logos get a count, always.** "250+ integrations", "200+ Integrations",
  "50+ marketing, CRM, and automation platforms". Never a bare row.
- **The stats band is a visual break**, usually inverted or tinted, 3 to 6
  figures with one-line labels.
- **Testimonial attribution is always three parts**: name, job title, company.
  Never just a name. Gong goes further and names the function: "Matt McBreen,
  VP of Sales Enablement, ADP".
- **Changelog or resources near the footer** proves the product is alive.
  Linear lists four dated entries; Attio lists four dated 23 September 2026;
  Gong carries five articles dated 30 September to 9 October 2026. Recency is
  the entire point, which also means **a stale one is worse than none**.

### 6.3 Navigation **[LIVE]**

- Pricing is a **top-level nav item** on 11 of 13 in corpus A.
- The product menu is a **grouped mega-menu**, labelled by job. Attio's groups
  are "Context", "Agents & automations", "Ecosystem", "Attio for", "Get
  started" — not "Features".
- "Attio for Slack / ChatGPT / Claude" is a nav pattern worth noting: the
  integration is positioned as a **place the product lives**, not a feature.
- Two or three buttons at the nav's right edge, in commitment order.
- **Nobody shows a visible breadcrumb trail.** Our 2026-10-13 decision to drop
  the trail and keep only the `BreadcrumbList` JSON-LD matches the corpus.

---

## 7. Social proof mechanics

### 7.1 Every number in the corpus **[LIVE]**

| Vendor | Numbers used |
|---|---|
| Linear | 40,000+ product teams |
| Attio | 30,000+ customers; 10.9M MCP calls/month; 400M API calls/week; 76k active customer agents; 15M emails synced/day; 83% faster lead triage (Granola) |
| Ramp | 70,000 companies; growing 3.2x faster than average; $1M+ saved (Notion) |
| Gong | 5,000+ customers; 6,278 G2 reviews; 64% productivity increase, 10 hours/seller/week, 46% ramp reduction (Anthropic); 6,700 hours saved, 32% response lift (Uber for Business); 14 courses with 75+ scenarios in ~3 hours (Frontline); 120 million calls analysed (Gong Labs) |
| CallRail | 14 years; 225,000+ businesses; 1B+ leads; 7,000+ agencies; Capterra 4.6; GetApp 4.5 |
| Convin | 4.7/5; 70+ languages; 21% sales, 27% CSAT, 100% compliance, 17% collection, 56s lower AHT, 60% faster ramp; 5% to 100% audit coverage (Kotak Life); 70% conversion lift (ezobooks) |
| Retool | 10,000+ teams |
| JustCall | 6,000+ businesses; 100+ integrations |
| Balto | 300+ customers |
| MyOperator | 15 years; 12,000+ brands |
| Aircall | 250+ integrations |

### 7.2 The finding **[SYNTH]**

**Every page in the corpus puts at least one hard number within the first two
screenfuls**, and that number is always one of exactly four kinds:

1. **Customer count.** 40,000+ / 30,000+ / 70,000 / 5,000+ / 225,000+ / 10,000+
2. **Years in business.** CallRail's "14 years", MyOperator's "15 Years of Trust"
3. **Volume processed.** 1B+ leads, 400M API calls/week, 15M emails/day,
   120 million calls analysed
4. **A named customer's outcome percentage.** "83% faster lead triage
   (Granola)", "64% productivity increase (Anthropic)"

Kind 4 is the most persuasive and the most expensive, because it requires a
real customer to agree to a real measured figure in writing.

**The escalation order is consistent:** anonymous volume, then logos, then
named person plus title, then a named customer with a number, then third-party
review scores. Weakest to strongest, and the strongest is last so it is the
thing standing next to the final CTA.

### 7.3 Integrity, and what we are allowed to say

**This is the part that binds us.** The standing instruction on this project is
*do not promise what we do not have in the app, and what is not completely
built*. Measured against that:

| Pattern | Can Auratel use it today? |
|---|---|
| Customer count | **No.** Three customers is not a proof number |
| Years in business | **No.** Not yet credible |
| Volume processed | **Not yet, but closest.** Calls transcribed is countable from the DB. It needs a decision on whether a live figure can be published, and it must not be an estimate |
| Named customer outcome % | **No.** The "5x" in `components/proof.tsx` is unsubstantiated and still has no sign-off |
| Third-party review score | **No.** No G2, Capterra or GetApp listing exists |
| Product facts | **Yes.** 4 languages, 8 handset brands, 11 connectors, 90-day retention. This is what the figure band already uses |

So the corpus's main credibility device is **unavailable to us**, and the
figure band of product facts was the correct substitution. The honest path to a
real number is kind 3, and it is a measurement task, not a copy task.

---

## 8. Pricing page anatomy

Two fetched in full. **[LIVE]**

### 8.1 CallRail, usage-based, closest to our model

- H1 "Lead Engagement Plans", subhead naming the included allowance:
  "packages that start with 5 numbers & 250 minutes".
- **Billing toggle**, Yearly / Monthly, with "Save up to 10% with a yearly plan".
- **Four plans**: Lead Tracking $50/mo, Lead Tracking Complete $95/mo, Lead
  Conversion $150/mo, Lead Conversion Complete $195/mo. Every one carries
  **"plus additional usage"** under the price.
- Each card: three CTAs. "See what's included", "See all … plans", "Start
  14-day trial".
- **No "Most Popular" badge on any plan.**
- An **add-on promo between sections**: Voice Assist from $95/month, with a
  footnote about the $1/call overage.
- **Comparison table** with a See more / See less toggle, grouped by
  allowance, then **per-unit add-on prices published**: local numbers $3 each,
  toll-free $5, toll-free minutes $0.08, SMS $0.03, form submissions $0.02.
- **FAQ as objection handling**, seven items, and notably blunt: "What if I go
  over my included usage?" is answered with the fact that overage fees are
  "not refundable under any circumstances". Also covers the trial, demos,
  supported countries (US, Canada, UK, Australia), billing mechanics, API
  pricing tiers, and a HIPAA BAA.

**[SYNTH]** The lesson for us: **publishing the per-unit overage price is a
trust move, not a risk.** A usage-billed product whose overage rate is hidden
reads as a trap.

**We already clear this bar, and then some. [MEASURED]** `app/pricing/page.tsx`
publishes the add-on meters and states outright that an hour pack "work[s] out
dearer per hour than" moving up a tier. That is a sentence arguing against the
upsell on the upsell's own card, and nothing in the corpus does it. Keep it.

### 8.2 Linear, seat-based

- H1 is just "Pricing". Four plans: Free $0 "Free for everyone", Basic $10
  per user/month "Billed yearly", Business $16 "Billed yearly", Enterprise
  "Custom" "Annual billing only".
- **No monthly/annual toggle at all.** Yearly is simply stated.
- **No highlighted or recommended plan.**
- CTA is "Get started" on the three priced tiers and **"Contact sales" on
  Enterprise**, with Business carrying both.
- "Trusted by more than **40,000** companies" sits **between the cards and the
  comparison table**, so the proof is placed at the moment of hesitation.
- Comparison table grouped under 13 headings (Members, File upload, Issues,
  Teams, Core, Triage, Releases, AI and agent workflows, Integrations, Team
  management, Analytics & Reporting, Security, Support), with a footnote
  "** Requires AI credits".
- **No FAQ.**
- Closes with the same "Built for the future. Available today." block as the
  homepage.

### 8.3 Against our own `/pricing` **[MEASURED]**

Our page is five sections: `Hero`, `Plans`, `Addons`, `Limits`, `Close`.
What the corpus does that we measurably do not:

- **No social proof anywhere on the page.** No `proof`, no testimonial, no
  figure band. Linear places its customer count between the cards and the
  comparison table, at the exact moment of hesitation. Our page has nothing in
  that slot.
- **No billing-period toggle**, and no saving stated for annual.
- **No FAQ.** CallRail answers seven awkward billing questions; we answer none
  on this page, although `Limits` covers the most important one.
- **No comparison table**, only plan cards.
- The closing block is not the homepage's.

What we already do right: Enterprise shows "Quoted" and never a figure, which
matches Linear's "Custom"; and every figure is read from the same constants
`quoteSubscription()` charges against, so the page cannot quote a price the
invoice will not honour. That constraint is stronger than anything in the
corpus and must not be relaxed to make a page prettier.

---

## 9. Corpus B: what our actual category does

### 9.1 The structural difference **[LIVE]**

Conversation-intelligence vendors are **sales-led, not product-led**:

- **No self-serve door.** Gong, Invoca, Observe, Balto, Salesken, Convin all
  lead with a demo booking.
- **No published price.** None of the six shows a figure. CallRail and JustCall
  do, and both are SMB-facing.
- **Security and compliance is a section, not a footer link.** Convin has
  "Experience Uncompromised Data Security" with six badges (GDPR, CCPA, HIPAA,
  SOC 2 Type II, ISO 27001, Secured by Astra). Balto: "Designed to meet the
  highest security standards".
- **Problem-first copy.** Convin's whole middle section is a tabbed
  problem/solution/impact grid, by function: Sales, Support, Collection.
- **Persona paths near the end.** Gong routes CRO, RevOps, Sales teams,
  Customer success, Enablement. Balto routes Agent, Manager, Executive.
- **Industry pages.** Gong: Technology, Financial services, Healthcare,
  Manufacturing.

### 9.2 Convin, the closest comparable **[LIVE]**

Indian, Bengaluru, B2C contact centres, multilingual, same buyer as ours. Two
devices worth copying and one worth avoiding.

**Worth copying, the problem/impact card.** Each card states a problem as a
statistic, then the solution, then the impact:

> "80% of deals need 5+ follow-ups" → shorten the sales cycle by 50%
> "50% of support calls face escalations and delays" → 35% higher FCR, 56
> seconds lower AHT

**Worth copying, the demo form asks for the scenario.** Their form takes
business email, contact number, first name, **a description of the call
scenario with a "Use Sample Scenario" option**, and a language choice of
English, Hindi or Hinglish. Then: "Perfect!! You will receive a call right
away." The AI calls you back and runs your scenario.

That "Use Sample Scenario" button is the smartest thing in corpus B. It
removes the blank-page problem from the one free-text field in the funnel.
Our `/start` funnel has the same blank-field problem.

**Worth avoiding:** the impact numbers have no source. "60% of sales time is
wasted on unqualified leads" is stated with no citation anywhere on the page.

### 9.3 Defects found in the wild **[LIVE]**

Recorded in the spirit of doc 43 §6, because the lesson is that these ship
even at large vendors.

1. **convin.ai ships a button labelled "Button Text".** It is in the served
   HTML. A template placeholder that reached production.
2. **convin.ai repeats one boilerplate impact line** ("Automate up to 60% of
   your lead qualification process") across cards whose problems differ, so
   the Collection cards claim a lead-qualification outcome.
3. **convin.ai attributes several different quotes to "Preeti Singh"**, with
   different companies. A CMS loop artifact.
4. **callrail.com's Google Ads logo has `alt="HubSpot"`.** Wrong alt text in
   the integrations row.
5. **callrail.com states "#1 Inbound Call Tracking for 8 years" with no source
   label**, sitting between two badges that do name their source (Capterra
   4.6, GetApp 4.5). The unsourced claim is the strongest one.
6. **callrail.com's own pricing page disagrees with itself** between renders:
   225,000+ vs 220,000+ businesses, and differing included allowances and
   overage rates. Content assembled from more than one source of truth.
7. **aircall.io ships all-caps and title-case versions of the same two CTAs.**

**[SYNTH] The common cause in 1, 2, 3 and 6 is the same one we have: copy held
in more than one place with no single source of truth.** Our marketing app
avoids it for prices by reading `CAPTURE_PLANS`. Nothing protects our claims,
counts or customer quotes the same way.

---

## 10. What the evidence actually supports

Separated by how much weight it can carry. Sources in section 13.

### Reasonably solid

- **Attention falls off a cliff below the fold.** Nielsen Norman Group
  eyetracking, 130,000+ fixations on 1920x1080: **57% of viewing time above
  the fold** in 2018, 74% within the first two screenfuls (down to 2160px).
  The 2010 figure was 80% above the fold. The shape held across both studies.
  NNG itself cautions the result may partly reflect short pages or people
  giving up.
- **Shorter forms convert better, in direction.** Consistent across every
  source. **The magnitude is unreliable**: two NP Digital studies from the same
  period report single-field conversion at 18.2% and 28.2%, and five-field at
  8.1% and 20.5%. Same direction, wildly different levels. HubSpot's
  40,000-page analysis adds that **multiple textareas and multiple dropdowns**
  hurt more than extra single-line fields, and that asking for age, phone
  number or street address depresses conversion.
- **Mobile speed correlates with conversion.** "Milliseconds Make Millions",
  Google-commissioned, run by 55 and Deloitte: 37 brand sites, 30.5M sessions,
  Oct-Nov 2019. A **0.1s mobile load improvement** associated with +8.4%
  retail conversion, +10.1% travel conversion, and **-8.3% bounce on
  lead-generation informational pages**. Correlational, mobile only, 2019.

### Weak, directional only

- **Three pricing tiers.** One benchmark of ~200 SaaS sites: three tiers on
  68% of them, with 14% higher conversion than four or more. Single agency
  study, method not published.
- **"Most Popular" badges.** Recommended by vendors, but **CallRail and Linear
  both ship no badge at all**, so the corpus does not support it as universal.
- **Anchoring and the decoy effect.** Mechanism is well established in
  behavioural economics (Ariely's *Economist* case is print subscriptions, not
  SaaS). The SaaS percentages circulating, "up to 30%" and "20%", trace to a
  single vendor blog citing sources I could not reach. One useful caveat does
  hold up: a decoy only works when tiers are **comparable on the same
  dimensions**, otherwise visitors defer instead of choosing.

### Folklore, no usable evidence found

- **CTA copy lift numbers.** I could not find a rigorous head-to-head test of
  "Get started" vs "Submit" vs "Free trial" with published figures. The
  widely-repeated "Start your free trial" → "Start my free trial" result is
  cited secondhand to Unbounce and I could not reach the original. The "12-28%
  lift from action-oriented CTAs" range has no study behind it. The one
  defensible statement is structural, not statistical: **"Submit" appears
  nowhere in 25 professionally built pages.**
- **Benchmark conversion rates.** A 3.8% SaaS median is attributed to
  Unbounce's 2026 report by several secondary sources; I could not reach the
  report. Other aggregates say 3.0%, 2-5%, or 1.5%. More useful than any
  single figure is the consistent claim that **offer type dominates industry**:
  demo-request pages land around 1.5-4% while self-serve trial pages land
  around 4-10%. If that holds, our demo-only shape **caps our ceiling**, which
  is an argument for section 11.4 rather than for more copywriting.

---

## 11. Application to Auratel

Recommendations only. Ordered by expected value over effort. Nothing here is
built.

### 11.1 Free, and nearly certainly right

1. **Repeat the hero headline in the closing CTA.** Ramp, Linear and Attio all
   do it. We write a new sentence at the bottom of every page.
2. **Rewrite section heads as declarative sentences with full stops**, in the
   CallRail shape of verb plus the buyer's object. Our heads currently name
   features.
3. **Put the customer count equivalent on `/pricing`, between the cards and
   the comparison table**, where Linear puts "Trusted by more than 40,000
   companies". We cannot use a count, but the product-facts figure band fits
   that slot exactly.
4. **Add the billing-period saving as text**, CallRail's "Save up to 10% with a
   yearly plan", provided the number is derived from `CAPTURE_PLANS` and not
   typed.
5. **Add a pricing FAQ** answering the awkward ones directly: what happens at
   the plan's call limit (the answer already exists, "A call is never
   refused"), what the per-unit overage is, what happens to recordings at 90
   days, who can hear a recording (`recordings-rbac-0196`, `call-access-gate`).
6. ~~Raise the display ceiling. Add a display tracking rule.~~
   **Withdrawn, both already satisfied.** Measured in 5.3: our ceiling is 68px
   and `.mk-display` already carries -0.035em, tighter than Linear's -0.022em.
   Nothing to change.

### 11.2 Cheap, and clearly supported by the corpus

7. **Draw the before state and caption it.** Ramp's "This is what five
   separate systems to reimburse a flight looks like." A diagram of a floor
   with no call data, captioned plainly, is drawable with the same hand-built
   HTML technique as `surfaces.tsx` and we have nothing like it.
8. **Give the `/start` free-text field a "Use a sample" affordance**, as Convin
   does. This is the only field in our funnel that presents a blank page.
9. **Add the integration count to any logo row**, never a bare row.
10. **Add Inter's display cut for sizes above 32px.** We load Inter alone
    (5.3), and the corpus does not set a text cut at 4 rem. `next/font/google`
    can load a second Inter instance, or Inter's `opsz` axis can be driven with
    `font-variation-settings` the way Linear does (`"opsz" auto`).
11. **Audit for all-caps/title-case CTA drift** before it becomes Aircall's bug.

### 11.3 Needs a decision from the owner, not from me

12. **A publishable volume number.** "N calls transcribed", countable from the
    DB. This is the only one of the corpus's four credibility numbers we can
    honestly reach. It needs: a decision that the figure can be public, a
    single source of truth so it cannot drift the way CallRail's 225,000 vs
    220,000 did, and a rule for how often it updates. **It must be counted,
    never estimated.**
13. **Third-party review listings.** Every corpus B vendor has G2 or Capterra
    badges and we have none. Getting listed is a business task, and the
    badges then become the strongest proof we could carry.
14. **Testimonial sign-off, still outstanding.** All three quotes in
    `components/proof.tsx` are written from what was relayed, not transcribed,
    and the "5x" is unsubstantiated and does not say 5x of what. The corpus
    attributes every quote to name, title and company; two of ours have no
    named person. **This gates publishing any page that imports `proof.tsx`,
    which is now more than one page.**

### 11.4 The real structural gap

The corpus splits cleanly: self-serve pages publish a price and a free door;
sales-led pages publish neither and sell demos. **We publish a price but have
no free door**, which is the one combination nobody in the corpus runs.

Doc 43's answer to a missing free door was a risk-reversal guarantee, and
corpus A's answer is a free tier or a no-card trial. **We have neither**, and
if the demo-page ceiling in section 10 is real, that is a cap on the whole
site's performance that no amount of copy work lifts.

The cheapest credible version is **Attio's third door, "Send me a demo"**: an
emailed recording. It costs no sales time, no provisioning, no gateway, and no
new claim. It is a genuine low-commitment door and it fits our constraints
better than a trial does. It also depends on a recording existing, which
depends on a seeded demo tenant, which is the same prerequisite the
`surfaces.tsx` panels are standing in for.

### 11.5 What not to copy

- **"#1" claims.** Three corpus B vendors use them; one of them, CallRail,
  ships its strongest claim unsourced. We have no ranking of any kind.
- **Unsourced impact percentages**, which is most of Convin's page.
- **A stats band of outcome percentages.** We cannot fill one honestly.
- **A stale changelog.** Worth having only if it stays current.
- **An "AI agents" framing.** Corpus-wide right now, and it would oversell
  Agent Studio, which is uncommitted and local only.

---

## 12. Gaps, and what to verify next

- **callrail.com returned a JS shell on the first fetch** and its content came
  from a second pass that produced self-inconsistent figures. Its numbers here
  should be re-read before being quoted anywhere public.
- **gong.io and ramp.com were truncated** before their footers. Their closing
  sections are likely under-described.
- **Figma, Supabase and Cal.com serve hash-named font subsets**, so their
  families are not recoverable from the HTML. Needs a rendered-DOM check
  (`getComputedStyle`) rather than a `curl`.
- **No rendered measurements were taken.** Everything in section 5 is authored
  CSS, not computed values at a real viewport. The CDP method used for
  `mobile-responsiveness` would settle actual rendered sizes.
- **Unbounce's 2026 Conversion Benchmark Report was not reached.** Every
  conversion figure in section 10 is secondhand.
- **No A/B evidence for any recommendation in section 11.** The ordering is my
  judgement of expected value, not a test result.
- **Corpus B pricing pages were not fetched**, only the two in 8.1 and 8.2.
  Convin and Gong hide price entirely, which is itself the finding.
- **Nothing was checked against Indian-market buyer behaviour.** The whole
  corpus except Convin, Exotel and MyOperator is US or Europe facing, and our
  buyer is a Tamil Nadu floor owner.

---

## 13. Sources

### Primary, fetched live 2026-10-13

**Corpus A:** linear.app, linear.app/pricing, stripe.com, vercel.com,
notion.com, figma.com, ramp.com, attio.com, posthog.com, cal.com, resend.com,
supabase.com, retool.com, clay.com.

**Corpus B:** callrail.com, callrail.com/pricing, invoca.com, gong.io,
observe.ai, convin.ai, dialpad.com, aircall.io, balto.ai, exotel.com,
myoperator.com, justcall.io, salesken.ai.

**Served CSS extracted:**
`static.linear.app/web/_next/static/css/layout.BJy9RiM8.css` (the full type
scale in 5.2), plus stylesheets from stripe.com, vercel.com, attio.com,
ramp.com, resend.com.

### Research, primary

- Nielsen Norman Group, "Scrolling and Attention" — nngroup.com/articles/scrolling-and-attention/
- "Milliseconds Make Millions", Google / 55 / Deloitte — web.dev/case-studies/milliseconds-make-millions, and thinkwithgoogle.com/marketing-strategies/app-and-mobile/mobile-page-speed-data
- HubSpot / Dan Zarrella, form-field analysis across 40,000+ landing pages — blog.hubspot.com/blog/tabid/6307/bid/6746/

### Research, secondary and low confidence

- NP Digital form-field studies, via neilpatel.com/marketing-stats/conversion-rate-by-form-fields/ — **the two studies contradict each other**
- Unbounce 2026 benchmark, **not reached**; the 3.8% SaaS median comes from
  clickminded.com/landing-page-statistics/, dupple.com, growthspreeofficial.com, saashero.net
- Pricing-tier benchmark of ~200 SaaS sites — atticusli.com/blog/posts/pricing-page-conversion-benchmark-insights-200-saas-websites/
- Anchoring and decoy mechanics — getmonetizely.com, kinde.com, adogy.com
- CTA copy claims — woobox.com, profiletree.com, gempages.net. **All folklore**

### Rejected as sources

Vendor pages selling the thing they are measuring, where the measurement was
the only evidence offered. Any figure that appeared solely inside a blog whose
own call to action was to buy a CRO service.

---

## Related

- **Doc 43**, high-converting funnel teardown. The direct-response counterpart.
  Read section 1 here for where the two disagree.
- **Doc 10 §9**, the SEO engine phase this feeds.
- **Doc 42**, self-serve onboarding. Section 11.4's free door depends on it.
- Memory: `seo-pillar-page`, `brand-rename-auratel`, `capture-pricing-0197`,
  `consent-is-the-telecallers-job`, `funnel-slot-first`,
  `mobile-responsiveness`.
