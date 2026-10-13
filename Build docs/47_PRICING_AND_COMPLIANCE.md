# 47 — Pricing, the four meters, and what the code does about them

The commercial source is the owner's own pricing document
(`https://claude.ai/artifact/LLbZKMQibGXEDDSkhJX9hj`, tabs *Pricing* and
*Consent and compliance*, as of 2026-10-05). **That document is the authority on
the numbers.** This file records what was built from it, the two decisions taken
during the build, and the things a reader will otherwise get wrong.

Built 2026-10-13. Migration `0197_capture_plans_and_billing.sql`. Local only —
nothing deployed, no production migration run.

---

## What was already true before any of this

Worth stating first, because it is why this was a pricing job and not a research
project. Every limit the price list sells was already measured and already
enforced, by a column that predates the plan system:

| Meter | Column | Enforced by |
| --- | --- | --- |
| Transcription hours | `organizations.asr_monthly_minutes_budget` (0086) | the worker pipeline, before the transcode advance |
| Audio retention | `organizations.retention_days` (0001) | the reaper |
| Storage cap | `organizations.storage_quota_bytes` (doc 27) | the hourly storage sweep |
| Transcription at all | `organizations.transcription_enabled` (0014) | the pipeline |
| Handsets | `devices` rows | **nothing — this was new** |

And 0192 had already built the plan layer itself: `plans`,
`plan_entitlements`, `org_subscriptions`, `usage_meters`, and one
`Entitlements.check()` every route reads. What was missing was a catalogue for
*this* product, an assignment, a handset cap, and a way to be paid.

So **assigning a capture plan resolves it into those columns** — the same move
0192 makes when it resolves a plan into `enabled_modules`. That is
`assignPlanToOrg` in `@aura/db`, shared by the operator's Apply, the billing
webhook, and the worker's trial-revert and downgrade sweeps.

## The two decisions taken during the build

**Growth is ₹19,999 for 200 hours.** The price list left this open. Growth is
the only tier that sells speaker separation, which means Sarvam diarized at ₹45
an audio-hour — ₹10,800 at the 200-hour cap, leaving 28% margin at the original
₹14,999. The two ways out gave identical 46% margin: raise the price and keep
200 hours, or hold ₹14,999 and cut to 150. The project owner chose to raise the
price.

The UAE figure stays at the published AED 899. That region is not sellable, so
there is nothing to re-derive yet — and inventing a number the price list does
not carry would be worse than leaving the ratio to be decided when the market
opens. **This is the one loose end in the price table.**

**One catalogue, two families.** `plans.family` is `capture` or `insights`. The
API-only Insights tier (0192) already owned the keys `starter` and `growth`, so
the capture tiers are `record`, `capture_starter`, `capture_growth` and
`capture_enterprise`. One `check()`, one subscription row per tenant, two rails.

## The hard blocker that had to be fixed first

`retention_days` governed **everything**. When it expired, the reaper deleted
the audio, the transcript, the AI analysis and every dormant lead, deal and
contact with it. Wiring a plan's "60 days on Starter" to that column would have
quietly deleted a paying customer's CRM history.

Retention is two clocks now:

- **`retention_days`** — the AUDIO clock. The plan lever, on the price list.
  Deletes the recording file and nothing else, stamping `recordings.expired_at`.
- **`data_retention_days`** — the full purge. Off the price list, defaults to 90
  days *or the audio window, whichever is longer*, only ever changed per
  customer on request.

A customer at day 90 on Starter has every transcript, lead and insight, and
simply cannot replay the audio. `HAS_RECORDING` and the two presign routes tell
"never had audio" apart from "the audio aged out", so the second gets a sentence
rather than a 404.

`applyPlanMeters` raises `data_retention_days` and never lowers it. A trigger
(`organizations_data_retention_floor`) holds the invariant at the table, because
a column DEFAULT cannot reference another column and a tenant created with a
365-day audio window was otherwise taking the constant 90 — audio outliving its
own transcript. **That defect was found by `verify-capture-plans.cjs` against a
real database, not by typecheck or a unit test.**

## What happens at each limit

One principle governs all four: **a call is never refused.** A recording we
decline is lost for good, the handset retries it forever, and the customer loses
the one thing they pay us to keep. Only the paid stages are ever skipped.

| Limit | What happens | Warns owners |
| --- | --- | --- |
| Handsets | Pairing is refused, with the add-on offered | no |
| Transcription hours | Call still recorded, stored, listed, playable; transcription and analysis skipped and **reprocessable** | 80% and 100% (`transcription_quota`) |
| Audio retention | The recording file is deleted; records all stay | no |
| Storage cap | Oldest audio evicted; uploads never blocked | 80% and 100% (`storage_quota`) |

The handset cap is the only hard stop, and it stops an administrative action
rather than a recording — visible, immediate, understood, and undone by spending
money. It is checked only for a *new* phone: a re-paired, recovered or
rebound handset lands on its old row and consumes no slot.

## The UAE is blocked on law, not engineering

Recording a call without the counterparty's consent is a **criminal** offence
there: Penal Code (31/2021) art. 431, and Cybercrime Law (34/2021) art. 44 at
AED 150,000–500,000 plus imprisonment. An announcement is notice, not consent,
and there is no workplace or commercial exception.

So the AED prices are seeded, correct, and `plan_prices.sellable = false`.
Beyond that:

- `organizations.billing_region` is **operator-set** and is deliberately *not*
  `org_business_profile.country`, which the tenant edits itself. A country a
  tenant can type cannot pin a criminal-law gate.
- A trigger clamps `consent_policy` to `prohibited` for any AE tenant with no
  `consent_cleared_at`. A trigger and not an API check, because three writers
  touch that column and a rule enforced in three places is a rule with two
  holes.
- `consent_cleared_at` is set by hand, per tenant, by an operator who holds the
  written counsel opinion.

Opening the UAE means: affirmative consent capture per counterparty (a keypress
or spoken "yes" in the recording, or consent in signed master terms), a hard
abort-and-discard path that deletes the buffer rather than marking a row, and
the opinion. Then four `sellable` flags.

## Payment: Razorpay behind environment keys, nothing live

`resolvePlatformGateway` returns `manual` unless `RAZORPAY_PLATFORM_KEY_ID` and
`RAZORPAY_PLATFORM_KEY_SECRET` are set, and for any currency but INR — Razorpay
is an India gateway and will not settle dirhams, which is why the provider is
per order rather than per platform. **`manual` is a complete path, not a
failure:** the order is recorded, the owner is told we will invoice them, and an
operator settles it at `POST /admin/billing/orders/:id/settle`. That is how the
first accounts get sold.

Three things worth knowing before touching it:

- **Creating an order never grants anything.** `org_subscriptions`,
  `enabled_modules` and every meter move in exactly two places: an operator's
  Apply, and `BillingOrdersService.settle()`. Both the webhook and the operator
  settle call the same `settle()`, so the manual path cannot grant something
  different from the paid one.
- **The total is frozen at create.** A price an operator edits tomorrow must not
  change what somebody is charged for a checkout they started today, and
  `settle()` refuses a capture whose amount does not match.
- **A retry must not grant a second month.** `billing_webhook_events` is UNIQUE
  on `(provider, event_id)` and the row is claimed *before* the work; a delivery
  with no `x-razorpay-event-id` is refused outright rather than given a
  synthesised key. `settle()` is also idempotent on the order's own status, so
  there are two independent reasons a replay is safe.

## Hour packs, add-ons, and the one trap

A `pack` is consumed and expires with the UTC month it was bought in; a
`recurring` add-on raises a ceiling for as long as it is held. The hour ceiling
is therefore resolved **at read time** (`readEffectiveLimits`) rather than
written into `asr_monthly_minutes_budget` — a column holding "the ceiling
including this month's top-ups" would be stale on the 1st and need a sweep to
correct, and a late sweep would either give away hours or refuse a customer who
had paid. That column keeps its original job: an operator's hand-set cap, which
wins over the plan, and which is how a negotiated Enterprise hour count is
expressed.

Packs are priced above the in-plan rate on purpose — ₹80 and ₹70 an hour against
₹60 inside Starter — so a customer who tops up every month can see that upgrading
is cheaper. Margin on a top-up is still around 65%.

Auto top-up is opt-in and the table's CHECK makes it impossible to switch on
without a monthly ceiling.

**The trap:** turning transcription on sweeps up calls that were stored but never
transcribed, so "upgrade and we'll transcribe your history" is a real feature. But
5 GB of stored audio is about 248 hours — an unbounded sweep on upgrade would cost
roughly ₹6,200, swallow the whole of Starter's first-month allowance and exceed the
first month's fee. `BACKLOG_TRANSCRIPTION_HOUR_CAP` exists for this and **is not
yet wired to the upgrade path.** See open items.

## Known divergences, stated rather than half-fixed

**The enforcement window is the UTC calendar month**, not the customer's own
calendar and not their billing date. A floor in Dubai sees its allowance reset
partway through their evening, and a contract starting on the 15th still resets
on the 1st. The price list says "per calendar month" and means it. Grants are
written into the same UTC bucket as the meter that spends them, because a grant
in one window and a meter in another is a customer paying for hours they cannot
spend.

**No seat is metered, ever.** `active_telecallers` and `dashboard_logins` are
`null` on all four capture plans, deliberately and permanently. Cost follows
audio, not logins, and the product wants *more* people in the CRM reading what
the calls revealed.

## Open items

1. **`plan_prices` is seeded but nobody reads it.** 0197 creates the table and
   fills it, and the stated point was that product could move a price without a
   release. But `quoteSubscription`, `quoteAddon` and the console's price list
   all resolve against the constants in `packages/shared/src/pricing.ts`, which
   are compiled in. So an operator editing `plan_prices` today changes nothing
   and a price change needs a deploy. Closing it means resolving the region's
   row on the admin pool in `BillingOrdersService` with these constants as the
   fallback when no row exists. **Until then, the prices live in code.**
2. **Wire the backlog cap.** `BACKLOG_TRANSCRIPTION_HOUR_CAP` is defined and
   unused; the upgrade path does not yet draw a backlog sweep against the
   customer's hour allowance.
3. **The UAE Growth price** (AED 899 against a raised ₹19,999) needs re-deriving
   when that market opens.
4. **Validate 25–30 audio-hours per handset per month.** Every margin in the
   pricing document rests on it and it is an assumption, not a measurement.
5. **Record's 30-day retention** — keep, or move to 60? Audio is the whole
   product on that tier.
6. **A UAE gateway.** Razorpay cannot settle AED. The billing layer no longer
   assumes one provider, but the second one does not exist.
7. **Singapore pricing.** The compliance tab covers the law; there is no price
   list and the cost base differs again.
8. **Align the hours window to the billing date,** or keep saying "per calendar
   month". Currently the latter.

## How to check it still works

```bash
cd platform
docker compose -f docker-compose.test.yml up -d --wait postgres
cd packages/db
DATABASE_URL="postgresql://aura:aura_dev_password@localhost:55432/callintel" node migrate.js
DATABASE_URL="postgresql://aura:aura_dev_password@localhost:55432/callintel" \
  APP_DATABASE_URL="postgresql://aura_app:aura_app_password@localhost:55432/callintel" node verify-rls.js
cd ../../apps/api
DATABASE_URL="postgresql://aura:aura_dev_password@localhost:55432/callintel" node verify-capture-plans.cjs
```

`verify-capture-plans.cjs` refuses any port but 55432, because it creates and
deletes an organization. It is the only check that proves the SQL joins reach
the right tables and the triggers fire — typecheck cannot see SQL, and
`EFFECTIVE_LIMITS_SQL` is four correlated subqueries, exactly the shape where a
wrong join answers plausibly and silently.

Unit coverage: `packages/shared/src/pricing.test.ts` (the price list, the
integer money math, add-on arithmetic, `effectiveLimits` across no-plan /
Record / trial / add-ons / operator override / the consent gate) and the
widened `entitlements.test.ts`, whose drift check now reads **0197** for the
full eight-plan table and leaves 0192 pinned to its own 23 keys.
