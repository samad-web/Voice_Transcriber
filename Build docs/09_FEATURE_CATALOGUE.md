# 09 — Feature catalogue: what Aura should build, and why

**Written 2026-08-06.** Companion to `08_ROAD_TO_10.md` (which says *when*) and
`ceo-dashboard-build-prompt-v2.md` (which specifies the owner-console modules in detail).

This document answers a different question from either: **given what Aura uniquely has, what should
it build that a generic CRM cannot?**

---

## 0. The leverage principle

Aura has one asset almost no SMB tool has: **the recorded content of every sales conversation the
business had, transcribed and structurally extracted.** A CRM knows a call happened for 4 minutes.
Aura knows the customer asked for a bulk discount, named a competitor, and committed to paying on
Friday.

Every feature below is ranked by a single test:

> **Could a competitor build this without the call content?**
> If yes, it is table stakes — build it cheaply, don't lead with it.
> If no, it is the moat — build it well, and price on it.

There is a second, purely economic filter. The Agent Studio already compiles a tenant's typed
schema into the provider's `responseSchema`, versions it immutably, and sandboxes it against a
stored call before activation. That means a very large class of features costs:

> **one extraction-agent template + one materialized view + one page.**

Those are the cheap ones. They are marked **⚡ agent-template** below. Prefer them relentlessly —
they ship in days, not sprints, and each one deepens the same moat.

---

## Tier 1 — The moat: features only call content makes possible

These are the reason to buy Aura instead of a CRM with a call-logging plugin.

### 1.1 Objection & Voice-of-Customer intelligence ⚡ agent-template

**What.** Aggregate across every call in a tenant: which objections recur, how often, raised by
whom, handled how, and with what outcome. Which competitors get named, and whether that share is
rising. Which product attributes customers ask about that the business never mentions in its own
pitch.

**Why it fits Aura.** An SMB owner has *no other way* to get this. They cannot sit in 400 calls a
month. Today they get it as anecdote from whichever telecaller talks loudest. This turns the call
corpus into market research the business is already paying to collect and currently throws away.

**Concretely, for RD Interlock Brick:** *"Price was the blocking objection in 43% of lost deals, up
from 31% last month. A competitor was named in 18% of calls (was 6%). 22 customers asked about
delivery lead time; your pitch never mentions it."*

**Cost.** An `objection-and-competitor` agent template emitting
`{objection_type: enum, objection_raised_verbatim: string, competitor_named: string|null,
resolution: enum}`, plus `mv_objections_weekly` and one page. Days, not weeks.

**Build:** immediately after Stage 4. This is the single highest value-per-hour feature in this
document.

### 1.2 Price & quote intelligence ⚡ agent-template

**What.** Extract the quoted price, unit, and quantity from every call; join to outcome. Produce a
real win-rate-by-price-band curve, per product, per telecaller, per month.

**Why it fits Aura.** For commodity and building-materials businesses — which is exactly the
customer base — pricing *is* the business, and it is currently set by feel. The extraction agent
already pulls `cost_per_brick`, `brick_quantity` and `total_budget` for RD Interlock. The data is
**already in the database**; nothing reads it as a distribution.

**Concretely:** *"Deals quoted above ₹32/unit close at 18%. Below ₹30, 61%. Rajesh quotes 8% higher
than the team median and closes 12% less often."*

**Cost.** Near zero on the extraction side — reuse the tenant's existing agent fields, add a
`valueField`-aware rollup. One page.

### 1.3 Ask-your-calls — semantic search and RAG over the corpus

**What.** Two layers on the same index:
* **Semantic search** — "find every call where someone asked about bulk discount" — replacing
  today's Postgres FTS (`0001_init.sql` tsvector, `search.controller.ts`), which only matches
  literal words and fails completely across the Tamil/English code-switching that dominates these
  calls.
* **Ask** — a chat box over the tenant's own calls: *"What did customers say about delivery delays
  last month?"* → a synthesised answer with citations that deep-link to the exact call and
  timestamp.

**Why it fits Aura.** This is the demo that sells the product in ninety seconds. It is also the
feature owners will use daily without being trained, which is what makes a tool stick in an SMB.

**Cost.** `pgvector` in Postgres (already there — no new datastore, consistent with the "no new
datastore" rule in 08), embeddings computed in a new pipeline stage after ASR, RLS-scoped like
every other table. The retrieval-and-cite layer reuses `packages/llm`. Medium.

**Guardrail.** Citations are mandatory. An answer without a linked call is a hallucination with
good manners.

### 1.4 Call clip evidence links

**What.** Select a span in the transcript → get a shareable, expiring, watermarked link to that
30-second audio clip plus the transcript excerpt and its call metadata.

**Why it fits Aura.** Non-obvious and disproportionately valuable in trading, building materials and
services. *"Your customer says they ordered 20,000 bricks and you delivered 18,000."* One link ends
the argument. Owners will discover this and then refuse to churn.

**Cost.** Small. The audited presigned-audio-URL path exists; add range extraction in the transcode
stage (which is getting ffmpeg anyway in 08 §3.5) and a signed short-lived share token.

**Compliance note.** Every generated link must write an audit row — it is an export of personal
data, and Stage 4.3's evidence trail depends on knowing who shared what.

### 1.5 Commitment tracking — the promise ledger ⚡ agent-template

**What.** Extract every commitment made *by either side* — "I'll send the quote today", "call me
Monday", "we'll pay by Friday" — with its owner and its due date. Then track whether it happened.

**Why it fits Aura.** This is the mechanism behind the v2 spec's "unfinished business" panel, but
sourced from **what was actually said** rather than from what someone remembered to log. In an SMB
telecalling operation, dropped commitments are the single largest source of lost revenue, and they
are invisible by definition.

**Concretely:** *"14 commitments made last week. 9 kept. 5 dropped, worth ≈₹3.4L. Three of the five
are Priya's."*

**Cost.** ⚡ agent template + a `commitments` table + the existing automation/notification path. This
feeds Module A's coaching engine and Module D's flow templates directly.

### 1.6 Winning-pattern analysis

**What.** Given enough closed calls, surface which behaviours correlate with winning *in this
tenant's own data*: talk:listen ratio, whether a next step was committed, question count in the
first two minutes, whether price was raised by the rep or the customer first.

**Why it fits Aura.** Every business believes it knows why it wins. Very few are right. This is
Gong's core value proposition, delivered to a segment Gong will never serve at a price point Gong
will never offer.

**Dependency.** Honest talk-ratio numbers require **real diarization** — see §5.1. Do not ship
talk-ratio metrics on top of the current text-based speaker labelling; it invents speakers.

### 1.7 Lead scoring from conversation, not from form fields

**What.** A probability-to-close per lead, trained on the tenant's *own* won/lost history using
extracted call features (sentiment trajectory, objection type, commitment made, quantity discussed,
contact-attempt depth).

**Why it fits Aura.** Every CRM scores leads on form fields and activity counts. Aura can score on
what the customer actually said. Even a plain logistic regression over extracted features will beat
the manual stage-guessing the board relies on today — and it explains itself, which matters more
than accuracy for adoption.

**Cost.** Medium. Needs ~500 closed leads per tenant before it means anything, so gate it on data
volume and fall back to a transparent rules score until then. Ship the explanation ("scored 78
because: price agreed, next step committed, third contact") — a bare number gets ignored.

---

## Tier 2 — The India wedge

These are not "localisation." They are the reason a Tamil Nadu brick trader picks Aura over an
American product that is better funded and worse fitted.

### 2.1 True multilingual ASR with code-switching

**What.** First-class Tamil, Hindi, Telugu, Kannada, Malayalam, Marathi and Bengali — including
mid-sentence code-switching, which is how these calls are *actually* spoken.

**Status.** Half-built: `0015_sarvam_asr_job.sql` and `0016_instance_asr_settings.sql` added Sarvam
as a second ASR provider. What is missing is a language-detection stage, per-tenant and per-device
language configuration, and quality measurement per language.

**Why it matters.** Every US-built competitor is English-first and degrades badly on code-switched
Indian speech. This is a durable structural advantage, and it should be stated on the landing page
as a headline claim, not a footnote.

**Do also:** track word-error-rate per language per provider so the `ProviderRouter` (08 §3.1) can
route Tamil to Sarvam and English to Gemini on evidence, not on a guess.

### 2.2 WhatsApp Business as a first-class channel

**What.** Ingest WhatsApp Business API conversations into the same lead timeline as calls, and send
outbound from the same place.

**Why it matters — this may be the highest-ROI integration in the entire product.** In this market,
calls and WhatsApp are one continuous conversation: the call happens, the quote goes on WhatsApp,
the confirmation comes back on WhatsApp. Aura currently sees half the conversation and the CRM sees
neither. Merging them makes the lead timeline *complete*, which is what makes the pipeline value
believable.

Three sub-features, ordered by value:
1. **Outbound notifications** — post-call summary and action items pushed to the telecaller's
   WhatsApp within a minute of hanging up. Cheapest to build, most immediately loved, and it drives
   daily active use without anyone logging into a console.
2. **Owner daily digest on WhatsApp** — see §2.4.
3. **Inbound conversation ingest** — WhatsApp Business API webhook → same lead, same extraction, one
   timeline. Bigger, and the thing competitors will not have.

**Important constraint to keep stating:** WhatsApp *voice calls* cannot be recorded — that is an OS
block, confirmed on hardware, and no amount of engineering defeats it. This feature is about
WhatsApp **messaging**, and the distinction must be explicit in sales material so it never becomes a
broken promise.

### 2.3 Payment-intent extraction and reconciliation ⚡ agent-template

**What.** Extract stated payment intent — "I'll send it on GPay tonight", "we'll pay 50% advance" —
with method, amount and promised date. Surface an aging list of promised-but-unreceived payments.
Optionally reconcile against a bank/UPI statement upload.

**Why it fits Aura.** The very first real transcript from RD Interlock contained a G-Pay payment
commitment. For SMBs running on informal credit — which is most of this segment — *receivables are
the crisis*, more than lead generation. A tool that says "₹4.2L was verbally promised and hasn't
arrived" gets renewed without a conversation.

### 2.4 Vernacular voice digest for the owner

**What.** A 60-second daily audio summary in the owner's own language, delivered on WhatsApp: what
happened yesterday, what needs attention, what money is at risk.

**Why it fits Aura.** A meaningful share of owners in this segment will not log into a dashboard —
ever. They will listen to a voice note. This is a *distribution* feature disguised as a reporting
feature: it puts Aura in front of the buyer daily without requiring behaviour change. TTS in
Indian languages is available from the same provider already integrated for ASR.

### 2.5 GST-compliant invoicing and the Indian business pack

Covered in `08_ROAD_TO_10.md` §4.1, restated here because it is a *feature*, not just plumbing:
GSTIN, HSN/SAC, place of supply, compliant invoice series. Plus DPDP-aligned consent evidence
(§4.3). An Indian buyer's accountant will ask, and "we'll add it later" loses the deal.

---

## Tier 3 — Capture assurance: turn the hardest problem into the product

Aura's most fragile dependency is that OEM dialers write recordings to public storage — device
specific, silently breakable, and outside your control. Every competitor using a telephony provider
has no such problem. **The correct response is not to hide it. It is to be the only vendor that
measures and guarantees it.**

### 3.1 Recording assurance SLA

**What.** Per device, per model, per day: calls placed (from the call log) vs. calls captured vs.
calls transcribed. A single number — *capture rate* — on the owner's dashboard and in a monthly
report. Alerts when a handset stops producing.

**Why it fits Aura.** Today a silent handset is indistinguishable from a quiet telecaller, and
nobody notices for days. Once you measure this, you can *sell* it: "95% capture rate, monitored,
with a credit if we miss it." No competitor in this segment offers a capture guarantee, because
none of them measures capture at all.

This is also 08's Android §A3 and §3.9's first business alert — the same work, sold as a feature.

### 3.2 Handset self-diagnostic and guided fix

**What.** A screen in the Android app answering: OEM folder found? recordings present? permissions
granted? battery optimisation exempted? last successful upload? — with a one-tap fix or a
copyable report for each failure.

**Why it fits Aura.** Battery-optimisation killing WorkManager is *the* classic silent failure on
Xiaomi and Oppo, and it currently manifests as "the app isn't working" with no further information.
This converts support calls into screenshots.

### 3.3 Published OEM compatibility matrix

**What.** Tested model × OS version × recording folder × outcome, maintained as data and published.

**Why it fits Aura.** It is simultaneously a support artefact, a purchasing rule for customer fleets,
and a credibility signal on the landing page. Confirmed so far: Samsung ✅ `Recordings/Call/`,
Xiaomi/HyperOS ✅ `Recordings/sound_recorder/call_rec/`, MIUI ✅ `MIUI/sound_recorder/call_rec/`,
Realme/Oppo/Vivo ✅, and **Google Dialer devices ❌ — permanently, confirmed on hardware.** Say that
publicly and confidently; a vendor who names their limits is trusted on everything else.

### 3.4 Zero-touch fleet provisioning

**What.** Android Enterprise / QR-based enrollment so a new handset is configured by scanning once
out of the box — no manual permission grants, no folder configuration, battery optimisation
exempted by policy.

**Why it fits Aura.** Onboarding a 10-handset customer currently costs hours of hand-holding. This
is the difference between selling to a 5-person team and a 50-person team, and it is a hard
prerequisite for the enterprise positioning the landing page will make.

---

## Tier 4 — Platform and business model

### 4.1 Reseller / white-label tier

**What.** A `parent_org_id` on organizations, a reseller console that is the existing operator
console scoped to that reseller's tenants, and per-reseller branding on the owner console and
digests.

**Why it fits Aura.** The multi-tenant spine, the operator console and the provisioning API already
exist — this is largely a scoping change plus theming. Regional IT resellers and CRM consultants in
Tier-2 Indian cities already sell to exactly this customer and already have the trust that is
hardest to build. It is the most capital-efficient distribution available.

**Gate it on Stage 2**, though: handing a third party a console today would mean handing them the
root admin key.

### 4.2 Multi-branch rollup

Customers with several locations need per-branch instances plus a consolidated owner view. The
`instances` table and `TenantSwitcher` already exist; this is a rollup query and a switcher that
aggregates rather than replaces. Small, and it raises the ceiling on deal size immediately.

### 4.3 Public API + webhooks

A documented, scoped, rate-limited API over calls, transcripts, leads and facts, with outbound
webhooks. Depends entirely on 08 §2.3 (scoped service credentials) — there is no safe way to expose
an API while `ADMIN_API_KEY` is the only credential. Once it exists, it converts Aura from an
application into a component, which is what makes it hard to remove.

### 4.4 Marketplace of extraction agent templates

The Agent Studio is genuinely good infrastructure and is currently one-agent-per-workspace by
convention. Ship a **catalogue** of pre-built, industry-specific agents — building materials,
interiors, real estate, education admissions, diagnostics/clinics, insurance — each with tuned
prompts, typed fields, lead rules and a matching CRM field map.

**Why it matters.** It converts "configure an AI agent" (a task no SMB owner will do) into "pick
your industry" (a task everyone will do), and it makes the 30-second demo on the landing page real.
It also unblocks 08 §4.2's tenant templates with actual content.

**Note:** `instances.default_agent_id` has existed since migration 0001 and is **never read** —
routing is "the one active agent per workspace", which silently caps a tenant at one extraction
shape. Reading that column (08 §3.5 / 06 §3.5) is a prerequisite for a customer with two sales
lines.

---

## Tier 5 — Correctness features that read as features

Not glamorous. Each fixes something currently *presented* to customers as working.

### 5.1 Real speaker diarization 🔴

Today's diarization is **text-based**: one LLM pass labels turns as Agent/Customer. On a one-sided
recording it cheerfully **invents** a Customer, and `diarized = true` is therefore not evidence that
both sides were captured. This is a documented, verified hazard — and every talk-ratio, sentiment
and coaching metric built on it inherits the fiction.

Fix with provider-native diarization or a `pyannote` stage, and cross-check against the actual
channel/source (`audio_source_used` already records `SOURCE@RATE`). Where only one side exists, say
so on the call — an honest "far end not captured" is worth more than a fabricated dialogue.

**This gates §1.6 and much of Module A.** It should be the first item of Stage 5.

### 5.2 Extraction confidence and human-in-the-loop review

Facts currently arrive with a validation flag and no confidence. Add per-field confidence, route
low-confidence extractions to a lightweight review queue, and feed corrections back as few-shot
examples on the next agent version. This is what makes extraction quality *improve* with use rather
than stay wherever the prompt landed — the compounding loop the whole product depends on.

### 5.3 Transcript editing

Let a user fix a mis-transcribed name, number or amount. Corrections should re-trigger extraction
for that call and be retained as evaluation data. Cheap, and it converts the most common complaint
about any ASR product ("it got the name wrong") from a churn reason into a two-second action.

### 5.4 Near-real-time coaching

The pipeline is post-call and takes minutes. Getting the summary and one coaching nudge to the rep
within 60 seconds of hang-up changes the product from a reporting tool into a performance tool.
Nothing architectural blocks it — it needs the queue prioritised for the summarise step and the
WhatsApp channel from §2.2.

---

## What to deliberately *not* build

* **Auto-dialer / click-to-call / CTI.** Aura is a passive capture product. Adding dialer control
  means telephony licensing, DND/TRAI compliance, and a different product. The v2 spec already rules
  this out — keep it ruled out.
* **A general CRM.** Do not chase Zoho. Aura's position is *upstream* of the CRM: it produces the
  structured record and dispatches it. The 15-provider connector catalogue is the strategy; owning
  the system of record is not.
* **Sandboxed tenant code execution** in automations. No sandbox exists; this is a remote-code-
  execution surface. Ruled out in the v2 spec — keep it ruled out.
* **VoIP / WhatsApp call recording.** An OS block, confirmed on hardware across multiple devices.
  Not an engineering problem. Never promise it.
* **Real-time streaming transcription during the call.** Expensive, and it solves a problem this
  segment does not have. Post-call within 60 seconds (§5.4) captures nearly all the value.

---

## Recommended build order

Assumes `08_ROAD_TO_10.md` Stages 0–4 are complete. Sequenced by (value × confidence) ÷ cost.

| # | Feature | Tier | Size | Why here |
|---|---|---|---|---|
| 1 | **5.1 Real diarization** | correctness | M | Gates Module A and every talk-ratio metric. Fixes something customers are shown today. |
| 2 | **3.1 Recording assurance SLA** | assurance | S | Turns the biggest weakness into the differentiator. Reuses Android §A3. |
| 3 | **1.1 Objection & VoC intelligence** | moat ⚡ | S | Highest value-per-hour in this document. |
| 4 | **1.2 Price intelligence** | moat ⚡ | S | The data is already in the database and nothing reads it. |
| 5 | **2.2.1 WhatsApp post-call summary** | wedge | S | Drives daily use without console login. Adoption unlock. |
| 6 | **1.5 Commitment tracking** | moat ⚡ | M | Feeds Module A coaching and Module D flows. |
| 7 | **Module A** (v2 spec) | product | L | Now honest, because diarization is real. |
| 8 | **1.3 Ask-your-calls** | moat | M | The demo that closes deals. |
| 9 | **2.3 Payment intent** | wedge ⚡ | S | Receivables are the real SMB crisis. |
| 10 | **1.4 Clip evidence links** | moat | S | Quiet retention feature. |
| 11 | **4.4 Agent template marketplace** | platform | M | Converts configuration into a dropdown; unblocks self-serve. |
| 12 | **2.4 Vernacular voice digest** | wedge | S | Distribution disguised as reporting. |
| 13 | **Module B** (v2 spec) | product | M | Daily-friction reduction for existing customers. |
| 14 | **2.2.3 WhatsApp ingest** | wedge | L | Completes the timeline. Big, and nobody else will have it. |
| 15 | **4.1 Reseller tier** | platform | M | Capital-efficient distribution. Gated on Stage 2. |
| 16 | **1.7 Lead scoring** | moat | M | Needs ~500 closed leads per tenant first. |
| 17 | **Modules C, D** (v2 spec) | product | XL | Only on named demand from ≥3 customers. |

Items 1–6 are roughly one quarter of work and would move Aura from "a working pipeline with a
dashboard" to "a product with a defensible reason to exist."
