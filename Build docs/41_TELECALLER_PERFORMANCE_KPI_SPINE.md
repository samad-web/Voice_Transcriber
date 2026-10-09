# 41 — Telecaller performance: the configurable KPI spine, and the gaps around it

Written 2026-10-09, after reading `Build docs/telecaller-performance-build-plan.md` against the
code that actually shipped.

The original plan asked for a KPI **catalog**, an owner **wizard**, effective-dated
**configuration** and a single **weighted score**. None of those exist — there is no
`kpi_catalog`, no `org_kpi_config` and no `kpi_snapshot` anywhere in the schema. What shipped
instead was the plan's *output*: four screens over a fixed metric set, computed from the call
pipeline, with every derivation centralised in `@aura/shared` and a strong discipline about what
a number is allowed to claim.

That discipline is the valuable part of what exists, and the configuration work below is exactly
the kind of work that quietly destroys it. So this document has two halves: **Part B, the
decisions that must survive every phase**, and **Parts C–I, the gaps to close**.

---

## Part A — What exists today, so none of it gets rebuilt

| Layer | Where |
|---|---|
| Capture | `calls`; `call_analytics.quality_score`; `transcripts.intelligence->>'sentiment'`; `call_sop_results.adherence_pct` (0091); `call_dispositions` (0097) + `resolves_on_first_call` (0144) |
| Daily rollup | `telecaller_daily_stats` (0090) — volume, pacing, span, presence, talk. Recomputed, not accumulated, by `apps/worker/src/pipeline/telecaller-stats.ts` every 15 min over today + `TELECALLER_STATS_LOOKBACK_DAYS` (2) |
| Definitions | `packages/shared/src/agent-scorecard.ts`, `performance-overview.ts`, `targets.ts`, `staff.ts` |
| Rep's own card | `/owner/my-performance` — ungated, scoped to the reader |
| Team activity | `/owner/productivity` — ungated, **rows** narrowed by `owner-scope.ts` (`telecaller_stats`) |
| Command centre | `/owner/performance` — owner + manager only |
| Staff scorecard | `/owner/staff` → Performance tab — owner + manager only |
| Targets | `sales_targets` (0050): `won_value` and `won_count` only, read against **pace** |
| Incentives | `commission_plans` (0071): one flat rate, multiplied on read |

There is **no telecaller-performance surface in the operator console** at all. `/admin` carries
per-tenant targets, calls, usage and access, and nothing about a floor's people.

---

## Part B — The five decisions this plan will not reverse

These are not preferences. Each is written into the code it governs, and each is the thing a
configurable KPI engine naturally breaks.

### D1. No composite over incommensurable denominators

`agent-scorecard.ts` refuses to average QA, sentiment and FCR into one "agent score", because
they are rates over three different subsets — calls the AI could score, calls that produced a
sentiment read, dispositioned first contacts — and the average of three rates over three
populations is not a rate over anything. It also hides the trade-off the page exists to show: a
rep who resolves more on first contact makes fewer calls.

**What this permits.** An *achievement* is a different object: `actual ÷ an agreed target`, which
is unit-free by construction. Weighting achievements is defensible where averaging rates is not.
So Phase 3 may build `Σ(achievement × weight)` **and must never** build a blend of the raw
quality signals. The four quality signals stay separately reported on every screen, with their
own bases beside them, exactly as they are now.

### D2. `null` means "not enough to say", never zero

`MIN_RATE_SAMPLE` 5, `MIN_QUALITY_SAMPLE` 8, `MIN_CONVERSION_BASE` 10, `MIN_CAMPAIGN_LEADS` 10.
Every new KPI in the catalog declares a minimum base, every snapshot row may be null, and a
composite computed over a suppressed component is **not** silently redistributed — see G2 below.

### D3. The identity gap is admitted, never averaged away

A lead belongs to a `telecallers` row; a task belongs to a `users` row; `telecallers.user_id` is
the only bridge and on live tenants it is mostly null. The scorecard reports `linked: false` and
the pages render a dash rather than a zero.

**Consequence for the schema.** A KPI declares which identity it is keyed on, and `kpi_snapshot`
keys on `(subject_kind, subject_id)` rather than on one id column. A wizard that lets an owner
weight a `user`-keyed KPI at 30% on a floor where 80% of reps have no login has configured a
score that is unanswerable for most of the floor, so the wizard must say so at the moment of
selection — with the count, and a link to `/owner/staff`.

### D4. The "calls today" tracker is a description until a real target exists

Nobody can set a daily call target today, so the tracker shows the floor's median calls on a
worked day (or the rep's own), and `paceSource` names which in words every time. The moment
Phase 2 lands, `paceSource` gains a `"target"` branch and the bar means something different —
and it must keep naming its source. The bar may never silently become a quota.

### D5. Commission is a calculator, not payroll

0050 and 0071 both state it: no accrual, no approval trail, no claw-back. Phase 4 adds slabs to
the calculator. It does not add payroll, and the slab UI says what it is.

---

## Part C — The gaps, as defects

| # | Gap | Kind |
|---|---|---|
| G1 | No KPI catalog, no owner wizard, no business-type presets. A tenant cannot choose what it is measured on. | Absent |
| G2 | No per-KPI targets, weights, rating bands, scoping or effective dates. | Absent |
| G3 | No daily/weekly activity target of any kind — `sales_targets` carries money and deal count only. | Absent (D4's cause) |
| G4 | **Disposition is not mandatory on call end.** The handset has no disposition UI at all; outcomes are confirmed in the console, by whoever gets round to it. | **Data integrity — the biggest threat to every number here** |
| G5 | No manager-scored quality. QA is entirely the AI's read; no review form on sampled recordings. | Absent |
| G6 | No performance alerting. The notification enum has `sla_breach` and `attendance_absent`; nothing for a person below threshold or a target missed N days running. | Absent |
| G7 | Incentives are one flat rate — no slabs. | Weaker than the plan |
| G8 | `marketing_sources.spend_amount` is a campaign's **lifetime** total, so window-leads ÷ lifetime-spend makes every long-running campaign read badly. | **Known wrong number, labelled on the page** |
| G9 | No performance view in the operator console, and 0122 means operators cannot read call content without the client's approval. | Absent, and possibly correctly so — see Part K |
| G10 | The three performance screens have no export. CSV exists for Sales overview only. | Absent |
| G11 | Original plan's Phase 3 — forecasting, benchmarking, lead-quality adjustment, ramp-up targets — entirely unbuilt. | Deferred, see Part J |

---

## Part D — The ordering principle

Nothing here is *wrong*; G8 is the only finding where a shipped number misleads, and it already
says so on the page. Everything else is absence. So the order is not severity, it is dependency
and trust:

1. **Inputs before measurement.** A configurable KPI engine resting on dispositions nobody
   enters is a more confident version of today's gap. G4 and G8 first, and G4 is long-lead
   because it needs an APK release — start it first precisely because it lands last.
2. **The spine before anything that reads it.** G1/G2/G3 are one piece of work, not three.
3. **Then the readers** — alerts, slabs, exports — each of which is small once the spine exists
   and impossible before it.
4. **Human QA (G5) runs independently** of all of the above and can be slotted wherever there is
   capacity.

Migration numbers below are nominal, starting after 0170. Renumber if something else lands
first; there is precedent for the ledger and the tree diverging.

---

## Part E — Phase 1: make the inputs true

### E1. Disposition capture on the handset (G4)

The product's shape is already decided and good — *the tenant defines the vocabulary, the AI
proposes from it, a person confirms*. What is missing is the moment of confirmation being
anywhere near the call.

- **Handset prompt.** Reuse the lock-screen alert machinery from 0150 (`AlertActivity`,
  `AlertNotifications`, `AlertSyncWorker`) rather than inventing a post-call screen. On call end,
  a notification offering the org's dispositions as actions; tapping one posts it through the
  existing device API.
- **Non-blocking, deliberately.** This runs on a personal handset. A modal that holds the phone
  hostage until a rep classifies a call gets the app disabled, not the data entered. The prompt
  is dismissible; what makes it stick is E3 below.
- **Ships with an APK.** 1.2.1/11 is built but unpublished; this rides that release or the next.
  Bump `versionCode` on every build that leaves the machine, and never republish 1.2.0/10.

### E2. An "outcome needed" queue in the console

A filter and a count on `/owner/calls` and on the rep's own call log: calls with no disposition,
oldest first. This is what a rep clears at the end of a shift, and what a manager sees the size
of.

### E3. `dispositioned_rate` as a first-class KPI

Make the data-quality problem a measured number rather than a caveat: *share of connected calls
carrying a disposition*, per person, in the catalog from day one (Part F), visible on the three
screens whether or not a tenant selects it for scoring. The original plan's §9 "data trust" row
asks for a last-synced time and a missing-disposition flag; this is the stronger version.

It also makes FCR honest: FCR's denominator is dispositioned first contacts, so FCR at 70% means
something very different at 90% disposition coverage than at 20%, and the two numbers belong
beside each other.

### E4. Per-period marketing spend (G8)

New table `marketing_source_spend (org_id, source_id, period_start, period_end, amount)`, RLS
on, one row per campaign per period. The command centre's campaign read window-joins it and falls
back to the lifetime figure only when no period rows exist — still labelled, as it is today.

**Migration 0171.** Needs RLS or `verify-rls` blocks the deploy.

---

## Part F — Phase 2: the configuration spine (G1, G2, G3)

### F1. The catalog is code, not a table

The original plan puts `kpi_catalog` in the database. It should not be: each KPI's definition is
a numerator, a denominator and a source predicate — SQL that has to ship with the code that runs
it. A tenant-editable formula is an injection surface and a tenant-editable *row pointing at*
code is two places to keep in step. Vocabulary belongs in tables (`call_dispositions`,
`call_sops`); formulas belong in `@aura/shared`, next to the derivations that already live there.

`packages/shared/src/kpi-catalog.ts` — one entry per KPI:

| field | meaning |
|---|---|
| `key` | stable id, e.g. `connect_rate` |
| `category` | `activity` \| `quality` \| `result` \| `discipline` |
| `identity` | `telecaller` \| `user` — **D3**; decides which column `kpi_snapshot` keys on |
| `numerator` / `denominator` | named sources the engine knows how to read; a count KPI has no denominator |
| `direction` | `higher` \| `lower`. **A property of the metric, not a tenant choice** — the original plan made direction configurable, which would let a workspace declare that fewer complaints is worse |
| `unit` | `count` \| `percent` \| `seconds` \| `currency` |
| `minBase` | the D2 floor for this KPI |

The opening set, roughly twelve, so an owner has something to choose between:

- **Activity** — `calls_made`, `connect_rate`, `talk_time`, `calls_per_active_day`,
  `median_idle_gap` *(lower)*
- **Quality** — `qa_score`, `sop_adherence`, `consent_rate`, `sentiment_index`
- **Result** — `leads_worked`, `conversion_rate`, `won_value`, `first_response_minutes` *(lower)*
- **Discipline** — `followup_compliance` *(user)*, `sla_breaches` *(lower)*, `unanswered_leads`
  *(lower)*, `dispositioned_rate`, `attendance_present_days`

`sentiment_index`, never `csat` — doc 40 §E already renamed that tile for the reason that nobody
asked the customer anything.

### F2. `org_kpi_config` — migration 0172

```
org_id, kpi_key, scope_kind ('org'|'workspace'|'owner_role'|'telecaller'),
scope_id, target_value, period ('daily'|'weekly'|'monthly'),
weight_pct, effective_from date, effective_to date NULL, created_by, created_at
```

Unique on `(org_id, kpi_key, scope_kind, scope_id, effective_from)`. RLS on.

- **Resolution rule.** For a subject S on day D, the applicable row is the most specific scope
  whose `[effective_from, effective_to)` contains D, specificity being
  `telecaller > owner_role > workspace > org`. Deterministic, which is what lets the engine
  recompute a past day and get the same answer it got the first time — the property that makes
  "changing a target next month must not rewrite last month" true by construction rather than by
  a snapshot nobody may touch.
- **Ramp-up targets for new hires fall out of this for free** (original plan's Phase 3): a
  `telecaller`-scoped row with a 30-day window and a lower target *is* a 30/60/90 ramp.

### F3. `org_kpi_bands` — same migration, same effective-dating

Default three bands: `< 60` "Needs support", `60–90` "On track", `> 90` "Excellent". Labels and
thresholds editable, count not fixed at three.

**Colour.** The lowest band must not render in the error orange. `StatusChip`'s `danger` tone is
that orange, and this codebase's standing rule is that red means *missed*, orange means *error* —
a person behind pace is neither a missed call nor a system fault. Use the KPI palette.

### F4. The wizard — `/owner/settings/performance`

The original plan's six steps, with two changes:

1. **Business type is not asked again.** The business profile already holds it and stage packs
   already key presets off it. Read it, pre-select the recommended set, let the owner edit.
2. **A step the original plan could not know it needed:** when a selected KPI is `user`-keyed,
   the wizard names how many of the floor have no login behind them and links to `/owner/staff`.
   Selecting it anyway is allowed; being surprised by it later is not (**D3**).

Guardrails, enforced in zod at the API and re-checked on save:

- 4–6 KPIs selected, blocked at 6
- weights total exactly 100 (cross-row, so it cannot be a CHECK — validate on save and ship a
  verification query that finds any org whose active set does not total 100)
- at least one `result` and one `activity` KPI, so the set cannot be all-activity and gameable
- "Changes apply from [date]" on the confirm step, writing `effective_from` and closing the
  previous rows' `effective_to`

### F5. G3 falls out

`calls_made` with a `daily` period *is* the daily call target. Once one exists for a subject,
`TodayProgress.pace` reads it and `paceSource` becomes `"target"` — and still says so (**D4**).

---

## Part G — Phase 3: the engine

### G1. `kpi_snapshot` — migration 0173

```
org_id, subject_kind ('telecaller'|'user'), subject_id, kpi_key, day,
numerator, denominator, target_value, weight_pct, direction, band_key, computed_at
UNIQUE (org_id, subject_kind, subject_id, kpi_key, day)
```

**Store numerator and denominator, not the rate.** A week is `Σnum ÷ Σden`; a week built from
stored daily rates is an average of averages, which weights a four-call Saturday the same as a
ninety-call Tuesday. This is the single most important column choice on the table.

Daily rows only. Weekly and monthly views derive on read.

### G2. Achievement, pro-rating, and the composite

- `achievement = (actual ÷ target)`, inverted to `(target ÷ actual)` for a `lower`-direction KPI,
  **capped at 1.2** so one enormous number cannot paper over a weak area (the original plan's
  §5 cap, kept).
- `null` when `denominator < minBase` (**D2**).
- **Pro-rating.** A monthly target read over an arbitrary window is scaled by
  `window_days ÷ period_days`, the same spirit as `periodElapsed`/`pace` in `targets.ts`, and
  the vocabulary on the page should match that page's: ahead of pace / on track / behind / at
  risk.
- **Composite.** `Σ(achievement × weight)` over the KPIs that answered, carrying
  `coverage = Σ weights that answered ÷ 100`. Suppressed below a coverage floor of 0.6, and
  **never** silently redistributed onto the KPIs that did answer — a score over 40% of the
  configured set is not the same object as a score over all of it, and quietly renormalising is
  how a dashboard reports 94% for a rep whose three measured KPIs were the easy ones.
- The composite is a score against *agreed targets*. It is not, and must not become, a blend of
  QA, sentiment and FCR (**D1**).

### G3. Where it computes

Extend the existing 15-minute `telecaller-stats` sweep rather than adding a second one; it
already recomputes today plus a lookback and already re-enters each org's RLS context. Resolve
config per day via F2's rule, which keeps recomputation idempotent across a target change.

### G4. What changes on the four screens

- **My performance** — the composite and its band at the top, the per-KPI progress bars against
  target, coverage stated beside the score. The existing "what to work on" panel stays as it is;
  it is coaching derived from signals, and it is not the score.
- **Team activity** — band chips per person, unchanged row scoping.
- **Command centre / staff scorecard** — sort by score, filter by band, drill-down unchanged.
- Every suppressed KPI keeps rendering as a dash with its reason, as today.

---

## Part H — Phase 4: what reads the spine

### H1. Alerts (G6) — migration 0174

Two notification kinds: `kpi_off_pace` (a subject below the lowest band for N consecutive days,
N configurable, default 3) and `kpi_target_missed` (a period closed below target).

- **Add the kind to the DB CHECK and to the zod enum in the same change.** The two lists have
  drifted in both directions before and the failure is a 23514 at runtime, in a sweep, where
  nobody is watching.
- **Recipients:** the person themself, and their manager/owners. The rep gets their own first —
  the original plan's §9 demotivation row, and the same ordering the console already follows.
- **Nothing sends outside the console by default.** A WhatsApp or email daily summary sits behind
  an owner-thrown switch, default off, consistent with every other outbound surface here.

### H2. Incentive slabs (G7) — migration 0175

`commission_tiers (plan_id, from_pct, to_pct, rate)` — a rate per attainment band, replacing the
single flat rate while keeping the plan a calculator (**D5**). The UI says, in words, that nothing
is accrued and nothing claws back.

### H3. Export (G10)

CSV for the scorecard and the staff table; PDF for the command centre, reusing the pdfkit path
`call-insights-pdf.ts` already proved — and remembering that its fonts need the `COPY` in the
Dockerfile or the deployed binary renders empty boxes. The general export engine (doc 35) is
still plan-only; do not block on it.

---

## Part I — Phase 5: human QA review (G5)

`call_reviews (org_id, call_id, reviewer_user_id, criteria jsonb, score, notes, created_at)`,
migration 0176, RLS on, plus a sampling rule — *n* calls per rep per week surfaced to the
reviewer rather than the reviewer hunting for them.

Two constraints:

- **Who may listen** is already governed by the call-access gate (0122). A review queue must go
  through it, not around it.
- **Human QA sits beside AI QA on the card and is never averaged with it** (**D1**). They
  disagreeing is the most useful thing this feature produces.

---

## Part J — What this plan deliberately does not do

- **Benchmarking against other tenants on the platform.** The original plan's Phase 3 lists it.
  It means computing one customer's numbers from other customers' data, and the only honest
  version is opt-in on both sides with a cohort large enough to anonymise. Not now, and not
  without an explicit decision.
- **Forecasting month-end attainment.** Cheap once Phase 3 exists (`actual ÷ periodElapsed`), and
  deliberately held back until there is a quarter of snapshot history to show it is not noise.
- **Lead-quality adjustment** — not penalising conversion when the lead list was poor. The data
  exists (`leads.temperature`, source, campaign) but "adjusted conversion rate" is a number
  nobody can audit in a review. The honest version is *comparison by source*, which Reports
  already does, rather than a corrected single figure.
- **Payroll.** See D5.
- **Any change to how the four quality signals are presented.** They are correct and they are
  the part of this surface least in need of help.

---

## Part K — Open questions, for you

Phase 1 depends on none of these. Phase 2 should not land until 1–3 are answered.

1. **Operator visibility (G9).** Should `/admin` show a tenant's per-person performance?
   *Recommendation: no — aggregate floor health only (size, calls per day, adoption), no named
   per-person quality.* 0122 already says an operator needs the client's approval to read call
   content, and a named quality score about a client's employee is not less sensitive than the
   call it came from. If you want it, it should hang off the same approval gate rather than off
   operator role alone.
2. **Who sets targets?** *Recommendation: owner writes, manager reads.* A manager setting the
   target they are measured against is the same conflict that keeps AI assistants owner-only.
3. **Leaderboard visibility to telecallers.** Today a rep cannot see colleagues at all.
   *Recommendation: an owner switch, default off, and when on, show the rep their rank without
   naming the people above them.*
4. **Cap at 120%** — confirm, or name another number.
5. **Band defaults 60 / 90** — confirm.
6. **Alert streak default of 3 days** — confirm.

---

## Part L — Verification each phase owes

Not optional, and each one has cost a round here before:

- Rebuild `packages/shared` (`npx tsc -p tsconfig.json`) before the API or web will see new
  exports; the errors otherwise look like the field does not exist.
- A new route means bumping four counts in `guard-mounting.spec.ts` and adding the controller to
  its hand-maintained list; a new nav entry means `ownerSectionOf`'s map or `owner-rail.test.ts`
  fails.
- Any new tenant table needs RLS, or `verify-rls` blocks the deploy.
- **SQL assembled from template literals typechecks without ever being valid.** Run every new
  statement against the ephemeral local Postgres with all migrations applied — extract the
  constants and substitute, as the 0144 queries had to be.
- A `name` collision across `export *` in `packages/shared/src/index.ts` is a build error; the
  catalog will want generic names like `direction` and `unit`.

---

## Part M — Progress

Written 2026-10-09 against `crm-phases-on-origin` at 061bfe2e.

### Phase 1 — partially built 2026-10-09. E2, E3 and E4 done; E1 not started.

**E4, per-period marketing spend (G8). Built.**

- **Migration 0171** `marketing_source_spend`, with RLS, the grant/revoke block and the
  `updated_at` trigger. **Month-grained, diverging from this doc's own `(period_start,
  period_end)`**: two overlapping periods double-count their overlap silently in a figure
  somebody moves a budget on, and the exclusion constraint that would prevent it needs
  `btree_gist`, which 0042 records this platform cannot assume it may create. A `month` column
  with a `date_trunc` CHECK and a unique key makes the overlap *unrepresentable* instead. It also
  matches the grain every ad platform and agency invoice reports in.
- **`PERFORMANCE_SQL`** gains `window_spend` (each month's spend pro-rated by the days of it that
  fall inside the reporting window) and `has_period_spend`. A campaign with any monthly spend
  reads on the period basis — including a legitimate **zero** for a window its months do not
  cover — and only a campaign with none falls back to the lifetime total.
- **`SpendBasis`** (`period` | `lifetime` | `none`) travels per campaign, because a workspace
  migrates one campaign at a time and a single header sentence would be wrong about half the
  table. A channel's basis is the *weakest* of its campaigns'.
- **Three routes** on `MarketingSourcesController`: `GET/PUT/DELETE .../spend`, the write pair
  gated owner/manager/marketing, matching create and update (doc 31 §2 X8).
- **Entry surface:** a Campaign spend panel on `/owner/lead-sources`, not on `/owner/performance`
  — that page is owner/manager only and the person who knows what an ad set cost usually is not.
  The panel renders nothing when the workspace has no campaigns, because campaigns still have no
  create surface in this console (a pre-existing doc-40-class gap, untouched here).
- The Performance page's fixed spend caveat is now conditional: per-row `*` markers and a sentence
  that counts how many campaigns are still on the lifetime figure.

**E3, disposition coverage (G4's measurable half). Built.**

- `disposition_coverage` CTE on the scorecard; `dispositionBase`/`dispositionLogged` on
  `AgentScorecard`; `dispositionCoverage()` in `@aura/shared` with four tests.
- **It is the one rate in that file with no sample floor**, deliberately: every other rate
  suppresses below `MIN_RATE_SAMPLE` because a thin base makes a *performance* claim unreliable,
  and this is a claim about the data, not the person. "2 of 3 calls have an outcome" is exactly as
  true and as actionable as 200 of 300 — and the quiet day is when a reader is most likely to be
  misled by FCR.
- Rendered inside the first-call-resolution tile, in **both** branches including "not set up",
  rather than as a fifth tile in a four-column grid.
- Its numerator deliberately does *not* join `call_dispositions`, unlike the FCR CTE: a retired
  outcome still proves the human did the work.

**E2, the outcome-needed queue. Built.**

- `outcome=needed|logged` on `GET /owner/calls`, and an "Any outcome" control on the call log with
  its own removable filter tag.
- `needed` is `disposition_key IS NULL AND duration_s > 0` — the **same population** E3's coverage
  percentage is computed over, so the queue's length and the rep's percentage are answers about
  the same calls.

**E1, the handset prompt. Not started.** It needs a device-auth route to file a disposition, the
org's vocabulary reaching the handset (likely on `GET /devices/me/config`), Kotlin work reusing
0150's `AlertActivity`/`AlertNotifications`, and an APK release. 1.2.1/11 is built and unpublished;
this rides that release or the next, and publishing is a decision, not a build step.

### Verified against a real database — 2026-10-09

Docker's engine had been answering every call with a 500; restarting Docker Desktop fixed it, and
the whole verification ran on the ephemeral `docker-compose.test.yml` stack (tmpfs, port 55432,
torn down with `down -v` afterwards).

- **All 168 migrations apply from zero**, 0001 through 0166 plus 0170 and 0171.
- **`verify:rls` found a real defect, and it was the second axis, not the first.**
  `marketing_source_spend` had `org_isolation` and no **`partner_wall`** — so a channel partner
  signed into the portal could read what the business pays per month to acquire the leads they are
  quoting against. `org_isolation` does not stop that: a partner principal is *inside* the org,
  and the whole point of 0163 is that being in the tenant is not the same as being staff. 0163's
  enumeration can only wall tables that existed when it ran, so every table created afterwards
  must carry its own wall (0165 and 0166 both do). Fixed in 0171 — the migration was still
  untracked, so the stack was dropped and re-run from zero rather than patched forward. **RLS
  verification then passed in full, structural and behavioural.**
- **Both changed statements execute.** `PERFORMANCE_SQL` returns 1 row / 7 columns and
  `SCORECARD_SQL` 0 rows / 14 columns against a database with no data — which is the point: a
  statement assembled from a dozen sibling template literals typechecks whatever it says, so it
  has to be lifted out and run. The runner lives in the session scratchpad: it cuts each
  controller at its `@Controller` line, transpiles the prefix, and evaluates it against the real
  `@aura/shared` so `leadHeldByParam(3, "l")` is the predicate that actually ships.
- **The arithmetic is right, proved on seeded rows** (one transaction, rolled back):
  - a mid-month date is rejected by the `date_trunc` CHECK; the same campaign-month twice is
    rejected by the unique key; `0` is accepted and `-1` is not;
  - 30,000 of September spend over the window 5–12 Sep reads **exactly 8,000** (8 of 30 days);
  - a campaign with no monthly rows keeps its lifetime total and is labelled `lifetime`;
  - **a November window over a campaign whose only months are August and September reads 0 on the
    `period` basis, not its lifetime total** — the fallback cannot come back by narrowing the date
    range, which was the one way this design could have gone quietly wrong;
  - coverage counts 4 connected calls, 2 classified, with the ring-out in neither half, and the
    `outcome=needed|logged` filter returns 2 and 2 — the queue and the percentage agree because
    they share the predicate.
- `supabase/migrations` re-synced (`sync-supabase-migrations.js`, then `--check` clean).
- Also run and passing: `tsc` on shared, API and web; `guard-mounting.spec.ts` (counts bumped
  611→614, 507→510, 552→555, and the two stale test titles corrected); all 10 API owner-module
  suites; the shared scorecard and performance suites; all 63 web suites (1165 tests); eslint on
  every touched file.
- Not run: the tenant-isolation suite, which is opt-in and was already failing 29 tests on
  fixture drift before this work.
- One trap re-paid for the record: **backticks inside a SQL template literal terminate it.** Two
  prose backticks in the new CTE's comment produced five TS1005s in a 500-line file.
