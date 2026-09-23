# 30 — One clock per workspace: the time standard and the time-zone picker

**Written for:** anyone who renders, stores, buckets or accepts a time anywhere in the Aura CRM (owner console, API, worker), and the product owner approving the behaviour.
**Status:** BUILT 2026-09-22 and verified locally (§9). Uncommitted and undeployed. Migration 0132 has been applied to the local database only.
**Companion:** doc 29 (dashboard redesign). Its daily and hourly charts are correct only because of this doc.

**Short path prefixes:** `W` = `platform/apps/web/app/(owner)/owner/`, `web/` = `platform/apps/web/`, `api/` = `platform/apps/api/src/modules/`, `S` = `platform/packages/shared/src/`, `db/` = `platform/packages/db/migrations/`.

---

## 0. What was asked

> Implement a standardized time management system across the CRM to ensure temporal uniformity across all modules and records. Integrate a comprehensive timezone picker functionality that allows owner/manager to seamlessly configure their preferred local time, ensuring that all timestamps, scheduled events, and communication logs are accurately synchronized and consistently displayed throughout the application regardless of geographical location.

## 1. The decision: one workspace clock

The workspace has **one** display and reporting time zone: `organizations.reporting_timezone` (migration 0090). Owners and managers set it, and everyone in the workspace reads every time in it, wherever they physically are.

**Why not the viewer's own zone?** Because "regardless of geographical location" means two colleagues looking at the same call must see the same day and hour. Take a manager in Dubai and a telecaller in Pune. With per-viewer zones, a call at 00:45 IST is "yesterday 23:15" to the manager and "today" to the telecaller. They would argue about whether a follow-up is overdue, and the dashboard's "Tuesday" column would hold different calls for each of them.

**Why not a per-user override on top?** Same argument. It reintroduces the disagreement the standard exists to remove. The operator console is the one exception (§8).

## 2. What was wrong before (audit, 2026-09-22)

| Where | What it did | Effect |
|---|---|---|
| `web/components/local-time.tsx` (28 uses) | Server renders UTC, then after hydration swaps to the **browser's** zone and locale | Every timestamp flashes, then settles on a clock that depends on who is looking. A telecaller abroad sees different days from their manager. |
| `W/types.ts relativeTime` (17 files) | Hard-codes `Asia/Kolkata` for dates over 30 days old | Wrong for any workspace outside India, while the rest of the page uses the browser zone. |
| ~40 call sites in `W` | `new Date(x).toLocaleString()` / `toLocaleDateString()` with no zone or locale | Server and browser disagree, causing hydration mismatches (a known open issue in `call-log-date-pager` memory). Output also varies by the machine's locale ("9/22/2026" vs "22/9/2026"). |
| `web/lib/next-actions.ts:123` | "Today" is the **viewer's** browser date | The API counts overdue with `org_reporting_today()` (0095). A viewer abroad saw a task as "due today" that the dashboard counted overdue. |
| `W/call-access/call-access-client.tsx:277-284` | `datetime-local` read in the **browser's** zone | An owner abroad granting operator access "until 18:00" granted it until 18:00 wherever their laptop was. |
| `api/owner/owner.controller.ts:331-337, 553-559` | Dashboard days = `date_trunc('day', ts)` on a UTC database | 00:00–05:29 IST filed under the previous day (doc 29 A1). |
| `api/owner/owner.controller.ts` (every windowed read) | Window = `now() - N days`, a rolling instant | No list filter (which take calendar dates) can reproduce the number (doc 29 P1). |
| `api/reports/reports.service.ts:253, :984`, `api/report-builder/crm-sources.ts:301`, `api/reports/targets.controller.ts:101, 185` | `current_date` (UTC) | "Overdue" on those reports flipped at 05:30 IST, not at midnight. Targets switched period 5½ hours late. |
| `apps/worker/src/pipeline/automation.ts:475-481` | `current_date` in a cross-org sweep | `task.overdue` automations fired on the UTC date. The dedupe key was a UTC date too. |
| `api/analytics/analytics.controller.ts:56, 129` | `date_trunc('day', started_at)` | UTC days on the tenant analytics series. |
| `W/account/business` | A plain `<select>` of ~420 raw IANA ids, owner-only | No search, offsets or preview; managers could not change it. The form also re-sent the zone on every save, so an old tab reverted a newer change. |

## 3. The rules (the standard itself)

| # | Rule | Enforced by |
|---|---|---|
| R1 | **Instants are stored as `timestamptz`** and travel as ISO-8601 UTC strings. Never store a local wall time. | Schema; unchanged |
| R2 | **Calendar dates stay dates.** `tasks.due_on`, `invoices.due_date`, `quotations.valid_until`, report `from`/`to`: `YYYY-MM-DD`, never converted through a zone. A task due "Thursday" is due Thursday in every zone. | The formatters take a date key and never a Date for these |
| R3 | **Every time a person reads is rendered in the workspace zone** through `S/time.ts` formatters: server and browser produce **byte-identical text**, so there is no hydration mismatch and no flash. | `formatInZone` family; `<Time>` / `LocalTime` |
| R4 | **Every day boundary is the workspace's midnight:** "today", "overdue", per-day and per-hour buckets, report windows, the dashboard window. SQL uses `org_reporting_today()` / `org_reporting_tz()` / `org_window_start(n)`, never `current_date` or a bare `date_trunc` on `timestamptz`. The browser uses `todayIn(zone)`. | Migration 0132; grep guard test (§7) |
| R5 | **A wall time typed by a person is interpreted in the workspace zone**, and the zone is printed beside the input. | `wallTimeToInstant` / `instantToWallTime` |
| R6 | **Show the zone where a time could be ambiguous:** page headers of time-dense views, tooltips on relative times ("3h ago" → hover gives the full stamp + zone). | `<Time>` title attribute |
| R7 | **One formatting vocabulary:** `22 Sep 2026` · `22 Sep 2026, 2:30 pm` · `2:30 pm` · `Tue 22 Sep` · relative (`just now`, `5m ago`, `3h ago`, `2d ago`, then the date). The month table is fixed, not ICU, because ICU builds disagree on "Sep"/"Sept". The clock is 12-hour lowercase am/pm, matching the console's existing en-IN convention. | `S/time.ts` |

## 4. The pieces

### 4.1 `S/time.ts`: pure, shared by API, worker and web

| Export | Purpose |
|---|---|
| `DEFAULT_TIME_ZONE` | `"Asia/Kolkata"`, the same fallback the SQL uses |
| `isValidTimeZone(id)` / `canonicalTimeZone(id)` | Validate; fold aliases (`Asia/Calcutta` → `Asia/Kolkata`) |
| `zonedParts(instant, zone)` | `{year, month, day, hour, minute, weekday}` via `Intl.DateTimeFormat#formatToParts`, numeric parts only (identical across ICU builds). Formatters cached per zone. |
| `dayKeyIn(instant, zone)` / `todayIn(zone, now?)` | `YYYY-MM-DD` in the zone |
| `utcOffsetMinutes(zone, at)` / `formatUtcOffset(min)` | `330` → `UTC+05:30`; DST-correct at the given instant |
| `wallTimeToInstant("2026-09-22T18:00", zone)` / `instantToWallTime(iso, zone)` | For `datetime-local` inputs. Two-pass offset solve, so DST gaps and overlaps resolve to a real instant. |
| `formatDate` / `formatDateTime` / `formatTime` / `formatDayMonth` / `formatWeekdayDate` / `formatRelative` | R7 vocabulary |
| `formatDateKey(YYYY-MM-DD)` | R2: a calendar date formatted with no zone at all |
| `timeZoneOptions(now)` | The picker's catalogue: id, city, region, offset, search keywords (country names and common abbreviations for the zones this market uses) |

### 4.2 Database: migration `0132_org_time_standard.sql`

- `org_reporting_tz()` returns `text`: the current org's zone, else `Asia/Kolkata`. `org_reporting_today()` is re-expressed on top of it, with unchanged behaviour.
- `org_window_start(p_days int)` returns `timestamptz`: the start of the calendar day `today − (p_days − 1)` in the org's zone, as an instant. Computed as `((org_reporting_today() - (p_days - 1))::timestamp AT TIME ZONE org_reporting_tz())`, which is **DST-correct**: local midnight is converted with the offset in force *on that date*, not today's.
- Both are `STABLE`, read `app.org_id` like `org_reporting_today()`, and fall back rather than raise outside org context.

### 4.3 API

| Change | Where |
|---|---|
| `GET /v1/owner/time-settings`: `{ timezone, updatedAt }`, owner + manager | `api/owner/time-settings.controller.ts` (new) |
| `PUT /v1/owner/time-settings`: `{ timezone }`, **owner + manager**. Validated in Node (`isValidTimeZone`) and by the 0090 trigger (a zone Postgres lacks is a 400, not a 500). Writes the same audit line the business profile writes. | same |
| Business profile stops writing the zone: `timezone` is optional in `BusinessProfileInput` and ignored on PUT, so an old tab can no longer revert a change made on the Time zone page. The GET still returns it for display. | `S/business-profile.ts`, `api/owner/business-profile.controller.ts` |
| **Every tenant transaction runs on the workspace clock.** `withOrgContext` sets `TimeZone` to the org's `reporting_timezone` in the same message as `app.org_id`, so it costs no extra round trip. Inside it, `current_date`, `ts::date`, `date_trunc('day', ts)`, `to_char(ts, …)` and `$1::date` compared with a `timestamptz` all mean the org's midnight. The zone is read inline from `organizations`, not through 0132, so an API deployed ahead of its migration still boots. | `packages/db/src/index.ts` (`ORG_TIME_ZONE_SQL`) |
| That one change is what fixes the `current_date` sites the plan listed one by one: `reports.service.ts:253, :984`, `crm-sources.ts:301`, `targets.controller.ts:101, 185`, the targets' `stage_changed_at::date`, `analytics.controller.ts`'s daily series, and the report builder's `to_char(date_trunc(…))` buckets. They were left textually unchanged on purpose: one mechanism instead of a list that the next query would miss. | (no edit needed) |
| **Anything contractually UTC now says so**: billing periods and the ASR budget month use `date_trunc('month', now(), 'UTC')`. Billing's period end is added in UTC wall time, because `timestamptz + interval '1 month'` adds in the session zone and would drift an hour across DST. | `api/billing/billing.controller.ts`, `api/owner/plan-usage.controller.ts:51`, `apps/worker/src/pipeline/pipeline.ts:842` |
| Overview windows + days in the org zone | `api/owner/owner.controller.ts` (doc 29 §6) |
| The worker's `task.overdue` sweep runs on the admin pool, outside `withOrgContext`, so it now joins `organizations` and uses each org's own date for the predicate, `idleDays` and the dedupe key. `deal.idle` and `outreach_step.overdue` measure elapsed time; their day key only throttles, so they are unchanged. | `apps/worker/src/pipeline/automation.ts` |
| `guard-mounting.spec.ts`: +2 routes (452 / 390 / 414) | `api/../common/guard-mounting.spec.ts` |

### 4.4 Web

| Piece | What |
|---|---|
| `web/components/org-time.tsx` | `OrgTimeProvider zone` (mounted once in `app/(owner)/layout.tsx` from `membership.reportingTimezone`), `useOrgTimeZone()`, and `<Time iso mode>`, which renders the R7 text in the zone with the full stamp + zone in `title`. `formatRelative` depends on "now", so only that mode suppresses the hydration warning and refreshes once a minute. |
| `web/lib/org-time.ts` | `getOrgTimeZone()` for Server Components (reads the same membership) |
| `LocalTime` | Keeps its props. Inside an `OrgTimeProvider` it renders deterministically in the workspace zone (no flash). Outside one (operator console) it keeps today's browser-local behaviour. This upgrades all 28 existing uses at once. |
| `relativeTime(iso, zone)` | Zone parameter added; absolute fallback uses it |
| ~40 bare `toLocale*` sites in `W` | Replaced by `<Time>` or `formatInZone` |
| Next actions / follow-up queue | "Today" = `todayIn(zone)`, the API's `org_reporting_today()`. Due times through `formatTime`. |
| Call access window | `datetime-local` read and written through `wallTimeToInstant` / `instantToWallTime` in the zone, with the zone printed beside the inputs |

### 4.5 The picker: `/owner/account/time` ("Time zone", owner + manager)

It sits in the account menu between Business profile and Plan & usage. The page has two cards.

**1. "Your workspace clock"** shows the zone's city and id, the live local time (ticks each minute), and the UTC offset. Below that, a plain list of **what the setting governs**:
- every time shown in the console
- "today", overdue follow-ups and SLA clocks
- daily and hourly charts and report windows
- the plan's usage month

It also says **what it does not change**: stored times, due dates (dates are dates), and the handset app.

**2. "Change time zone"** is an accessible **combobox**, following the ARIA 1.2 pattern:
- `role="combobox"` on the input, `aria-expanded`, `aria-controls`, `aria-activedescendant`, a `listbox` of `option`s.
- ↑ ↓ Home End Enter Esc.
- Typing filters by **city, region, country, abbreviation or offset**: "dubai", "india", "IST", "+5:30", "utc+4" and "gmt-5" all match.
- Every option shows the city, its region path, its **current local time** and its **UTC offset**.
- Options are grouped by region.
- Two suggestions sit above the list: **this browser's zone** (when it differs from the workspace's; the one-click answer for an owner setting up from their own city) and the current zone.

**Picking a zone does not save it.** It opens a **preview** first:

> Now in Dubai: Tue 22 Sep, 1:00 pm (UTC+04:00), 1 h 30 m behind the current clock. "Today" will end at midnight Dubai time; overdue follow-ups, daily charts and reports re-count on that boundary. Stored times do not change, and you can switch back at any time.

Then **Save time zone** runs, with pending state and success/error feedback. After saving, the page and the layout's provider show the new clock on the next render.

**Why a combobox and not the old `<select>`:** 420 options with no search and no offsets is unusable. A person thinks "Dubai" or "+4", not "Asia/Dubai".

**Why a preview:** the change silently moves every day boundary in the product. Saying so before the save is cheaper than explaining an overnight jump in "overdue".

**Why owner and manager:** the request says so, and a manager runs the floor whose "today" this is. The API gates the PUT with `@RequireOwnerRole("owner", "manager")`, so the page gate is not the control.

## 5. Why the output is identical on server and browser

The three things that make `toLocaleString()` unstable are the **zone** (server UTC vs browser local), the **locale** (machine default), and **ICU data** (month abbreviations, ` ` before "pm" in newer ICU). The standard pins all three:
- The zone is always passed explicitly.
- Only *numeric* parts are read from `formatToParts`.
- Words (month names, am/pm, weekdays) come from fixed tables.

Two renders of the same instant in the same zone are therefore the same string on any machine. This is what lets `<Time>` drop `LocalTime`'s render-UTC-then-swap dance.

## 6. Verification

- `S/time.test.ts`:
  - day keys across the IST midnight (18:29Z vs 18:30Z)
  - DST spring-forward gap and fall-back overlap (`America/New_York`, `Europe/London`)
  - half- and quarter-hour offsets (`Asia/Kolkata`, `Asia/Kathmandu`)
  - wall-time round trips
  - alias folding
  - the formatting vocabulary
  - search matching ("ist", "+5:30", "dubai", "india")
- `web`:
  - `org-time` render test: the same text for the server and client renders, and the zone in `title`
  - next-actions tests with a zone-derived today
  - account-menu tests (the new item and its personas)
- API: time-settings controller spec (validation, persona gate) and `guard-mounting` counts.
- SQL: 0132 applied to a local database, with `org_window_start` checked against hand-computed instants for IST and a DST zone; overview batch executed (doc 29 §11.3). Needs Docker. If it was off, this is reported as not run.
- **Grep guard** (`web/app/console-time.test.ts`): no bare `toLocaleString(` / `toLocaleDateString(` / `toLocaleTimeString(` on a Date in `app/(owner)`. Number formatting (`n.toLocaleString()`) is recognised and allowed. This stops the drift coming back the way the palette test stops colour drift.

## 7. Delivery order

1. `S/time.ts` + tests; rebuild `@aura/shared` (the web and API consume `dist`).
2. Migration 0132.
3. API: time-settings routes, business-profile change, SQL fixes, worker fix, guard counts.
4. Web: provider + `<Time>` + `LocalTime` upgrade + `relativeTime`; then the call-site sweep; then next-actions and call-access; then the picker page + account menu.
5. Grep guard test.
6. Doc 29's dashboard on top.

## 8. Out of scope, deliberately

| Area | Why left alone |
|---|---|
| Operator console `app/(platform)`, `app/(admin)` | Operators work across tenants. One tenant's clock would be wrong for the next row. It keeps the viewer's local time via `LocalTime`'s no-provider path; a later pass could print an explicit zone there. |
| Billing periods (`api/billing`), ASR budget month (`apps/worker/src/pipeline/pipeline.ts:842`) | Metered against the platform's UTC month by contract. `plan-usage.controller.ts:74-77` documents the one place the two meet. |
| Android handset app | It reports instants (epoch millis). Nothing it sends is a wall time. |
| Scheduled report delivery / cadences | They already schedule in instants. Their "send at 9 am" wording would be a separate feature, not a display fix. |
| `W/integrations` call sites | Owned by the doc 28 session at the time of the sweep. They all use `LocalTime`, which now renders in the workspace zone, so they needed no edit. (`messaging-setup-client.tsx:165` was migrated after that session finished.) |
| `W/insights/insights-sections.tsx` `callTime` | Already passes the org zone. It still reads the am/pm *word* from Intl's `dayPeriod`, which can differ between ICU builds (R7's reason for fixed tables). That's a cosmetic follow-up, not a zone bug. |

## 9. Build record (2026-09-22)

**What was built:**
- `S/time.ts` + 24 tests.
- Migration 0132.
- `ORG_TIME_ZONE_SQL` in `withOrgContext`.
- `GET/PUT /v1/owner/time-settings` (owner + manager) + spec.
- The business profile no longer writes the zone.
- `OrgTimeProvider` / `<Time>` / `getOrgTimeZone()`, and the `LocalTime` upgrade.
- `relativeTime(iso, zone)`.
- ~40 owner-console call sites migrated.
- "Today" is the workspace's date in Next actions, Task list, Task browser, the follow-up queue and the Reports overdue card.
- `localToday()` deleted.
- Call-access `datetime-local` inputs read and written in the workspace zone.
- The `/owner/account/time` picker page + loader + account-menu entry.
- `app/console-time.test.ts` guard.

**Verified:**

| Check | Result |
|---|---|
| 0132 on local Postgres 16 | IST window starts at 18:30Z; London uses the offset in force on each date across 25 Oct; no org context falls back to Asia/Kolkata |
| `withOrgContext` live, as `aura_app` | Each org's transaction reports its own `TimeZone`; `current_date` = `org_reporting_today()`; a pooled connection is back on UTC after COMMIT |
| Picker, driven in headless Chrome (real component, esbuild bundle, save action mocked) | "india" and "IST" → Kolkata first; "+5:30" → exactly Colombo and Kolkata; "zzqq" → the empty message; ArrowDown/ArrowUp/Enter select; the preview states "4 h 30 m behind the current clock (Kolkata)"; save sends `Europe/Dublin` and the clock re-renders |
| Suites | shared 1252/1252, db 78/78, worker 364/364 + typecheck, web 889/889 + typecheck; API 739 passed / 5 skipped across 46 suites + typecheck |

**Not done / follow-ups:**
- `web` lint has 8 pre-existing warnings in files this work did not touch (admin provisioning, import page, operator pages, a test), so `lint --max-warnings=0` fails on the tree as it stands.
- Nothing here is committed or deployed. 0132 must run before the new API, because `org_window_start()` is used by the dashboard's SQL.
