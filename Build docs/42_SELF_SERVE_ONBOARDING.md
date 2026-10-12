# 42 — Self-serve onboarding: they pay, then they provision themselves

Written 2026-10-12, after reading the provisioning, billing, invite and funnel code that already
ships. The ask: **after paying, a customer onboards into the application themselves, with no
operator interference.**

This is a go-to-market decision that `20_KAILASH_CRM_GAP_ANALYSIS.md` parked as "needs the user,
not an engineering call", and `10_LANDING_PAGE_PLAN.md` argued against in 2026-08 on the grounds
that *"Aura cannot be self-served today: it needs a handset enrolled, an extraction agent
configured and a CRM connected."* Two of those three objections have since been built away — the
handset pairs itself from a QR dialog (0124), the setup guide walks the rest (0129), and the
API-only Insights tier (0192–0195) needs no handset at all. The decision is now takeable, and
this document is how.

The short version: **almost all of it exists.** What is missing is a *front door* (a priced,
public plan page and a checkout), a *bridge* (a signed payment webhook that provisions what the
operator's `POST /admin/tenants` provisions today), and a *key* (a way for the buyer to get a
login without reopening public sign-ups). Everything after first login — the checklist, the
guide, the QR pairing, colleague invites, the app install page — is already built and must not be
rebuilt.

---

## Part A — What exists today, so none of it gets rebuilt

| Layer | Where | State |
|---|---|---|
| Tenant provisioning | `POST /v1/admin/tenants` — `apps/api/src/modules/admin/admin.controller.ts` | Org + workspace + instance + enrollment key + `seedRoleDefaults` + `seedBoardDefaults` + optional `seedCrmDefaults`, one transaction. **Operator-only, admin key** |
| Plan catalogue | `plans`, `plan_entitlements` (0192) | 4 plans seeded (`starter`/`growth`/`scale`/`platform`), **every `price_minor` NULL**, `provider` default `'none'` |
| Subscription state | `org_subscriptions` (0192) | Full shape: status, trial, `pending_plan_id`, `current_period_end`, `cancel_at`, `provider`, `billing_ref`. **Nothing writes it on provisioning** |
| Plan changes | `plan_change_requests` (0192) + `insights/plan/request` + `/admin/plans` | Owner asks, operator applies. Deliberately manual because there is no gateway |
| Entitlement enforcement | `entitlement.guard.ts`, `entitlements.service.ts`, `usage_meters` | Real: hard/quota/window limits, warn + block |
| Console login | Supabase GoTrue + `AUTH_CONTEXT_SQL` (`auth.service.ts`) | Session → membership → org. **Public GoTrue sign-ups are OFF, deliberately** (08 §0.1, 17 §Supabase) |
| Server-side user creation | `SupabaseAdminService` (`createUser`, `ensureUser`, `setPassword`) | Exists precisely so a deployment with sign-ups off can still admit one named person |
| Login provisioning | `OwnerAccountsService.createLogin` | Creates the GoTrue user *then* the platform rows, deletes the auth user again if the second half fails |
| Invites | `org_invites` (0137), `/invite/[token]`, `invite-token.ts`, `invites.service.ts`, 0152 notification | Live in production. Token hashed at rest, 43-char base64url, TTL, single use, `prepared_subject` for sign-ups-off, Google identity linking |
| Platform mail | `invite-mail.ts` + `PLATFORM_SMTP_*` | One email, one recipient, one button. Off unless configured; link shown for copying otherwise |
| First-run checklist + guide | `org_setup_step_skips`, `setup_completed_at`, `guide_*_at` (0106/0129), `owner/setup.controller.ts`, `@aura/shared` setup catalogue | ~25 measured completion signals, readiness lines, skip/dismiss. **This is the onboarding, post-login** |
| Handset self-pairing | Enrollment tokens, QR dialog (0124), `/app` install page (doc 28), Samsung PDF | A buyer can pair a phone without us |
| Payment plumbing | `invoices/razorpay.ts`, `stripe.ts`, both webhook controllers, `payment_webhook_events` dedupe, `payment_gateway_config` + env fallback | Built for **tenant→their customer** invoices, not for us charging the tenant |
| Public funnel | `apps/marketing` — `/start`, `/continue/[token]`, `/booked`, `/pay/thanks`, `/pay/cancelled`, `/f/[slug]` | Sales-led: qualify → book a call. `/pay/*` are result pages only; nothing mints a checkout |
| Suspension mechanism | `organizations.status <> 'active'` | Already enforced on call ingest, device sync and API keys |

Two things in that table deserve emphasis, because they are what make this a two-week job rather
than a quarter:

1. **`createTenant` already does the hard part correctly** — including the non-obvious parts
   (`seedRoleDefaults` must run for every tenant or the org 403s on every gated route and *cannot
   repair itself from its own console*; the board must be seeded before the pipeline or the org
   gets two competing defaults). Self-serve must call that code, not a copy of it.
2. **`org_invites` is already a "let one named stranger in without opening sign-ups" machine.**
   The self-serve claim link should be an `org_invites` row, not a new token system.

---

## Part B — The six rules this plan must not break

### R1. Public GoTrue sign-ups stay OFF. Forever.

`NEXT_PUBLIC_SUPABASE_ANON_KEY` ships in the browser bundle. Reports 12, 14, 15 and 17 each spend
a section on the chain *stranger → self-signup → session → reach a Server Action*, and closing it
was Stage 0's first item. "Self-serve signup" must therefore **never** mean `/auth/v1/signup`.

Every account in this flow is created **server-side, by the API, after money arrives**, through
`SupabaseAdminService`. That is exactly what `ensureUser`'s header already describes for invites.
A test must assert the marketing app never calls GoTrue sign-up and that no new route does either.

### R2. No organization exists before the payment is verified.

Not "payment attempted", not "browser arrived at `/pay/thanks`". The rule 0060 wrote for invoices
holds verbatim here: **the signed webhook is the only thing that may create a tenant.** A browser
hitting a success URL proves a browser arrived.

The pre-payment record is therefore not an org. It is a row in a non-tenant table (Part D), and if
the buyer abandons checkout it stays there and expires.

### R3. The marketing container holds no credential that can create a tenant.

`lib/funnel/db.ts` connects as `aura_marketing` — USAGE on the `marketing` schema and nothing
else — and its header spends a paragraph on why there is no fallback. `app/f/[slug]/api.ts` spends
another on why the public form asks the API over HTTP instead. Self-serve signup follows the same
shape: **marketing proxies, the API decides.** The container answering unauthenticated traffic
from the open internet must not be able to mint an organization.

### R4. One provisioning path, not two.

`createTenant`'s body moves into a `ProvisioningService` that both the operator route and the
signup webhook call. A second copy of that seeding would drift, and the failure mode of the drift
is the one the file already warns about in writing: *a tenant with no roles, which 403s everywhere
and cannot be repaired by its owner.*

### R5. Money captured and provisioning failed is an incident, never a dead end.

A failed webhook after a successful charge is the worst state this system can reach. It must:
always answer the gateway 200 (a non-2xx makes Razorpay/Stripe retry for days), record the failure
on the signup row, raise it to the operator console, and be resumable with one click — and the
buyer must see "we're setting your workspace up, we've emailed you" rather than an error.

### R6. Transactional mail to the buyer is not the thing "nothing automated sends" forbids.

That rule (and `invite-mail.ts`'s header) is about messages reaching a **lead or contact**. The
welcome/claim email goes to the person who just paid us, about the account they just bought, once.
It is the same class as the invite mail and uses the same code. Record the distinction in
`DECISIONS.md` so nobody has to re-derive it.

And the corollary: **onboarding must not depend on email.** With `PLATFORM_SMTP_*` unset the claim
link is shown on screen immediately after payment, exactly as the invite link is shown for copying
today.

---

## Part C — The gap, precisely

Five things, in order of how much is missing:

| # | Gap | Size |
|---|---|---|
| 1 | Nothing charges a customer for Aura itself. Both gateways are wired for *tenant* invoices; `plans.price_minor` is NULL on every row; `org_subscriptions.provider` defaults to `'none'` | **New** |
| 2 | A plan does not say what it turns on. `plans.ts` documents the mapping as the future write: *"assigning a plan is write `plan_id` + write the plan's module set to `enabled_modules`"*. There is no column holding that module set | **New, small** |
| 3 | No public priced plan page and no checkout page. `/pay/thanks` exists; nothing creates the session it is the success URL for | **New** |
| 4 | Nothing turns a verified payment into a tenant + an owner login | **New, the heart of it** |
| 5 | The console's first-run assumes someone else already chose the workspace name, country, currency, timezone and module set. For a self-serve tenant, nobody did | **Extend what exists** |

Everything else — the checklist, the guide, pairing, invites, entitlements, suspension — is done.

---

## Part D — The shape

```
  marketing (public, aura_marketing role, no tenant access)
    /pricing ──────────── GET  /v1/signup/plans      (sellable catalogue, no prices in code)
    /signup  ──proxy────► POST /v1/signup/start      (+ x-forwarded-for, like /f/[slug]/submit)
                             │
                             ├─ writes public.org_signups  (status='checkout_open')
                             └─ returns the gateway's pay URL
    ▼
  Razorpay / Stripe hosted checkout
    │                                   browser ──► /pay/thanks?s=<signup public id>
    │                                                 polls GET /v1/signup/:id/state
    ▼
  POST /v1/webhooks/signup/{razorpay|stripe}   ← the ONLY thing that provisions
    1  dedupe on payment_webhook_events (provider, event_id)
    2  verify signature with the PLATFORM secret from env
    3  lock the org_signups row FOR UPDATE; bail if org_id IS NOT NULL (replay)
    4  ProvisioningService.provision({ name, modules: plan.modules, region, ... })   ← R4
    5  INSERT org_subscriptions (plan, active, period end, provider, billing_ref)
    6  organizations.plan_id = plan.key
    7  create the owner's claim: an org_invites row (owner / org_admin, invited_by NULL)
    8  mail it if PLATFORM_SMTP_* is set; always store it on the signup row
    9  org_signups.status='provisioned', org_id set
   10  notify the operator console (new self-serve tenant)
    ▼
  console /invite/<token>  ← EXISTING page: Google sign-in or set a password,
                              creates users + memberships, links the GoTrue identity
    ▼
  /owner  → first-run wizard (workspace name, country/currency, timezone, "what first?")
          → the EXISTING setup guide (0129) takes over
```

### Why `public.org_signups` and not `marketing.*`

A stranger with no tenant is what the `marketing` schema is for (`funnel_submissions`, 0020), and
putting it there would let the marketing app write the row itself. It must not go there, for two
reasons: the row acquires FKs into `organizations` and `users` the moment it is provisioned, and
R3 says the public container must not be able to create a tenant. So: `public.org_signups`,
**admin pool only**, REVOKEd from `aura_app` and from all three Supabase API roles (REVOKE before
GRANT — 0089's order; a GRANT-only migration narrows nothing), and added to `NON_TENANT_TABLES` in
`verify-rls.js` with a reason, the same reviewed edit 0192 and 0145 made.

### Why the claim link is an `org_invites` row

`invited_by` is already nullable; `prepared_subject` already exists for exactly this deployment
(sign-ups off, so the GoTrue user is pre-created and opened by nothing but a verified Google
identity for the same address). Reusing it buys the accept page, the token rules, the identity
linking, the expiry/revoke semantics, the 0152 notification and the audit trail for free.

**And this case is already live, not theoretical.** `instance-invites.controller.ts` is the
operator inviting a customer's *first* owner into a workspace with no inviter and no existing
membership — persona fixed to `owner`, `invited_by` null, the operator named in the audit row
instead. `invites.service.ts:714` and `invite-announcement.spec.ts:137` both document that null
inviter as a supported case, with a test. The signup webhook therefore calls the **same
`InvitesService.issue(...)`** the operator console calls; it is not a new path, only a new caller.

---

## Part E — Phases

### O0 — Decisions and prerequisites (no code)

Nothing below can ship without these; they are Part F.

* A platform payment account, and which gateway. `INSIGHTS_TIER_DECISIONS.md` records
  (2026-10-10): *"there is no Razorpay account yet"*.
* Real prices for the plans that will be sold self-serve.
* `PLATFORM_SMTP_*` on the API container (nice-to-have, not a blocker — R6).
* Confirm which plans are self-serve at all (Part F, Q2).

### O1 — Make a plan sellable  ·  migration 0196

`plans` gains four columns, all operator-editable from the existing `/admin/plans` console so
commercial changes never need a deploy (0192's §4 MUST):

| Column | Why |
|---|---|
| `modules text[] NOT NULL DEFAULT '{aura}'` | Gap 2. What `enabled_modules` becomes on provisioning. `'aura'` is forced in by the service anyway, as `createTenant` already does |
| `self_serve bool NOT NULL DEFAULT false` | A plan is *not* buyable without a decision. Defaulting false means shipping this migration sells nothing |
| `trial_days int` | For Q3. `org_subscriptions` already models trials properly; this is only the catalogue's half |
| `handset_required bool NOT NULL DEFAULT false` | Drives the first-run wizard's path and the pricing page's honesty (doc 10's objection, now a data point instead of a reason not to ship) |

Seed `price_minor` for the self-serve plans in the same migration (ON CONFLICT DO NOTHING keeps it
safe to re-run), and set `self_serve = true` only on the ones Q2 names.

`plans.ts`'s `orgPlanIncludesWhatsapp` stub can finally resolve against `plans.modules` instead of
returning `true` for everybody — do that here, it is four lines and the file has been asking for it.

### O2 — The signup record  ·  same migration 0196

```
public.org_signups
  id uuid pk, public_ref text unique            -- public_ref is what /pay/thanks carries
  email text not null (lower CHECK), name, phone, company_name not null
  country text, plan_id uuid not null → plans(id)
  status text CHECK (started|checkout_open|paid|provisioning|provisioned|failed|abandoned)
  provider text CHECK (razorpay|stripe), provider_ref text, amount_minor bigint, currency text
  org_id uuid → organizations(id), invite_id uuid → org_invites(id)
  failure_reason text, attempts int default 0
  utm jsonb, source_ip inet
  created_at, updated_at, paid_at, provisioned_at
UNIQUE (provider, provider_ref) WHERE provider_ref IS NOT NULL   -- the idempotency key
UNIQUE (email) WHERE status IN ('started','checkout_open')        -- one open checkout per address
```

`status` is a CHECK **and** a zod enum, and `notification-kind-drift` is the precedent for why
those two drift and throw 23514 at runtime: add them in the same commit and assert the pair in a
test.

### O3 — Public catalogue + checkout  ·  API

Two unguarded, throttled routes in a new `signup` module, plus one read:

* `GET /v1/signup/plans` — active ∧ self_serve ∧ priced. No price, name or blurb hardcoded
  anywhere in marketing (0192 §9.6).
* `POST /v1/signup/start` — zod-validated (email, company, country, plan key, consent, honeypot,
  `rendered_at`, utm — mirror `funnel/state.ts`'s field discipline). Creates the `org_signups` row,
  mints the gateway checkout with `notes.signup_id` / `metadata.signup_id`, returns the pay URL.
  Throttled 300/min per source IP like `PublicFormsController`, and the source IP is the
  **forwarded** one — `main.ts` already sets `trust proxy`.
* `GET /v1/signup/:public_ref/state` — `{ state: 'pending' | 'ready', inviteUrl? }`. What
  `/pay/thanks` polls so the buyer lands on their claim link in seconds without an email.

All three go in `guard-mounting.spec.ts`'s UNGUARDED list **with their reason**, same class of
exception as `PublicFormsController` and `/auth/login`: unguarded by design, asserted so they
cannot become unguarded by accident.

A thin gateway adapter (`platform-checkout.ts`) wraps "create a payment link / checkout session for
plan X" over the existing `razorpay.ts` / `stripe.ts` helpers, reading the **platform** env keys
(`RAZORPAY_KEY_ID`/`SECRET`, `STRIPE_SECRET_KEY`) — never `payment_gateway_config`, which is a
tenant's own account for charging *their* customers. Do not blur those two.

### O4 — Marketing pages  ·  `apps/marketing`

* `/pricing` — the catalogue from `GET /v1/signup/plans`, rendered server-side. Plans with
  `handset_required` say so, with a link to `/compatibility`; the un-sellable tiers keep the
  existing "Talk to us" CTA into the funnel at `/start`.
* `/signup` — one short form (name, work email, company, country, plan) → a server route that
  proxies `POST /v1/signup/start` adding `x-forwarded-for`, exactly as `f/[slug]/submit/route.ts`
  does, and redirects to the gateway.
* `/pay/thanks` — gains the poll on `?s=<public_ref>`: "Setting up your workspace…" → "Open your
  workspace" when the webhook has landed. Keep it chrome-free and analytics-free, as
  `pay-result-page.ts` requires.
* `/pay/cancelled` — unchanged.

### O5 — `ProvisioningService`  ·  the R4 refactor, do this before O6

Move `createTenant`'s transaction body and the three `seed*Defaults` functions out of
`admin.controller.ts` into `apps/api/src/modules/tenancy/provisioning.service.ts`, taking
`{ name, workspaceName, modules, consentPolicy, retentionDays, region, tokenTtlMinutes,
tokenMaxUses, planId, provenance }` and returning the tenant + the one-time enrollment key.
`AdminController.createTenant` becomes a thin caller; its behaviour must not change by one byte
(it has a spec and an operator console on top of it).

New, in the same transaction, when `planId` is given: the `org_subscriptions` row and
`organizations.plan_id`. An org provisioned without a plan (every operator-created tenant today)
behaves exactly as now.

`provenance` (`'operator' | 'self_serve'`) lands on `organizations` as a column and in the audit
row, so the operator console can tell a self-serve tenant from one they built. Six months from now
"where did this org come from" must have an answer that is not a guess.

### O6 — The webhook  ·  the heart

`POST /v1/webhooks/signup/razorpay` and `.../stripe` — a **new controller**, not an extension of
the invoice ones. Those resolve an *org* from the payment and apply it to a tenant invoice; this
one has no org yet and verifies against the platform secret. Same discipline, different subject,
so: a deliberate twin, with the differences written in the header.

Order of operations, and every step is load-bearing:

1. Raw body + signature header. Dedupe on `payment_webhook_events (provider, event_id)` first.
2. Verify the signature with the platform webhook secret from env. Nothing is read from the
   payload before this except the event id.
3. Resolve the `org_signups` row from `notes.signup_id`, `SELECT … FOR UPDATE`. If `org_id IS NOT
   NULL`, this is a replay: 200, do nothing. This is the whole idempotency story, and the
   `doc39-migrations-run-and-two-defects` lesson (*an INSERT that never bound `$10`*) says to test
   it against a real database rather than reading it.
4. `status='provisioning'`, `attempts = attempts + 1`, commit — so a crash mid-provision is
   visible rather than silent.
5. `ProvisioningService.provision(...)` with `modules` from the plan.
6. Owner claim: `InvitesService.issue(...)` — the same call `instance-invites.controller.ts`
   makes, persona `owner`, `invited_by` null, GoTrue user pre-created via `ensureUser`. The actor
   in the audit row is the signup, not an operator.
7. Mail it if configured; store `invite_id`; `status='provisioned'`.
8. Notify the operator: a new self-serve tenant, with the payment reference.
9. **Always 200.** Unknown signup, bad signature, an event we ignore — all `{ ok: true }`. A
   non-2xx earns three days of retries.

Failure after step 4 → `status='failed'`, `failure_reason`, operator notification with the payment
reference, and `POST /v1/admin/signups/:id/retry` to resume (R5). The buyer's `/pay/thanks` keeps
saying "we're setting up, we've emailed you" — never an error page, because their money did arrive.

### O7 — First-run wizard  ·  `apps/web`

What the operator used to decide, now asked of the buyer, **once**, at `/owner/welcome`, shown when
`provenance='self_serve' ∧ setup_completed_at IS NULL`:

1. **Your workspace** — name (pre-filled from the signup's company), country + currency, reporting
   timezone. All three already have pickers (`/owner/account/time`, 0126/0132); this reuses them,
   it does not reimplement them.
2. **Your team** — team size, then the existing invite composer inline. Optional, skippable.
3. **What first?** — three cards, chosen by the plan: *Pair a phone* (the 0124 QR dialog + the
   `/app` install page + the Samsung PDF), *Import your leads* (0182 import centre), *Connect
   WhatsApp*. One click, then straight into the existing guide.

Then **stop**. Hand over to 0129's setup guide, which already measures ~25 signals and already
re-opens when a module is added. Do not add a parallel checklist: `cosmetic-debt-audit-doc40.md`'s
whole subject is surfaces that look like mechanisms, and a second progress tracker that nothing
reads is exactly that.

### O8 — Lifecycle, self-serve  ·  the part that makes it stick

* **Renewal** → webhook moves `current_period_end`.
* **Failed renewal** → `status='past_due'`, an owner banner, a grace window, then
  `organizations.status='suspended'` — a mechanism that is already enforced on call ingest, device
  sync and API keys, so suspension is real and not decorative. Reinstatement on payment.
* **Upgrade** → a checkout, applied by the webhook. `plan_change_requests` stays for the plans
  Q2 keeps sales-assisted, and `/admin/plans` keeps working for both.
* **Downgrade** → already modelled as `pending_plan_id` applied at `current_period_end`. Honour it;
  do not make it immediate.
* **Cancel** → `cancel_at`, access to the end of the period, then suspension. Export first
  (0148/0188 export engine) — a customer who cancels is entitled to their data.
* **A worker sweep** for trial expiry and period rollover. `finance-module-build`'s lesson applies:
  one bad sweep took the whole worker down (`fb6ca7cd`), so this one is guarded the same way.

### O9 — Abuse, operator visibility, verification

* **Rate limits** on `/v1/signup/start` per IP *and* per email; honeypot + `rendered_at` dwell
  check, as the funnel already does; one open checkout per address.
* **A paying address that already has a membership** does not create a second org silently. Offer
  "sign in instead" before checkout, and if it slips through, the webhook attaches the new
  subscription to the existing org only if the buyer is its owner — otherwise it fails to the
  operator (R5). This is the subtlest hole in the whole flow; write the test first.
* **Operator console**: `/instances` gains provenance + subscription status; a new `/signups`
  screen listing started / failed / provisioned with the retry button.
* **Tests**: webhook replay (same event twice → one org); bad signature → no org; token rules;
  plan→modules mapping; the CHECK ↔ zod enum pair; `guard-mounting.spec.ts` UNGUARDED list;
  `verify-rls.js` non-tenant allowlist; and a "GoTrue sign-ups stay off" assertion.
* **Run 0196 against a real Postgres** on the ephemeral 55432 recipe (`local-postgres-verification`)
  plus `verify-rls`, both directions, before it goes anywhere near production. Typecheck cannot see
  a wrong column name inside a SQL string, and this migration is mostly SQL strings.
* **End-to-end in gateway test mode**: pay → provisioned → claim → first login → guide, with zero
  operator actions. That is the exit check for the whole document.

---

## Part F — Decisions needed (these are yours, not engineering's)

| # | Question | Recommendation |
|---|---|---|
| **Q1** | **Which gateway for our own subscriptions?** No platform account exists yet (2026-10-10). | **Razorpay.** India-first buyers, UPI/netbanking/cards, INR, and the webhook + signature code already exists. Keep Stripe behind the same adapter for non-INR later |
| **Q2** | **Which plans are self-serve?** `handset_required` plans drag in the sideload problem: Play Protect blocks the APK and the Samsung guide exists because of it (`samsung-setup-guide`). | **Starter + Growth self-serve** (API/Insights, no handset). **Scale + Platform stay sales-assisted** until the install is frictionless. Prices: see Q4 |
| **Q3** | **Trial before payment, or pay first?** You said after paying — so pay-first. `org_subscriptions` models trials correctly either way. | Pay first, with a **money-back window** stated on the pricing page instead of a trial. Revisit once Q2's handset friction is gone |
| **Q4** | **Prices.** Every `price_minor` is NULL and the Compare-plans page renders "Talk to us" because of it. Per-handset-per-month (doc 10 §6) does not fit the API tiers. | Needs your numbers. Per-seat monthly for Starter/Growth, annual option at ~2 months' discount |
| **Q5** | **Do we issue a GST invoice for the subscription?** We are an Indian seller charging Indian businesses; the gateway's receipt is not a tax invoice. | Yes, and it is not free: either the gateway's own invoicing or a small platform-side invoice generator. **Do not** reuse the tenant-facing `invoices` module — that is their book, not ours |
| **Q6** | **One org per email, or many?** `createLogin` already links an existing login to a second instance. | One self-serve org per address. A second purchase by the same person routes to the operator (Q9's screen), because "which org did I just buy" is a question a buyer should never have to answer |
| **Q7** | **Email from which domain, and is `PLATFORM_SMTP_*` set in production?** Onboarding works without it (R6), but a buyer who closes the tab then needs you. | Configure it. A claim link that only ever existed on one tab is a support ticket per signup |

---

## Part G — Traps, each one already paid for once

1. **`seedRoleDefaults` must run for every tenant.** An org with no `roles` rows 403s on every
   permission-gated route and the owner cannot fix it, because fixing roles needs the grid that is
   missing. The API-only tier was the first shape of tenant to expose this. R4 exists for it.
2. **Board before pipeline.** `seedBoardDefaults` find-or-creates the default pipeline;
   `seedCrmDefaults` after it reuses that one. Reversed, the org gets two `is_default` pipelines and
   nothing in the database stops it.
3. **CHECK ↔ zod drift** on `org_signups.status` throws 23514 at runtime and looks like a bug
   anywhere but where it is (`notification-kind-drift`).
4. **`Input.partial()` keeps `.default()`** — a PATCH on a plan or a signup silently overwrites
   fields the caller never sent (`zod-partial-default-trap`). There is one live instance of this
   already; do not add a second.
5. **REVOKE before GRANT** on `org_signups`, or the Supabase API roles keep whatever they had
   (`marketing-schema-grants-trap`).
6. **Migration numbering.** Local tree is at 0195 and both `packages/db/migrations/` and
   `supabase/migrations/2026010100NNNN_*` must get the file. Production migration names have
   diverged from the local tree before (`crm-integrity-fixes`) — verify production's state
   read-only through the container before adding 0196, and never trust `schema_migrations` alone
   (`production-migration-drift`).
7. **Deploy from the commit, not the worktree.** A parallel session's fix between `add` and
   `commit` once crash-looped the whole production worker (`staged-vs-worktree-deploy-trap`).
8. **`next redirect()` in a server component** throws a React hooks error on hard load — a Next
   15.5.20 bug, not yours (`next-redirect-hooks-error`). The claim and welcome pages redirect a
   lot; expect it, do not chase it.
9. **The repo is public.** A gateway key or webhook secret in a commit is a breach; scan the patch
   before pushing (`github-repo-public`).
10. **No offsite backup yet** (`supabase-selfhost-migration`). Self-serve multiplies tenants, which
    multiplies what an unbacked database loses. Not a blocker for this build; a blocker for
    advertising it.

---

## Part H — Sequencing

| Step | Phase | Depends on |
|---|---|---|
| 1 | O5 `ProvisioningService` refactor (no behaviour change, ships alone) | — |
| 2 | O1 + O2 migration 0196, verified on a real DB | Q2, Q4 |
| 3 | O3 catalogue + checkout routes | Q1, step 2 |
| 4 | O6 webhook + claim | steps 1–3 |
| 5 | O4 marketing `/pricing` + `/signup` | step 3 |
| 6 | O7 first-run wizard | step 4 |
| 7 | O9 operator `/signups` screen + the abuse tests | step 4 |
| 8 | O8 lifecycle sweeps | step 4 |

**Exit check:** buy a plan with a test-mode card, from a browser that has never seen this platform,
and reach a workspace with a paired phone or an imported lead list — with nobody at a terminal.
That is the sentence `08_ROAD_TO_10.md` §4.4 wrote in 2026-08 and this document finally closes.
