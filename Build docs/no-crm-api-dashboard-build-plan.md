# No-CRM, API-Only Dashboard: Build Specification (for the implementing agent)

> **How to use this file.** This is a build spec for a **separate customer experience** of the application: a dashboard for businesses that do **not** want our CRM and only want **API access** to push their data in and see KPI and telecaller performance out. Follow the sections in order, build in the milestones of section 15, and treat every item marked **MUST** as required. Where a decision is not specified, use the default in section 16 and record it in `DECISIONS.md`. Reuse the existing KPI, Finance, Org Chart, Import Center, connector and feature-gate work wherever it exists; **do not duplicate it**. Inspect the repository first.

---

## 1. Goal and scope

Many prospective customers already have a CRM, a dialer or their own system. They do not want to migrate. They want to **send us their data through an API and get a clear, statistical view of how their telecallers and organization perform against the KPIs they choose**.

**Deliver a dashboard and an API platform that provide:**

1. **API-first data ingestion** (REST, webhooks, bulk file upload) with a developer portal.
2. **KPI-based telecaller and organization performance**, with owner-configured KPIs (4-6), targets, weights and rating bands, exactly as in the KPI specification.
3. **Plan-based entitlements** and **honest, contextual upsell options** so a customer can move to a higher plan to unlock more capacity or features.

**In scope (this tier):** API access, data health and integration tools, KPI setup, org and telecaller dashboards, leaderboards, reports and exports, basic rule-based alerts (by plan), team and user management, usage and billing views, upsell surfaces.

**Explicitly out of scope for the no-CRM tier (see section 5):** CRM screens (leads, pipelines, contacts), calling or dialer interface, to-call lists and callback popups, transcripts, agents and any other AI feature (summaries, AI scoring, AI coaching, AI actions), calendar booking, WhatsApp/SMS automation. These may appear **only as locked upsell cards** (section 9).

**Design principles (MUST)**

- **API-first, UI-light.** The product is data in, insight out. Every dashboard number must be reproducible from data the customer sent.
- **Data minimization.** Store only what is needed for KPIs. A "lead" is a lightweight reference, not a CRM record.
- **No dark patterns.** Core access is never blocked to force an upgrade, and upsell never appears in critical flows.
- **Server-side enforcement** of plans and limits, in the API as well as the UI.

---

## 2. Assumptions and defaults

The stack is not given. **First step: inspect the repository** and adopt its language, framework, ORM, migrations, queue, test runner, component library and design tokens. Only where nothing exists, use these defaults:

| Concern | Default |
| --- | --- |
| Database | PostgreSQL 14+, time-partitioned fact tables |
| Money | Integer minor units plus ISO currency code; never floats |
| Time | Store UTC (`timestamptz`); accept ISO 8601 with offsets; display in the org timezone (default `Asia/Kolkata`) |
| Tenancy | Every table has `org_id`; every query is scoped in the data-access layer |
| Queue | Durable queue with retries and a dead-letter queue for ingestion processing |
| Secrets | API keys stored only as hashes; webhook secrets encrypted at rest |
| UI | The application's existing design system and tokens; no hard-coded styles |
| Audit | Append-only audit log for configuration, key, plan and permission changes |

---

## 3. Roles

| Role | Can do |
| --- | --- |
| Owner | Everything: plan and billing, API keys, KPI setup, users, all data, exports |
| Admin | Same as owner except plan purchase and ownership transfer |
| Manager | View their teams' dashboards and telecaller drill-downs; run reports for their teams |
| Developer | API keys (non-production by default), webhooks, event inspector, integration center; no billing and no people-level pay data |
| Telecaller (optional) | View only their own KPIs, score and rank (if enabled); never see others' data or any billing or upsell |
| Viewer | Read-only dashboards as configured by the owner |

**MUST:** enforce roles server-side on every endpoint and query. Upsell and billing surfaces are visible only to Owner and Admin (and read-only plan information to Developers where relevant).

---

## 4. Plans and entitlements

Plans are **data, not code**. Define them in tables and map them to entitlements using the generic feature-gate framework (`platform/feature-gates`) already specified for the agent module. If it does not exist yet, build it first (see milestone M1). All numbers below are **editable defaults**, not commitments.

| Entitlement | Starter (API Insights) | Growth | Scale | Platform (CRM + AI) |
| --- | --- | --- | --- | --- |
| Active telecallers | 10 | 50 | 200 | Custom |
| Dashboard logins (non-telecaller) | 3 | 10 | 50 | Unlimited |
| Ingestion events per month | 50,000 | 500,000 | 5,000,000 | Custom |
| API rate limit (requests/min) | 60 | 300 | 1,500 | Custom |
| History retention | 3 months | 12 months | 36 months | Custom |
| Selectable KPIs | Up to 4 | Up to 6 | Up to 6 plus custom KPIs | Up to 6 plus custom |
| Teams and hierarchy | Flat list | Teams | Teams plus org chart | Full |
| Org and telecaller dashboards, leaderboard | Included | Included | Included | Included |
| Exports | CSV, limited rows | CSV and Excel | CSV, Excel, PDF | All |
| Scheduled reports | None | Weekly and monthly email | Unlimited, branded | Unlimited |
| Rule-based threshold alerts | None | Email | Email, WhatsApp, escalation | All |
| Outgoing webhooks | None | Included | Included | Included |
| Excel import center | Single template | Saved mappings | Advanced mappings and scheduled imports | All |
| Manual quality scoring form | None | Included | Included | Included |
| Revenue and collections summary by telecaller | None | Basic | Full finance module and connectors | Full |
| Audit log | 30 days view | 12 months | Export and retention controls | All |
| SSO, IP allowlist | None | None | Included | Included |
| White-label branding | None | None | Included | Included |
| Support | Email | Priority email | Chat plus SLA | Dedicated |
| CRM | None | None | None | Included |
| AI features (agent, transcripts, AI scoring, coaching) | None | None | None | Included (or add-on) |

**MUST**

- Plan definitions live in `plan` and `plan_entitlement` tables so product can change limits without a release.
- Every entitlement is checked by one `Entitlements.check()` service, server-side, in the UI, API, jobs, exports and scheduled reports. No direct plan-name checks scattered through code.
- Limit types: **hard** (feature absent), **quota** (count or volume with a soft warning at 80% and behavior at 100%), and **window** (retention).
- Behavior at 100% of a quota (defaults): users and telecaller counts block *adding* more but never remove existing ones; event volume is accepted in a **grace band** (up to 110%) then rejected with a clear error and an alert to the owner; retention never deletes data early, it only limits what is displayed (older data stays stored for a configurable grace period and returns on upgrade).
- Fail closed for features, fail open for **already-ingested data visibility** (a plan check outage must not hide a customer's own dashboard).

---

## 5. What is excluded, and how it appears

| Excluded in no-CRM tier | Where it exists | How it shows in this tier |
| --- | --- | --- |
| Lead and contact management, pipelines | CRM module | Not shown in navigation; a locked card on the Upgrade page |
| Calling or dialer interface, to-call list, callback popups | CRM and callbacks module | Locked card only |
| Transcript agent, AI summaries, AI quality scoring, AI coaching | Transcript agent and AI modules | Locked cards with a short, honest description |
| Calendar booking | Agent module | Locked card only |
| WhatsApp/SMS automation | Messaging | Locked card only |
| Contracts and positions | Org chart module | Basic team list now; org chart on Scale (locked card on lower plans) |
| Finance advisor (forecasts, leak detection) | Finance module | Locked card; basic revenue summary on Growth |

**MUST:** hidden or locked features must be absent from the API too. Calls to them return `403` with `entitlement_required` (section 9.4).

---

## 6. Data ingestion platform (the core of this product)

### 6.1 Ingestion methods

- **REST API** (primary), JSON, versioned (`/v1`).
- **Bulk upload** through the Import Center: Excel and CSV with dynamic column mapping, saved templates and validation (reuse the Import Center spec).
- **Outgoing webhooks** from us to the customer (alerts, report ready, data stale).
- **Later:** connectors to dialers and telephony providers (reuse the connector framework).

### 6.2 Resources and endpoints (suggested; adapt to repo conventions)

| Endpoint | Purpose |
| --- | --- |
| `PUT /v1/telecallers/{external_id}` | Create or update a telecaller (name, team, status, joined date, targets override) |
| `PUT /v1/teams/{external_id}` | Create or update a team and its parent |
| `POST /v1/calls` | Ingest one or a batch of calls (up to 500 per request) |
| `POST /v1/dispositions` | Attach or update outcomes for calls or leads |
| `POST /v1/conversions` | Sale, enrollment or other conversion with value |
| `POST /v1/payments` | Collections attributed to a conversion and telecaller (Growth and above) |
| `POST /v1/attendance` | Login/logout or present/absent (optional KPI input) |
| `POST /v1/quality-scores` | Manual quality reviews entered by the customer's own QA (non-AI) |
| `POST /v1/targets` | Per-person or per-team target overrides |
| `GET /v1/kpis/org?period=` | Org-level KPI results |
| `GET /v1/kpis/telecallers/{id}?period=` | One telecaller's KPI results and score |
| `GET /v1/leaderboard?period=&team=` | Ranked list (respects visibility settings) |
| `GET /v1/reports` and `POST /v1/reports` | List, create and fetch generated reports |
| `GET /v1/usage` | Current usage against plan limits |
| `GET /v1/events/{id}` | Inspect the status of an ingested event |
| `DELETE /v1/subjects/{external_id}` | Erase or anonymize a person's data on request |

### 6.3 API conventions (MUST)

- **Authentication:** API keys (and OAuth client credentials for higher plans). Keys are shown once, stored hashed, scoped (read, write, per-resource), environment-tagged (`test` and `live`), rotatable, revocable, with last-used time and optional expiry.
- **Idempotency:** every write accepts an `Idempotency-Key` header; the combination of resource `external_id` is also idempotent (upsert semantics). Replaying a request must not duplicate data.
- **Batching:** batch endpoints return **per-item results** (accepted, rejected with reason) and never fail the whole batch for one bad row.
- **Late and out-of-order data:** accepted; corrections via upsert; KPI snapshots are recomputed for affected periods.
- **Validation:** strict schemas with clear field-level errors; unknown fields rejected or stored as custom attributes per setting.
- **Errors:** a consistent problem-details style body with `code`, `message`, `field_errors`, `request_id`, and `docs_url`.
- **Rate limits:** per key and per org, with standard headers (limit, remaining, reset) and `429` with `Retry-After`.
- **Pagination:** cursor-based. **Timestamps:** ISO 8601 with offset. **Money:** minor units plus currency.
- **Versioning and deprecation policy** documented; breaking changes only in new versions.
- **OpenAPI specification** published and generated from code; downloadable Postman collection and a sandbox using `test` keys that never affect live KPIs.
- **Webhook security:** outgoing webhooks are signed (HMAC) with a timestamp, retried with backoff, and visible in a delivery log with replay.

### 6.4 Example payloads

```json
// POST /v1/calls
{
  "calls": [{
    "external_id": "call_8841",
    "telecaller_external_id": "tc_102",
    "direction": "outbound",
    "started_at": "2026-10-10T10:12:03+05:30",
    "connected": true,
    "duration_sec": 184,
    "talk_time_sec": 160,
    "disposition": "interested",
    "lead_ref": "L-5521",
    "campaign": "oct-promo",
    "source": "facebook"
  }]
}
```

```json
// POST /v1/conversions
{
  "external_id": "conv_3320",
  "telecaller_external_id": "tc_102",
  "lead_ref": "L-5521",
  "closed_at": "2026-10-10T15:40:00+05:30",
  "value_minor": 1500000,
  "currency": "INR",
  "product": "premium-plan"
}
```

### 6.5 Privacy and data handling (MUST)

- **Lead references are pseudonymous by default:** `lead_ref` is the customer's own ID. Name and phone fields are optional; offer **hashing** of phone numbers on ingest for customers who only need uniqueness and attribution.
- Per-org **retention** setting and an **erasure endpoint**; export of an org's data on request.
- Encryption in transit and at rest; no PII in logs; access to raw events limited to Owner, Admin and Developer.
- Check obligations under India's data protection law and your contracts with legal counsel; provide a data processing agreement template.

---

## 7. Processing pipeline and KPI engine

```
API / webhook / bulk upload → authenticate → rate limit & entitlement check
  → validate → store raw event (immutable) → queue
  → normalize into fact tables (call, conversion, payment, attendance, quality score)
  → match to telecaller/team by external_id → KPI engine → kpi_snapshot
  → dashboards, reports, alerts, outgoing webhooks
```

- **Reuse the KPI specification:** catalog, owner configuration (4-6 KPIs, targets, periods, weights, direction, rating bands, effective dates), scoring engine (achievement capped, weighted overall score), and `kpi_snapshot`. Do not rebuild.
- **Only KPIs computable from sent data are offered.** In setup, each catalog KPI shows a **"Data needed"** line (for example, connect rate needs `connected` on calls) and a status: *ready*, *missing data* or *partial*.
- **Manual quality score** is supported through `/v1/quality-scores` and a simple review form in the dashboard (human-entered, not AI).
- **Recompute** snapshots when late or corrected data arrives, for the affected periods only.
- **Unmatched data** (unknown telecaller `external_id`) goes to an "unmapped" queue with a one-click create or map action; it never silently disappears.

---

## 8. Dashboard: screens and features

All screens use the app's design system and tokens, work in light and dark mode, and are responsive from tablet up.

### 8.1 First-run onboarding

A checklist with live status: **create API key → send a telecaller → send a call → choose KPIs → see your dashboard.** Each step has a copyable code snippet and a **"Send a test event"** button. Offer a clearly labelled **demo data mode** so the dashboard is not empty before data arrives; it is read-only, watermarked, and never mixed with live data.

### 8.2 Overview (owner and manager)

- Selected KPIs as cards: actual vs target, achievement %, trend arrow, mini sparkline.
- Overall organization score and rating band.
- Period selector (today, week, month, quarter, financial year, custom) with comparison to the previous period and the same period last year.
- Funnel: dialed → connected → interested → converted (built from the customer's dispositions).
- **Data freshness stamp** ("last event received 3 minutes ago") and data-quality banner when feeds stop or fields are missing.
- Top and bottom performers, teams ranking.

### 8.3 Telecaller performance

- **Leaderboard** with sort and filters (team, period, KPI). Visibility is an owner setting (hidden, own rank only, or full).
- **Telecaller drill-down:** KPI cards, overall score, rank, trend vs previous periods, call volume by hour and weekday, disposition mix, talk time, connect rate, conversion rate, revenue attributed (Growth and above).
- **Compare** two or more telecallers or a telecaller against the team average.
- **Median and 90th percentile** for durations and time-to-conversion, not just averages.
- **Drill to underlying events** (the calls and conversions behind a number) with the raw-event link for developers.
- Telecaller self-view: own progress first, own score and band, and rank only if enabled.

### 8.4 Team and organization view

- Teams roll-up with targets and attainment.
- Org chart view on Scale and above (reuse the org chart module); a flat or team list on lower plans.
- Span of control, headcount and active vs inactive telecallers.

### 8.5 KPI setup wizard (owner)

Reuse the KPI spec flow: business type presets → pick 4-6 KPIs (limit by plan) → targets, period, weight (total 100%), direction → scope (all, team, role) → rating bands → review and confirm with an **effective-from date**. Show the "Data needed" status per KPI and block confirmation of a KPI that has no data unless the owner acknowledges it.

### 8.6 Reports and exports

- On-demand exports (limits by plan) with filters.
- **Scheduled reports** (weekly, monthly) emailed as PDF or Excel (Growth and above); branded on Scale.
- Saved views and **expiring, read-only share links** (owner-controlled; never expose person-level data to links unless chosen).
- Every export is audit-logged.

### 8.7 Alerts (rule-based thresholds; no AI)

- Examples: telecaller below X% of target for N days, KPI missed this week, **data feed stopped for N hours**, usage reaching 80% of plan.
- Channels by plan: in-app, email, then WhatsApp and escalation on Scale.
- Acknowledge and snooze; digest option.
- These are simple threshold rules configured by the owner; no model is involved.

### 8.8 Integration center (developers)

- API keys (create, scope, rotate, revoke, last used), environments (test/live).
- **Event inspector:** search ingested events, see validation result, normalized output and the KPIs they affected.
- **Ingestion errors** list with reasons and a replay option.
- Webhook endpoints, delivery log, retry and replay.
- **Data completeness per KPI** and last received time per event type.
- Rate-limit and usage graphs; sample requests; link to docs and OpenAPI.

### 8.9 Team and user management

- Invite users, assign roles, optional telecaller logins, teams.
- 2FA for staff roles; SSO and IP allowlist on Scale and above.
- Audit log of key, plan, KPI, permission and export events.

### 8.10 Usage, plan and billing (Owner/Admin)

- Current plan, included limits, **live usage meters** (telecallers, events, users, retention), renewal date.
- Invoices and GST details; payment method.
- Upgrade, downgrade and cancel flows (section 9.6).

### 8.11 Settings

Organization profile, timezone, financial year start, currency, working hours, visibility settings (leaderboard, rank), data retention, branding (Scale), notification preferences.

### 8.12 Help

Docs, API reference, changelog, status page link, support contact with the plan's support level.

---

## 9. Upsell and plan-change experience

**Principle:** upsell should help the customer see value at the moment they need it, never block their work, and never feel like a trap. Every upsell is tied to a real limit they are approaching, a feature they are looking at, or a question they are asking.

### 9.1 Upgrade page ("Compare plans")

- Side-by-side plan table from the **live plan definitions** (never a hard-coded copy).
- Highlights what the customer would **gain from their current plan** ("You'd unlock: 12 months of history, scheduled reports, webhooks").
- Shows the customer's own usage next to limits ("You use 41 of 50 events/month allowance").
- CTA: self-serve upgrade for Growth and Scale; **"Talk to us"** for Platform and Enterprise.
- Includes a locked-feature gallery of CRM and AI capabilities with honest descriptions (what it does, what it requires), and a "Request a demo" action.

### 9.2 Contextual triggers (MUST be rate-limited)

| Trigger | What the owner sees |
| --- | --- |
| Usage at 80% of any quota | In-app banner and email with the plan that raises it |
| Usage at 100% (grace band) | Clear notice of what happens next and the upgrade path |
| Trying to select a 5th KPI on Starter | Inline message: "Growth lets you track up to 6 KPIs" |
| Selecting a date range beyond retention | "Data older than 3 months is available on Growth" with a preview of the chart shape (no real data shown beyond the plan) |
| Opening Reports and scheduling | Locked scheduled-reports card with a one-click upgrade |
| Viewing a metric that needs more data | "Send `/v1/payments` to see revenue by telecaller; full finance on Scale" |
| Adding a telecaller beyond the limit | Blocking message with the plan that fits the new headcount |
| Needing webhooks or alerts | Locked card describing what they enable |
| Interest in CRM or AI | Locked cards on the Upgrade page and a "Request a demo" form |

### 9.3 Locked preview pattern (MUST)

A locked feature shows: name, one-sentence benefit, a **static preview with sample data clearly labelled "Sample"**, the plan that includes it, and one primary action. Never show fake numbers as if they were the customer's own.

### 9.4 API behavior for locked features

Return `403` with a stable body so integrators can handle it programmatically:

```json
{
  "code": "entitlement_required",
  "message": "This endpoint requires the Growth plan or higher.",
  "required_plan": "growth",
  "upgrade_url": "https://app.example.com/billing/upgrade?feature=payments",
  "request_id": "req_..."
}
```

### 9.5 Trials

- **Time-boxed trial of a higher plan** (default 14 days), started by the owner, with a visible countdown.
- At the end, the account **automatically reverts** to the prior plan with a summary of what will be locked; data is never deleted. Offer a one-click upgrade at that moment.

### 9.6 Plan changes

- **Upgrade:** immediate unlock (entitlement cache invalidated within seconds), prorated charge according to the billing provider's rules, confirmation email and a "what's new for you" tour.
- **Downgrade:** takes effect at the end of the billing period; show a **preview of what will be locked or limited** and require acknowledgement; existing data is retained read-only; over-limit resources (extra users or telecallers) are flagged for the owner to choose which remain active within a grace period.
- **Cancel:** retain data for a configurable period, offer an export, then follow the retention policy.
- Billing provider: decide with the project owner (for example a subscriptions-capable payment provider supporting Indian customers and GST invoices) and record it in `DECISIONS.md`. Do not hard-code plan prices.

### 9.7 Guardrails (MUST)

- Upsell visible only to Owner and Admin; **telecallers and viewers never see any upsell or billing**.
- **Frequency caps** (default: at most one in-app upsell banner per user per week, none during onboarding's first day), and dismissals are respected and stored.
- No upsell inside critical workflows (during a failed ingestion, a data export in progress, or an incident).
- No countdown pressure tactics or hidden costs; show the full price and what changes.
- Core access (viewing existing data, API reads, key management) is never blocked to force an upgrade.
- Track the funnel (impression, click, trial start, upgrade, dismissal) for product learning, aggregated and respecting consent.

---

## 10. Data model

All tables include `org_id`, `created_at`, `updated_at`. Reuse existing tables for KPI catalog and snapshots, teams, users and import batches. Adapt syntax to the repo's migration tool.

```sql
-- Plans and billing
plan (id, key, name, active)
plan_entitlement (plan_id, entitlement_key, limit_type TEXT,   -- hard | quota | window
                  value JSONB)
subscription (id, org_id, plan_id, status TEXT,                -- trialing | active | past_due | cancelled
              trial_ends_at NULL, current_period_end, cancel_at NULL, billing_ref)
usage_meter (org_id, entitlement_key, period, used BIGINT)
upsell_impression (id, org_id, user_id, trigger_key, surface, shown_at, action TEXT NULL)  -- dismissed | clicked | upgraded

-- API platform
api_key (id, org_id, name, key_hash, prefix, env TEXT, scopes TEXT[], created_by,
         last_used_at NULL, expires_at NULL, revoked_at NULL, ip_allowlist TEXT[] NULL)
ingest_event (id, org_id, api_key_id, resource TEXT, external_id, idempotency_key NULL,
              payload JSONB, received_at, status TEXT,         -- queued | processed | rejected
              error JSONB NULL, UNIQUE (org_id, resource, external_id))
webhook_endpoint (id, org_id, url, secret_enc, events TEXT[], active)
webhook_delivery (id, endpoint_id, event, payload JSONB, status, attempts, next_attempt_at NULL, last_error NULL)

-- People and facts (customer's own identifiers kept as external_id)
telecaller (id, org_id, external_id, name, team_id NULL, status, joined_on, attributes JSONB,
            UNIQUE (org_id, external_id))
team (id, org_id, external_id, name, parent_team_id NULL)
call_fact (id, org_id, external_id, telecaller_id, started_at, direction, connected BOOL,
           duration_sec, talk_time_sec, disposition, lead_ref, campaign, source,
           attributes JSONB, UNIQUE (org_id, external_id))
conversion_fact (id, org_id, external_id, telecaller_id, lead_ref, closed_at, value_minor, currency, product)
payment_fact (id, org_id, external_id, conversion_id NULL, telecaller_id, amount_minor, currency, received_at, method)
attendance_fact (id, org_id, telecaller_id, date, status, login_at NULL, logout_at NULL)
quality_score (id, org_id, telecaller_id, call_external_id NULL, reviewer, score NUMERIC, rubric JSONB, reviewed_at)
unmapped_event (id, org_id, resource, external_ref, ingest_event_id, resolved_at NULL)

-- KPI (reuse the KPI spec's kpi_catalog, org_kpi_config, kpi_snapshot)
-- Alerts, reports
alert_rule (id, org_id, kind, params JSONB, channels TEXT[], enabled)
report_schedule (id, org_id, report_type, cadence, recipients JSONB, format, branding JSONB, next_run_at)
share_link (id, org_id, report_id, token_hash, expires_at, scope JSONB, created_by)
audit_log (id, org_id, actor_id, action, entity, entity_id, before JSONB, after JSONB, at)
```

**Indexes (minimum):** `call_fact(org_id, telecaller_id, started_at)`, `conversion_fact(org_id, telecaller_id, closed_at)`, `ingest_event(org_id, received_at)`, `api_key(prefix)`, `usage_meter(org_id, entitlement_key, period)`. Partition large fact tables by month.

---

## 11. Non-functional requirements

- **Performance:** dashboards load from precomputed snapshots; p95 under 2 s for dashboard endpoints; ingestion endpoint acknowledges within 500 ms and processes asynchronously; batch of 500 calls processed within seconds under normal load.
- **Reliability:** ingestion is idempotent and replayable from raw events; no data loss on deploys; queue backpressure handled with clear `429` or `503` and `Retry-After`.
- **Scalability:** partitioned facts, per-org rate limits to prevent noisy neighbors, background recomputation throttled.
- **Security:** hashed keys, least-privilege scopes, signed webhooks, rate limiting, input size limits, SSRF protection on customer-supplied webhook URLs, no secrets in logs, tenant isolation tests.
- **Observability:** per-org ingestion metrics (rate, errors, lag), queue depth, API latency, webhook success, entitlement denials, usage near-limit; request IDs on every response.
- **Accessibility and UX:** keyboard navigable, readable contrast, consistent number formatting (₹ and Indian digit grouping option), loading, empty and error states for every widget.

---

## 12. Integration with other modules

- **KPI module:** the engine, catalog and wizard are reused as-is; this tier adds "data needed" statuses and plan limits.
- **Feature-gate framework:** plans map to feature entitlements, shared with the agent module.
- **Import Center:** bulk upload path for customers who cannot call the API.
- **Connector framework:** future dialer and telephony connectors feed the same ingestion pipeline.
- **Finance module:** Growth shows a basic revenue and collections summary from `payment_fact`; Scale and above unlock the full module and connectors.
- **Org chart module:** unlocks on Scale; lower plans use a simple team list.
- **Upgrade path to Platform:** migrating a customer to the CRM and AI tier must **preserve their API-sent history**; document and test the migration path.

---

## 13. Testing requirements

- **Unit:** entitlement resolution and limit behaviors (hard, quota, window); idempotency; validation; KPI calculations from sent data; "data needed" status logic.
- **API contract tests:** every endpoint against the OpenAPI spec, including batch partial failures, error shapes, rate-limit headers and `entitlement_required` responses.
- **Integration:** event → raw store → fact → KPI snapshot → dashboard, end to end, including late and corrected data and unmapped telecallers.
- **Security:** key scoping and revocation, tenant isolation (an org can never read another org's data by any endpoint), webhook signature verification, SSRF attempts, injection attempts.
- **Plans and upsell:** every trigger fires once per its cap and never for telecallers or viewers; trial start and automatic revert; upgrade unlocks within seconds; downgrade preview and over-limit handling; data retained read-only after downgrade.
- **Load:** seeded high-volume ingestion meets latency targets without cross-tenant interference.
- **UX/visual:** snapshot tests in light and dark mode; empty, loading, error and locked states; confirmation that locked previews are labelled "Sample".
- **Fixtures:** a seed org per plan with 6 months of calls, conversions and payments, a feed that goes stale, an unmapped telecaller and a late correction.

---

## 14. Developer experience (MUST)

- Public **API documentation** with quickstart (5 minutes to first event), authentication, idempotency, batching, errors, rate limits and webhooks.
- **OpenAPI file**, Postman collection, and sample code in at least JavaScript, Python and cURL.
- **Sandbox** (`test` keys) with the event inspector and a "reset test data" action.
- **Changelog** and deprecation notices by email to Developers and Owners.

---

## 15. Build order (milestones with acceptance criteria)

Do each milestone fully, with tests, before starting the next.

**M0: Discovery.** Inspect the repo and existing KPI, finance, Import Center, connector, org chart and feature-gate code; write `DECISIONS.md`. *Done when:* reuse decisions are recorded and a migration runs.

**M1: Plans and entitlements.** `plan`, `plan_entitlement`, `subscription`, the shared feature-gate framework, `Entitlements.check()`, usage meters, limit behaviors, admin plan editor. *Done when:* changing a plan's limit takes effect within seconds and the quota, hard and window behaviors pass tests.

**M2: API platform.** API keys with scopes and environments, authentication, rate limiting, idempotency, schemas, error format, batch endpoints, raw event store, OpenAPI generation, sandbox. *Done when:* replaying a request creates no duplicates and one bad item in a batch does not fail the others.

**M3: Processing and facts.** Queue, normalizers into fact tables, telecaller and team matching, unmapped queue, late-data recompute. *Done when:* a corrected call updates affected KPI periods only.

**M4: KPI engine and setup wizard.** Reuse the KPI engine; add "data needed" status and plan limits on KPI count; effective-dated configuration. *Done when:* an owner can configure 4 KPIs on Starter and is prevented from a 5th with the upgrade message.

**M5: Dashboards.** Overview, telecaller performance, leaderboard with visibility settings, drill-down to events, team view, period comparison, freshness stamps, onboarding checklist, demo mode. *Done when:* every dashboard number reconciles with the facts and drills to its source events.

**M6: Integration center and developer portal.** Keys UI, event inspector, error list and replay, webhook endpoints and delivery log, completeness per KPI, docs, Postman, samples. *Done when:* a developer can go from signup to a visible KPI in under 15 minutes following the quickstart.

**M7: Reports and alerts.** Exports, scheduled reports, share links, threshold alerts, outgoing webhooks, digest. *Done when:* scheduled reports respect plan limits and branding, and alerts fire once per condition with acknowledge and snooze.

**M8: Upsell and billing.** Usage meters UI, Compare plans page, contextual triggers with caps, locked previews, `entitlement_required` API errors, trials with automatic revert, upgrade and downgrade flows, billing integration, funnel tracking. *Done when:* upsell never reaches telecallers or viewers, each trigger respects its frequency cap, and a downgrade retains data read-only with a clear preview.

**M9: Users, roles and security hardening.** Roles, invitations, telecaller logins, 2FA, SSO and IP allowlist (Scale), audit log views, SSRF protection, tenant isolation tests, privacy features (hashing, retention, erasure). *Done when:* negative permission tests pass and an erasure request removes a person's data from facts and snapshots.

**M10: Performance, docs and migration path.** Load testing, partitioning review, accessibility audit, final docs, tested migration of an API-only org to the Platform tier with history intact. *Done when:* performance targets are met on a seeded high-volume dataset and the migration test preserves all history.

---

## 16. Defaults for open decisions

Use these unless the project owner says otherwise; record them in `DECISIONS.md`.

| Decision | Default |
| --- | --- |
| Plan names | Starter (API Insights), Growth, Scale, Platform (CRM + AI) |
| Plan numbers | Section 4 table values, stored as data and editable |
| Quota grace band | Up to 110% accepted, then rejected with clear error and owner alert |
| Retention behavior | Older data stored but not displayed beyond the window; returns on upgrade; grace period 90 days after downgrade |
| Trial | 14 days of the next plan up, one trial per org per plan |
| Upsell cap | One in-app banner per user per week; none on day one of onboarding |
| Who sees upsell/billing | Owner and Admin only |
| Leaderboard visibility | Owner setting; default own rank only for telecallers |
| Phone hashing on ingest | Optional, off by default |
| API versions | `/v1`, deprecation notice at least 6 months before removal |
| Batch size | 500 items per request |
| Rate limits | Per plan table; `429` with `Retry-After` |
| Demo data | Available, labelled and isolated from live data |
| Timezone / FY | `Asia/Kolkata`; April to March, configurable |
| Billing provider | Decided by project owner; must support Indian customers and GST invoices |

---

## 17. Definition of done

- Milestones M1-M10 accepted against their criteria.
- A customer can sign up, create an API key, send telecaller, call and conversion data, choose 4-6 KPIs and see accurate organization and telecaller performance, without any CRM or AI feature present.
- Every plan limit and locked feature is enforced server-side in the UI **and** the API, with stable `entitlement_required` responses.
- Upsell surfaces are contextual, rate-limited, honest, and never visible to telecallers or viewers; core access is never blocked to force an upgrade.
- Every dashboard number drills down to ingested events and reconciles with the facts.
- Ingestion is idempotent, replayable, tenant-isolated and observable.
- Downgrade, trial revert and cancellation never delete customer data prematurely.
- `DECISIONS.md`, API documentation with OpenAPI, Postman collection, and an operator runbook (plan changes, key revocation, replaying failed events, handling erasure requests) are written.
