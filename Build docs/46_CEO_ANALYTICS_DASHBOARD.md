# 46 · The CEO analytics dashboard

`/owner` rebuilt to the CEO analytics layout: what each band answers, where its
numbers come from, and the decisions that are load-bearing.

Written for an engineer who has to change this page. It describes the code as
it stands on `crm-phases-on-origin`, 2026-10-12.

**This supersedes `44_OWNER_DASHBOARD_ANATOMY.md` §2.1, §3 and §4** — the five
hand-written persona compositions and the seven-chart inventory. Doc 44's §2.2
(scope is applied in SQL), §2.4 (the API-only redirect), §2.5 (every figure
names its clock), §6 (colour rules) and §8 (the loader test) are all still
current and are not repeated here. Doc 29 remains the argument behind the four
charts this layout reuses unchanged.

---

## 1. Where everything lives

| Path | What it is |
| --- | --- |
| `platform/apps/web/app/(owner)/owner/page.tsx` | The route. Fetches, resolves the window and the clock, parses the chart controls, hands everything to one component. No layout. |
| `platform/apps/web/app/(owner)/owner/_dashboard/ceo/index.tsx` | The layout, and the `BANDS` table that is the whole of the per-persona difference. |
| `platform/apps/web/app/(owner)/owner/_dashboard/ceo/*.tsx` | Eleven panels. Server-rendered, no chart library. |
| `platform/apps/web/app/(owner)/owner/_dashboard/ceo/actor-colors.ts` | One colour per person, fixed across six panels. |
| `platform/apps/web/lib/ceo-dashboard.ts` | Every number the new panels need: pace, forecast, attribution, the ranked alerts, the funnel, the scenarios. Pure, and unit-tested (54 cases). |
| `platform/apps/web/app/(owner)/owner/_dashboard/*.tsx` | The four panels carried over unchanged: the missed heatmap, pipeline health, response speed, source effectiveness. |
| `platform/packages/ui/src/theme.css` | `--color-chart-cat-1..5` and `-other`: the actor ramp, added by this work. |
| `platform/apps/api/src/modules/owner/owner.controller.ts` | `GET /v1/owner/overview` and `GET /v1/owner/crm-overview`. One new aggregate each. |

---

## 2. The page, top to bottom

1. **KPI row** — six tiles: revenue won, lead→win, revenue per call, open
   pipeline, active callers, next-30d forecast.
2. **Series strip** — four toggleable series, a daily/weekly control, and a
   "compare with the earlier half" switch.
3. **Pace** — the selected series over the window, each in its own pane on a
   shared time axis, projected a fortnight forward.
4. **Needs you** — the ranked alert list.
5. **Next actions** — unchanged, where the reader can open Tasks.
6. **Who drives the business** — four attribution donuts.
7. **Telecaller performance** — five small-multiple bar cards.
8. **Effort vs yield** · **Conversion funnel** — two up.
9. **Missed heatmap** · **Call outcomes** — two up, both unchanged.
10. **Speed to first response** · **Open leads by age** — two up.
11. **Pipeline health** — unchanged.
12. **Source effectiveness** — unchanged, marketing and owner only.
13. **Won revenue · 3 scenarios** · **Cash & collections**.
14. **Latest activity**, then the CRM **team roll-up** for owners and managers.

### 2.1 One layout, five readers

Every persona gets this page. `BANDS` in `_dashboard/ceo/index.tsx` is the only
place they differ, and it switches four groups: `people` (attribution, the
per-person bands, effort/yield), `money` (the revenue tiles, scenarios, cash),
`sources`, and `calls`.

The five hand-written compositions this replaced were the same fourteen panels
in five orders. Every change to the page had to be made five times or it
silently applied to four personas, and three of the five had drifted.

**What has not changed is that rendering is never the control.** The payload is
narrowed in SQL by `owner-scope.ts` before it reaches the web app, so a
telecaller's "calls" is their own desk under the same heading. A bug in `BANDS`
can only mislabel somebody's own numbers; it cannot show them a colleague's.

The telecaller still sees no rupee figure. That is doc 44's rule and it is kept:
a rep is measured on activity and conversion, a money total invites working the
biggest card rather than the next one, and the value of a lead they were handed
is not a number they set.

---

## 3. The decisions worth not reversing

### 3.1 One plot, four lines, two axes

This went through three shapes in a day. The history matters because the
constraints are not obvious and the end state looks like the thing that was
rejected first.

1. **The mock** overlaid calls and new leads on one plot with a scale down each
   side. Rejected: 389 calls against 5 leads sets the two scales 78x apart, and
   **any** pair of series can be made to look correlated — or anti-correlated —
   by choosing that ratio, with nothing on the chart saying what was chosen.
2. **Stacked panes on a shared time axis**, built and confirmed with the owner.
   Same question answered by letting the eye compare two shapes along one x.
3. **One plot, on the owner's explicit instruction** (asked twice, reaffirmed),
   first as lines like Google Search Console's hourly chart, then combined.

**What makes the end state defensible** is not that the objection went away. It
is that three of the four series are the SAME UNIT and belong on one scale on
their merits: calls, new leads and missed inbound are all counts of the same
events, and they NEST — missed inbound is a subset of calls, new leads are what
calls produced. On a shared count axis they are a real comparison, and the
reader sees directly that leads are a thin slice of dials.

Only `Leads / 100 calls` is a rate, and it takes the right-hand axis. So there
is exactly ONE arbitrary ratio rather than three, it is between a rate and the
counts it is derived from, and the right axis is drawn only while that series
is on — a reader who never turns it on never sees a second scale. Its legend
key says "(right axis)".

**A fourth unit does not get a third axis.** Give it its own card, or index it.

**The mark** is a 2px line, solid across the window and dotted across the
forecast, the two sharing their last point so the projection reads as the same
series continuing. An SVG stretched over the plot with
`preserveAspectRatio="none"` and `vector-effect="non-scaling-stroke"` —
geometry in column units so every series lands on the shared x exactly, stroke
constant however wide the card gets. Same construction `trend-chart.tsx`
already uses for its rolling mean.

### 3.1.1 Why every line is named on the plot

This is the part that is load-bearing rather than decorative, and it is the
thing a future change is most likely to delete as clutter.

Two of the four hues are **pinned by meaning**: red is MISSED (`state.tsx`, and
the whole console depends on that) and blue is the outgoing-call hue. With
those fixed there is no pair of further hues that clears the CVD separation
floor against both. Measured, not guessed:

| set | light, all pairs | dark, all pairs |
| --- | --- | --- |
| blue / KPI-orange / aqua / red | **FAIL** — orange↔red ΔE 6.0 normal vision | FAIL — ΔE 10.0 |
| blue / violet / aqua / red | FAIL — violet↔blue ΔE 14.2 | — |
| blue / amber / aqua / red | **PASS** | FAIL — amber↔red ΔE 4.4 deutan |

The dark lightness band (0.48–0.67) is too narrow to re-step amber out of that
last one. **Re-stepping cannot solve four series with two pinned hues** — which
is exactly the cap the dataviz guidance states: past three, fold or facet.

The first row is worth noting on its own: the original orange for "New leads"
and the red for "Missed inbound" are ΔE 6.0 apart in normal vision, well under
the 15 floor. They were never adjacent while the series lived in separate
panes. **Combining the chart created a defect that neither series had.**

So identity does not rest on hue at all: each line **says its own name at its
right-hand end, in its own colour**. `endLabels()` anchors each on its last
drawn value, then pushes them apart with a one-pass separation and clamps the
stack inside the plot. Each label carries a backing chip, because every series
is flat across the forecast region where the labels sit, so a bare label is
struck through by its own line — lifting it was not enough, as the first
attempt showed.

The legend, the crosshair tooltip (one per bucket, naming every series with its
value) and the table twin are the other three ways to resolve a line. Colour is
the accelerator, never the mechanism.

Two more things the line form forces that columns did not:

- **A gap must break the line.** The rolling leads-per-100 series is `null`
  until it has a full week, and a polyline across that gap would draw a segment
  nobody measured. Each contiguous run is its own polyline; a lone point gets a
  zero-length segment so its round cap renders as a dot.
- **A 2px line is not a hover target.** The tooltips hang off full-height
  invisible columns, one per bucket, which also carry the point markers.

### 3.2 Sentence case, not the mock's caps

The source design sets every panel title in uppercase. The system retired that
convention deliberately (`mono-label.tsx`, doc 16 §1.2): it hurts scanning at
11px and does nothing at all for Tamil, Hindi and Telugu, which have no case —
and native support for those scripts is this product's headline claim. Weight
and colour carry the hierarchy instead.

### 3.3 The actor ramp is a new token set, and it is validated

Identity hues for the donuts, the per-person bars and the scatter. They could
not come from anywhere that already existed:

- `--color-outgoing`, `--color-orange`, `--color-danger` and
  `--color-mark-answered` each **mean** something (`state.tsx`). A person is
  not a state.
- `--color-label-*` are 50/800-class chip tints, far too pale for a 10px arc.

So `--color-chart-cat-1..5` plus `-other`, with real dark-mode steps. Every
value was run through the dataviz validator against both surfaces, not
eyeballed:

- slots 1–3 pass `--pairs all` in both modes (the scatter, where any dot may
  land beside any other): worst normal-vision ΔE 27.4 light / 18.1 dark;
- slots 1–5 pass the adjacent pairlist in both modes (donut arcs, bar rows).

Three light slots sit under 3:1 on white, so the **relief rule** applies: every
chart spending these ships direct labels and a table twin. It is met.

The order is fixed to the person, by call volume, and held across all six
panels (`actor-colors.ts`). Each panel colouring its own rows would repaint the
floor four times on one screen — the top slice of the revenue donut and the top
slice of the calls donut would both be slot-1 blue while being different people.

Class names are written out as literals. Tailwind v4 emits CSS only for names it
can read statically; a computed `bg-chart-cat-${n}` renders transparent with no
error.

### 3.4 The attribution donuts divide the KPI, and name the remainder

A floor's totals come from `calls` and `leads` directly; the per-person rows
come from a join through `devices`. The two differ by every record no handset
owns — a call from an unenrolled phone, a lead a web form made, revenue closed
before the deal carried a telecaller.

`driverSlices()` therefore divides **the authoritative total**, not the sum of
its rows, and draws the gap as a neutral "Unattributed" slice. Rescaling to the
attributed part would quietly delete it, and on a real tenant that gap is
routinely half the revenue.

### 3.5 …which is why the API grew a second join

`telecallers[].won_value` / `closed_won` are a **separate** aggregate from the
existing `leads`/`won` columns, and the predicate is the whole reason:

| join | predicate | answers |
| --- | --- | --- |
| `l` (existing) | records **created** in the window | a cohort: how many of this month's leads have since been won |
| `cw` (new) | `status='won'` **and** `stage_changed_at` in the window | closes: what was banked this month, whenever it arrived |

The KPI tile prints `closed.won_value`, which is the closes predicate. The donut
slices that number. On the cohort predicate a deal opened in August and won in
October would be in the KPI's numerator and in nobody's slice, so the handset
that actually closed it would show as unattributed revenue.

**Verified on a real database**, not by reading: an ephemeral Postgres with all
195 migrations applied and a floor seeded to include exactly that case — a lead
created 90 days ago, won 2 days ago. The rollup returns `leads: 1` (cohort) and
`won_value: 1500 / closed_won: 2` (closes), reconciling exactly with the KPI
aggregate's `1500 / 2`. Both endpoints were executed; neither errors.

### 3.6 The alert list is ranked by money, and says so

Ordering is the panel's whole contribution. The console could already say that
three leads are uncontacted and that the recorder is dropping calls; what it
could not say is which to do first. "Three leads never contacted" is a red row
worth one deal; "the floor stopped dialling" is the same red worth a month of
them.

Every rule has a floor to clear, and `rankAlerts()` returns nothing when nothing
qualifies — a dashboard that always has four problems on it is one people stop
reading.

Severity is a dot plus an `sr-only` word, never the row's colour. A red band
here would collide head-on with the console's rule that red means a customer was
not picked up.

The impact column is formatted by a `money` callback passed in, not a hardcoded
`₹`: the workspace's currency lives on the membership.

### 3.7 Log scales, stated

Two panels use one, for the same reason and with the label to prove it:

- **Effort vs yield** — on a floor where one person dials 369 and another dials
  1, a linear x pins everybody but the top dialler into one illegible clump.
  Someone with no calls is dropped rather than plotted at zero (log 0 is
  undefined, and "leads per 100 calls" has no value with no denominator); the
  panel names them in words underneath.
- **Conversion funnel** — five quantities across four orders of magnitude and
  three different units. No length comparison between them means anything, so
  the bars are orientation and the **step labels between the rows** are the
  chart.

### 3.8 "Collected" is blank, not zero

Collections live behind a deal template most workspaces have not created, so the
true value is unknown. `funnelSteps` keeps it `null` and the cash panel renders
dashed outlines with em-dashes. Zero would tell an owner they collected nothing
of what they earned.

The cash panel renders **even when it is entirely empty**, which is deliberate:
the funnel ends at "Revenue", and a dashboard that stops at revenue teaches an
owner that revenue is the end of the process. An empty panel that names the six
figures and says which one action turns them on is a better answer than silence.

### 3.9 The scenarios are a sensitivity reading

Three rows, same arithmetic, exactly one term moved — so the comparison between
them ranks the two levers an owner has. Reading any single bar as a prediction
is the misuse, and the panel is built to make it hard: a flat ±40% band called
"likely range" and not a confidence interval (with two closed deals there is no
distribution to take one from), and the thin base stated in the header in the
signal hue rather than in a footnote.

### 3.10 The chart controls are client state, and the URL still tracks them

These started as links into the query string, like the date range and every
board filter. That was wrong, and the reason is worth stating because it is
the one place on this page where the console's standing pattern does not
apply.

**The date range changes what is FETCHED. These three change nothing.** Every
series, at both grains, is already computed server-side and already in the
component's props (`panesByGrain`). A link meant a server round trip that
re-rendered the whole dashboard in order to draw a line that was sitting in
memory — the page blanked and came back to tick a checkbox.

So `pace-section.tsx` is a client component holding `series`, `grain` and
`compare` in `useState`, and the redraw is immediate.

**The URL still tracks it**, via `window.history.replaceState` — which writes
the query string WITHOUT telling the router, so Next does not re-render and
nothing refetches. Supported deliberately since 14.1 for exactly this. A
configured dashboard stays sendable and a reload restores it; the server parses
the query string on first load and passes the result in as the initial state.
`replaceState` and not `pushState`: ticking four checkboxes should not put four
entries in the back stack.

Only non-default values ride in the URL, and the last series cannot be switched
off — no control should be able to produce an empty plot.

**Measured, not assumed** (CDP driving the real page): clicking a toggle and
switching the grain produced **0 navigations**, no `GET /owner` in the server
log, and a query string that tracked both changes.

#### The trap this created

Making `series-strip.tsx` a client component silently broke the page at
RUNTIME, not at build. `SERIES_OPTIONS` was exported from it and imported by
the server component — and **a Server Component importing from a `"use client"`
module gets client REFERENCE stubs, not values**. `SERIES_OPTIONS.calls` was
`undefined` and the dashboard 500'd on `.label`.

Typecheck cannot see this: the types are real, only the runtime values are
proxies. The constant now lives in `series-options.ts`, a module with no
directive, which both sides may import for what it actually is. **Any value
shared across that boundary belongs in a third, directive-free module.**

---

## 4. Verification

| What | How |
| --- | --- |
| `lib/ceo-dashboard.ts` | 54 unit cases. The edge cases are the point: a window too short to halve, a drift too small to call a trend, parts overshooting the whole, a floor that dialled nothing, division by zero on an empty window. |
| The two SQL changes | Executed against an ephemeral Postgres with all 195 migrations and seeded data. See §3.5. |
| Loader parity | `app/console-loading.test.ts`, 133 cases, all passing. The loader was rewritten to the new geometry. |
| The whole web tier | 1313 tests, 66 files. |
| The whole API tier | 1471 tests, 87 suites (`npx jest -w 2`; the default worker count fails 18 suites with `Cannot find module` inside `node_modules/.pnpm` — a store-resolution artifact on this machine, reproducible on a clean tree). |
| Light and dark rendering | Both modes rendered to static HTML and screenshotted. Four defects were found this way and only this way — see §5. |

### 4.1 Rendering it without a dev server

Local has no Supabase, so console pages are unreachable by login. The recipe
from the loading-skeleton work still applies and was used here: compile
`app/globals.css` with PostCSS, `renderToStaticMarkup` the component from a
throwaway vitest file with a synthetic `Overview`, wrap in
`<html data-theme="dark|light">`, then headless Chrome with an **absolute**
`--screenshot` path and a fresh `--user-data-dir` per run.

The harness file is deliberately not committed — it writes to an absolute
scratch path and would run in CI under `lib/**/*.test.tsx`.

---

## 5. What looking at it caught that nothing else did

All four of these typechecked, linted and passed their unit tests:

1. **Open leads by age drew every bucket as a hairline.** The columns were
   content-sized in an `items-end` flex row, so each bar's `height: n%`
   resolved against its own content box rather than against the plot. Fixed by
   `h-full` columns with an absolutely positioned bar.
2. **The alert list printed raw numbers** — "−2792 / month" — because
   `rankAlerts` had no currency formatter. Now takes one; a test asserts it.
3. **The funnel's per-deal step said "750 each".** Same cause,
   `funnelSteps(f, money)`.
4. **Two label collisions.** "Unattributed" truncated in the donut legends at
   four cards across; and the busiest caller's label overprinted the team-average
   line, because that caller's rate is usually just under the floor's own
   average. Labels now sit on the side of their dot away from the reference
   line, and dots are inset from the plot edges so they never land on a quadrant
   caption.

---

## 6. Adding something to this page

Doc 44 §9 still applies in full — add the number to the API first and to the
same multi-statement batch, scope it in SQL, declare it optional in `types.ts`
with `null` meaning "this view cannot answer that", put the maths in a tested
lib file, say which clock it is on, give a chart a table twin and a sentence.

Four additions for this layout:

9. **Decide which `BANDS` group it belongs to**, and put it in the band that
   answers the question the band above it raises. Do not add a persona check
   inside a panel.
10. **If it is about a person, take the colour from the palette** the page
    passes down. Never pick one in the panel.
11. **If it prints money, take a `money` callback.** Nothing below `index.tsx`
    knows the workspace's currency.
12. **Render it and look at it, in both themes** (§4.1). Every defect in §5 was
    invisible to the type checker and to the tests.

---

## Cash & collections is gated on the finance MODULE, not just the persona

`BANDS.money` answers a persona question - may this reader see money at all.
For a while it was answering a second question it was never asked: does this
workspace *have* the finance module.

It does not, and the result was visible on any tenant without it. The Cash &
collections panel rendered (correctly empty - every tile an em-dash, no figure
leaked), but its header link read "Create a deal template to switch this on"
and pointed at `/owner/finance`, which `requireFeature` bounces straight back
to `/owner`. A call to action that silently returns you to the page you were
already on.

`rankAlerts` had the same hole and a sharper edge: the **"Finance is blind"**
alert - *"no deal template → no collections tracked"*, priced at the untracked
revenue - fires whenever `tracksCollections` is false and there is revenue,
which is every tenant. Alerts rank by money, so it could sit near the top of
"What needs you", telling somebody their setup was deficient for want of a
module nobody had sold them, behind the same dead link.

The fix is one flag, `finance`, resolved in `page.tsx` from
`membership.enabledModules` exactly as `callIntel` already is and defaulting
FALSE, so a render that cannot resolve an owner hides the band rather than
advertising it. It does three things:

- the panel renders only when the module is on;
- `rankAlerts` takes a new `collectionsAvailable`, distinct from
  `tracksCollections` - *can* this tenant track collections at all, versus
  *does* it - and the alert needs both;
- the alert's action href is dropped when the page cannot be opened.

**The behaviour when finance IS on is unchanged**, which was the point. The
panel's own doc argues it should stay visible-but-empty to teach that revenue
is not cash banked, and that argument holds for a tenant who can act on it.
It was only ever reasoning about "finance on, no deal template yet"; finance
being off was the case nobody had considered.

Verified both ways against the running console: finance off gives no panel, no
alert and zero `/owner/finance` links on the dashboard; finance on gives the
panel, the alert, and both links landing on `/owner/finance`.
