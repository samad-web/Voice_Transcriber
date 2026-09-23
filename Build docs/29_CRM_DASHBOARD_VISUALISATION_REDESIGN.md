# 29 — CRM dashboard: visualisation redesign

**Written for:** the engineer or Claude Code session building, reviewing or extending the owner-console dashboard in `platform/`, and the product owner deciding whether the design is right.
**Status:** BUILT 2026-09-22 and verified locally (§13). §1–§9 is the design. §10–§12 is how it was built and what was rejected. §13 is what the build actually did, including where it departed from this plan. Uncommitted and undeployed.
**Depends on:** doc 30 (the org time standard). Every day and hour on this dashboard is a day or hour in the workspace's own time zone, and doc 30 is what makes that true.
**Companion docs:** 22 (design system), 24 (UI consistency), `report_builder_design.md` (why the console draws charts without a chart library).

**Short path prefixes used below:**

| Prefix | Path |
|---|---|
| `W` | `platform/apps/web/app/(owner)/owner/` |
| `web/` | `platform/apps/web/` |
| `api/` | `platform/apps/api/src/modules/` |
| `ui/` | `platform/packages/ui/src/` |

Line numbers were read on 2026-09-22 from a busy working tree. Re-read a file before you edit it.

---

## 0. Context

### 0.1 What was asked

> Redesign the main CRM dashboard by replacing the existing inadequate charts with advanced, highly detailed data visualizations that accurately reflect current system metrics and highlight actionable business insights. Include a comprehensive implementation plan that details the specific UI/UX design choices for the new dashboard components, providing clear rationales for selecting each chart type.

"The main CRM dashboard" is `/owner` (`W/page.tsx`). Everyone lands there after sign-in. It renders one of five persona compositions (owner, manager, telecaller, sales, marketing) from shared panels in `W/dashboard-panels.tsx`, all fed by one API call: `GET /v1/owner/overview`, or `/v1/owner/crm-overview` behind the shadow-read flag.

### 0.2 What the dashboard drew before this change

| Panel | Form | File |
|---|---|---|
| KPI row | 4 `StatCard`s on the orange KPI band | `W/page.tsx:203-237` (owner), one row per persona |
| Call outcomes | 3 figures: missed / answered / outgoing | `W/dashboard-panels.tsx:195-278` |
| Activity | Paired grey columns, calls beside leads, one per day | `W/dashboard-panels.tsx:291-397` |
| Pipeline by stage | One horizontal bar per stage | `W/dashboard-panels.tsx:96-167` |
| Where leads came from | One accent bar per channel | `W/dashboard-panels.tsx:550-607` |
| Tables | Telecaller performance, campaigns, recent activity | `W/dashboard-panels.tsx` |

### 0.3 The audit: what was wrong

Two kinds of problem. Accuracy defects make a number wrong or mislabelled. Adequacy gaps leave out the question an owner opens the page to answer.

**Accuracy defects**

| # | Defect | Evidence | Consequence |
|---|---|---|---|
| A1 | Days are UTC days | `api/owner/owner.controller.ts:331-337`: `date_trunc('day', started_at)` on a UTC database | Everything from 00:00 to 05:29 IST lands on the previous day's column: 5½ hours of every Indian working day filed under the wrong date. |
| A2 | Empty days vanish | The API omits zero days ("the client fills the gap", `:328-330`). `ActivityChart` maps `byDay` straight onto columns and never fills them. | A 30-day window with 12 active days draws 12 equal columns labelled only by day of month. A quiet week disappears instead of reading as quiet. |
| A3 | Two magnitudes on one axis | `ActivityChart`: `maxDay = max(calls, leads)` (`dashboard-panels.tsx:302`) | Calls outnumber leads 5–20×, so the lead bars are 2–8px slivers. The chart cannot show the one trend a marketer reads it for. |
| A4 | All-time figures under a window control | "Won", win rate and won value count `status = 'won'` with no date filter (`owner.controller.ts:222-229`), directly under a "Window: 30 days" picker | The Sales dashboard prints "N closed in this window" over an all-time count (`W/page.tsx:446`). That is a false statement, not only an ambiguous one. |
| A5 | Day labels in the wrong clock | `date.toLocaleDateString(undefined, …)` (`dashboard-panels.tsx:360`) | The server renders in its own zone and the browser in the viewer's. That causes a hydration mismatch, and the labels can name a different day from the org's reports. |
| A6 | Missed-call share against the wrong base | "N% of total" (`dashboard-panels.tsx:257`) | Missed is a property of *inbound* calls. On a floor that is 80% outbound, 10 missed of 50 inbound (20%) reads as "2% of 500". |

**Adequacy gaps**

| # | Gap | Why it matters |
|---|---|---|
| G1 | The triage block (open-lead aging + never-responded) is computed on every load (`owner.controller.ts:357`) and **rendered nowhere** | The API's own comment says the dashboard is where a suspicion is created. The numbers existed and nobody could see them. |
| G2 | No time-of-day view of missed calls | "We miss calls" is not actionable. "We miss calls on Tuesdays between 1 and 2 pm" is a staffing decision. |
| G3 | Pipeline shows where leads *are*, never how long they have *been* there | The stuck deal is the actionable one, and a snapshot bar hides it. |
| G4 | No comparison anywhere | "64 missed calls" has no reference. Up or down on last month is the first question. |
| G5 | Response speed against the org's own SLA (0109 `response_sla_minutes`) is not on the dashboard | It is the single strongest predictor of conversion on an inbound floor, and the org already chose a target. |
| G6 | Source bars painted `bg-accent` (`dashboard-panels.tsx:596`) | Accent is brandable and blue means "outgoing". This violates the dashboard's own colour rule (its comments at `:149-154` and `:336-339` explain why every other bar went grey). |
| G7 | Per-telecaller missed calls not shown | A manager needs to know who is missing calls, not only how many the floor missed. |

---

## 1. Design principles (apply to every panel)

**P1. Every figure names its clock.** A figure is one of three kinds:
- **now:** open leads, pipeline value, aging
- **in the window:** calls, new leads, closes, response speed
- **all time:** used nowhere on the new page

The tile's context line or the panel's subtitle says which. The window is **the last N calendar days in the workspace's time zone, today included**, and the filter row prints its dates ("24 Aug – 22 Sep"). This is the same definition the Reports page and every list filter use, so a drill-down link reproduces the number it came from. The old rolling `now() - N days` window could not be reproduced by any list filter.

**P2. Colour means state; everything else is grey.** This is inherited unchanged from `ui/state.tsx` and enforced by `web/app/console-palette.test.ts`. Red = missed call, green = answered, blue = outgoing, orange = error. The consequences for charts:
- Call data wears the state hues and nothing else does.
- Magnitude and order use a **grey ordinal ramp** (§4.2).
- The one heatmap about missed calls uses a **ramp of the missed hue itself** (§4.3), because the cell's hue *is* its meaning.
- Deltas are **never green for up and red for down**, because those hues already mean answered and missed. A delta is a glyph (▲ ▼ –) plus signed words.

**P3. One y-axis per plot.** Two quantities of different magnitude (calls vs leads) are drawn as **small multiples that share the x-axis**, never on a shared scale and never with a second y-axis.

**P4. Every mark opens the list it counted.** A bar or row links to the list page, filtered by the same predicate the SQL used. This rule is inherited from the Reports dashboard (`web/lib/report-dashboard.ts:1-16`). A mark with no list filter that can reproduce it (the heatmap's hour cells) is hover-and-table only, and says so.

**P5. Tooltips enhance and never gate.** Every chart has a **"Show as table"** twin in a `<details>`, and the plot is `aria-hidden`. A keyboard or screen-reader user reads the table. Nobody has to tab through 90 columns.

**P6. Server-rendered, no chart library.** Charts are HTML/CSS marks (plus one SVG polyline) inside Server Components. Why not Recharts, which is already a dependency:
- **No pop-in.** Recharts' `ResponsiveContainer` must measure its parent before it draws, so server HTML holds an empty box and the chart appears after hydration. That breaks the route loader's measured geometry (`loading-skeletons` rule) and flashes on every navigation.
- **Tokens, not hexes.** Marks use the same Tailwind token classes as the rest of the console. Dark mode and tenant branding therefore apply with no chart-specific theming, and the palette guard test can scan them.
- **Zero JavaScript.** Hover is CSS (`group-hover`), consistent with `W/reports/daily-leads-chart.tsx`, which this generalises.
- **Precise mark specs.** 2px surface gaps, 4px rounded data ends and ≤24px bars are one class each here, but a fight with a library's defaults.

**P7. The insight is written down.** Each trend panel ends with one plain sentence naming the extreme ("Most missed: Tue 16 Sep, 12 calls"). The chart shows the shape and the sentence tells a reader who glances what to do.

**P8. Honest small numbers.**
- A rate prints its base ("64% of 25").
- A rate over fewer than 5 cases prints the counts instead ("3 of 4").
- "Nothing closed" never becomes "0%" (the existing `winRate` rule).

**P9. Empty states say what to do.** Each panel has a zero state that names the setup step behind it, as `EmptyPipeline` already does.

---

## 2. Information architecture

### 2.1 The owner's page, top to bottom (lg ≥ 1024px)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Window [7 days][30 days][90 days]  24 Aug – 22 Sep · IST, UTC+05:30  Change │  filter row
├────────────┬────────────┬────────────┬───────────────────────────────────┤
│ Open leads │ Pipeline   │ Won        │ Calls                             │  KPI band
│ 282        │ 48.2L      │ 12 · 8.4L  │ 1,204        ⊘ 64 missed          │  (orange)
│ 41 new · ▲ │ now · 282  │ ▲ 3 vs prev│ ▼ 4% vs previous 30 days          │
├────────────┴────────────┴────────────┴───────────────────────────────────┤
│ Next actions (unchanged)                                                  │
├──────────────────────────────────────────────────────────────────────────┤
│ CALLS AND NEW LEADS                    1,204 calls · 13% of inbound missed │
│  ■ Answered ■ Outgoing ■ Missed                                           │
│  [stacked state columns, one per day, 160px]                              │  small multiple A
│  [new-lead columns + 7-day average line, 96px]                            │  small multiple B
│  24 Aug            7 Sep             22 Sep                               │
│  Busiest: Tue 16 Sep, 84 calls · Most missed: Mon 15 Sep, 12  ▸ table     │
├──────────────────────────────────┬───────────────────────────────────────┤
│ WHEN INBOUND CALLS GO UNANSWERED │ CALL OUTCOMES                         │
│ weekday × hour heatmap (missed)  │ 3 figures + 100% bar + missed-rate Δ  │
├──────────────────────────────────┴───────────────────────────────────────┤
│ PIPELINE HEALTH  open leads by stage, shaded by time in stage            │
│ New         142 · 12L  [▒▒▒▓▓▓████████████]  31 over 30 days             │
│ Contacted    61 · 9L   [▒▒▓▓██]                                          │
│ Closed in the window: 12 won (8.4L) · 5 lost                             │
├──────────────────────────────────┬───────────────────────────────────────┤
│ OPEN LEADS BY AGE                │ SPEED TO FIRST RESPONSE               │
│ never-responded emphasised       │ buckets vs the org's SLA              │
├──────────────────────────────────┴───────────────────────────────────────┤
│ Team roll-up (unchanged) · Telecaller performance (+missed, inline bars)  │
│ Latest activity (unchanged)                                               │
└──────────────────────────────────────────────────────────────────────────┘
```

**Why this order:**
- Money first for an owner: the KPI band.
- Then *what to do today* (Next actions). This is unchanged from Phase 4 and is why the panel sits above every chart.
- Then *what happened* (the trend).
- Then *where it went wrong* (missed hours, stuck stages, unanswered leads).
- Then *who* (team).

Each band answers a question the band above it raises.

### 2.2 Per persona

The API already scopes every figure (`owner-scope.ts`). Personas choose *which* panels to show, never *whose* data.

| Persona | Order after the KPI row + Next actions | Left out, and why |
|---|---|---|
| Owner | trend · heatmap + outcomes · pipeline health · aging + response · team · recent | none |
| Manager | team roll-up · telecaller table · response + aging · trend · heatmap + outcomes · pipeline health · recent | none. The manager's question is "who needs help", so people come first (Phase 8 rule). |
| Telecaller | pipeline health · trend · heatmap + outcomes · aging · recent | **Response speed:** the SLA is a floor target a manager manages, and one person's median is noise at their volume. **Money:** Phase-1 rule, no rupee totals on an activity-measured desk. |
| Sales | pipeline health · new-leads trend (plot B only) · aging · recent | **Call-state plots:** a rep is measured on value, not talk (existing composition rule). |
| Marketing | source effectiveness · arrivals trend (plot B) + response speed · campaigns · pipeline health + recent | **Heatmap, call outcomes:** marketing has no call-transcript object (`roles.ts`) and does not staff phones. |

**The CRM read** (`crm-overview`, deals) has no `first_responded_at`, so `triage` and `response` arrive as `null`. Those panels do not render. They must not draw zeros that mean "cannot answer" as if they meant "none" (the existing `triage: null` contract, `owner.controller.ts:636-643`).

---

## 3. The components

Each subsection answers four questions: what question the panel answers, why this form and not the alternatives, exactly how it is encoded, and how it is operated.

### 3.1 Filter row: window and time zone

- **Form:** the existing `WindowPicker` pills (7 / 30 / 90), then the window's resolved dates and the zone: "24 Aug – 22 Sep · IST (UTC+05:30)". Owners and managers also get a **Change** link to `/owner/account/time`.
- **Why:** the dataviz rule is one filter row, above everything it scopes, with the date range first.
- **Why print the dates and the zone:** P1. "30 days" is ambiguous about today and about whose midnight. Printing both removes the argument before it starts.
- **Behaviour:** a pill is a link (`?days=`), so the window survives refresh, Back and a pasted URL.

### 3.2 KPI tiles, now with a period-over-period delta

- **Question:** what are the headline numbers, and are they getting better?
- **Form:** stat tiles (`StatCard`, unchanged). A number is the chart when there is one number, and a one-bar chart is an anti-pattern.
- **New:** windowed tiles carry a delta against the **previous window of equal length**, e.g. "▲ 18% vs previous 30 days".
- **Delta encoding:**
  - The glyph gives direction (▲ ▼ –) and the words give size.
  - It is written in the tile's own foreground (`--color-kpi-fg`). A state hue on the KPI fill is invisible or reads as decoration (theme.css KPI note), and up/down colours would collide with answered/missed (P2).
- **When a delta is omitted:**
  - When the previous window was zero, the tile says "none in the previous 30 days", never "▲ ∞%".
  - Snapshot tiles (open leads, pipeline value) have no previous value that means anything, so they show no delta. Their context says "now".
- **No sparkline:** the full-size trend chart sits directly below and carries the same series. A 40px copy inside the tile adds ink, not information.
- **"Won" becomes windowed:** closed = status won/lost with `stage_changed_at` inside the window. That is the same predicate the Reports forecast uses (`api/reports/reports.service.ts:973`), so the dashboard and Reports cannot disagree. Win rate = won ÷ (won + lost) *closed in the window*, and the tile says "of 17 closed".

### 3.3 Calls and new leads (the trend), two plots on one time axis

- **Question:** is activity growing, what happened to the calls, and is demand keeping up?
- **Form:** a small-multiple pair on one shared x-axis (one column per calendar day in the window, zero days drawn as zero):
  - **A: stacked columns** of calls per day, split by state.
  - **B: columns** of new leads per day, with a **7-day trailing average line** when the window has 14 or more days.
- **Why not the old paired columns:** A3. On one axis the leads were slivers.
- **Why not a dual-axis line chart:** it invents a correlation (anti-pattern #1).
- **Why stacked for calls:** the total per day and its make-up are both the point. Stacking gives the total as the column height and the composition as the segments. It is part-to-whole over time.
- **Why columns and not lines:** days are discrete buckets with small integer counts, and many days are zero. A line through zeros implies a continuous quantity.
- **Why a moving average on leads:** daily arrivals are lumpy (a campaign day, a Sunday). A 7-day mean shows the direction a reader would otherwise estimate by eye. Same unit, same axis, so it is not a second scale.
- **Encoding:**
  - Stack order bottom→top is answered, outgoing, missed. **This order is a correctness rule, not a preference.** Validated (§4.1), missed next to answered fails deuteranopia (ΔE 5.0), while blue between them gives ΔE 29.9.
  - Missed on top also puts the thing an owner scans for at the silhouette's edge.
  - Leads columns are ink (`--color-text`). The average is a 2px `--color-text-muted` line.
  - Columns are capped at 24px wide with ≥2px between days, a 2px surface gap between segments, a 4px rounded top on the topmost segment only, and square at the baseline.
  - The y-axis has clean ticks (0, mid, top from `niceCeiling`) and hairline grid.
  - The x-axis labels the first, middle and last day.
- **Hover:** the whole day slot, both plots, is one hit target. One tooltip lists every series for that day (weekday + date, answered, outgoing, missed, total, new leads). This is the crosshair rule for discrete days.
- **Drill-down:**
  - Plot A's segment area opens the call log for that day (`/owner/calls?from=&to=`), when the tenant has `call_intel`.
  - Plot B's opens the leads that arrived that day (`leadsArrivedHref`).
- **Insight line (P7):** "Busiest: Tue 16 Sep, 84 calls · Most missed: Mon 15 Sep, 12". Pure function, tested.
- **Header:** window totals: calls, % of inbound missed, new leads.

### 3.4 When inbound calls go unanswered: weekday × hour heatmap

- **Question:** when do we miss calls, so we can staff that hour?
- **Form:** a heatmap with 7 rows (Mon→Sun) and one column per hour. It covers the hours that had any inbound call, always widened to include 09–18 so the grid does not change shape week to week.
- **Why a heatmap:** two ordinal dimensions (day, hour) and one magnitude is exactly the heatmap's job. The alternatives:
  - A bar per hour loses the weekday.
  - 7 small line charts make the reader compare seven shapes.
- **Why count and not rate:** the cell's colour encodes the **number of missed calls**, not the missed percentage.
  - A rate turns 1-of-1 at 07:00 into the darkest cell on the grid.
  - Count is the business loss, which is what staffing fixes.
  - The rate is in the tooltip with its base ("6 of 14 inbound missed, 43%").
- **Encoding:**
  - **Four classes** of a single-hue ramp of the missed colour (§4.3).
  - Class edges are computed from the window's maximum, so the ramp is used whatever the volume. A scale legend prints the ranges.
  - Three states that must look different:
    - no inbound calls: an empty cell with a hairline outline
    - inbound but none missed: a neutral grey fill ("the phones rang and we answered")
    - missed: the ramp
  - Cells are square, with a 2px gap and 4px radius.
- **Hover:** each cell is its own hit target. The tooltip reads "Tue · 13:00–14:00 · 6 missed of 14 inbound (43%)".
- **Drill-down:** none from the cell, because the call log has no hour filter. It says so via P4, and the table view lists every cell.
- **Insight line:** "Most missed: Tue 13:00–14:00 (6). 38% of all missed calls fall between 13:00 and 15:00." The second clause appears only when a two-hour band holds at least a third of the window's missed calls, so it only speaks when there is a pattern.
- **Row totals** are printed at the right of each weekday.
- **Time zone:** hours are **workspace-local**, which is why this panel waits for doc 30. In UTC, an Indian lunch hour would draw at 07:30.
- **Phone:** the grid scrolls sideways inside a focusable region, and the weekday labels stay pinned.

### 3.5 Call outcomes: figures, one part-to-whole bar, a rate with a delta

- **Question:** out of everything that rang, how did it go?
- **Form:** the three existing figures, which are the exact numbers, plus **one 100% stacked horizontal bar** in the same state order as §3.3.
- **Why the bar:** it is the at-a-glance proportion that three numbers cannot give.
- **Why not a donut:** close proportions are unreadable as angles, and it would introduce a second shape language for the same three states.
- **Changed:** the missed figure's percentage is now **of inbound** (A6): "13% of 492 inbound". A new line reads "Missed rate ▲ 2 pts vs previous 30 days".
- The processing-failure sentence is unchanged (`failed` overlaps; see the API note).

### 3.6 Pipeline health: stages as bars, shaded by time in stage

- **Question:** where is the pipeline, and where is it *stuck*?
- **Form:** one row per open stage, in pipeline order. The **bar length is the count** of open records in the stage (scaled to the largest stage). The bar is **segmented by how long each record has sat in its current stage**, using the five buckets 0–3 / 4–7 / 8–15 / 16–30 / 30+ days, each shaded one step darker.
- **Why:** it answers G3 without a second chart. Length says where, and darkness says how long.
  - The old snapshot bar made a 142-lead "New" column look healthy when 31 of those leads were a month old.
  - It stays a bar, and not a Sankey or funnel, because stage counts are a *snapshot*. A funnel's stage-to-stage conversion needs the transition ledger, which leads have only had since 2026-09-21. The honest cohort funnel lives on Reports (`reports.service.ts:464`).
- **Encoding:**
  - The age buckets are **ordinal**, so they take the grey ordinal ramp (§4.2), light = fresh, dark = old. That ramp is validated for monotone lightness and visible step gaps.
  - Why not amber/red for old: those are reserved hues. Darkness already reads as "more", which is the message.
  - The same bucket bounds are used as the aging report (`AGING_BUCKETS`, `api/reports/sla.ts:72`) so the two cannot draw the line in different places.
- **Row text:** stage, count, value, then "31 over 30 days" beside an hourglass when that bucket is non-zero. The hourglass is the same glyph the deals board uses for stale, so the vocabulary is learned once.
- **Footer:** "Closed in the window: 12 won (8.4L) · 5 lost". Terminal stages are not bars, because a bar for "Lost" all-time grows forever and says nothing.
- **Hover:** each segment: "Proposal · 8–15 days in stage · 6".
- **Drill-down:** the row opens that stage's list (the existing `stageHref`).

### 3.7 Open leads by age, never-responded emphasised

- **Question:** how many leads are waiting, and has anybody ever answered them?
- **Form:** five columns (the same age buckets, *since arrival*). Each column is stacked:
  - **never responded:** ink, on the baseline, emphasised
  - **responded but still open:** light grey, on top
- **Why the emphasis form:** the one sub-population that matters is the one nobody has touched, and it is the only one you can act on today. Giving both halves a hue would make them equally loud.
- **Headline:** "38 open leads have never had a response — 11 of them for over 30 days".
- **Data:** this is the triage block that was computed and never drawn (G1), extended with per-bucket never-responded counts.
- **Drill-down:** the headline opens the unanswered list (`/owner/reports/sla`, whose "awaiting first response" table is exactly that list).

### 3.8 Speed to first response, against the org's own SLA

- **Question:** do we answer new leads fast enough?
- **Form:** a **hero figure** ("64% answered within your 60-minute SLA", with a delta in points), then **horizontal bars** for the response buckets (Under 5 min … Over 24 hours, then "No response yet" set apart).
- **Why horizontal bars:** the buckets are ordered, and their labels are words that need room.
- **Why a hero figure:** the SLA percentage is the decision number. The bars explain it.
- **Encoding:** buckets **wholly inside the SLA are ink**, the rest are the de-emphasis grey. A hairline marker labelled "SLA 60 min" sits between the two groups (emphasis form).
  - If the SLA falls *inside* a bucket (e.g. 45 min, inside 30–60), that bucket is drawn grey and captioned "partly within SLA". The hero percentage is exact regardless, computed from minutes, not buckets.
  - "No response yet" is a separate row with a gap above it. It is open work, not the slowest bucket (the `responseBucket` rule, `sla.ts:40-45`).
- **Window:** leads that *arrived* in the window, measured on the source clock (`COALESCE(source_created_at, created_at)`), exactly as the response-time report does. Windowing on the response would hide every lead nobody answered.
- **Drill-down:** `/owner/reports/sla`.

### 3.9 Source effectiveness (marketing)

- **Question:** which channel is worth the money?
- **Form:** aligned rows, one per channel, sorted by volume, with three columns sharing a row:
  - **Leads:** a bar, in ink.
  - **Converted:** a **dot on a 0–100% track** with the **all-channel rate as a reference tick**.
  - **Won value:** text.
- **Why not a scatter** (volume × rate): ≤ 10 channels with long names. Dots need labels that collide, and a reader wants the exact numbers anyway.
- **Why not bars + a rate line:** dual axis.
- **Why a dot for rate:** a rate is a *position* on a fixed 0–100 scale, compared against the average. A dot reads as position, and a bar would read as a quantity piled up.
- **Colour:** all ink. The old `bg-accent` bars were a colour-rule violation (G6).
- **Small numbers:** under 5 leads, the rate prints as "2 of 3" and the dot is hollow.

### 3.10 Telecaller performance (table, upgraded)

- **Kept as a table:** people are > 7 categories with exact values to compare, which is table territory (dataviz form rule).
- **Added:**
  - a **Missed** column, carrying the missed state glyph when non-zero (G7)
  - a thin ink **inline bar** under the Calls figure, scaled to the busiest person, so the ranking is visible without reading every number

### 3.11 Unchanged

- `NextActions` (Phase 4)
- `TeamRollup` (Phase 8)
- `CampaignTable`
- `RecentActivity`

They were not inadequate, and changing them would be an unrequested cost.

---

## 4. Colour specification (validated, not eyeballed)

Every value below was run through the dataviz six-checks validator (`validate_palette.js`) on 2026-09-22, light surface `#ffffff` and dark surface `#171717`.

### 4.1 Call states as a stacked series

| Order (bottom→top) | Light | Dark | Result |
|---|---|---|---|
| answered, outgoing, missed | `#16a34a`, `#2563eb`, `#dc2626` | `#16a34a`, `#3b82f6`, `#ef4444` | **PASS both.** Worst adjacent CVD ΔE 29.9 light / 26.7 dark, normal-vision ΔE ≥ 29.4 |
| answered, missed, outgoing | | | **FAIL:** ΔE 5.0 deuteranopia (red beside green) |

**Answered in dark mode is drawn `#16a34a`, not the chip green `#22c55e`.** The chip green sits at OKLCH L 0.72, outside the dark categorical band (0.48–0.67), and out-shouts its neighbours. Chips keep `#22c55e`, which is a text-on-fill tier with its own contrast budget. Chart marks go through a new `mark` class on `STATE_TONE` (§6.2), so `state.tsx` stays the only module that names a state hue.

### 4.2 Grey ordinal ramp (age buckets, time in stage)

`color-mix(in oklab, var(--color-text) p%, var(--color-surface))` at **p = 34, 50, 66, 82, 100**. Because it is mixed from tokens, the dark ramp is **selected by the dark tokens**, not flipped: light #a7a7a7 → #171717, dark #5b5b5b → #fafafa. Both pass `--ordinal`: monotone L, adjacent ΔL ≥ 0.06, light end ≥ 2:1 on the surface. An earlier start of 22% failed the light-end contrast (1.71:1).

### 4.3 Missed-call ramp (the heatmap)

Four steps: `color-mix(in oklab, var(--color-danger) 50%, surface)`, the same at 74%, `var(--color-danger)`, `var(--color-danger-text)`.
- Light: #f89f94 → #b91c1c.
- Dark: #7c322f → #fca5a5 (the ramp brightens in dark mode, "more = more contrast from the ground").
- Both pass `--ordinal`.

A five-step ramp of the missed hue cannot pass. The hue's lightness range is too short to keep every step 0.06 apart *and* clear 2:1 at the light end. Four classes is the honest maximum.

### 4.4 Neutral marks

| Mark | Token |
|---|---|
| Single-series columns (new leads, source volume) | `--color-text` |
| Moving average | `--color-text-muted` |
| De-emphasis (responded, beyond-SLA buckets) | ramp step 1 (34%) |
| Grid | `--color-border` |
| Baseline | `--color-border-strong` |

---

## 5. Mark and layout specification

| Element | Spec |
|---|---|
| Column / bar | ≤ 24px thick; 4px rounded data end (`rounded-t` / `rounded-r`); square at the baseline |
| Gaps | 2px surface gap between days and between stacked segments (`gap-[2px]`) |
| Line | 2px, round cap/join, `vector-effect: non-scaling-stroke` so a stretched SVG keeps 2px |
| Heat cell | min 14px square, 2px gap, 4px radius |
| Gridlines | 1px solid hairlines (`border-border`); baseline `border-border-strong`; never dashed |
| Axis text | 11px `text-text-subtle` `tabular-nums` |
| Tooltip | `bg-surface border-border shadow-md`, value first (semibold `text-text`), label second (`text-text-muted`); series keyed by a short line/rect of the mark colour; edge columns open inward |
| Plot heights | trend A 160px, trend B 96px, heatmap rows 20px; every container includes its axis band (no nested scroll) |
| Panel chrome | `Card elevated`, `MonoLabel` title, optional right-side link (`PANEL_LINK`); same as every existing panel |

---

## 6. Data contract (API changes, additive)

Everything is added to the existing single multi-statement batch in `api/owner/owner.controller.ts`, so the page still costs **one** Mumbai→Seoul round trip (`prod-latency-root-cause`). No new route.

### 6.1 Fields

| Field | Shape | Notes |
|---|---|---|
| `window` | `{ days, from, to, timezone }` | `from`/`to` are `YYYY-MM-DD` in the org's zone; `to` is today |
| `byDay[]` | `{ day: 'YYYY-MM-DD', calls, outgoing, answered, missed, leads }` | **gap-filled** with `generate_series` over org-local dates; `day` is a string, not a Date |
| `previous` | `{ calls, inbound, missed, answered, outgoing, leads_created, won, lost, won_value }` | the equal-length window before `from` |
| `closed` | `{ won, lost, won_value }` | status terminal and `stage_changed_at` in the window |
| `callHeat[]` | `{ dow: 1–7 (ISO, Mon=1), hour: 0–23, inbound, missed }` | org-local; only cells with inbound > 0 |
| `stageAging[]` | `{ stage, d0_3, d4_7, d8_15, d16_30, d30_plus }` | open records, age = whole days since `stage_changed_at` |
| `triage` | + `never_d0_3 … never_d30_plus` | still `null` on the CRM read |
| `response` | `{ sla_minutes, leads, responded, within_sla, median_minutes, buckets{…}, prev_leads, prev_within_sla }` | `null` on the CRM read |
| `telecallers[]` | + `missed` | inbound, zero duration, same reassignment-safe join |

### 6.2 The window predicate

`org_window_start(days)` (migration 0132, doc 30) returns the instant the window began: midnight at the start of `today − (days − 1)` in the org's zone. Every windowed statement in both overview readings uses `>= org_window_start(N)` in place of `> now() - make_interval(days => N)`. The previous window is `[org_window_start(2N), org_window_start(N))`. See doc 30 for why a DST-safe calendar start matters.

### 6.3 Kit change: `STATE_TONE[state].mark`

This is a class for a chart mark, distinct from `dot`, which is a legend or chip swatch. Only `answered` differs today (§4.1). `state.tsx` stays the only place a state hue is named, and `console-state.test.ts`'s rules apply to it.

---

## 7. Accessibility

- Every plot is `aria-hidden` and followed by its table twin. The table caption is the chart title.
- The insight sentence is also real text, not hidden.
- Identity never rests on colour alone:
  - State legends carry the state **glyphs** (slashed ring, disc, arrow).
  - The ordinal ramps carry printed ranges in the scale legend.
  - The emphasis panels say in words which half is emphasised.
- Every tooltip value is also in the table view.
- Focusable scroll regions (heatmap, telecaller table) carry `tabIndex={0} role="region" aria-label`.
- Reduced motion: no animation is added. Hover changes opacity only, and the global reduced-motion rule already zeroes transitions.

## 8. Responsive behaviour

| Width | Behaviour |
|---|---|
| < 640px | One column. Trend columns thin to 2px minimum. Axis labels drop to first/last. The heatmap scrolls sideways with pinned weekdays. Pipeline-health text stacks over its bar. |
| 640–1023px | Paired panels still stack. KPI tiles 2×2. |
| ≥ 1024px | The layout in §2.1. |

## 9. Loading state

`W/loading.tsx` mirrors the new composition (owner persona, fullest state), panel for panel. That covers:
- the filter row with its date text
- the KPI band drawn as the solid fill (`Skeleton onFill`)
- the trend card's two plot heights
- the heatmap grid
- the pipeline rows
- the paired aging/response cards

`console-loading.test.ts` keeps it honest: sibling loader exists, header parity, no wrapper element.

---

## 10. Build plan (as executed)

| Step | What | Files |
|---|---|---|
| D0 | Time standard (doc 30): `org_window_start`, zone-aware day keys and formatting | see doc 30 |
| D1 | API contract §6: rewrite both overview batches on the window predicate; new statements; SQL generators beside `agingBucketFilters` | `api/owner/owner.controller.ts`, `api/reports/sla.ts` |
| D2 | Pure chart logic with tests: gap fill, `niceCeiling`, stack segments, rolling mean, heat bins and hour range, deltas, insight sentences, SLA split | `web/lib/dashboard-charts.ts`, `web/lib/dashboard-charts.test.ts` |
| D3 | Panels | `W/dashboard/*.tsx` (trend, heatmap, outcomes, pipeline health, lead aging, response speed, source effectiveness, chart parts) |
| D4 | Compositions + filter row + KPI deltas | `W/page.tsx`, `W/dashboard-panels.tsx` |
| D5 | Kit `mark` class + chart ramps | `ui/state.tsx`, `ui/theme.css` |
| D6 | Loader | `W/loading.tsx` |
| D7 | Verify (§11) | none |

## 11. Verification

1. `pnpm --filter @aura/web typecheck` and `lint` (`--max-warnings=0`), plus `pnpm --filter ./apps/api typecheck`.
2. `vitest`:
   - `dashboard-charts.test.ts`
   - `console-palette.test.ts`, `console-state.test.ts` (colour rule)
   - `console-loading.test.ts` (loader parity)
   - the owner-controller SQL shape tests
3. **Generated SQL executed against a real database** (typecheck cannot see SQL): the overview batch runs read-only in a rolled-back transaction for a seeded org, for the leads and CRM readings, and for `days` = 1, 7, 90.
   - Assert that `byDay` has exactly `days` rows, that its call sum equals `calls.total`, and that `outgoing + answered + missed = calls` per day.
   - Needs Docker (`windows-build-quirks`). If Docker is off, this step is reported as **not run**, not as passed.
4. Visual check: render the panels to static HTML with the real compiled CSS and screenshot them light + dark with headless Chrome (`loading-skeletons` recipe). Look for label collisions, clipping and overflow at 375px and 1280px.

## 12. Rejected alternatives (so nobody re-litigates them)

| Idea | Why not |
|---|---|
| Recharts / ECharts | P6: SSR pop-in, a second theming system, +KB. Recharts stays in the report builder, where charts are user-configured. |
| Funnel with stage-to-stage conversion on the dashboard | Stage counts are a snapshot, and the lead ledger is only days old. It would print invented conversion rates. Reports has the honest cohort funnel. |
| Up-green / down-red deltas | Green and red mean answered and missed here (P2). |
| Missed-rate heatmap | Small-base cells dominate. Count is the loss, and the rate is in the tooltip. |
| Dual-axis calls + leads | Anti-pattern #1; replaced by small multiples. |
| Donut for call outcomes | Angles hide close proportions. The 100% bar and figures replace it. |
| Sparklines in KPI tiles | They duplicate the full-size trend directly below. |
| Per-user display time zone | Doc 30 §1: one workspace clock, or two colleagues argue about which day a call happened. |

---

## 13. Build record (2026-09-22)

### 13.1 Where the build departed from the plan, and why

| Plan said | Built | Why |
|---|---|---|
| Panels in `W/dashboard/` | `W/_dashboard/` | A leading underscore keeps the folder out of Next's routing, following the `integrations/_connect` precedent. |
| Axis tops from the Reports page's `niceCeiling` (steps 1/2/5/10) | `niceTop` in `web/lib/dashboard-charts.ts` (steps 1/2/3/4/5/6/8/10) | Seen in the first screenshot: a maximum of 22 got a 50 axis, so the aging chart was half empty. |
| The marketing tile keeps the label "Converted" | "Win rate, 30d" | The source panel reports won ÷ ARRIVED (9% on the demo data) and the tile reports won ÷ CLOSED (63%). Both were called "converted" on one page. The panel now says "won so far". |
| Response buckets restated on the web side | The API returns them self-describing (key, label, min/max minutes, `never`); aging bucket labels arrive as `agingBuckets` | One definition of each bound, in `api/reports/sla.ts`. |
| — | `responseBucketFilters()` in `sla.ts`, pinned to `responseBucket()` by evaluating each generated SQL bound as JS over 15 sample values | The dashboard counts buckets in SQL, the report counts them in JS, and they must agree. |
| — | Every windowed statement reads the window through a `MATERIALIZED` CTE | `org_window_start()` runs a subquery. An inlined CTE would evaluate it once per ROW inside every `FILTER`. |
| Legend swatches `rounded-sm` | `rounded-[2px]` | The theme's `rounded-sm` is 6px, which turns a 10px swatch into a dot. The answered legend showed two green circles, and a swatch could pass for a glyph. |

### 13.2 Verified

- **Generated SQL, executed** against the local database (Postgres 16) through the real controller methods: 334/334 checks passed.
  - Coverage: both readings (`overview`, `crmOverview`), days 1, 7, 30 and 90, a scoped telecaller, and a persona with no telecaller identity (who sees nothing, not everything).
  - Checks:
    - `byDay` has exactly `days` rows, from `window.from` to `window.to`
    - calls sum to `calls.total`, and states partition each day
    - heatmap inbound = answered + missed; heatmap missed = missed
    - stage aging sums to open; triage and never-responded buckets sum to their totals
    - response buckets sum to leads, in `sla.ts` order
- **The real page, per persona**, rendered to static HTML with the app's compiled CSS and the demo org's real overview JSON, then screenshotted in headless Chrome:
  - owner 30d light, dark and at a 390px column
  - owner 90d, manager, telecaller, sales, marketing
  - Three defects were found this way and fixed: the average line's SVG kept its 300px intrinsic width; axis labels collided in the 12px gap between the plots; the axis steps were too coarse.
- **Suites:**
  - web 889/889 + typecheck, including the colour, state, loading-parity and new time guards and `dashboard-charts.test.ts` (18)
  - shared 1252/1252, db 78/78, worker 364/364
  - API: the full jest suite, 46 suites, 739 passed, 5 skipped (skips pre-existing), including guard-mounting (452 routes), sla (40, with the SQL-vs-JS bucket pairing) and time-settings

### 13.3 Open

- Nothing committed or deployed.
- Migration 0132 must be applied before this API ships: the overview SQL calls `org_window_start()`.
- `web` lint: 8 pre-existing warnings in files this work did not touch.
- Not yet seen against a live, logged-in console. Local dev has no Supabase login, and the API on :4000 was an older build owned by another session, so it was not restarted.
