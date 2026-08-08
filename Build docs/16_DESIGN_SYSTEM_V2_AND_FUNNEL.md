# 16 — Design system v2 + the acquisition funnel

**Written 2026-08-07.** The build contract for two coupled pieces of work:

1. **Design system v2** — replace the Aura neo-brutalist language with a modern-minimal SaaS system,
   applied to `@aura/ui`, the whole console, and the new marketing site as **one token set**.
2. **The acquisition funnel** — `apps/marketing`, implementing `lead-funnel-spec.md` with both entry
   variants behind a split test.

Decisions taken by the repo owner on 2026-08-07: *modern minimal SaaS* · *console + landing, one
system* · *both funnel variants, split-tested*.

Companion docs: `10_LANDING_PAGE_PLAN.md` (site IA, copy, SEO, trust surface — still valid, the
funnel slots into it), `lead-funnel-spec.md` (the funnel's own spec), `09_FEATURE_CATALOGUE.md`.

---

## 0. Four corrections to `lead-funnel-spec.md`

These are defects, not preferences. Build the corrected version.

### 0.1 `lead` is already taken — call this `funnel_submissions`

This platform already has a `leads` table: one row per **qualified extraction from an analyzed
call**, RLS-scoped by `org_id`, deduped on `contact_number_hash` within a workspace, written by
`apps/worker/src/pipeline/leads.ts`. It is a core product object.

The spec's "lead" is an **inbound marketing enquiry** with no tenant, no call, and no org. Same
word, unrelated object. Reusing the name would guarantee permanent confusion in queries, in the
console, and in every future conversation.

**Table name: `funnel_submissions`.** It lives outside the tenant model entirely — see §3.1.

### 0.2 The name regex rejects the market

```
^[a-zA-Z\s\-']+$
```

This rejects தமிழ், देवनागरी, తెలుగు and every accented Latin name. Aura's headline claim is native
Tamil/Hindi/Telugu support; a form that will not accept the customer's own name in their own script
is a bad first impression and an own goal.

**Use** `\p{L}` **with the unicode flag**: `/^[\p{L}\p{M}\s\-'.]{2,60}$/u`. Keep the 2–60 length
bound and the digit/symbol rejection; drop the Latin-only assumption.

### 0.3 A pre-ticked WhatsApp box is not consent

The spec has *"WhatsApp same as phone? — checkbox, checked by default."* Under India's DPDP Act and
the GDPR, pre-ticked boxes do not constitute consent.

Two separate things are being conflated. Split them:

* **"Is your WhatsApp number the same as this one?"** — a *data* question, not a consent question.
  Pre-ticked is fine, because it only controls whether a second field appears.
* **"You may contact me on WhatsApp and email about this enquiry."** — an *unticked, required*
  consent checkbox, with a link to the privacy policy. Store the timestamp and the exact wording
  version alongside the submission. That stored string is the evidence.

Given Aura sells itself on data protection, its own lead form must not be its weakest artefact.

### 0.4 Google Calendar is blocked on credentials

Real booking needs a Google Cloud project with the Calendar API enabled and an OAuth consent screen
— an external dependency you do not have yet. Build behind an interface:

```ts
interface Scheduler {
  availableSlots(from: Date, to: Date): Promise<Slot[]>;
  book(slot: Slot, lead: FunnelSubmission): Promise<{ eventId: string }>;
}
```

Ship `GoogleCalendarScheduler` (real) and `UnavailableScheduler` (renders the disqualified-style
"our team will reach out" screen). Select by env. **The spec's rule that no fake slot is ever shown
holds absolutely** — when the scheduler is unconfigured, the qualified path shows the contact-us
screen, never a decoy calendar.

---

## 1. Design system v2 — tokens

One token set, defined once in `@aura/ui`, consumed by `apps/web` and `apps/marketing`. Tailwind v4,
CSS-first `@theme` — **no `tailwind.config.js`**, matching how the repo already works.

### 1.1 Colour

Neutral-led with a single restrained accent. Every value must pass **WCAG AA (4.5:1)** for body text
and **3:1** for large text and UI boundaries, in both modes. Verify with a contrast checker; do not
eyeball it.

```css
@theme {
  /* Neutrals — the system is 90% these */
  --color-bg:            #FFFFFF;
  --color-bg-subtle:     #FAFAFA;
  --color-surface:       #FFFFFF;
  --color-surface-hover: #F5F5F5;
  --color-border:        #E5E5E5;
  --color-border-strong: #D4D4D4;
  --color-text:          #171717;
  --color-text-muted:    #737373;
  --color-text-subtle:   #A3A3A3;

  /* Accent — used sparingly: primary CTA, active nav, focus ring, selected state */
  --color-accent:        #2563EB;
  --color-accent-hover:  #1D4ED8;
  --color-accent-subtle: #EFF6FF;
  --color-accent-text:   #1E40AF;

  /* Semantic — status only, never decoration */
  --color-success:       #16A34A;
  --color-warning:       #CA8A04;
  --color-danger:        #DC2626;
  --color-info:          #0891B2;
}

@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { /* dark values */ } }
:root[data-theme="dark"] { /* same dark values */ }
```

**Dark mode is required**, not optional — see §1.6.

### 1.2 Type

Retire the three-font system. Two families:

| Role | Family | Usage |
|---|---|---|
| UI + headings | **Inter** (variable, self-hosted, subset) | everything |
| Numeric + ids | **JetBrains Mono** or Inter's `tabular-nums` | ids, timestamps, metrics |

Scale: `12 · 14 · 16 · 18 · 20 · 24 · 30 · 36 · 48`. Body **16px** in the console and **18px** on
marketing. Weights: 400 / 500 / 600 only. Line height 1.5 body, 1.2 headings.

**Sentence case everywhere.** The uppercase-heading convention goes with the brutalist system; it
hurts scanning at small sizes and is hostile to non-Latin scripts.

`MonoLabel` survives as a component but restyled: `text-xs text-muted` with `tabular-nums`, not
uppercase-tracked.

### 1.3 Space, radius, elevation

* **Space:** 4px base — `4 8 12 16 24 32 48 64 96`. Console sections `24`, marketing sections `96`.
* **Radius:** `--radius-sm: 6px` (inputs, chips) · `--radius-md: 8px` (buttons, cards) ·
  `--radius-lg: 12px` (modals, feature cards) · `--radius-full` (avatars, pills).
  **`rounded-none` is gone.**
* **Elevation:** borders do most of the work; shadows are subtle and functional.
  ```
  --shadow-sm: 0 1px 2px rgb(0 0 0 / 0.05);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.07), 0 2px 4px -2px rgb(0 0 0 / 0.05);
  --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.08), 0 4px 6px -4px rgb(0 0 0 / 0.05);
  ```
  The `4px 4px 0 rgba(0,0,0,1)` offset shadow is retired. In dark mode, shadows barely register —
  use `--color-border` and surface lightness for hierarchy instead.

### 1.4 Motion

150ms `ease-out` on hover/focus, 200ms on enter/exit. Respect `prefers-reduced-motion` on every
animation. `motion` is already a dependency; do not add another.

### 1.5 Focus

`outline: 2px solid var(--color-accent); outline-offset: 2px` on `:focus-visible`. **Never remove a
focus ring.** The old system leaned on thick black borders for affordance; this one does not, so
focus visibility is now load-bearing for keyboard and low-vision users.

### 1.6 Both modes, properly

The console is used all day, often on a phone in daylight and on a laptop at night. Ship light and
dark. Follow `prefers-color-scheme` by default; allow an explicit override via `data-theme` on
`<html>`, persisted in a cookie so the server render matches and there is no flash.

---

## 2. `@aura/ui` v2

### 2.1 Migrate the seven existing primitives

`BrutalButton` · `Card` · `ConsolePanel` · `MonoLabel` · `ProgressBar` · `StatCard` · `StatusChip`

* **`BrutalButton` → `Button`.** Keep a deprecated `BrutalButton` re-export for one migration pass
  so the console is not broken in a single commit. Variants: `primary` (accent fill) · `secondary`
  (border) · `ghost` · `danger`. Sizes `sm | md | lg`. Loading and disabled states.
* **`ConsolePanel`** — the black/green terminal panel for raw JSON. Keep the idea, restyle to the
  dark surface token so it reads as intentional in both modes rather than as a leftover.
* **`StatusChip`** — semantic colour + a **shape or icon difference per status**. Colour alone fails
  colour-blind users and prints badly.
* The rest: same API, new tokens. **Do not change any component's props in this pass.** A visual
  migration that also changes APIs cannot be reviewed.

### 2.2 New primitives needed

Console: `Button` · `Input` · `Select` · `Checkbox` · `Radio` · `Textarea` · `Label` · `FormField`
(label + control + inline error + hint) · `Table` · `Tabs` · `Dialog` · `Drawer` · `Toast` ·
`Skeleton` · `EmptyState` · `Pagination` · `Tooltip` · `Avatar` · `Breadcrumb`

Marketing: `SectionHeading` · `FeatureCard` · `PricingCard` · `LogoGrid` · `FAQAccordion`
(`<details>`, no JS) · `Testimonial` · `ComparisonTable` · `StepFlow` · `CTABanner`

Build only what a page actually uses. An unused primitive is a maintenance cost.

### 2.3 Accessibility floor

WCAG 2.1 AA. Every interactive element keyboard-reachable, every control labelled, every dialog
focus-trapped and Escape-closable, every icon-only button given an accessible name. `FormField`
wires `aria-describedby` to its error text automatically — get this right once, in the primitive,
and every form in both apps inherits it.

---

## 3. The funnel

### 3.1 It does not live in the tenant database

`funnel_submissions` holds pre-customer personal data: name, phone, WhatsApp, email, budget. It has
no `org_id`, so it does not belong in the RLS model — and forcing it in would mean either a fake org
or a table exempt from the invariant `verify-rls.js` now enforces across every `org_id` table.

**Put it in its own schema, `marketing`, in the same Postgres instance.** Separate schema, separate
grants, explicitly listed in `verify-rls.js`'s reviewed allowlist as a non-tenant table with a
comment explaining why. That keeps one database and one backup, without weakening the tenancy
invariant.

```sql
CREATE SCHEMA IF NOT EXISTS marketing;

CREATE TABLE marketing.funnel_submissions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name              text NOT NULL,
  email             text NOT NULL,
  email_normalized  text NOT NULL,           -- lower(trim(email))
  phone_e164        text NOT NULL,
  whatsapp_e164     text,
  country_code      text NOT NULL,
  business_type     text,
  team_size         text,
  budget_inr        text,
  intent            text,
  has_crm           text CHECK (has_crm IN ('yes','spreadsheets_whatsapp','no')),
  crm_name          text,                    -- free text when has_crm = 'yes'
  wants_custom_crm  text CHECK (wants_custom_crm IN ('yes','no','tell_me_more')),
  status            text NOT NULL DEFAULT 'contact_captured'
                    CHECK (status IN ('contact_captured','qualified','disqualified')),
  variant           text NOT NULL,           -- 'demo_first' | 'form_first'  (§3.5)
  consent_text      text NOT NULL,           -- the exact wording shown (§0.3)
  consent_at        timestamptz NOT NULL,
  utm               jsonb NOT NULL DEFAULT '{}',
  calendar_event_id text,
  booking_slot      timestamptz,
  contact_attempts  integer NOT NULL DEFAULT 1,
  last_contacted_at timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE marketing.funnel_contact_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id  uuid NOT NULL REFERENCES marketing.funnel_submissions(id) ON DELETE CASCADE,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  business_type  text, team_size text, budget_inr text, intent text,
  has_crm        text, crm_name text, wants_custom_crm text,
  variant        text, utm jsonb NOT NULL DEFAULT '{}'
);

CREATE UNIQUE INDEX funnel_email_uniq ON marketing.funnel_submissions (email_normalized);
CREATE UNIQUE INDEX funnel_phone_uniq ON marketing.funnel_submissions (phone_e164);
CREATE INDEX funnel_created ON marketing.funnel_submissions (created_at DESC);
```

Note the spec's dedupe rule — *match on phone **OR** email* — combined with two unique indexes has a
real edge case: a submission whose email matches row A and whose phone matches row B. Decide it
deliberately (recommendation: match on phone first, since it is the stronger identity in this
market; attach to that row and record the conflicting email in history) and **write a test for it**.
An unhandled conflict here throws a 500 on a live lead form.

### 3.2 Qualification is server-side and silent

Per the spec: `budget >= ₹30,000/month AND intent == "ready"`. Evaluate in a server action or route
handler — **never** ship the rule to the browser, and never tell the user which answer decided it.

Encode it as a pure function in `packages/shared` with a full test table, so the threshold can be
tuned without touching the form.

**The custom-CRM answer overrides the budget rule.** A custom CRM build is a one-off project fee,
not a monthly subscription, so a respondent answering `wants_custom_crm = 'yes'` is describing a
different — usually larger — transaction than their stated *monthly* budget represents. Judging them
on the monthly number sends the highest-value enquiries to the "we'll reach out" screen.

```
QUALIFIED if:
      (budget_inr >= ₹30,000/month AND intent == 'ready')
   OR (wants_custom_crm == 'yes'   AND intent == 'ready')
   OR (wants_custom_crm == 'yes'   AND has_crm == 'no')   -- greenfield: no system at all

ROUTE-TO-HUMAN (disqualified path, but flagged) if:
      wants_custom_crm == 'tell_me_more'
```

`tell_me_more` deliberately does **not** book a slot — it is an information request, not a buying
signal, and filling the calendar with them is how the qualified path stops being worth anything.
Flag those submissions in the lead list so a human can triage them; the follow-up template should
answer the question rather than push a call.

> **Business note, not an engineering one.** ₹30,000/month against a per-handset SMB price point
> will disqualify most of the market this product is currently built for — RD Interlock Brick and
> Fortune Innovatives are 5–20 handset businesses. That may be exactly the intent (protect calendar
> time, sell upmarket), in which case the disqualified path is the main path and its follow-up
> deserves as much care as the booking flow. Worth a deliberate look at the first month's split.

### 3.3 Rate limiting is not optional

A public, unauthenticated form that writes to your database and books real calendar slots. Required
before it goes live:

* Per-IP and per-phone/email rate limits.
* The spec's soft cap: >5 attempts in 24h from one identity still records the attempt but stops
  triggering bookings and emails.
* A honeypot field plus a submission-timing check (a form completed in under ~2s is a bot).
* Cloudflare Turnstile on step 2 — invisible to nearly all humans.
* Server-side revalidation of **everything**. Client validation is UX; it is not a control.

### 3.4 Disposable-email blocklist

The spec calls it optional. Include it — it is a static list and it materially reduces junk. Fail
*open* on an unrecognised domain; never reject a legitimate corporate domain you have not seen.

### 3.5 One funnel: form-first

**Decided by the repo owner on 2026-08-07: ship `form_first` only. The split test is cancelled.**

This supersedes both the earlier "build both variants" decision and `10_LANDING_PAGE_PLAN.md` §2's
recommendation against gating content behind a form. Doc 10's reasoning is not withdrawn — it is
overruled, deliberately, and the section below records what that costs so nobody has to reconstruct
it later.

| Route | Above the fold |
|---|---|
| `/` | The two-step form immediately, marketing content below it |
| `/start` | Alias of `/`, kept so existing CTA deep links and the custom-CRM section's UTM keep resolving |

**What this simplifies.** No variant assignment, no signed variant cookie, no per-variant
attribution, no stopping rule, no parallel entry composition. The `variant` column stays on
`funnel_submissions` and `funnel_contact_history` — it costs nothing, it is already written, and it
makes a future test a config change rather than a migration. Write the literal `'form_first'`.

**What it costs, stated plainly.** Form-first maximises captured contacts and lowers their average
quality: a visitor who has not yet seen what Aura does is guessing at "monthly budget" and
"ready to get started", and those two answers are exactly what `qualify()` reads. Expect the
disqualified path to carry more volume than it would have, and expect some genuinely good leads to
answer "just exploring" because they are — they have not been shown anything yet.

**Two consequences worth designing for now rather than discovering:**

* **The form is the first thing a stranger sees, so it must justify itself above the fold.** The
  headline and subhead are doing the work the demo would have done. Keep the interactive demo
  immediately below the form rather than deprioritising it — a visitor who scrolls past the form is
  the one most likely to come back and fill it.
* **The disqualified path is now a main path, not an edge case.** Its copy, its follow-up template
  and its triage flagging deserve the same care as the booking flow. §3.6 is no longer a footnote.

**Still measure the one number.** Qualified submissions per 100 visitors, in Plausible (cookieless
— a consent banner on a page selling data protection is a bad look, and GA is worse). Without a
comparison arm it is a baseline rather than a verdict, but it is the number that tells you whether
the funnel is working, and you cannot recover it retroactively.

### 3.6 Follow-up

Disqualified leads get the neutral template from the spec — no mention of budget, no rejection.
Async via the worker, not inline in the request. Reuse the existing outbox pattern
(`crm_sync_log` is the model: a table-as-queue with retry) rather than inventing a second delivery
mechanism.

### 3.7 The CRM questions — step 2

Three fields, appended to the qualification step. They are the highest-signal questions on the form:
the answer tells you whether this lead is a connector integration, a custom build, or a greenfield
customer with no system at all.

| Field | Type | Options |
|---|---|---|
| Do you use a CRM today? | radio | **Yes, we use one** · **Spreadsheets / WhatsApp** · **No, nothing yet** |
| Which one? | select + free text | shown only when "Yes" — see the list below |
| Would you like us to build one for you? | radio | **Yes** · **Tell me more** · **No, just the call intelligence** |

**The middle option is the point.** "Spreadsheets / WhatsApp" is the honest answer for most of this
market, and burying it under "Other" would lose the single most useful segmentation this form can
produce. Make it a first-class choice, worded without judgement.

**The "which one" list must match the real connector catalogue**, ordered for an Indian SMB
audience, because the answer has to be actionable:

> Zoho CRM · LeadSquared · Kylas · Freshsales · HubSpot · Salesforce · Bitrix24 · monday.com ·
> Pipedrive · GoHighLevel · Zendesk Sell · Close · Attio · Keap · Microsoft Dynamics 365 ·
> **Other (please specify)**

Two consequences worth designing for rather than discovering later:

* A named CRM that is **in the catalogue** means onboarding is a connector config, and the sales
  conversation can promise it. A CRM that is **not** means a custom connector build — a different
  quote. The lead list should show which, computed at write time, not left to a human to remember.
* **Zoho, Salesforce, monday and Dynamics 365 are pilot-only today** — they authenticate with pasted
  access tokens that expire in hours, and the OAuth refresh flow is unbuilt (`DEPLOYMENT.md` §7.8,
  `08_ROAD_TO_10.md` Stage 3 / blocked-on-credentials). Zoho in particular is the market leader in
  India, so this will be a *common* answer. Do not let the funnel imply a turnkey integration that
  needs manual token rotation. Flag those four in the lead list so the call is set up honestly.

Field visibility is progressive: "Which one?" appears only on "Yes"; nothing else is conditional.
All three are optional-but-prompted — a required CRM question on a lead form costs more submissions
than the answer is worth.

---

## 4. `apps/marketing`

Per `10_LANDING_PAGE_PLAN.md` §8, and unchanged by this document:

* **Separate Next.js 15 app**, importing `@aura/ui` from the workspace. Not a route group in
  `apps/web` — public traffic must not run `supabase.auth.getUser()` on every request, and a copy
  fix must not require rebuilding the console image.
* **Not statically exported**, because the funnel needs server actions. Deploy as a small Node
  server (Vercel/Cloudflare, or the same VPS behind nginx). All marketing *content* pages stay
  statically generated; only the funnel routes are dynamic.
* **Domain:** marketing on the apex/`www`. The console and API **stay at
  `aura.sirahagents.com`** — enrolled handsets carry that URL in their activation payload,
  `S3_PUBLIC_ENDPOINT` presigns against it, and the release APK is HTTPS-pinned. Moving it means
  re-enrolling every device in the field.
* **Performance budget** (`10_LANDING_PAGE_PLAN.md` §9) applies to the funnel too: `libphonenumber-js`
  is ~145 KB — import the **min metadata** build, or load it in the server action only and keep
  client-side validation to a cheap length/format check. Do not ship the full metadata bundle to a
  phone on 4G.

### 4.1 The custom-CRM section on the homepage

A new section in the homepage IA, sitting **between "Integrations" and "Pricing"** in
`10_LANDING_PAGE_PLAN.md` §3 — that is, immediately after the connector logo grid, so the two read
as one offer with two doors rather than as two products.

**The strategic point.** Aura's connector catalogue answers *"we push leads into your CRM."* It has
no answer at all for *"I don't have a CRM"* — which, for brick, interiors, real-estate and
building-materials SMBs in Tamil Nadu, is the majority. Today that visitor reaches the pricing
section, realises the product assumes a system they do not own, and leaves. This section converts
that dead end into the larger transaction.

**Structure — a two-column fork, one section:**

```
              Your leads, wherever they need to go

  ┌──────────────────────────┐   ┌──────────────────────────┐
  │ Already have a CRM        │   │ Don't have one yet        │
  │                           │   │                           │
  │ Aura pushes every         │   │ We'll build you one,      │
  │ qualified call straight   │   │ shaped around how you      │
  │ into it — 15 connectors,  │   │ actually sell. Your        │
  │ your field names, your    │   │ stages, your fields, your  │
  │ pipeline stages.          │   │ language.                  │
  │                           │   │                           │
  │ [ See the integrations ]  │   │ [ Talk to us about a       │
  │                           │   │   custom CRM ]             │
  └──────────────────────────┘   └──────────────────────────┘
```

**Copy direction for the custom-CRM column** — concrete, not aspirational. What it actually is:

> **A CRM built around your business, not around a template.**
>
> Most CRMs make you describe your business in someone else's words — deals, opportunities, sales
> cycles. We build yours around what you actually track: brick type and quantity, site location,
> quotation status, follow-up date. Whatever your calls are already about.
>
> Aura feeds it automatically. Every qualified call becomes a record, with the details already
> filled in, in Tamil or English. Nobody types anything.
>
> `Built on the same extraction engine your calls already run through · Your fields · Your stages · Your team's language`

That last line is the differentiator and it is **true, not marketing**: the Agent Studio already
compiles a tenant's typed field schema into the provider's `responseSchema`, and the CRM connector
catalogue already handles field mapping. A custom CRM here is a configuration of machinery that
exists, not a bespoke rebuild — which is exactly why this offer is credible at an SMB price.

**CTA.** A `CTABanner` directly below the section:

> **Not sure which you need?** Tell us how you sell today and we'll tell you honestly whether you
> need a new system or just a connector.
> **[ Talk to us on WhatsApp ]** · [ Start the 2-minute setup form ]

The secondary CTA deep-links to `/start` (the form-first variant, §3.5) with a UTM marking the
custom-CRM section as the source, so §3.7's answers can be attributed back to the section that
prompted them. That attribution is how you find out whether this section earns its place.

> **Business note, not an engineering one.** Custom CRM builds are **services revenue**, not SaaS
> revenue — different margin, different delivery capacity, different scaling story, and each one is
> a commitment of your time rather than of your servers. For an agency-shaped business (Sirah
> Digital) that is a natural fit and probably where the near-term money is. But it changes what the
> company is, and it competes for the same hours as `08_ROAD_TO_10.md`. Decide how many of these you
> can deliver per quarter **before** the section goes live, and set the qualification threshold
> (§3.2) to match that capacity rather than to maximise enquiries.

---

## 5. Build sequencing

Nothing here starts until the Stage 1 triage run lands — it currently owns `apps/web`.

| # | Slice | Partition | Depends on |
|---|---|---|---|
| 1 | **Tokens + `@aura/ui` v2 primitives** | `packages/ui/**` | — |
| 2 | **Console migration** — route group by route group: `(owner)` → `(platform)` → `(admin)` | `apps/web/**` | 1 |
| 3 | **`apps/marketing` scaffold** + static pages from doc 10, **including the custom-CRM section and its CTA (§4.1)** | `apps/marketing/**` | 1 |
| 4 | **Funnel core** — schema, validation, qualification incl. the CRM override (§3.2), the three CRM questions (§3.7), dedupe, rate limits | `packages/shared`, `packages/db/migrations/0020_*`, `apps/marketing/**` | 3 |
| 5 | **Both variants + split-test instrumentation** | `apps/marketing/**` | 4 |
| 6 | **Scheduler** — interface + `UnavailableScheduler`; real Google Calendar when credentials exist | `apps/marketing/**` | 4 |
| 7 | **Follow-up delivery** via the worker outbox | `apps/worker/**` | 4 |

1 and 3 can run in parallel. 2 is the largest and most mechanical — do it *last* among the visual
work, once the primitives have stopped moving.

**Migration discipline for slice 2.** The console has ~50 page and component files. Migrate by route
group, keeping `BrutalButton` as a deprecated alias until the final group lands, then delete it in
one commit. Screenshot each group before and after. `pnpm -r build` and the Stage 1 test suite must
stay green at every step — that suite is now the thing that makes a change this broad survivable,
which is precisely why it was built first.

### Run log

**2026-08-07 — slices 1 and 3 executed in parallel.** Full report:
`18_THEME_V2_SLICE_1_3.md`.

| # | Slice | Status |
|---|---|---|
| 1 | Tokens + `@aura/ui` v2 primitives | ✅ **done** |
| 2 | Console migration | ☐ not started (out of scope, by design) |
| 3 | `apps/marketing` scaffold + static pages incl. §4.1 | ⚠️ **partial** |
| 4 | Funnel core | ☐ not started |
| 5 | Both variants + split test | ☐ not started |
| 6 | Scheduler | ☐ not started |
| 7 | Follow-up delivery | ☐ not started |

Tree at close: `pnpm -r typecheck` 9/9 · `pnpm -r test` 544 passed / 7 skipped / 0 failed (baseline,
zero delta) · `pnpm tenancy:check` OK · web build 19/19 static · marketing build 9/9 static.

**Slice 1 done.** `packages/ui/src/theme.css` is the single token contract, consumed by both apps.
Four contract hexes changed because the doc-16 values failed §1.1's own AA floor — `border-strong`
`#D4D4D4`→`#8F8F8F`, `text-muted` `#737373`→`#6B6B6B`, `text-subtle` `#A3A3A3`→`#8A8A8A`, `warning`
`#CA8A04`→`#A16207`; names unchanged, per §1.1's "verify, do not eyeball". 7 v1 primitives restyled
with zero prop changes, 12 console + 7 marketing primitives added. Not built from §2.2, per its own
"build only what a page uses": `Textarea`, `Tabs`, `Drawer`, `Toast`, `Pagination`, `Avatar`,
`Breadcrumb`, `Testimonial`.

**Slice 3 partial**, on three counts: `NEXT_PUBLIC_WHATSAPP_NUMBER` is unset repo-wide so the only
live CTA renders as an "unconfigured" notice (14 on the homepage) and the site converts nobody; the
demo and language-proof sections are sized placeholders pending an anonymised consented call
fixture; and the pricing tiers advertise four capabilities that are roadmap rows in
`09_FEATURE_CATALOGUE.md`, against §14's "every claim true of the deployed build today". §4.1's
custom-CRM section **is** built and in position, with its `CTABanner` secondary gated behind
`FUNNEL_LIVE = false` until slice 4 ships `/start`. The marketing app still ships local copies of the
§2.2 marketing primitives rather than importing them from `@aura/ui`; the token layer is shared, the
component layer is a follow-up.

§4.1's business note stands and is now load-bearing: decide quarterly custom-CRM delivery capacity
**before** flipping `FUNNEL_LIVE`, and set §3.2's ₹30,000 threshold to match it. §3.2 already routes
`wants_custom_crm = 'yes'` around the budget rule, so that answer is a qualification bypass.

§7 of `12_STAGE0_EXECUTION_REPORT.md` deploy blockers are **unchanged** by this run:
`CRM_SECRET_KEY`, `PLATFORM_OPERATOR_EMAILS`, `SUPABASE_SERVICE_ROLE_KEY` absent; Supabase email
signups still enabled.

---

## 6. What this does not change

* **The API.** No endpoint, guard, or tenancy behaviour is touched. `funnel_submissions` is reached
  from `apps/marketing` server actions, not through `/v1/*`.
* **Android.** Nothing.
* **The Stage 0–4 plan** in `08_ROAD_TO_10.md`. This work is additive and runs alongside it; it does
  not substitute for the deploy blockers in `12_STAGE0_EXECUTION_REPORT.md` §3, which remain
  outstanding.
* **The pricing decision.** §3.2's ₹30,000 threshold is taken from the spec as given.
