# 44 · The owner dashboard, end to end

How `/owner` — the console's landing page, the one every tenant sees after
login — is actually built: the route, where its numbers come from, how it
composes itself per persona, and every panel and chart on it.

Written for an engineer who has to change this page and has not read it before.
It describes the code as it stands on `crm-phases-on-origin`, 2026-10-12. The
design arguments behind it live in `29_CRM_DASHBOARD_VISUALISATION_REDESIGN.md`
(charts) and `30_ORG_TIME_STANDARD_AND_TIMEZONE_PICKER.md` (clocks); this
document is the map, not the rationale.

> **PARTLY SUPERSEDED, 2026-10-12.** `/owner` was rebuilt to the CEO analytics
> layout later the same day. **§2.1 (five hand-written persona compositions),
> §3 (the page top to bottom) and §4 (the seven charts) no longer describe the
> code** — read `46_CEO_ANALYTICS_DASHBOARD.md` for those.
>
> Everything else here is still current and doc 46 does not repeat it: §1 (where
> things live, allowing for the new `_dashboard/ceo/` directory), §2.2 (scope is
> applied in SQL and rendering is never the control), §2.3 (the fetch), §2.4
> (the API-only redirect and why it sits above every other await), §2.5 (every
> figure names its clock), §5 (the non-chart panels), §6 (the colour rules), §7
> (the header) and §8 (the loader and its test). §9's checklist still applies in
> full; doc 46 §6 adds four items to it.

---

## 1. Where everything lives

| Path | What it is |
| --- | --- |
| `platform/apps/web/app/(owner)/owner/page.tsx` | The route. 799 lines: one data fetch, five persona compositions. |
| `platform/apps/web/app/(owner)/owner/loading.tsx` | Its skeleton, shaped like the OWNER composition at its fullest. |
| `platform/apps/web/app/(owner)/owner/_dashboard/` | The seven chart files. Server-rendered, no chart library. |
| `platform/apps/web/app/(owner)/owner/dashboard-panels.tsx` | The non-chart panels (window picker, call outcomes, tables, activity). |
| `platform/apps/web/app/(owner)/owner/next-actions.tsx` | The only client component on the page. |
| `platform/apps/web/app/(owner)/owner/team-rollup.tsx` | Per-person roll-up, owners and managers only. |
| `platform/apps/web/app/(owner)/owner/types.ts` | The `Overview` payload contract (line 503). |
| `platform/apps/web/lib/dashboard-charts.ts` | Every number the charts need: axes, deltas, bucketing, insight sentences. |
| `platform/apps/web/lib/date-range.ts` | The shared window control, used by every report screen too. |
| `platform/apps/api/src/modules/owner/owner.controller.ts` | `GET /v1/owner/overview` (line 543) and `GET /v1/owner/crm-overview` (line 800). |

Three other pages are also called "dashboard" and are **not** this one:
`/owner/kpi` (the API-only tier's landing page, migration 0192),
`(platform)/dashboard` (the operator's fleet view), and the report builder's
`(dashboard)` route group. Nothing in this document applies to them.

---

## 2. How the page is built

### 2.1 One route, five dashboards

`/owner` is a single route that composes itself from the reader's persona. Five
components, same props, picked at the bottom of the default export:

```
role === "telecaller" → <TelecallerDashboard />   one person's desk
role === "sales"      → <SalesDashboard />        one person's pipeline, in money
role === "marketing"  → <MarketingDashboard />    demand by channel
role === "manager"    → <ManagerDashboard />      the floor, people first
role === "owner"      → <OwnerDashboard />        the business, money first
```

It is one route and not five because `/owner` is where the layout sends everyone
after login and it is the sidebar's href. Splitting it would mean the console's
most-linked URL had to resolve a persona before it could route, and a bookmarked
`/owner/manager` would strand a demoted manager.

### 2.2 The data is already narrowed — rendering is never the control

Nothing in `page.tsx` filters anything. `/v1/owner/overview` applies the
persona's record scope **in SQL** (`owner-scope.ts`), so a telecaller's payload
contains only their own leads and calls before it reaches the web app. What
varies per persona is which numbers are worth showing and what they are called.

This matters when you change the page: a bug here shows someone their own
numbers under the wrong heading. It cannot show them someone else's data. Keep
it that way — a panel that filtered by role would be a second, weaker copy of
the authorization rules, and the weaker copy is the one that drifts.

### 2.3 The fetch

Two calls, in parallel:

```ts
const [result, team] = await Promise.all([
  ownerTry<Overview>(crmPrimary ? "/v1/owner/crm-overview?…" : "/v1/owner/overview?…"),
  wantsTeam ? ownerGet<TeamRollupData>("/v1/reports/team?…") : null,
]);
```

- `crmPrimary` is the shadow-read flag (`lib/crm-cutover.ts`). Both endpoints
  return the **same `Overview` shape**; only the tables underneath fork.
- `wantsTeam` is owner or manager. A rep never asks: the API would refuse an
  `owned` caller outright, so asking would spend a round trip to render nothing.
- Parallel, not sequential — the page already costs one Mumbai→Seoul round trip
  and a second in series is felt (see `prod-latency` notes).
- On the API side, all seven aggregates go out as **one multi-statement round
  trip**. The window is interpolated, not bound, because that protocol takes no
  bind parameters; `WindowQuery` has already pinned it to an integer day count
  or two calendar dates.

### 2.4 The redirect that happens before any of it

A tenant on the API-only tier (migration 0192) writes no leads, deals or
recorded calls — their facts arrive over `/v1/ingest`. This page would greet
them with "Open leads 0 · Pipeline value 0 · Calls 0". So:

```ts
if (owner && !makesLeads && hasInsights) redirect("/owner/kpi");
```

It sits directly under `getOwner()` and **above every other await**. Moving it
further down throws "Rendered more hooks than during the previous render" on the
client transition — the router has already begun reconciling this page's tree by
then. (This is the same Next 15.5.20 redirect/hooks interaction noted elsewhere
in the repo.)

### 2.5 Every figure names its clock

A tile is either **now** (open leads, pipeline value, overdue follow-ups) or
**in the window** (calls, new leads, closes). The window is the last N calendar
days in the workspace's zone, today included, or a From/To pair — resolved by
the API in the org's own calendar and echoed back in `data.window`.

The page reads the zone from the echo, never computes it:

```ts
const zone = resolveTimeZone(data.window.timezone ?? owner?.membership.reportingTimezone);
const days = data.window.days ?? …;
```

A custom range words itself as its own dates (`windowLabel`), because "last 30
days" over 1–30 June would be untrue by July. A one-day preset says "today", not
"1d".

---

## 3. The page, top to bottom

Shared by every persona, in this order:

1. `<PageHeader>` — as of 2026-10-12 this renders nothing unless the page passes
   a description or actions. See §7.
2. `<JoinedNotice>` — only on the one render after accepting an invite (`?joined=1`).
3. `<WindowPicker>` — the date control and the zone line.
4. `<DateRangeNotice>` — only when the query string was invalid.
5. The persona composition.

Then, per persona:

| Band | Owner | Manager | Telecaller | Sales | Marketing |
| --- | --- | --- | --- | --- | --- |
| KPI row (4 × `StatCard`) | Open deals · Pipeline value · Won · Calls | Open deals · Team on the phone · Win rate · Overdue | Open leads · Calls · Follow-ups · Won | Pipeline · Won value · Win rate · Follow-ups | New leads · Win rate · Revenue won · Open pipeline |
| Next actions | ✓ team | ✓ team | ✓ mine | ✓ mine | ✓ mine |
| Team roll-up | ✓ | ✓ (leads the page) | — | — | — |
| Trend chart | ✓ | ✓ | ✓ | demand only | arrivals only |
| Missed heatmap | ✓ | ✓ | ✓ | — | — |
| Call outcomes | ✓ | ✓ | ✓ | — | — |
| Pipeline health | ✓ | ✓ | ✓ (no value) | ✓ | ✓ |
| Lead aging + response speed | ✓ | ✓ (response first) | aging only | aging only | response only |
| Source effectiveness | — | — | — | — | ✓ (leads the page) |
| Campaign table | — | — | — | — | ✓ |
| Telecaller table | ✓ | ✓ | — | — | — |
| Recent activity | ✓ | ✓ | ✓ | ✓ | ✓ |

The differences are **order and emphasis, not access**. A manager sees every
record an owner does; their scope is `all`. What changes is that people come
first and the KPI row swaps pipeline value — a number a manager does not control
— for overdue follow-ups, which they can do something about this afternoon.

Two deliberate omissions worth not "fixing":

- **No rupee value anywhere on the telecaller page.** They are measured on
  activity and conversion; a money total invites working the biggest card rather
  than the next one, and the value of a lead they were handed is not a number
  they set. `<PipelineHealth showValue={false}>` enforces it.
- **No talk time on the sales page.** A rep is measured on value, so their trend
  draws demand only (`showCalls={false}`).

---

## 4. The charts

All seven are **server-rendered HTML and CSS. No chart library, no client
JavaScript.** Hover is `group-hover`, so a chart paints complete in the server
HTML and never pops in after hydration. Every chart carries a collapsed
`<details>` **table twin** with the same numbers and the same links — the plot
itself is `aria-hidden`, so keyboard and screen-reader readers get the table
instead of ninety tab stops across a plot.

### 4.1 `trend-chart.tsx` — calls and new leads

Two plots on one shared time axis. Plot A is calls per day, stacked by state;
plot B is new leads per day as ink columns, plus a trailing 7-day mean drawn as
a non-scaling-stroke SVG polyline.

- **Two plots, not one.** Calls outnumber new leads 5–20×, so on one scale the
  leads were slivers; a second y-axis would invent a correlation.
- **The stack order `answered → outgoing → missed` is a correctness rule, not a
  preference.** Missed stacked directly on answered puts red against green and
  fails deuteranopia (ΔE 5.0); with outgoing between them the worst adjacent
  pair is ΔE 29.9. Missed on top also puts the number an owner scans for at the
  silhouette's edge.
- The 7-day mean only appears with ≥14 days of window — a "7-day average" over
  three days is a different claim.
- Every calendar day gets a column, zeros included (the API gap-fills in the
  org's zone), so a quiet week reads as quiet.
- Plot heights are **px literals** (160 / 20 / 96) because gridlines are laid
  across every column at fixed offsets and must land exactly on each baseline.

### 4.2 `missed-heatmap.tsx` — when inbound calls go unanswered

Weekday × hour, coloured by the missed **count**.

- "We miss calls" is not actionable; "we miss calls on Tuesdays between one and
  two" is a staffing decision.
- **Colour is a count, not a rate.** A rate makes one-of-one at 07:00 the
  darkest cell on the grid. The rate and its base are in the tooltip and table.
- **Three states that must look different**: no inbound calls (outlined empty
  cell), inbound but none missed (neutral grey — the phones rang and we
  answered), and missed (the ramp). Collapsing the first two makes a closed
  office look like a perfect one.
- Hours are the workspace's hours. In UTC an Indian lunch hour draws at 07:30.

### 4.3 `pipeline-health.tsx` — where the pipeline is, and how long it has been there

One horizontal bar per stage: **length is the open count, segments are time in
the current stage** on a 5-step grey ramp.

- The bar this replaced showed only where records are, so a 142-lead "New"
  column looked healthy while 31 of them were a month old.
- **Not a funnel.** Stage counts are a snapshot; stage-to-stage conversion needs
  the transition ledger, which leads have only had since 2026-09-21. The honest
  cohort funnel is on Reports.
- **Grey, because age is an ordered magnitude, not a state.** Amber and red are
  spoken for. The 30+ bucket also gets words and the stale hourglass, so the
  message never rests on shade alone.

### 4.4 `lead-aging.tsx` — open leads by age

Five ordered columns (the aging report's own buckets), each split into the part
nobody has **ever** answered (ink, on the baseline) and the part somebody has
(de-emphasis grey, on top). The emphasis form rather than two hues: the
untouched population is the one a person can act on this afternoon, and painting
both halves would make them equally loud.

Not windowed — the whole point of the 30+ column is the leads that fell out of
the reporting window months ago and are still waiting.

### 4.5 `response-speed.tsx` — speed to first response

A hero percentage ("what share did we answer inside our own SLA", computed
exactly on the server from minutes, not from buckets), then horizontal bars that
explain it. Buckets wholly inside the SLA are ink, the rest grey, with a rule
between them. A bucket the SLA falls *inside* (45 min sits in 30–60) is drawn a
middle grey and captioned rather than guessed. "No response yet" sits apart
after a gap — it is open work, not the slowest bucket.

### 4.6 `source-effectiveness.tsx` — which channel is worth the money

One row per channel carrying three readings: leads as a bar, conversion as a
**dot** on a fixed 0–100% track, won value as text.

- Not a scatter (labels collide), not a bar-plus-rate-line (a second y-axis
  invents a correlation).
- A dot because a rate is a *position* on a fixed scale against a reference tick
  (the all-channel rate); a bar would read as a quantity piled up.
- Under five leads the dot is hollow and the rate prints as "2 of 3". A
  confident percentage over a thin base is how a channel that produced nothing
  keeps its budget.
- It says **"won so far"**, never "converted": won ÷ *arrived* in the window, a
  cohort still mostly open. The KPI row's win rate is won ÷ *closed*. Two
  figures both called "converted", 9% and 63%, would read as a contradiction.

### 4.7 `chart-parts.tsx` — the shared primitives

`TOOLTIP` / `TOOLTIP_BOX`, `edgeAlign` (tooltips near an edge open inward so
they never leave the card), `AXIS_TEXT`, `StateKey` and `SwatchKey` (a legend
swatch is a 2px-corner **square**, not the theme's rounded-sm, which would turn
a 10px swatch into a dot and read as a second glyph), `DeltaNote`, `ChartTable`,
the `TH`/`TD` cell classes, and `Insight` — the one plain sentence under each
chart that says what it shows.

---

## 5. The non-chart panels

| Component | File | What it is |
| --- | --- | --- |
| `WindowPicker` | `dashboard-panels.tsx` | 7/30/90-day presets or a From/To range, plus the dates and zone in words. Owners and managers get the zone-change link. It prints the dates the **API echoed**, never dates computed locally, so the label cannot disagree with the numbers under it. |
| `CallOutcomes` | `dashboard-panels.tsx` | Answered / outgoing / missed as figures plus one 100% bar in the trend chart's state order. The missed share is **of inbound** — on a mostly-outbound floor, "2% of all calls" hid a 20% miss rate on the phones that rang. Failed calls are a sentence below, not a fourth figure: an operational problem for us, not a business outcome for the reader. |
| `TelecallerTable` | `dashboard-panels.tsx` | Per-person performance as a real table — people are more than seven categories with exact values to compare — with a thin ink bar under each call count scaled to the busiest person. |
| `RecentActivity` | `dashboard-panels.tsx` | The latest records, each a link into the board or lead. |
| `CampaignTable` | `dashboard-panels.tsx` | Top 8 campaigns by lead count (marketing only). |
| `EmptyPipeline` | `dashboard-panels.tsx` | The empty state. Leads only appear once a call's extraction qualifies, so an empty pipeline is usually a setup gap, not a quiet week — it says which. |
| `CHANNEL_LABELS` | `dashboard-panels.tsx` | `meta_ads` → "Meta Lead Ads". An unknown key falls through to the raw value, so a channel added to the enum and forgotten here looks untidy rather than invisible. |
| `NextActions` | `next-actions.tsx` | **The only client component.** Follow-ups in work order, with Done / Log call / Log message on the row. Mine/Team flip and realtime refresh both re-query from the client. Overdue and today use the *workspace's* calendar, so this card and the numbers beside it agree for someone travelling. |
| `TeamRollup` | `team-rollup.tsx` | Per-person cards (not a table — a manager checking the floor is very often on a phone). People with nothing are folded into a `<details>`, counted rather than dropped. |

---

## 6. Colour rules you can break by accident

From `packages/ui/src/state.tsx` and `theme.css`:

- **Four console states**, each with a hue *and* a glyph, never colour alone:
  `missed` (danger + slashed ring), `answered` (success + filled disc),
  `outgoing` (its own blue + leaving arrow), `error` (orange + triangle).
- **Red means missed, not error.** Errors are orange. A chart that paints a
  failure red is saying "a customer was not picked up".
- `outgoing`, not `accent` — the accent is brandable and a data hue is not.
- **Sequential ramps**: `chart-seq-1..5` (grey, text mixed into surface at
  34/50/66/82/100%) for ordered magnitudes like age; `chart-missed-1..4` (the
  missed hue as a magnitude) for the heatmap only.
- Ramp class names are written out as **literals** in each file. Tailwind v4
  only generates CSS for class names it can see statically in source, so a
  computed `bg-chart-seq-${n}` silently produces no colour.

---

## 7. The header, as of 2026-10-12

`<PageHeader>` used to draw a bordered card with a gradient wash, an uppercase
eyebrow and a 3xl/4xl title — about 96px plus a layout gap on all 236 pages that
render it, restating a name the rail, the section tabs and the breadcrumb were
already showing. It now renders **nothing** unless the page passes a
`description` or `actions`, and `PageHeaderSkeleton` renders nothing either.

`title` and `context` are still accepted and ignored on purpose: `app/console-loading.test.ts`
reads those literals out of the source to check loader↔page and nav↔page parity,
and the phone's top bar titles itself from the matching nav entry. The dashboard
still passes `title={data.org.name}` and `context={HEADER_CONTEXT[role]}`.

---

## 8. The loader, and the test that keeps it honest

`app/(owner)/owner/loading.tsx` mirrors the OWNER composition at its fullest —
the date control and its date line, the KPI band, the trend card **at its real
plot heights**, the heatmap beside call outcomes, pipeline rows, aging beside
response, the telecaller table, the recent list. Next actions is deliberately
left out: it is a client panel that fetches after the page is up and draws its
own inline loader.

`app/console-loading.test.ts` (133 cases) enforces four properties across every
console route, and it is the file you will trip over:

1. **Coverage** — every `page.tsx` in a console route group has its own
   `loading.tsx`, or is listed in `NO_LOADER` with a reason. Next applies the
   nearest ancestor loader otherwise, silently.
2. **Header parity** — a loader whose page renders a literal `<PageHeader>` must
   render the same one.
3. **Nav parity** — a nav entry's `title`/`context` must be what the page renders.
4. **Shape** — each loader renders, draws skeleton blocks, is a fragment at its
   root (the layout's `<main>` spaces direct children with `space-y-*`), and
   does not announce itself (Next's route announcer already does).

Property 4 used to count rendered top-level elements, which worked only because
every loader drew a header as a guaranteed second element. Since the header
block renders nothing it checks the loader's **source root** for a fragment
instead, following the two `export { default } from …` re-export stubs.

---

## 9. Adding something to this page

1. **Add the number to the API first.** `overview()` and `crmOverview()` must
   return the same shape — the page cannot tell them apart and neither should
   your panel. Add it to the one multi-statement batch; do not add a round trip.
2. **Scope it in SQL**, with `ownerScopeAnd(...)`, not in the component.
3. **Declare it in `types.ts`** as optional if an older API might not send it,
   and use `null` to mean "this view cannot answer that" — the `triage: null`
   contract on the CRM read is the precedent. Zeros mean "none", which is a
   different and sometimes untrue claim.
4. **Put the maths in `lib/dashboard-charts.ts`**, not in JSX. That file is unit
   tested; a component is not.
5. **Say which clock it is on** — "now", or the window — in the tile context or
   the panel subtitle.
6. **Give a chart a table twin and an `<Insight>` sentence.**
7. **Decide which personas get it**, and put it in the band that answers the
   question the band above it raises.
8. Update `loading.tsx` to match the new geometry, then run
   `npx vitest run app/console-loading.test.ts`.
