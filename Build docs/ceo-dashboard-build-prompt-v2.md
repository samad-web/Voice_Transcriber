# Build Prompt v2 — Owner Console Expansion (Aura Call Intelligence)

> Rewritten against `07_WEBAPP_OVERVIEW.md`. This is a **delta spec** for `platform/apps/web/app/(owner)` plus its supporting API/worker/db work — not a greenfield build.
> Companion docs: `02_BACKEND_DESIGN.md`, `06_HARDENING_PLAN.md`.
> Branch context: `crm-connectors-and-console-auth`.

---

## 0. What changed from v1 of this prompt

The first draft was written blind and assumed a conventional CRM. The codebase is not that. Corrections now baked in:

| v1 assumed | Aura reality | Consequence |
|---|---|---|
| Leads are manually created / arrive from web forms | Leads are **projected from analyzed calls** (`ingest → transcode → ASR → analyze → lead-project → CRM dispatch`) | No lead-creation UI. Lead quality is downstream of ASR + the active extraction agent. |
| Telephony/CTI provider, click-to-call, auto-dialer | **Passive capture** via an enrolled Android app | No dialer-control automation nodes. Automations act on *records and integrations*, never on placing calls. |
| Build a Kanban + list from scratch | `/owner/board` and `/owner/leads` already exist and work | Extend, don't rebuild. Board already has optimistic DnD + rollback. |
| WebSockets for real-time | App has no WS layer; Calls Explorer polls every 4s (capped 30) | Reuse the polling + `revalidatePath` pattern. Do not introduce a WS gateway. |
| ClickHouse/Timescale for analytics | Postgres via `packages/db` with RLS | Rollups are Postgres materialized views + worker cron. No new datastore. |
| Client-side REST calls, TanStack Query, Zustand | **Zero client REST anywhere.** Server Actions only; URL is the shared state | No data-fetching or client-state library. `useState`/`useTransition` + `searchParams`. |
| Generic Tailwind/shadcn UI | Tailwind v4 CSS-only config + `@aura/ui` neo-brutalist | New components go in `@aura/ui`, `rounded-none`, offset shadows, three-font system. |
| Build AI call scoring from scratch | **Agent Studio already compiles typed extraction schemas** | Coaching/QA scoring becomes a versioned extraction agent, not new infrastructure. |
| Build integration plumbing for outbound actions | CRM connector catalogue already handles provider specs, auth variants, field maps, delivery log, retry/dead-letter | Outbound automation nodes reuse that machinery. |

---

## 1. Objective

Expand the customer-facing `(owner)` console from three read-mostly pages into a **self-configurable business console** that lets a customer's CEO/owner answer four questions without contacting Sirah:

1. **How are my telecallers performing, and what specifically must each of them improve?**
2. **Where are my leads, in whichever view I prefer — board or list — with views I've saved myself?**
3. **Is the business healthy, measured on fields *I* chose?**
4. **What's unfinished, and can the system finish it for me?** — via a visual automation builder.

Every new tenant provisioned at `/instances/new` must land on a **populated, working** version of all four, seeded automatically, then reconfigurable by the owner.

---

## 2. Current state → target state

| Capability | Today | Target | Size |
|---|---|---|---|
| Owner KPI dashboard | `/owner`: open leads, pipeline value, win rate, talk time, funnel, calls/leads chart, telecaller leaderboard, activity feed — **fixed layout** | Same metrics as a *seeded default*, on a **configurable widget canvas** | L |
| Kanban board | `/owner/board`, native HTML5 DnD, optimistic + rollback | + configurable stages, WIP limits, stage SLA aging, swimlanes, saved views, **view toggle to list** | M |
| Lead list | `/owner/leads`, filter/sort/paginate, URL-state, deep-linkable | + column chooser, bulk actions, saved views, **view toggle to board** | M |
| Telecaller performance | Leaderboard tile only | Full module: drill-down, trends, coaching engine | L |
| Business health review | — | New module: metric catalog, custom metric builder, targets, health score, digests | XL |
| Automations | — | New module: node canvas + execution engine on `packages/queue` | XL |
| Owner nav | 3 items | 6 items | S |
| Per-tenant seeding | `/instances/new` creates org + workspace + instance + enrollment key | + seeds dashboards, views, pipeline, metrics, flow templates | M |
| Owner-side roles | Single owner persona; `/team` is operator-side only | Owner-scoped roles: Owner, Manager, Telecaller (read-own) | M |

---

## 3. Non-negotiable constraints

These are properties of the existing app. Violating any of them is a defect, not a tradeoff.

1. **No client-side `fetch` to the API.** Browser → Server Action (`"use server"`) → `lib/server-api.ts` → NestJS. `ADMIN_API_KEY` never reaches the browser.
2. **Owner pages never read `?org=`.** Org comes only from `lib/owner-context.ts` via the verified Supabase session's membership. Any new owner route that accepts a tenant id from the client is a tenant-isolation bug.
3. **`resolveTenantScope()` is operator-side only.** Do not import it into `(owner)`.
4. **Mutations call `revalidatePath(...)`** after the API write. Optimistic UI must roll back on rejection, as `/owner/board` already does.
5. **URL is the state container** for filters, date windows, grouping, and active view. Everything must stay deep-linkable and shareable.
6. **`apiGetAs`/`apiGetAdmin` return `null` on failure** — every new panel renders an "API offline" card, never throws.
7. **`cache: "no-store"`** on all API fetches.
8. **Design system**: `@aura/ui` only. `border-2`/`border-4 border-black`, `rounded-none` everywhere, `shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]` cards / `[2px_2px_...]` buttons, off-white `#F9F9F9` ground, red = destructive only, green only inside black `ConsolePanel`, Space Grotesk bold-uppercase headings, `MonoLabel` for ids/timestamps/micro-labels, `border-b-2`/`divide-y-2` ledger tables. No Tailwind config file — extend `@theme` in `app/globals.css` if tokens are genuinely needed.
9. **Every new owner route gets a nav entry** so `loading.tsx`'s longest-prefix title matching resolves, and so the nav array remains the second layer of route gating.
10. **No new client state or data library.** If a piece of state feels like it needs Zustand, it belongs in the URL or in a server component.

### 3.1 Two dependency decisions to make explicitly

- **Charts.** `recharts` is already a dependency but unused — every chart today is hand-rolled `<div>` bars. Scorecards, sparklines, and simple bars should stay hand-rolled (they're cheap and on-brand). **Adopt `recharts` for the new module only** where hand-rolling is unreasonable: funnels with stage-leak labels, heatmaps, cohort grids, multi-series trends with comparison overlays. Wrap it in `@aura/ui/chart` with brutalist defaults (square caps, `border-2 border-black` frame, no gradients, no rounded bars, mono tick labels) so call sites can't drift.
- **Flow canvas.** React Flow is the pragmatic choice for the node editor but is a heavy addition. Load it via `next/dynamic({ ssr: false })` so it never enters the shared bundle, and skin nodes brutalist (square nodes, 2px black borders, offset shadows, mono port labels). If bundle budget forbids it, fall back to a constrained **vertical step-list builder** — same execution engine, no canvas. Decide before starting Module D; do not build both.

---

## 4. Routes & navigation

```
(owner)                    — layout redirects non-owners to /dashboard
  /owner                   → EXISTING dashboard → becomes configurable canvas (Module C surface)
  /owner/board             → EXISTING Kanban → + stage config, SLA aging, saved views
  /owner/leads             → EXISTING list  → + column chooser, bulk actions, saved views
  /owner/team              → NEW  telecaller performance: leaderboard, drill-down, coaching
  /owner/team/[agentId]    → NEW  single telecaller profile
  /owner/health            → NEW  business health review (multiple named dashboards)
  /owner/health/[boardId]  → NEW  a specific health dashboard
  /owner/automations       → NEW  flow list + run history
  /owner/automations/[id]  → NEW  flow editor
  /owner/settings          → NEW  pipeline stages, SLAs, metric targets, digest schedule,
                                   owner-side team roles, lead field visibility
```

**Owner nav grows 3 → 6**: Dashboard · Lead Board · All Leads · Team Performance · Health Review · Automations. Settings sits in the sidebar footer, not the main array. Keep the nav deliberately narrow — resist adding a seventh.

`/owner/health` and `/owner/automations` are **owner+manager only**; telecallers (once the owner-side role model lands, §9) get `/owner`, `/owner/leads` scoped to self, and `/owner/team/[their own id]`.

---

## 5. Module A — Telecaller performance & coaching (`/owner/team`)

This is the module Aura is uniquely positioned to build, because the data is *call content*, not CRM activity logs. Lean on that.

### A.1 Metrics available from existing pipeline output

Derive from `calls`, their analysis output, and projected leads — do not invent new capture requirements.

**From call records:** call count (in/out), total + average talk time, calls per active day, first-response latency on inbound, contact-attempt depth per counterparty (the existing "N in / M out" and ordinal "3rd call" labeling already computes this), follow-up-flagged call count.

**From AI analysis:** sentiment distribution, outcome distribution, action-items generated vs. action-items closed, key-point density, and any typed fields the tenant's **active extraction agent** emits (objection raised, budget discussed, competitor named, next-step committed — whatever their agent schema declares).

**From projected leads:** leads projected per agent, qualification rate, stage progression, win rate, pipeline value, average deal value, cycle length, stale-lead count, SLA breaches.

**From pipeline health:** calls stuck or failed mid-pipeline attributable to an agent's device — surfaces a *device* problem masquerading as a performance problem, which matters and is easy to misread.

### A.2 Leaderboard (module landing)

Ledger table, `divide-y-2`, sortable by any column, each numeric cell carrying a hand-rolled sparkline of the trailing 14 days and a delta chip vs. the previous window. Date window in `searchParams`, matching the existing owner-dashboard window control. `StatusChip` for the agent's device/enrollment state so an offline capture device is never mistaken for an idle telecaller.

### A.3 Agent drill-down (`/owner/team/[agentId]`)

- Hourly activity heatmap (day × hour) from call timestamps
- Their leads' funnel with per-stage leak percentages
- Trend charts for every A.1 metric with **team-median and top-quartile overlays**
- Their call log — reuse the existing Calls Explorer + drawer components rather than writing a second call table; scope it to the agent and hide operator-only affordances (Reprocess, raw AI JSON, Load-Audio) behind role
- Sentiment/outcome mix over time
- Action-item follow-through rate

### A.4 "What must improve" engine

Not charts — **ranked, evidenced findings**. Store rule definitions as tenant-editable rows (`coaching_rules`), evaluate them in a worker cron, persist results to `coaching_findings`.

| Signal | Default condition | Diagnosis | Suggested action |
|---|---|---|---|
| Low connect / high no-answer | Connected share < 60% of team median | Wrong call windows or bad numbers | Show their best-converting hour blocks from the heatmap |
| High volume, low conversion | Calls top-quartile, win rate bottom-quartile | Pitch or objection handling | Queue 5 of their calls for review with transcript |
| Long talk time, low close | Avg talk > 1.5× median, win rate below median | Not disqualifying early | Enforce qualification fields in the extraction agent |
| Negative sentiment skew | Negative share > 2× team median | Tone / handling | Pull the 3 worst-sentiment calls with timestamps |
| Action items unclosed | Closure rate < 70% | Commitments dropped | Auto-create follow-up tasks via automation template |
| Follow-up flagged, never actioned | Follow-up call with no subsequent contact in N days | Pipeline leakage | Trigger the stale-lead flow |
| No next-step committed | Extraction agent's `next_step` field null on > 40% of calls | Weak closes | Script coaching; make the field required in the agent schema |
| Declining trend | Any core metric down > 15% over 3 consecutive weeks | Disengagement | Prompt a 1:1 |
| Device/pipeline failures | > 10% of their calls fail ingest or ASR | **Not a performance issue** | Route to operator; show device health |

Each finding renders as a card: **Agent → Problem → Evidence (actual number + comparison) → Suggested action → [Create automation] [Open calls] [Dismiss]**. "Create automation" deep-links into Module D with a pre-filled template.

### A.5 AI call QA scoring — reuse Agent Studio

Do **not** build a parallel scoring service. Ship a **`call-qa` extraction agent template** in the Agent Studio catalogue: a system prompt plus typed fields (`greeting_quality: enum`, `discovery_depth: number`, `objection_handled: boolean`, `next_step_committed: boolean`, `compliance_phrases_present: boolean`). It compiles through the existing `@aura/shared` schema compiler to the active provider's `responseSchema`, versions like any other agent, and can be sandboxed against a stored call before activation.

Roll the emitted fields into an agent-level quality score and feed it to A.4 as another signal. **The entire module must degrade gracefully when no QA agent is active** — hide score columns, keep every non-AI metric working.

### A.6 Identity prerequisite

Per-agent analytics need a stable telecaller identity joining device → user → call. The existing telecaller leaderboard implies one exists; **verify it before building**, and if agents are currently only device-bound, add a `telecallers` table with device and (optional) Supabase-user linkage first. Flag this as the module's blocking dependency.

---

## 6. Module B — Lead workspace upgrades

### B.1 Unify board and list behind one view model

`/owner/board` and `/owner/leads` currently fetch independently. Extract a shared server-side `resolveLeadView(searchParams, orgId)` returning `{ filters, sort, grouping, columns, renderer, pagination }`, and let both routes render from it. Add a header toggle that swaps `renderer` — same URL state, different renderer. Persist the last-used renderer per user as their default.

### B.2 Configurable pipeline

Stages currently come from the lead-projection logic. Promote them to tenant config in `/owner/settings`: name, color, order, terminal win/lost flag, **stage SLA in hours**. `lead-project` in the worker must map its output to the tenant's configured stages rather than a hardcoded enum — this is the one backend change with real blast radius, so gate it behind a per-tenant flag and keep the current enum as the seeded default.

Board columns then show count, total value, WIP-limit warning, and cards render an SLA aging indicator (black → yellow band → red band, per the palette — not a rainbow gradient).

### B.3 List upgrades

Column chooser (resize/reorder/hide, persisted in the saved view), multi-column sort, bulk select with bulk actions (reassign owner, change stage, tag, export CSV, run a flow), and inline edit on the few safely-editable fields (owner, stage, priority, tags). Keep the ledger-table styling.

### B.4 Saved views

Any `{filters, sort, grouping, columns, renderer}` combination saveable as a named view. Private by default, shareable to the org, one settable as the user's landing view. **Seed these at provisioning:** My Leads · Unassigned · High Value · Stale > 7 Days · SLA Breached · Follow-Up Flagged · Closing This Week.

The saved view is just a serialized query string plus metadata — which keeps it consistent with the URL-as-state model rather than introducing a parallel one.

### B.5 Scale

Virtualize both renderers. Server-side filter/sort/paginate with cursor pagination (the list is already paginated — extend the same contract to the board, loading columns lazily rather than fetching the whole pipeline). Since leads are call-derived, realistic per-tenant volume is bounded by call volume; target **smooth at 25k leads / 100k calls per tenant** rather than the arbitrary 50k in v1.

---

## 7. Module C — Business health review (`/owner/health`)

The requirement is that the owner picks the fields. Ship the engine plus a strong default.

### C.1 Metric catalog

Server-defined catalog (`metric_definitions`), each with id, label, unit, aggregation, source entity, and target direction. Seed groups:

- **Pipeline** — leads projected, qualified, won, lost, win rate, pipeline value, weighted pipeline, avg deal value, cycle length, stage conversion rates
- **Calls** — total calls, inbound/outbound split, talk time, avg call duration, calls per agent per day, follow-up-flagged share
- **AI/quality** — sentiment mix, outcome mix, action-item closure rate, QA score (when a QA agent is active), extraction confidence
- **Hygiene** — stale leads, unassigned leads, overdue follow-ups, SLA breaches, calls with failed analysis
- **Team** — active telecallers, utilization, revenue per agent, leaderboard spread
- **Delivery** — CRM dispatch success rate, dead-lettered deliveries, retry volume *(this is genuinely differentiating — the owner can see their CRM sync health, which no generic dashboard offers)*

### C.2 Custom metric builder

No-code: pick source entity (call / lead / agent / delivery) → filters → aggregation (count, sum, avg, min, max, distinct, ratio, percentile) → unit and precision → up-is-good flag → target and healthy/warning/critical thresholds. Plus **formula metrics** composing other metrics (`pipeline_value / calls_total` → "Pipeline per Call").

Compile definitions to parameterized SQL server-side against a whitelisted column set. **Never accept raw SQL from the client** — a metric definition is structured JSON, validated with a `zod` schema in `packages/shared`, and any unknown field is rejected. This is the module's primary injection surface; treat it that way.

### C.3 Widget canvas

12-column grid, drag-to-place, resize, reorder, duplicate, delete. Since there's no client state library, hold layout in `useState` during editing and commit the whole layout through one Server Action on save — no per-drag round trips.

Widget types: `StatCard` scorecard (big number + delta + sparkline) · trend line/area · bar / stacked bar · funnel with leak labels · gauge vs. target · leaderboard table · heatmap · pivot table · traffic-light health grid · text/annotation block · **embedded saved lead view** · **embedded coaching findings**.

Every widget drills through to the underlying leads or calls — reusing the existing lead list and call drawer, not new detail screens.

### C.4 Health score, digests, alerts

- **Business Health Score 0–100**: weighted roll-up of chosen metrics against their targets, owner-set weights, displayed with the top 3 contributors and top 3 detractors in plain sentences.
- **Multiple named dashboards** per tenant (Daily Standup, Monthly Review), each with its own layout, window, and audience.
- **Scheduled digest**: daily/weekly/monthly render to PDF, delivered by email at a tenant-timezone hour. Worker cron job; reuse whatever mail path the platform already uses for owner-login credentials.
- **Threshold alerts** fire a notification and can trigger a flow (Module D).

### C.5 Query performance

Dashboard queries must hit **pre-aggregated rollups**, never raw call scans. Add hourly and daily materialized views (`mv_agent_daily`, `mv_lead_daily`, `mv_calls_hourly`) refreshed by a worker cron, with RLS applied. Budget: dashboard first paint < 1.5s, widget refresh < 500ms, board interaction < 100ms. Because pages are RSC, a slow widget blocks the page — **stream widgets with `<Suspense>` and per-widget skeletons** so one heavy query can't hold the whole dashboard.

---

## 8. Module D — Automations (`/owner/automations`)

### D.1 Engine first, canvas second

Build and test the execution engine before any UI. It runs in `apps/worker` on `packages/queue` (RabbitMQ), consuming pipeline events the platform already emits.

**Triggers** — `call.analyzed` · `lead.projected` · `lead.stage_changed` · `lead.field_updated` · `call.follow_up_flagged` · `lead.idle_for(N days)` · `sla.breached` · `metric.threshold_crossed` · `crm.delivery_failed` · `schedule.cron` · `webhook.inbound` · `manual`

**Conditions** — if/else with the same filter builder as saved views · switch/router · wait-until

**Internal actions** — assign/reassign owner (round-robin / load-balanced) · change stage · set field · add/remove tag · set priority · create task · schedule follow-up · add note · escalate to manager · **re-dispatch to CRM** · **re-run analysis with a different agent version**

**External actions** — **reuse the CRM connector catalogue**: an outbound node targets a connected integration or a custom webhook, inheriting the existing bearer/header/header-prefix/basic/query auth variants, field-map editor, live payload preview, delivery log, and retry/retry-all-dead. Do not write a second HTTP-integration layer. Email/SMS/WhatsApp arrive later as catalogue providers, not as bespoke nodes.

**Utility** — delay · loop · merge · set variable · stop. **A sandboxed code node is out of scope for v1** — it's a tenant-code-execution surface and the platform has no sandbox today.

**Execution guarantees** — at-least-once with idempotency keys, exponential backoff, dead-letter queue, per-tenant rate limits so one runaway loop can't starve the fleet, and a hard cap on flow depth and per-run node count.

### D.2 Editor

Draft/published states, version history, enable/disable, and a **run log** listing each execution with per-node input/output, duration, and error, plus manual retry — visually identical to the CRM delivery log so owners learn one pattern. Render node JSON in the existing black/green `ConsolePanel`.

### D.3 Seeded flow templates (disabled by default)

1. **Follow-up enforcer** — call flagged follow-up → no further contact in 48h → notify owner → 5d → escalate to manager
2. **Stale lead rescue** — lead idle 7d → nudge owner → 10d → return to unassigned pool
3. **Hot lead fast lane** — value above threshold or positive sentiment + next-step committed → priority high, notify owner, re-dispatch to CRM immediately
4. **Unclosed action items** — action items open > 3d → digest to the owning agent
5. **CRM delivery rescue** — delivery dead-lettered → alert owner → auto-retry with backoff → escalate to operator after N failures
6. **Analysis failure watch** — call fails ASR/analyze twice → flag the device, notify owner
7. **Coaching trigger** — new coaching finding of severity high → create task, notify manager
8. **Daily owner digest** — 8 AM tenant-time: yesterday's calls, pipeline movement, top 3 risks
9. **Health alert** — win rate down > 15% WoW → alert with drill-through link

### D.4 "Finish what you already have"

**(a) Setup completion rail** — persistent progress strip on `/owner` showing completeness with the next 3 highest-impact steps: enroll devices → confirm telecaller identities → configure pipeline stages → set SLAs → activate an extraction agent → connect a CRM → pick health metrics → set targets → enable first automation → schedule first digest. Each deep-links to the exact screen, skippable, hides at 100%, retrievable from settings.

**(b) Unfinished business panel** — hourly worker scan of real tenant data, surfaced on `/owner`:

- N calls stuck or failed mid-pipeline *(this data already exists — the call drawer shows pipeline status with failure reason and retry ETA)*
- N CRM deliveries dead-lettered
- N leads unassigned
- N follow-up-flagged calls with no subsequent contact
- N action items past due
- N leads with no activity ever
- N calls analyzed before the current agent version *(→ offer bulk reprocess)*
- N drafted flows never published

Each row: count, impact estimate ("≈₹4.2L pipeline at risk"), and a **Fix it** button that runs a bulk action or opens the matching pre-filled flow template.

---

## 9. Owner-side roles

`/team` today is operator-side, per selected tenant. The owner console assumes a single persona. Introduce **owner-scoped roles** — Owner, Manager, Telecaller — resolved in `lib/owner-context.ts` from the membership record so no new trust path appears.

- **Owner**: everything, including settings, health config, automations
- **Manager**: everything except billing-adjacent settings and destructive config; team scope limited to their reports
- **Telecaller**: `/owner` (personal), `/owner/leads` filtered to self, `/owner/team/[own id]` — no health config, no automations, no other agents' data

Enforce **server-side on every API endpoint**, not by hiding nav items. Nav filtering is defense-in-depth, matching the existing pattern where an owner "cannot navigate to an operator route because it's not in their nav array."

---

## 10. API & data model additions

**New/extended NestJS modules** (`apps/api` already has `admin, agents, analytics, auth, billing, calls, crm, devices, owner, tenancy`):

- `owner` — extend: saved views, pipeline stage config, bulk lead actions, owner-role resolution
- `analytics` — extend: agent metrics, rollup reads, metric-definition evaluation, health score
- `dashboards` — **new**: dashboard CRUD, widget layout, metric definitions, digest schedules
- `automations` — **new**: flow CRUD, versioning, run history, manual trigger
- `coaching` — **new**: rule CRUD, findings read, dismiss

**Migrations** (`packages/db`, **every table RLS-scoped by org**):

```
telecallers                (if not already present — see §A.6)
pipeline_stages            org, name, order, color, terminal_kind, sla_hours
saved_views                org, owner_user, name, query_json, renderer, visibility, is_default
dashboards                 org, name, layout_json, window_default, audience
dashboard_widgets          dashboard, type, metric_ids, config_json, grid_position
metric_definitions         org|system, source_entity, aggregation, filters_json, formula, unit,
                           target, thresholds_json, up_is_good
health_scores              org, computed_at, score, contributors_json
coaching_rules             org, signal, condition_json, severity, enabled
coaching_findings          org, telecaller, rule, evidence_json, status, computed_at
automations                org, name, graph_json, version, state, enabled
automation_runs            automation, trigger_payload, status, started_at, finished_at
automation_run_nodes       run, node_id, input_json, output_json, duration_ms, error
onboarding_progress        org, step_key, status, completed_at
mv_agent_daily / mv_lead_daily / mv_calls_hourly   (materialized, cron-refreshed)
```

All request/response shapes and the metric-definition and flow-graph schemas go in `packages/shared` as `zod` schemas, consumed by api, worker, and web — matching how the CRM provider catalogue and agent schema compiler already work.

---

## 11. Auto-provisioning

Extend the `/instances/new` provisioning transaction (currently org + workspace + instance + enrollment key). Idempotent, transactional, rolled back wholly on failure:

1. Seed **owner roles** (Owner/Manager/Telecaller) with the default permission matrix
2. Seed **default pipeline stages** with SLAs, matching the current lead-projection enum
3. Seed **7 saved views** (§B.4)
4. Seed **"Owner Overview" dashboard** replicating today's `/owner` layout — open leads, pipeline value, win rate, talk time, funnel, calls/leads chart, telecaller leaderboard, activity feed — **plus** the coaching-findings panel, unfinished-business panel, and setup rail
5. Seed **"Weekly Review" dashboard** (empty-ish, prompts the owner to pick metrics)
6. Seed **system metric catalog** with targets blank and a prompt to set them
7. Seed **coaching rules** with defaults from §A.4, enabled
8. Seed **9 flow templates**, disabled
9. Seed **onboarding_progress** with all steps pending
10. Suggest a `call-qa` extraction agent in Agent Studio, unactivated
11. Emit `tenant.provisioned`

**Day-zero problem:** a brand-new tenant has zero calls, so every dashboard is empty until devices enroll and calls flow. Do **not** seed fake sample leads into real tables. Instead render a **demo-mode dashboard** — the real layout populated from a static fixture, clearly banded with a yellow warning banner ("Sample data — enroll a device to see your own"), which disappears permanently on the first successfully analyzed call. This preserves the "never an empty screen" goal without polluting tenant data or corrupting early metrics.

**Personalization at signup:** at most 4 questions (industry, team size, primary use case, main goal) driving which dashboard preset, stage set, and flow templates get seeded. Nothing longer — the operator-side `/instances/new` form is already dense.

---

## 12. Prerequisites & risks

Pull from `06_HARDENING_PLAN.md` before starting:

- **`/admin` is ungated** (`TODO` pending `platform_admin` role once OIDC lands). Not this module's scope, but it must not be the pattern any new route copies.
- **Several pages are still pinned to `DEV_ORG_ID`.** No new owner surface may depend on `adminHeaders`; use `orgHeaders(orgId)` derived from the session throughout.
- **`AUTH_ENABLED=false` local-dev mode leaves the app fully open.** The seed/demo path must not assume auth is on.
- **Telecaller identity model** (§A.6) is the hard blocking dependency for Module A — resolve it first.
- **Configurable pipeline stages** (§B.2) touch `lead-project` in the worker — the highest-blast-radius change here. Flag-gate it.
- **Metric builder = SQL generation.** Whitelist columns, validate with `zod`, parameterize everything, and write injection tests before shipping it.

---

## 13. Build order

1. Telecaller identity + owner-side roles + RLS migrations *(unblocks everything)*
2. Rollup materialized views + cron refresh
3. Module A: leaderboard → drill-down → coaching rules engine → findings UI
4. Module B: shared view model → view toggle → saved views → column chooser → bulk actions
5. Configurable pipeline stages + SLA aging *(flag-gated)*
6. Module C: metric catalog → widget canvas → custom metric builder → targets → health score → digests
7. Module D: execution engine + run log → templates → editor UI
8. Provisioning seeds + demo mode + setup rail + unfinished-business panel
9. `call-qa` agent template and QA score integration
10. Performance pass, load test, tenant-isolation test suite

---

## 14. Acceptance criteria

- [ ] A tenant provisioned at `/instances/new` opens `/owner` on a fully populated layout — demo-banded before its first call, real data after — with zero manual configuration.
- [ ] The owner adds, resizes, reorders, and removes widgets, and defines a formula metric with a target, without engineering help.
- [ ] Any lead view toggles board ⇄ list with identical filter state, saves as a named view, and is settable as the user's default.
- [ ] Kanban drag persists, reflects the tenant's configured stages, and still rolls back cleanly on API failure.
- [ ] `/owner/team` names a specific telecaller, a specific weakness, the supporting number, and a one-click remediation — and correctly attributes device/pipeline failures as *not* performance problems.
- [ ] The whole of Module A works with no QA agent active; QA columns simply hide.
- [ ] A flow can be built, published, triggered by a real `call.analyzed` event, and inspected node-by-node in the run log; a failing outbound node dead-letters and retries through the existing CRM delivery machinery.
- [ ] The unfinished-business panel reflects real tenant state and each Fix-it button completes the work.
- [ ] **Zero client-side `fetch` calls to the API exist in the new code.** `ADMIN_API_KEY` never appears in a client bundle.
- [ ] No owner route accepts an org id from the client. A signed-in owner of Tenant A cannot read one row of Tenant B under any endpoint, filter, saved view, metric definition, or flow configuration.
- [ ] Metric-definition injection tests pass against a hostile fixture set.
- [ ] `/owner` first paint < 1.5s with widgets streamed under `<Suspense>` at 25k leads / 100k calls.
- [ ] Every new surface renders an "API offline" card when `apiGetAs` returns `null`.
- [ ] Visual review: no rounded corners, no blurred shadows, no off-palette color, headings in Space Grotesk uppercase, ids/timestamps in `MonoLabel`.

## 15. Out of scope (v1)

Sandboxed code node · marketplace for third-party flow nodes · WebSocket real-time (polling is sufficient) · per-tenant theming beyond logo and accent · owner-facing SQL editor · replacing the operator console's tenant tooling · native mobile (responsive web only, with a genuinely usable phone layout for `/owner`).
