# Hawcus CRM — Structural Teardown and Gap Analysis vs Aura

**Target:** `https://crm.digygo.in` — "Hawcus CRM", tenant *DittoMart*, signed in as an Owner.
**Captured:** 2026-09-07, automated Chromium crawl over CDP, read-only.
**Coverage:** 41 pages, 42 sidebar entries, 74 distinct API endpoints, 0 navigation errors.
**Compared against:** Aura platform, branch `crm-connectors-and-console-auth` — 28 owner-console nav
entries, 37 owner page routes, 73 API controllers / 168 route decorators, 110 tables.

---

## 0. How this was captured, and what the evidence is worth

A headful Chromium was launched on a **clean, empty profile** with the CDP port open; a human signed
in by hand. No credentials were scripted, and nothing was read out of the real Chrome profile.
The crawler walked every same-origin link breadth-first (max 2 exemplars per route template),
recorded each page's nav tree, headings, table columns, tabs, buttons, form fields and stat tiles,
took a screenshot, and — from XHR traffic — recorded **JSON key names only, never values**. So this
document describes Hawcus's *shape*, not DittoMart's customer data.

**Evidence grades used below:**

- **[O]** Observed directly — a rendered page, a column header, a captured form field.
- **[A]** API-attested — a key name in a live response payload. Strongest evidence for the data model.
- **[I]** Inferred — a reasonable reading of [O]/[A], flagged wherever the inference could be wrong.

### 0.1 Disclosure: three unintended writes

The crawler was built to open "Add/New/Create" buttons to capture their field schemas and then press
Escape, with a denylist that blocked Save/Send/Delete/Import/Export/Assign. That guard held for
every modal-based form. It **did not** hold on two pages that use a *create-record-first* pattern,
where the button POSTs a draft immediately and then opens an editor. The complete set of writes:

| Request | Count | Effect |
| --- | --- | --- |
| `POST /api/workflows` | 1 | Created workflow **"Untitled Automation"** — Draft, unpublished, 0 nodes, 0 contacts |
| `POST /api/whatsapp-personal/sessions` | 2 | Created 2 device rows — phone `-`, status *Connecting*, 0 messages |
| `POST /api/whatsapp-personal/sessions/:id/connect` | 2 | Opened a QR-pairing attempt on those 2 rows |

There were **no** PUT, PATCH or DELETE requests during the crawl, and **no message-send calls of any
kind**. No contact, lead, deal or conversation was modified, and nothing was transmitted to any
third party. Workflow count went 5 → 6; device count went 1 → 3. All three records were inert: the
workflow was an unpublished Draft that could not fire, and the two sessions had no linked phone.

**Cleanup completed** the same session, with the account owner's approval, through the product's own
UI (each behind a "type DELETE to confirm" gate):

```
DELETE /api/workflows/319a99bc-…                     -> 200
DELETE /api/whatsapp-personal/sessions/0d6c9f69-…    -> 200
DELETE /api/whatsapp-personal/sessions/9b139e24-…    -> 200
```

Verified restored: **5 Total Workflows / 3 Active / 2 Inactive**, and **1 device**
(the pre-existing one, untouched). The tenant is back to its pre-crawl state.

**The generalisable lesson, which applies to Aura too:** "Create" is not a read-only verb. A crawler
denylist keyed on *button text* cannot distinguish a modal opener from a POST, because both say
"Create". The correct guard is at the transport layer — block non-GET requests via CDP request
interception — not at the click layer. That is a one-line fix and should be in place before any
future crawl.

---

## 1. Architecture at a glance

| Dimension | Hawcus | Aura |
| --- | --- | --- |
| Shape | SPA + `/api/*` REST tier **[A]** | Next.js console + NestJS API tier |
| Auth | Bearer token in `localStorage` (`dg_tok`, `dg_usr`, `dg_ten`) **[O]** — raw cookie fetch returns `401 No token provided` | Server-side session table, httpOnly |
| Tenancy | `tenant_id` on every payload **[A]**; enforcement appears app-layer **[I]** | `org_id` + Postgres **FORCE RLS**, enforced below the app tier |
| Realtime | `socket.io` — 138 polls during the crawl **[O]** | Request/response; no socket layer |
| Permissions | `GET /api/auth/me/permissions` → `{role, all, permissions}` **[A]** | Role/permission grid, `guard-mounting.spec.ts` pins every route |
| Tenant config | `subscription_status`, `subscription_expires_at`, `billing_cycle`, `plan_price`, `blocked`, `superfone_enabled` **[A]** | `billing` module; feature gating via `enabled_modules` |

Two observations worth carrying into our own thinking:

1. **Their token lives in `localStorage`.** That is XSS-reachable in a way our httpOnly session is
   not. This is a security posture where Aura is straightforwardly ahead — worth naming when this
   product comes up competitively.
2. **`superfone_enabled` is a per-tenant boolean on the tenant record itself** — feature flags are
   modelled as tenant columns rather than a flags table **[I]**. It works, but it means every new
   integration is a migration. Aura's `enabled_modules` approach ages better.

---

## 2. Navigation map (complete, as captured)

Seven top-level groups, 42 leaf entries:

```
Dashboard
Leads            /lead-management        Pipelines (cards/list), Follow-ups, Contacts, Contact Groups
                 /leads                  Pipeline board (kanban)
Lead Generation  /lead-generation        Overview, Meta Forms, Custom Forms
Automation       /automation             Overview, Workflows, Uploads (field routing), Devices,
                                         Templates, Single Send
                 └ WABA sub-nav          Dashboard, Templates, Single Send, Broadcast
Inbox            /inbox                  Conversations, Overview (message log)
Calendar         /calendar               Dashboard, Create/Edit, Appointments
Reports          /reports                Pipeline, Response Time, Staff Scorecard,
                                         Funnel, Follow-ups, Source ROI
Calls            /calls                  Dialer Call Logs
                 /superfone-calls        Superfone Call Logs
Payments         /payments
Fields           /fields                 Standard Fields, Additional Fields, Values, Tags
Staff            /staff                  Team, Roles & Permissions, Performance
Settings         /settings               Branding, Company Details, Security, Dialer Device Pair,
                                         Integrations, Notifications
```

**The IA lesson:** Automation carries a *second-level channel switcher* (WhatsApp | WABA) that
re-skins the whole sub-nav. It is how they fit two messaging stacks into one section without a
20-item flat list. Aura's sidebar was recently grouped for the same reason; the channel-switcher
pattern is a further step worth considering if we add a second WhatsApp transport.

---

## 3. Module teardown

### 3.1 Leads and pipelines

`GET /api/leads` field set **[A]**:

```
id, tenant_id, name, email, phone, source, pipeline_id, stage_id, assigned_to, notes,
status, tags, created_at, updated_at, is_deleted, lead_score, is_converted, custom_fields,
source_ref, meta_form_id, custom_form_id, meta_created_at, deal_value, win_probability,
team_members, stage_name, pipeline_name, assigned_name, meta_form_name, custom_form_name
```

`GET /api/pipelines` → `id, tenant_id, name, is_default, color, sort_order, kind, stages` **[A]**.

Observed: 11+ named pipelines on one tenant (*Maamisa Mall* 467 leads, *Default* 663, *Lead_2.0*,
*Meats Bhavan*, *After Sales*, *All_leads_together 2.0*, *SSS Smart Tech / Justdial Lead*,
*Pharmacy Lead*, *Cash Point _Meta Enquiry*, *dittomart_calender*) **[O]**. Board and List views,
drag-to-move stages, `GET /api/leads/stage-counts` and `/pipeline-counts` feeding column headers **[A]**.

Five details worth taking:

- **`team_members` — multi-assignee.** A lead has one `assigned_to` *and* a `team_members` array **[A]**.
  Aura assigns a single owner. Real shops put a telecaller and a closer on the same lead.
- **`source_ref` + `meta_created_at`** — a pointer back to the origin record, and **the timestamp
  the lead was created at the source**, preserved separately from `created_at` **[A]**. Any
  response-time metric measured against `created_at` alone is wrong for imported/synced leads;
  they kept the source clock. This is a genuinely good schema decision.
- **`pipelines.kind`** — pipelines are *typed*, so an "After Sales" pipeline can carry different
  semantics from a sales pipeline **[A]**.
- **`win_probability` alongside `deal_value`** — weighted forecasting is possible.
- **`is_deleted`** — soft delete on leads.

### 3.2 Follow-ups — the operational core

`GET /api/leads/followups` **[A]**:
`id, lead_id, tenant_id, title, description, due_at, completed, completed_at, assigned_to,
created_by, created_at, reminder_sent, reminders_sent, completed_by, lead_name, lead_phone,
assigned_name, completed_by_name, pipeline_name, stage_name, pipeline_id, stage_id`

UI tabs with live counts: **All 1179 · Overdue 1060 · Today 1 · Upcoming 14 · Completed 104** **[O]**.

This is the single most operationally-loaded object in the product. It is not a generic task — it is
a *promise to contact this lead at this time*, with `reminder_sent`/`reminders_sent` escalation
counters and a `completed_by` distinct from `assigned_to`. It has its own compliance report (§3.6)
and its own dashboard widget (§3.7).

Aura has `tasks`, which is close but framed as generic work, and has neither the reminder counters
nor the compliance reporting.

### 3.3 Lead generation

- **Meta Forms** — OAuth connect *or* manual Page Access Token entry **[O]**;
  `GET /api/integrations/meta/status` → `connected, connectedPages, blockedPages` **[A]**.
  The `blockedPages` concept — surfacing pages you *can't* read and why — is a nice diagnostic.
- **Custom Forms** — a real form builder. Captured builder fields **[O]**: field label, hint text,
  tags to apply, submit button text, thank-you message, redirect URL, brand colour, background
  colour, transparent-background toggle, text colour, plus preview fields (name, phone).
- `GET /api/lead-generation/overview` → `summary.total_leads, active_forms_count, leads_today,
  best_form, dead_forms, forms` **[A]**. **`dead_forms`** — forms that have stopped producing — is
  a metric most CRMs don't ship. Cheap, and it catches a broken integration before the client does.

### 3.4 Automation and messaging

`GET /api/workflows` **[A]**:
`id, tenant_id, name, description, status, allow_reentry, nodes[], total_contacts, completed,
skipped, failed, completed_with_errors, goal_trigger, goal_field, goal_operator, goal_value,
max_contacts, trigger_key, trigger_forms, api_token, created_at, updated_at`

`nodes[]` → `{id, type, label, config, actionType}` **[A]** — a visual node graph.

Live workflow list **[O]**: triggers seen include **"Google Sheet Row Added"** and *"Trigger will
fire when a new lead is created"*. Run telemetry is rendered inline per row:
`376 Done / 0 Errors / 376 Contacts`, `416 Done / 416 Contacts`, and one at
**`91 Done / 266 Errors / 357 Contacts`**.

Four ideas here are excellent and one is disqualifying:

- **Run telemetry in the list view.** Done/Errors/Skipped/Contacts/Failed on the row, not buried in
  a log. That 266-error workflow is visible at a glance.
- **`allow_reentry`** as an explicit per-workflow policy, surfaced as "Re-entry allowed / blocked".
- **Goal-based exit** — `goal_trigger/goal_field/goal_operator/goal_value`: a contact leaves the
  journey when the goal is met, rather than running to the end.
- **`max_contacts`** — a blast radius cap on the workflow itself.
- **`api_token` per workflow** — an external system can trigger one specific workflow.
- **Disqualifying:** these workflows *send WhatsApp automatically on a trigger*. That is a direct
  conflict with Aura safety rule 3 (§6).

**Messaging stack — two parallel transports:**

| | WhatsApp Personal (device) | WABA (Cloud API) |
| --- | --- | --- |
| Pairing | QR scan, `GET /sessions/:id/qr` **[A]** | Credentials + webhook config **[O]** |
| State | `session_id, session_name, status, phone_number, connected_at, total_messages, assigned_staff` **[A]** | `connected, webhookUrl, verifyToken` **[A]** |
| Templates | `wa-personal-templates`, `{%first_name%}` syntax **[O]** | 22 templates, `{{1}}` syntax, Marketing/Utility/Auth categories **[O]** |
| Template lifecycle | local | **Sync from Meta**, submit for approval, `status`, `meta_template_id`, `last_meta_edit_at` **[A]** |
| Bulk | — | **Broadcasts** |

`GET /api/templates` is a **single unified table across channels** **[A]**:
`template_type, category, language, status, subject, body, header, footer, buttons, variables,
meta_name, meta_template_id, meta_components, last_meta_edit_at, file_path, file_type, file_name`.
Template counts by channel: WABA 22, Email 0, SMS 0, WA Personal 0 **[O]**. One templates table
serving four channels, with Meta's approval state modelled inline, is the right design.

**Field Routing** (`/automation/pincode-routing`, `GET /api/field-routing/sets` **[A]**) — named
routing sets that assign leads by a field value such as pincode, with bulk upload. Labelled
"Uploads" in the sidebar **[O]**.

### 3.5 Calls — two telephony sources

`GET /api/calls` **[A]**:
`id, cdr_id, direction, outcome, caller_phone, superfone_number, duration_seconds, started_at,
ended_at, staff_name, recording_url, recording_path, recording_downloaded, recording_status,
is_unknown, notes, disposition, disposition_key, source, lead_id, lead_name, pipeline_name, stage_name`

`GET /api/calls/stats` → KPI block, daily inbound/outbound series, outcome breakdown, per-agent
totals, disposition breakdown, per-pipeline counts **[A]**.

Live: Dialer **1,522 calls / 55% answer rate / 674 missed**; Superfone **523 calls** **[O]**.
Columns: `S.No | Lead | Pipeline | Direction | Outcome | Duration | Agent | Date | Rec` **[O]**.

Three things to take:

- **`source` on the call row + a separate page per provider.** One call model, many CDR feeds.
- **Unmatched-call triage.** The page shows **`Unmatched (939)`** with exactly three verbs per row:
  **Create**, **Link**, **Dismiss – not relevant** **[O]**. That is the whole reconciliation UX in
  three buttons, and it keeps the unmatched count as a visible work queue.
- **Configurable dispositions with a quality mapping.** `GET /api/settings/dispositions` →
  `{key, icon, color, label, lead_quality}` **[A]**. The tenant defines its own call outcomes, and
  **each outcome carries a lead-quality weight** — so disposition feeds scoring directly. Settings
  showed seven editable "Outcome label" rows **[O]**.

What is conspicuously absent: **no transcription, no AI call analysis, no coaching or QA surface.**
Recordings can be played and downloaded, nothing more **[O]**. This is Aura's moat (§5).

### 3.6 Reports — six canned reports

| Report | KPIs captured **[A]** |
| --- | --- |
| Pipeline Analytics | `total_leads, won, active, conv_pct, avg_days_to_close`, per-stage `avg_days`, sources, lead_flow, win_loss, quality, staff, followups, stale, automation, tags, aging, calls |
| **Lead Response Time** | `avg_response_min, median_response_min, within_5min, within_30min, within_1hr, no_response` + per-staff + daily |
| Staff Scorecard | `total_leads, calls_made, messages_sent, followups_completed, followups_overdue, stages_moved, leads_won` |
| Conversion Funnel | drop-off per stage |
| **Follow-up Compliance** | `total, completed, overdue, pending, compliance_pct` + per-staff `compliance_pct` + overdue list with `overdue_days` + daily series |
| Source ROI | per-source `total_leads, contacted, won, conv_pct, avg_days_to_convert` + monthly trend |

Every report carries the same date-range presets: Today / Yesterday / This Week / This Month /
This Quarter / All Time / Custom **[O]**.

**Response Time and Follow-up Compliance are the two reports Aura has no equivalent of**, and they
are the two that change behaviour rather than describe it: one says how fast the floor reacts, the
other says who is keeping their promises.

### 3.7 Dashboard — built as a triage surface

Sections **[O]**: Business Growth · Pipeline Funnel · Source Intelligence · Follow-up Priority ·
Lead Aging · Team Health.

`GET /api/dashboard/analytics` **[A]** returns, among others:
`growth_pct, conversion_rate, conversion_rate_all_time, stale_leads, overdue_followups, best_source,
source_breakdown, pipeline_funnels, staff_leaderboard[{assigned_count, converted, conversion_rate_pct}],
today_followups, leads_not_contacted, source_conversion[{pct_of_total, conv_pct}],
staff_accountability[{assigned, contacted, won, contacted_pct, conv_pct}],
stale_leads_list[{days_stale}], untouched_leads`

Plus dedicated endpoints: `/dashboard/followup-priority` → `{overdue, due_today, upcoming, total}`,
`/dashboard/lead-aging` → `{buckets[{key,label,count,quick}], total, stages}`,
`/dashboard/lead-timeline` → daily + hourly **[A]**.

Rendered live: *Overdue **969** (99%) · Due Today 1 · Upcoming 13*, and aging buckets
**0-3 Days 54 · 4-7 Days 103 · 8-15 Days 119 · 16-30 Days 168 · 30+ Days 3,639** **[O]**.

The design principle: **every dashboard number is a filter into a work queue** — note the `quick`
field on each aging bucket **[A]**, which is the click-through. It answers "what needs action right
now", not "how did we do". And it is honest: it renders *969 overdue, 99%* without softening it.

### 3.8 Fields, contacts, calendar, payments, staff, settings

- **Fields** — four tabs: Standard Fields, Additional Fields (questions), Values, Tags **[O]**.
  `GET /api/fields/custom` → `id, tenant_id, name, type, slug, placeholder, options, required,
  is_active` and `/api/fields/system` → `id, name, slug, group` **[A]**. Field groups seen:
  Contact, Company, Calendar, CRM, Custom **[O]**. A "Copy unique key" action exposes the slug for
  integrations **[O]**. Note: **custom fields are scoped to entity groups including Calendar** —
  the calendar is a first-class CRM object, not a bolt-on.
- **Contacts** — 4,700 total, typed **Lead / Customer**, columns
  `CONTACT | SOURCE | PIPELINE | TAGS | TYPE | CREATED | LAST ACTIVITY` **[O]**.
- **Contact Groups** — named static audiences with a description ("What is this group for?"),
  used as broadcast targets **[O]**.
- **Calendar** — `GET /api/calendar`, `/calendar/event-types`, `/calendar/booking-links` **[A]**.
  Multiple named calendars (e.g. *HawcusSlotBooking*), **per-calendar staff attendee selection via
  checkbox list**, description, Google Meet URL field, and a **thank-you redirect URL** **[O]**.
  Tabs: Dashboard / Create-Edit / Appointments. This is a Calendly-class booking engine inside the
  CRM, with leads linked ("Search lead name or email…").
- **Payments** — `GET /api/payments/stats` → `total_amount, total_count, avg_amount, refund_amount,
  refund_count, success_rate` + daily + methods **[A]**; Razorpay status includes
  `webhook_url, last_payment_at` **[A]**. Columns `# | CUSTOMER | AMOUNT | STATUS | METHOD |
  PIPELINE | PAYMENT ID | DATE` **[O]**. Note **PIPELINE on a payment row** — revenue is attributed
  back to the pipeline that produced it.
- **Staff** — Team / Roles & Permissions / Performance **[O]**.
  `GET /api/settings/staff` → `id, name, email, role, avatar_url, is_active, phone, staff_id,
  has_login_pin` **[A]**. **`has_login_pin`** — telecallers sign in with a PIN, not a password. For
  a shared-floor deployment that is the right call, and the login screen confirms it
  ("PASSWORD OR PIN") **[O]**.
- **Settings** — Branding (logo, favicon, banner, brand colour, login background, tab title, app
  background, accent **[A]**), Company Details (legal name, website, industry, phone, address,
  timezone, currency, date_format **[A]**), Security (2FA), **Dialer Device Pair**, Integrations,
  Notifications. Also `GET /api/settings/webhook-url` → `webhookInbound, paymentReceived,
  paymentFailed, courseEnrolled` **[A]** — outbound webhooks, and `courseEnrolled` is a leftover
  from an education vertical **[I]**.
- **Integration visibility** — `GET /api/integrations/visibility` → `{hidden}` **[A]**: the vendor
  can hide specific integrations per tenant. Useful white-label control.

### 3.9 Google Sheets as a first-class lead source

`GET /api/integrations/sheets/status` **[A]**:
`connected, configs[{spreadsheet_url, spreadsheet_id, gid, spreadsheet_name, sheet_name,
column_mapping, last_row_synced, created_at}]`

And the dashboard's **Top Channel is "Google Sheets: MD_Aug_2026"** **[O]**, with a workflow trigger
**"Google Sheet Row Added"** driving 376 contacts through an automation **[O]**.

This deserves emphasis: on a live Indian SMB tenant, **the highest-volume lead channel is a
spreadsheet**, not Meta, not a web form. `column_mapping` + `last_row_synced` is the whole design —
map columns once, poll for new rows, remember the watermark.

---

## 4. Gap analysis — what Hawcus has that Aura does not

Verified absent from Aura by direct search of `apps/`, `packages/` and the migration set.

| # | Capability | Evidence in Hawcus | Aura today | Impact |
| --- | --- | --- | --- | --- |
| G1 | **Follow-up compliance reporting** | `compliance_pct` per staff, overdue list with `overdue_days` **[A]** | `tasks` exist; no compliance metric | **High** |
| G2 | **Lead response-time SLA** | `within_5min/30min/1hr`, median, per-staff **[A]** | No `first_response`/`responded_at` anywhere | **High** |
| G3 | **Lead aging buckets + click-through** | `/dashboard/lead-aging`, `quick` filter per bucket **[A]** | No `days_stale`/aging concept | **High** |
| G4 | **Google Sheets lead connector** | `column_mapping`, `last_row_synced` **[A]**; top channel live **[O]** | `lead_sources.kind` = web_form, email, telephony, meta_ads, linkedin_ads, api — no sheets | **High** |
| G5 | **Calendar / booking engine** | event types, booking links, attendees, Meet URL **[A][O]** | No owner-facing calendar; only marketing funnel booking slots | **High** |
| G6 | **Unmatched-call triage UI** | `Unmatched (939)` + Create/Link/Dismiss **[O]** | `call_crm_integrity_flags` + reconciliation log exist; no owner triage surface found | **High** |
| G7 | **Configurable dispositions → lead quality** | `{key,icon,color,label,lead_quality}` **[A]** | No `call_dispositions` table | **Medium-High** |
| G8 | **Workflow run telemetry in list** | Done/Errors/Skipped/Contacts/Failed per row **[O]** | `automation_runs` exists; not surfaced this way | **Medium-High** |
| G9 | **Goal-based exit, re-entry policy, max_contacts** | `goal_*`, `allow_reentry`, `max_contacts` **[A]** | Rules have no goal-exit or blast-radius cap | **Medium-High** |
| G10 | **Custom form builder with branding** | full builder captured **[O]** | Intake accepts web forms; no builder | **Medium** |
| G11 | **Field/pincode routing sets** | `/api/field-routing/sets` **[A]** | No routing-set concept | **Medium** |
| G12 | **Multi-assignee on a lead** | `team_members[]` **[A]** | Single `assigned_to` | **Medium** |
| G13 | **Contact groups as audiences** | `/api/contact-groups` **[A]** | Tags only | **Medium** |
| G14 | **Source timestamp preservation** | `meta_created_at` + `source_ref` **[A]** | Not modelled | **Medium** |
| G15 | **Unified cross-channel template table** | one table, 4 channels, Meta approval state **[A]** | `marketing.message_templates` is funnel-scoped | **Medium** |
| G16 | **Typed pipelines** | `pipelines.kind` **[A]** | Boards untyped | **Low-Medium** |
| G17 | **PIN login for floor staff** | `has_login_pin` **[A]**, "PASSWORD OR PIN" **[O]** | Password only | **Low-Medium** |
| G18 | **`dead_forms` metric** | lead-gen overview **[A]** | — | **Low** |
| G19 | **Per-tenant integration visibility** | `/integrations/visibility` **[A]** | — | **Low** |
| G20 | **Realtime via socket.io** | 138 socket polls **[O]** | Request/response only | **Low** |

---

## 5. Where Aura is ahead — do not regress these

1. **Tenant isolation below the app tier.** Aura's `org_id` + FORCE RLS holds even if a query
   forgets its filter. Hawcus's `tenant_id` travels in the payload and appears app-enforced **[I]**.
2. **Route-level guard pinning.** `guard-mounting.spec.ts` pins every route; there is no equivalent
   we could observe.
3. **The entire AI call layer.** Transcription, `call_facts`, AI agents, call quality, SOP scoring,
   `ai_outputs`. Hawcus logs calls and stores recordings — and stops there **[O]**. This is the
   largest single asymmetry in Aura's favour, and it is exactly the layer that is hardest to copy.
4. **Products / Quotations / Invoices with GST.** Hawcus has payments but no quoting or invoicing
   surface was observed.
5. **Report Builder.** A custom report canvas with datasets, runs, schedules, shares and palettes
   beats six fixed reports — *for power users*. See §7 for the caveat.
6. **Dedupe / merge / duplicates**, custom-field provenance, per-user email+calendar connections,
   interactions timeline, projects, SOPs, commission plans, targets.
7. **httpOnly server-side sessions** vs a `localStorage` bearer token.
8. **Deliberately non-sending automation** — a safety property, not a missing feature (§6).

---

## 6. What must NOT be ported

Aura safety rule 3: *nothing automated sends*. Hawcus violates this by design — workflows send
WhatsApp on a trigger, and Broadcasts send to a contact group in bulk.

The crawl produced an unusually direct argument for our rule: one live workflow sits at
**91 Done / 266 Errors / 357 Contacts** **[O]**. Roughly three quarters of that run errored, on a
path that sends messages to real people without a human in the loop.

So: port the **shape** of workflows — the node graph, the run telemetry, `allow_reentry`,
goal-based exit, `max_contacts` — and keep Aura's substitution: a step becomes a **human work item**
that moves `waiting → due`, and a person clicks send. Broadcasts should not be ported at all in
their current form; the nearest safe equivalent is a reviewed, segment-scoped queue of individually
confirmable sends.

---

## 7. Recommendations, in build order

**Tier 1 — high value, low effort, no safety friction.** These are reports and views over data Aura
already stores.

> **Status, 2026-09-07 — items 1-3 built** on `crm-connectors-and-console-auth`.
> Migration `0090_response_and_compliance.sql` (one column, `leads.first_responded_at`, plus a
> trigger and a backfill off `lead_stage_transitions`); `GET /reports/response-time`,
> `/reports/followup-compliance`, `/reports/lead-aging`; console page `/owner/reports/sla`
> ("Response & Follow-ups", owner/manager only). 373 API + 343 web tests green, both typechecks
> clean. **The SQL has not been run against a live Postgres** — see "Not yet done" below.
> Item 4 (uniform date presets) is not started.
>
> Two deliberate deviations from the recommendation above: the reports landed on their own page
> rather than being folded into the owner dashboard (the dashboard reframe is a bigger change and
> is still open), and response time is broken down **by telecaller** while compliance is broken
> down **by console user**, because `reports.service.ts` documents that nothing maps between the
> two — a single merged "staff scorecard" row would put one person's calls beside another
> person's follow-ups.
>
> **Not yet done, and load-bearing:** `first_responded_at` is fed only by human stage moves
> (`lead_stage_transitions` where `source` is `console` or `device`). A telecaller who rings a lead
> without moving its stage is not counted, because `calls` has no `lead_id`. The migration exposes
> `mark_lead_first_response(lead, at)` for the worker's lead upsert to call once an outbound call is
> attached; until that lands the metric **under-reports** responsiveness, which is the safe
> direction for a number read in a performance review, but it is not yet the whole truth.

1. **Follow-up compliance + response-time SLA** (G1, G2). Add `first_responded_at` to leads and a
   compliance rollup over `tasks`. Two reports, one migration. This is the highest
   value-per-line-of-code item in the document.
2. **Lead aging buckets with click-through** (G3) on the owner dashboard, plus a stale-leads list
   carrying `days_stale`.
3. **Reframe the owner dashboard as a triage surface** (§3.7). Follow-up Priority (overdue / due
   today / upcoming), staff accountability with `contacted_pct`, untouched-leads count — every tile
   a filter into a work queue.
4. **Uniform date-range presets** across every Aura report.

**Tier 2 — net-new capability, no safety friction.**

5. **Google Sheets lead connector** (G4) — a new `lead_sources.kind`, `column_mapping` +
   `last_row_synced`. Given it is the top channel on a live tenant, this is likely the highest
   commercial-value gap in the list for the Indian SMB segment.
6. **Unmatched-call triage** (G6) — surface `call_crm_integrity_flags` as a queue with the same
   three verbs: Create, Link, Dismiss.
7. **Configurable call dispositions with `lead_quality`** (G7) — feed the existing lead-scoring
   sweep from tenant-defined outcomes.
8. **Custom form builder** (G10) on top of the existing intake pipeline.

**Tier 3 — larger builds.**

9. **Calendar / booking module** (G5) — event types, booking links, attendees, lead linkage.
   Largest single build here; check first whether it is a real customer ask or a checkbox.
10. **Workflow telemetry + goal exit + re-entry policy + `max_contacts`** (G8, G9) on Aura's
    non-sending automation.
11. **Multi-assignee** (G12), **contact groups** (G13), **field routing** (G11),
    **unified templates** (G15).

**Tier 4 — schema hygiene, cheap, do alongside.**
`meta_created_at`/`source_ref` (G14), `pipelines.kind` (G16), `dead_forms` (G18),
integration visibility (G19), PIN login (G17).

---

## 8. Open questions — business calls, not engineering ones

1. **Calendar (G5)** is the biggest build in Tier 3. Is client-facing appointment booking actually
   being asked for, or is Google Calendar via Connections enough?
2. **PIN login (G17)** trades security for floor speed. Acceptable for telecallers?
3. **Report Builder vs canned reports.** Aura's builder is more powerful but requires someone to
   build. Hawcus ships six reports that work on day one. Recommendation: ship Tier-1 reports as
   **pre-built Report Builder templates** so we get both — but that assumes the builder can express
   `within_5min`-style bucketed aggregates. Worth confirming before committing.
4. **Multi-assignee (G12)** changes `owner-scope.ts` semantics — if a lead has a team, who sees it
   on a telecaller's self-filtered board? Needs a decision before implementation.

---

## Appendix A — Hawcus API surface observed (74 endpoints)

`auth/me`, `auth/me/permissions` · `calendar`, `calendar/booking-links`, `calendar/event-types` ·
`calls`, `calls/stats` · `contact-groups` · `conversations`, `conversations/broadcast-leads`,
`conversations/broadcasts`, `conversations/canned-responses` · `dashboard/analytics`,
`dashboard/followup-priority`, `dashboard/lead-aging`, `dashboard/lead-timeline` ·
`field-routing/sets` · `fields/custom`, `fields/questions`, `fields/system`, `fields/values` ·
`forms` · `integrations/{configs, meta/status, meta/connected-forms, meta/sync-forms,
razorpay/status, sheets/status, smtp/status, superfone/status, visibility, wa-numbers,
waba/stats, waba/status}` · `lead-generation/overview` · `leads`, `leads/followups`,
`leads/pipeline-counts`, `leads/stage-counts`, `leads/summary` · `notifications` · `payments`,
`payments/stats` · `pipelines` · `reports/{conversion-funnel-detail, followup-compliance,
pipeline-analytics, pipelines, response-time, source-roi-detail, staff-scorecard}` ·
`settings`, `settings/dispositions`, `settings/notifications`, `settings/staff`,
`settings/webhook-url` · `tags` · `templates`, `wa-personal-templates` ·
`whatsapp-personal/{analytics, devices, logs, sessions, sessions/:id/qr, status, top-contacts,
volume}` · `workflows`, `workflows/:id` · `socket.io`

## Appendix B — Artifacts

Crawl output (JSON + 50+ screenshots) is in the session scratchpad:

```
scratchpad/crawler/out/pages.json    41 pages: nav, headings, columns, tabs, buttons, fields, forms
scratchpad/crawler/out/api.json      74 endpoints with response key names (no values)
scratchpad/crawler/out/errors.json   empty
scratchpad/crawler/out/shots/        per-page and per-form screenshots
```

These live in a temp directory and will not survive indefinitely — copy them into the repo if the
screenshots are wanted for reference.
