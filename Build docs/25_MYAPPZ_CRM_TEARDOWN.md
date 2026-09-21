# MyAppz Platform: Structural Teardown and Porting Blueprint for Aura

**Target:** `https://admin.myappzbackend.com/v2/s/bbb14585-56f7-40b1-b911-76808af2f6b9/dashboard`. This is a
white-label agency/SaaS platform. The URL opens the **sub-account** (client workspace) tier.
**Captured:** 2026-09-21, from the production build published that morning (`index.html` `Last-Modified:
Mon, 21 Sep 2026 05:08:45 GMT`).
**Method:** static analysis of the publicly served JavaScript bundle (2,166 chunks, 49 MB), parsed with
Babel. The router, navigation registry, page logic and chart specs were rebuilt from it. **No login, no
API calls, no writes.**
**Coverage:** 1,983 route nodes across all tiers. Every sub-account route is inventoried in
Appendix A: 628 in the router, 611 once the 17 finance routes that exist only at the agency and
super-admin tiers are removed. Also covered: the full navigation registry (295 nodes), 180 distinct
chart definitions and 89 permission keys. Finance is read line by line: every formula below comes from shipping code.
**Compared against:** Aura platform, branch `crm-phases-on-origin` (latest migration `0123`).

---

## Contents

0. How this was captured, and what the evidence is worth
1. Architecture at a glance
2. Tenancy tiers, sign-in flow and URL scheme
3. Navigation, gating and UX flow
4. The sub-account Dashboard (the URL you gave)
5. **Finance: deep dive** (data model, dashboard maths, documents, subscriptions, reports, payment ops)
6. Finance and other modules at the agency and super-admin tiers
7. **Chart system**: conventions and catalogue
8. CRM (lead management): logic summary
9. Gap analysis vs Aura
10. What must NOT be ported
11. Recommended build order for Aura
12. Open questions (business calls, not engineering ones)
- Appendix A: sub-account route inventory (611 routes)
- Appendix B: navigation registry
- Appendix C: chart catalogue
- Appendix D: finance data surface
- Appendix E: finance RPCs and edge functions
- Appendix F: reproducing this analysis

---

## 0. How this was captured, and what the evidence is worth

The URL returns an empty SPA shell (`<div id="root">`) from S3 behind Caddy. Every screen is rendered
client-side from JavaScript that the server hands to **any** visitor, signed in or not. That bundle was
downloaded (static `GET`s under `/assets/` only), and then:

1. **Router reconstruction.** The React Router v6 JSX tree was walked with `@babel/parser`, including
   route fragments returned by helper functions (e.g. the finance route set, built by one function
   called with `tier = "super_admin" | "agency" | "subaccount"`). Each route's `element` was resolved
   to its lazy chunk and to any guard wrapped around it.
2. **Navigation registry.** The sidebar, module top-nav and in-page tabs are driven by one literal
   array of `{feature_key, label, route_suffix, nav_location, module_group, children}`. It was
   extracted verbatim (Appendix B).
3. **Logic read.** Finance, the dashboard and the CRM core were pretty-printed and read function by
   function. Each other screen got an automated fact sheet: the Supabase tables it reads or writes and
   their filters, RPCs, edge functions, realtime channels, chart specs and UI labels.
4. **Chart specs.** The minified Recharts exports were mapped back to component names through their
   `displayName`/`chartName` strings, and every `<XChart>` with its series was catalogued (Appendix C).

**Nothing was sent to the backend.** There were no `/rest/v1`, `/auth/v1` or `/functions/v1` calls,
no sign-in and no clicks. That is a deliberate contrast with the Hawcus crawl
(`21_HAWCUS_CRM_GAP_ANALYSIS.md` §0.1), which created three records through a UI crawl. This method
cannot mutate anything.

**Evidence grades used below:**

- **[C] Code-read:** logic read directly in the shipped JS. This is the strongest evidence for anything
  computed in the browser. Most of this platform's finance maths is computed there.
- **[R] Router/registry:** derived from the route tree or the nav registry.
- **[L] Label:** a UI string only (headings, column names, button text). It shows a feature exists,
  not how it works.
- **[I] Inferred:** a reading of the above. Flagged wherever it could be wrong.

**What this method cannot see.** Treat these as unknowns, not as absences:

- **Server-side logic.** 325 edge functions, 152 RPCs, the database triggers and the **RLS policies**
  are visible only as names and parameter lists. Examples: `dashboard-stats`, `refund-engine`,
  `payment-orchestrator`, `transition_invoice_status`.
- **Your tenant's state.** Which of the 628 routes this sub-account can actually open depends on its
  feature gates and plan (§3.2). That was not observable without signing in.
- **Pixel-level look.** Layout is described from component structure and Tailwind classes, not from
  screenshots.
- **Drift.** Chunk names are content-hashed and change on every deploy. Behaviour described here is
  as of the 2026-09-21 build.

**Porting rule (unchanged from the B2, Kailash and Hawcus teardowns): designs port, code never does.**
This bundle is someone else's proprietary code. The document describes behaviour, data shapes and
formulas so Aura can build its own versions under its own architecture (NestJS + raw SQL + `org_id`
+ FORCE RLS). No code was copied into Aura, and none should be.

---

## 1. Architecture at a glance

| Layer | What it is | Evidence |
|---|---|---|
| Frontend | Vite SPA, React 18, React Router v6 (JSX `<Route>` trees), TanStack Query, Radix/shadcn UI, Tailwind with HSL design tokens, date-fns | [C] |
| Charts | **Recharts** on every chart screen except three (Instagram, Courses and Zoom analytics use **Chart.js**) | [C] |
| Exports | jsPDF + autotable (PDF), SheetJS (XLSX), hand-built CSV with a UTF-8 BOM | [C] |
| Backend | **Self-hosted Supabase** at `https://myappzbackend.com`: PostgREST `/rest/v1`, GoTrue `/auth/v1`, Edge Functions `/functions/v1`, Realtime `postgres_changes`, Storage | [C] |
| Data access | Mostly **direct table access from the browser** (`supabase.from(t).select/insert/update/delete`), plus RPCs for multi-row or privileged operations and edge functions for gateways, AI and heavy aggregation | [C] |
| Tenancy | Columns `agency_id`, `sub_account_id`, `tenant_id` (finance documents use `tenant_id` = sub-account id). The client always adds the filter; RLS is presumed but invisible | [C] / [I] |
| Realtime | Pages subscribe to `postgres_changes` and invalidate their queries (finance dashboard, CRM board, notes, call logs, feature gates) | [C] |
| PWA | `vite-plugin-pwa` / Workbox, installable, a mobile-nav settings screen | [C] |
| White-label | `branding-bootstrap.js` and a `BrandingContext`; per-domain branding on "verified agency custom domains"; OG tags intentionally blank | [C] |
| Auth plumbing | A global `fetch` interceptor: on a 401 it refreshes the session; if the refresh fails it signs out and redirects to `/login`. On `/portal/*` it injects an `x-portal-session` header from `localStorage` | [C] |

**Scale** (sub-account tier only): **959** distinct tables, **152** RPCs and **325** edge functions are
referenced from sub-account screens [C]. The product spans CRM, marketing (sites, funnels, ads, social),
automation (WhatsApp, WABA, email, workflows), sales (voice AI, IVR, webinars, proposals, affiliates),
AI (agents, "business brain"), operations (HRM, payroll, inventory, hiring, a school/franchise vertical),
finance, community/LMS, calendar and healthcare. **It is a GoHighLevel-class agency suite, not a CRM.**
Porting "complete features" therefore means choosing among roughly 15 products (§11).

---

## 2. Tenancy tiers, sign-in flow and URL scheme

### 2.1 Three tiers, three URL roots [R]

| Tier | Root | Who | Route nodes |
|---|---|---|---|
| Super-admin (platform operator) | `/v2/x/…` | Platform staff | 347 |
| Agency (reseller) | `/v2/a/…` | Agency owner and staff | 224 |
| **Sub-account (client workspace)** | **`/v2/s/:id/…`** | The agency's clients and their staff | **628** |
| Portals | `/portal/…`, `/i/:slug/portal/…`, `/f/:slug/portal/…`, `/community/*`, `/event/:slug` | End customers, students, parents, teachers, community members | ~445 |
| Public and standalone | `/checkout/…`, `/pay/…`, `/p/proposal/:token`, `/form/:id`, `/book/:slug`, `/site/…`, `/store/…`, `/:shortCode`, plus the school/franchise vertical's own shells | Anonymous or vertical-specific | ~340 |

`:id` is the sub-account UUID. In your URL it is `bbb14585-56f7-40b1-b911-76808af2f6b9`.

### 2.2 Sign-in to dashboard [C]

1. **`/login`:** the user enters an email, then either a **6-digit PIN** or an **emailed OTP** (edge
   function `staff-login-otp`, "Code expires in 10 minutes"). `/signin`, `/auth/login`, `/admin/login`
   and `/superadmin` are aliases or redirects.
2. **`/select-account`** decides where the user lands:
   - super-admin → `/v2/x/agencies/all`
   - `app_metadata.role === "agency"` or an `agency_id` present → `/v2/a/dashboard`
   - on an education, community, institution or franchise portal domain → that portal's login
   - otherwise it loads sub-account memberships (`sub_account_members`, with `user_roles` as a
     fallback, roles `subaccount_owner` / `subaccount_staff`). Only `status = 'active'` sub-accounts
     count. It retries once after 350 ms if the list is empty. It **auto-enters `lastSubAccountId`
     from `localStorage`** when that is still valid; otherwise it shows a "Choose Account" list
     grouped by agency.
3. **`/v2/s/:id`** redirects its index to **`dashboard`** (§4).

### 2.3 URL conventions [R]

- **Tabs live in the query string**: `?tab=…`, with sub-views in `&view=…`. For example
  `finance/reports?tab=profit-loss` and `lead-generation/ads-social?tab=campaigns&view=adsets`.
- **Old paths are kept as redirects**, e.g. `finance/reports/gst → ../reports?tab=tax`,
  `finance/invoices → ../payments/invoices`, `staff/* → settings/staff/*`. 83 of the 628 sub-account
  routes are pure redirects.
- **Each module has a catch-all** (`<module>/*`) that renders a "module not found" page with a back link
  to the module home. There is no silent redirect to the dashboard.
- **Full-screen editors sit outside the shell**: site, funnel, form, chat-flow and workflow builders
  are mounted as absolute `/v2/s/:id/...` routes so they render without the sidebar.

---

## 3. Navigation, gating and UX flow

### 3.1 Shell [C][R]

- **Left sidebar:** one entry per module (Dashboard, Get Started, Lead Generation, Lead Management,
  Lead Automation, Sales, AI Suite, Operations, Inbox, Calendar, Finance, Community, Staff, Settings),
  grouped by `module_group` (Core, Marketing, CRM, Automation, Sales, AI, Operations, Communication,
  Scheduling, Finance, Engagement, Team, Settings).
- **Module top-nav:** the module's `top_nav` children, e.g. Lead Management → Opportunity · Pipeline ·
  Bulk Import · Lead Scoring · Forecasting · Attribution · Follow-up · Contacts · Meta Leads ·
  Agentic AI.
- **In-page tabs:** `inner_tab` children, usually `?tab=` values.
- **Settings hub:** `settings` entries render as a card grid at `/settings`.
- One registry drives all four (Appendix B). An agency-level registry (`agency_use_feature_registry`)
  and per-sub-account feature toggles decide which nodes show.

Global chrome [L]: a date-range picker (presets, custom range, timezone-aware), a staff filter on
dashboards, a Refresh button that invalidates listed query keys, a "Customize Dashboard" drawer, an AI
chat sidebar, product-update and help-centre links, and an experience-mode switch
(`feature_experience_modes` per feature: simple or advanced).

### 3.2 Three gating layers [C]

Every sub-account route passes up to three guards, in this order.

| Layer | Mechanism | Behaviour |
|---|---|---|
| **1. Module feature gate** (`featureKey`, e.g. `sub_finance`) | RPC `list_feature_gates(_sub_account_id)` → `[{feature_key, has_access, state}]`; fallback RPC `check_feature_access`. Realtime-invalidated on `feature_gates`, `feature_gate_grants`, `feature_gate_optins` | No access → **redirect to `/v2/s/:id/dashboard`**. Bypassed for the agency's primary sub-account, for agency users under `/v2/a`, and for super-admins while on operator paths, unless the gate's `state` is `private` |
| **2. Plan-feature gate** (`featureKeys[]`, e.g. `["sales_finance","payment_links"]`) | `hasAnyFeature(keys)` against the sub-account's plan | Holding any one key passes. Otherwise **redirect to the module home** (e.g. `/finance`). **Sub-account tier only** |
| **3. Permission gate** (`module.feature.action`, e.g. `finance.invoices.read`) | Resolved by role: super-admin → all; agency_owner → by the agency's sellable features; sub-account owner → all; staff → the permission grid for that module, where `canManage` = any `.create/.edit/.delete/.all` ≠ `none` and `canExport` = any `.export` | Denied → an in-place "access denied" panel (`showDenied`). **Sub-account tier only**; agency and super-admin skip it |

**Two fail-open behaviours to note, and not to copy (§10):**

- While any permission source is loading, `has()` returns **`true`**.
- If the feature-gate list query **errors**, the gate returns **`true`**.

Both are client-side only. Whether RLS backs them is unknown.

**89 permission keys** exist, in module groups [C]: `finance` (17, e.g. `invoices.read/create/delete`,
`payment_gateways.all`, `settlements.read`), `lead_management` (21, e.g. `crm.read/create/edit/delete`,
`pipeline.edit`, `forecasting.read`), `lead_generation` (8), `lead_automation` (4), `sales` (8),
`operations` (10), `community` (9), `calendar` (5), `inbox` (3), `ai_suite` (3), `settings` (2),
`staff` (1).

### 3.3 Sub-account module map [R]

| Module (left nav) | Routes | Top-nav / notable screens |
|---|---|---|
| Dashboard | 1 | 11 dashboard tabs (§4) |
| Lead Generation | 67 | Shop (15 tabs), Sites, Vibe Studio, Forms, Surveys, Ad Launcher (Meta/Google ads), AI Social, Reputation, Chat Widget, Digital Human, Prospecting, Templates |
| **Lead Management (CRM)** | 32 | Opportunity board/list, Pipeline mgmt, Bulk Import, Lead Scoring, Forecasting, Lead Sources, Follow-up, Contacts (import, dedupe, segments, stats, search settings), Contact Groups, Lead Dashboard, Agentic AI |
| Lead Automation | 31 | Email, WhatsApp (device-based), WABA (official), Telegram, Workflows (workflow/chat-flow/social-flow builders), Keyword Triggers, Bulk Campaigns, Voice Agent, Event Monitor |
| Sales | 49 | Sales dashboard, IVR, Voice AI (agents, numbers, campaigns, KYC), Webinars, Proposals, Events, Assignments, Affiliate, Performance (leaderboard, targets, scorecards, SLA), Incentives |
| AI Suite | 45 | AI Brain / Business Brain, Agents, Skill Builder, Command Center, Council, Approvals, Marketplace |
| Operations | 68 | Tasks, Report Builder, Inventory (7 sections), HRM (attendance, leave, payroll, shifts, hiring ATS), Kit Orders, School vertical |
| Inbox | 3 | Unified inbox with a dashboard tab |
| Calendar | 15 | Calendar view, event types (wizard), appointments, check-in, reports |
| **Finance** | 76 | §5 |
| Community | 72 | Courses/LMS, live classes, certificates, digital store, memberships, leaderboard/gamification |
| Settings | 116 | Staff and roles/permissions, tags, custom fields and "values", 26 analytics screens, integrations/app store, domains, branding, API, webhooks, vault, AI settings |

### 3.4 Navigation drift: 14 links with no route [R]

Fourteen `route_suffix` values in the registry have no matching route in the shipped router, so they
land on the module's "not found" page: `lead-generation/shop/finance`, all five
`lead-generation/digital-human/*`, `lead-management/meta-leads`, `lead-automation/bulk` (the router
has `bulk-campaigns`), `ai-suite/dashboard`, `operations/productivity`, `finance/plan`,
`settings/inbox-triggers`, `settings/api-settings` (the router has `settings/api`) and `healthcare`.
Separately, every "Hiring: …" entry under Operations is caught by
`operations/hiring/* → ../hrm/hiring/roles`, so "Candidates", "Interviews" and the rest all open
**Roles**. [I] The live sidebar may merge database rows over this registry, so some of these may be
hidden in practice.

**The lesson for Aura:** keep nav and routes in one source, or add a test asserting that every nav
target resolves. Aura's `loading-skeletons` guard test is the precedent for that kind of structural
test.

### 3.5 Recurring screen patterns [C][L]

- **List page:** a KPI strip (4–6 tiles), then search, filter popover, table, "Rows per page" and
  Prev/Next pagination, and **Export CSV / Download PDF**. PDFs come from jsPDF with an audit context
  (`entity_type`, `row_count`) logged.
- **Detail page:** a header with a status badge and state-transition buttons, a line-item table, a
  totals block, then tabs for activity, messages and history.
- **Dashboards:** cards of `h-[260px]` charts. Every card has a skeleton while loading and an
  icon-plus-sentence empty state ("No MRR data in this period").
- **Create flows:** mostly modal dialogs. Large creations are wizards (calendar event, product, import).
- **"Live" widgets:** realtime subscriptions plus 30–120 s refetch intervals, labelled "Live".
- **AI Advisor buttons** on the approvals, reminders and dunning settings pages suggest thresholds
  ("Auto-approve below / Single approval below / Dual approval above").

---

## 4. The sub-account Dashboard (`/v2/s/:id/dashboard`)

### 4.1 Tabs [C]

`overview` (default) · `marketing` ("Marketing & Leads") · `sales` ("Sales & Revenue") · `operations` ·
`messaging` ("Messaging & Engagement") · `team` ("Team & Productivity") · `finance` · `customer`
("Customer Success") · `forecasting` ("Forecast & Growth") · `ai` ("AI Intelligence") · `system`
("System Health").

The user's preferred tab persists per user in `dashboard_preferences.preferred_dashboard`. Unknown
values fall back to `overview`. Each non-overview tab is its own lazy chunk.

### 4.2 Data source [C]

The Overview reads **one edge function**:

```
GET /functions/v1/dashboard-stats
    ?sub_account_id=…&date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
    &from_utc=…&to_utc=…&tz=<IANA>[&staff_id=…]
```

- The date range is converted to **business-local dates and UTC bounds** using the sub-account's
  timezone. `timezoneSource` is one of business profile, agency profile or platform default; the UI
  says which one applied ("fallback — set a timezone in your business profile").
- `staleTime` 30 s, `refetchInterval` 120 s, refetch on window focus.
- **Realtime invalidation** on `finance_subscriptions`, `customer_subscriptions`, `ad_reports_daily`
  and `finance_daily_revenue`, filtered by `sub_account_id`.
- The server may clamp the range; the UI then shows **"Range corrected by server"**.
- The range comes from the shared date-range picker in the page header. The staff filter lists
  `staff_members` where `is_active`. Tiles that cannot be split by staff say "Not staff-filterable".

The response is a nested JSON (`marketing.*`, `sales.*`, `calendar.*`, `contacts.*`, `finance.*`,
`whatsappOfficial.*`). Each widget reads it through a `dataPath` string.

### 4.3 Widget registry: 32 KPI tiles [C]

| Category | Tiles (on by default in **bold**) | Notable definitions |
|---|---|---|
| Marketing | **Ad Spend**, Cost per Lead, **Leads Generated**, **Conversion Rate** (progress), ROAS, Impressions, Clicks, CTR, CPC | CPL = spend ÷ ad leads; conversion = ad conversions ÷ clicks; ROAS = revenue ÷ spend; values in the ad account's currency |
| Sales | **Total Sales**, **Sales Calls**, Show-Up Rate, No Shows, Revenue | Revenue duplicates Finance → Total Revenue and is off by default (see below) |
| Operations | **Calendar Bookings**, Cancelled, Rescheduled | Bookings = booked or confirmed, excluding cancelled |
| Messaging | **WA Official Status**, WA Quality | Status-style tiles (text) |
| Contacts | **New Contacts**, **Total Contacts**, **Active Leads**, **Customers**, **New Customers** | "New …" is in-period; the rest are all-time |
| Finance | **Total Revenue**, **MRR**, ARR, Active Subscriptions, Transactions, Ad Leads | |
| System | WA API Balance, Messaging Tier | |

Tile variants are `stat`, `progress` and `status`. Formats are `currency`, `number`, `percent` and
`text`. A negative currency value renders in the destructive colour. Each tile's info popover shows
**Source / Formula / Period**.

**Per-user layout:** show or hide, drag to reorder, and resize to 1–4 columns ("Resize (n/4 columns)").
The layout persists **twice**: in `localStorage` (`dashboard_overview_widgets_v3`, migrated from v2)
and in `dashboard_widget_preferences(user_id, sub_account_id, widget_config)` (upsert on that pair).
The server copy wins on first load. A version counter runs one-time migrations; for example, at
version 3 "Sales → Revenue" is hidden when "Finance → Total Revenue" is visible, so the same figure
does not appear twice.

A second, **config-driven KPI engine** (`DynamicKPIGrid`) reads `dashboard_kpi_config` and
`daily_metrics`. Rows are keyed by `portal_type` and `dashboard_tab`, with `metric_key`,
`query_source`, `aggregation_type`, `chart_type`, `cache_ttl_seconds`, `format`, `icon` and `color`.
KPIs can therefore be added without a deploy [C]. The query sources run server-side and are not
visible.

### 4.4 Other tabs [L][C]

- **Marketing:** source attribution.
- **Sales:** "AI Deal Alerts" ("No alerts — pipeline is healthy") and a rep leaderboard.
- **Finance:** a compact version of §5.4. Revenue, MRR, ARR, subscriptions, transactions and net
  profit. Net profit = revenue − `finance.expenses`.
- **Operations:** automation success rate and team workload.
- **Messaging:** channel breakdown and automation performance.
- **Team:** leaderboard and department insights.
- **Customer Success:** churn-risk customers.
- **Forecasting:** a three-month revenue trend, a recurring-revenue projection and a pipeline
  forecast.
- **System Health:** broken ad-platform connections (`ad_platform_connections.token_expires_at`), an
  IndiaMART key-expiry banner (`sub_account_integrations.last_sync_status = 'auth_error'`) and usage
  against limits.
- **AI Intelligence:** "What should you do today?" suggestions.

---

## 5. Finance: deep dive

### 5.1 Scope and navigation [R]

`/v2/s/:id/finance` has **76 routes** at the sub-account tier. Its inner tabs:

**Dashboard** · **Documents** (All, Create, Templates) · **Transactions** (Real-time, List, Failed) ·
**Expenses** (Categories, Vendors, List, Table) · **Reports** · **Recurring** · **Approvals** ·
**Reminders** · **Quotes** · **Settlements** · **Import** · **Migration** · **Plan** (Coupons, Payment
Links, Subscription = product catalogue) · **Sales** · **Settings** · **Analytics**.

Deep-linked screens outside the tabs: `disputes`, `wallets`, `audit-log`, `dunning`, `gateway-routing`,
`commissions`, `recurring-expenses`, `payment-retry`, `anomaly-detection`, `credit-notes`,
`expense-analytics`, `clv`, `tax-summary`, `profit-loss`, `balance-sheet`, `aged-receivables`,
`my-plan`, `settings/qr` and `payment-gateway/template/:templateId`.

**One route function serves all three tiers.** It is called with `tier`: guards apply only when
`tier === "subaccount"`, and some routes exist only at one tier (§6.1).

### 5.2 Finance access matrix [C]

| Screens | Permission key | Plan-feature keys (any one) |
|---|---|---|
| Coupons, Payment Links | `finance.coupons.read`, `finance.payment_link.read` | `sales_finance`, `payment_links` |
| Product catalogue ("Subscription") | `finance.subscription.read` | `sales_finance`, `payment_links`, `subscriptions_finance` |
| Sales, Order detail | `finance.subscription.read` | `transactions_finance`, `subscriptions_finance`, `sales_finance` |
| Invoices table | `finance.invoices.read` | same as Sales |
| Transactions, Failed | `finance.transactions.read` | same as Sales |
| Expenses (all), Commissions, Recurring expenses, Expense analytics | `finance.manage_expenses.read` / `finance.expense_category.read` | `expenses` |
| Reports, Audit log, Anomaly, CLV, Tax summary, P&L, Balance sheet, Aged receivables | `finance.reports.read` | `reports_finance` |
| Documents, Quotes, Credit notes | `finance.invoices.read` / `finance.quotes.read` | `documents_finance` |
| Recurring, Dunning | `finance.recurring.read` | none |
| Approvals · Reminders · Settings · Settlements | `finance.approvals.read` · `finance.reminders.read` · `finance.finance_settings.read` · `finance.settlements.read` | none |
| Disputes, Wallets, Payment retry | `finance.transactions.read` | none |
| Gateway routing | `finance.payment_gateways.all` | none |
| Dashboard, Import, Migration, Invoice setup, My plan | none | none |

### 5.3 Data model (core entities) [C]

Each table below is used from the browser. The full list, with operations and screens, is in
Appendix D.

| Entity | Table(s) | Key columns seen |
|---|---|---|
| Product / plan catalogue | `finance_products`, `finance_product_folders`, `finance_product_groups` (multi-product checkout), `finance_product_templates`, `finance_product_upgrade_paths`, `finance_product_dependencies`, `finance_product_entitlements`, `finance_usage_alert_rules`, `finance_product_audit_log` | `product_type` (one-time / subscription / recurring / installment), `billing_type`, `billing_mode`, `billing_interval` + `billing_interval_count`, `price`, `currency`, `tax_percentage`/`gst_percentage`, `hsn_sac_code`, `tds_applicable`/`tds_percentage`, `emi_down_payment`, `deposit_amount`, `lifecycle_status`, `total_sales`, `total_revenue` |
| Subscriptions (**three overlapping tables**) | `finance_subscriptions`, `customer_subscriptions` (+ `subscription_products`), `finance_installment_plans` + `finance_installments` | `status`, `billing_amount`, `mrr_amount`, `billing_interval`, `next_billing_date`, `current_cycle`/`total_cycles`, `cancel_at_period_end`, `autopay_enabled`, `gateway`, `gateway_subscription_id`, `subscription_seq`, `original_subscription_id`, `discount_amount`; installments: `installment_number`, `amount`, `status` (pending / partial / overdue / paid), `due_date`; plan: `downpayment_amount`, `payment_structure` |
| Documents (**two overlapping invoice tables**) | `finance_documents` + `finance_document_items`/`finance_document_lines`; legacy `finance_invoices` + `finance_invoice_items` | `document_type`, `document_number`, `status`, `party_name`/`party_gstin`, `issue_date`/`due_date`/`paid_date`, `subtotal`, `tax_total`, `igst`/`cgst`/`sgst`, `discount_total`, `grand_total`, `amount_paid`, `amount_due`, `refund_amount`, `source_document_id`/`source_document_type`, `opportunity_id`, `capi_purchase_status` |
| Money movement | `finance_transactions`, `finance_refunds`, `finance_credit_notes`, `finance_disputes`, `finance_settlements`, `finance_reconciliation_matches`, `finance_reconciliation_issues` | transactions: `amount`, `status` (success / paid / failed / refunded), `payment_type` (incl. `refund`), `transaction_date`, `payment_gateway`, `invoice_id`/`invoice_number`, `gateway_order_id`, `transaction_id_external`; settlements: `gross`, `fees`, `net_amount`, `settlement_date`, `gateway_code` |
| Expenses | `finance_expenses`, `finance_expense_categories`, `finance_vendors`, `finance_recurring_expenses` | expense: `amount`, `category`, `vendor_name`, `expense_date`, `payout_status`, GST mode, TDS; vendor: PAN, GSTN, address, bank (beneficiary, account, IFSC), default category |
| Automation config | `finance_recurring_schedules`, `finance_reminder_rules`, `finance_dunning_rules`, `finance_approval_workflows` + `_stages` + `_items`, `finance_payment_retry_rules` + `_log`, `finance_gateway_routing_rules`/`finance_routing_rules`, `finance_retry_policies`, `finance_anomaly_rules` + `_alerts` | see §5.11 |
| Stored value | `finance_wallets` (`balance`, `hold_balance`), `finance_wallet_transactions` (`balance_before`/`balance_after`), `finance_commissions` | |
| Numbering and presentation | `finance_numbering_config`, `finance_number_counters`, `finance_document_settings`, `finance_document_templates`, `finance_qr_settings`, `finance_business_profiles` (incl. `dashboard_mode_override`, `business_industry`) | |
| Rollups and views | `finance_daily_revenue` (`summary_date`, `total_invoiced`, `total_paid`, `total_refunded`, `transaction_count`, `new_customers`), `finance_customer_ltv`, `finance_revenue_schedule` (revenue recognition), `v_sa_all_subscriptions`, `v_agency_consolidated_pl` | |
| Audit | `finance_audit_logs` (writes), `finance_audit_log` (reads). Two names; [I] likely a table and a view | |

### 5.4 Finance Overview dashboard: exact logic [C]

**Industry-driven "dashboard mode."** The hero KPI row and primary chart change with the business type.
The mode comes from `finance_business_profiles.dashboard_mode_override`, else from `business_industry`
(or `sub_accounts.industry`) through a lookup, else `subscription`.

| Mode | Industries mapped to it | Hero KPIs (5) | Primary chart |
|---|---|---|---|
| `coach` | coach, trainer, fitness, healthcare, therapist, consultant | total revenue, paid invoices, avg invoice, collection rate, repeat revenue % | sessions revenue |
| `education` | education/training, school, academy, coaching institute | collected, outstanding, invoiced, paid invoices, collection rate | fee waterfall |
| `finance` | SaaS, B2B SaaS, digital, agency, marketing agency | ARR, MRR, net revenue, avg invoice, collection rate | MRR movement |
| `subscription` (default) | none | MRR, ARR, active subs, new subs, churn rate | MRR movement |
| `installment` | real estate, loans, lending, automotive | collected, outstanding, paid invoices, avg invoice, collection rate | revenue trend |
| `onetime` | e-commerce, retail, events | total revenue, net revenue, paid invoices, avg invoice, refunds | revenue trend |

**Period totals.** These are computed for the selected range and again for the **immediately preceding
range of equal length**, to produce the change %.

| Metric | Formula |
|---|---|
| Gross revenue | Σ `finance_transactions.amount` where `status ∈ {success, paid}` and `created_at ∈ period` |
| Refunds | Σ `finance_refunds.amount` where `status ∈ {success, completed}` and `refunded_at ∈ period` |
| **Net revenue** | gross − refunds |
| Invoiced | Σ `finance_invoices.amount` where `status ∈ {sent, partially_paid, paid, overdue}`, `issue_date ∈ period`, not deleted |
| Collected | = gross revenue (successful transactions in period) |
| Outstanding | Σ `amount_due` over **all** open invoices (`sent, partially_paid, overdue`), **not** limited to the period |
| **Collection rate** | collected ÷ invoiced × 100, rounded to 0.1 and **clamped to 0–100** |
| Paid invoices | count of in-period invoices with `status ∈ {paid, partially_paid}` |
| Avg invoice | **invoiced total ÷ paid-invoice count**. The numerator and denominator do not match (see §10) |
| Change % | `(cur − prev) / |prev| × 100` rounded to 0.1; when `prev = 0`: 100 if `cur > 0`, else null |
| **Repeat revenue %** | Of paid and partially-paid invoice amounts in period: the share from customers (key = `contact_id` ∥ `customer_email`) whose first invoice predates the period start. "First invoice" is only searched in the current and previous periods |
| **DSO** | `outstanding ÷ gross revenue × days-in-period`, rounded to 0.1. Tile colour: ≤30 good, ≤60 warn, else bad |
| Collection-rate tile colour | ≥80 good, ≥50 warn, else bad |

**Subscription metrics** use a merged "sales rows" set (§5.6):

- **MRR** = Σ over `finance_subscriptions` with `status ∈ {active, recurring, paid, trialing}` of the
  normalised monthly amount. Normalising `billing_amount` by the product's
  `billing_interval`/`billing_interval_count`: year → ÷(12·n), month → ÷n, week → ×52/(12·n),
  day → ×365/(12·n). **Trialing counts toward MRR.**
- **ARR** = MRR × 12.
- **Active** = rows with status recurring, active or paid. **New** = rows created in the period.
- **Churn rate** = churned-in-period ÷ (active + churned-in-period) × 100. "Churned" = status
  cancelled or refunded with `cancelled_at` in the period.
- **Overdue** = rows with status overdue, past_due or partially_paid.

**Widgets and charts on the page:**

| Widget | Data and logic | Chart |
|---|---|---|
| Hero KPI row (5) + "universal strip" (Gross, Collected, Refunds, Outstanding, Invoices, Collection) | as above | tiles with ▲▼ change |
| **Revenue Trend** | Invoices bucketed by `issue_date`. Bucket size: ≤45-day range → **daily**, ≤180 → **weekly** (week start), else **monthly**. Per bucket: invoiced, paid (paid / partially paid → `amount_paid`), refunded (by `refunded_at`), net = paid − refunded | AreaChart: "Invoiced" dashed grey, "Collected" solid primary, gradient fills |
| **Subscription Breakdown** | counts by active / trialing / past_due / cancelled / paused / refunded (zeros hidden) | donut (inner 40, outer 65) + legend list |
| **MRR Movement** | Per month in range: new MRR = Σ normalised MRR of subscriptions created that month; churned = −Σ of those cancelled that month; **expansion is hard-coded to 0** | stacked BarChart with `stackOffset="sign"` and a zero reference line |
| **Revenue Waterfall** | Gross → Discounts (Σ `finance_invoices.discount_total` in period) → Refunds → Net (= net revenue − discounts, floored at 0) | 4-bar BarChart with per-bar colours |
| Collection Rate + DSO | as above | two tiles with threshold colours |
| **Product Performance** | Paid invoices grouped by product name: `source_type = product` → product; else subscription → its product; else `invoice_name` unless it looks like `INV-…`; else "Other" | horizontal BarChart |
| **Top Customers** | Paid invoices grouped by email / name / contact; top 10 by amount (8 shown) with count, AOV, first and last date | list |
| **Upcoming Renewals** | active-ish subscriptions with `next_billing_date` in the next **7 days** | list |
| **Overdue Invoices** | status ∉ {paid, cancelled, void} and `due_date < today`; with days overdue | list |
| **Reconciliation** | last 100 `finance_reconciliation_issues`: open / resolved / total, last scan. Green at 0 open, amber below 5, red at 5 or more | status card |
| **Finance Activity** ("Live") | last 10 `finance_transactions`; realtime `INSERT` subscription and a 60 s refetch | feed with status badges |
| **Export CSV** | sections: KPI summary, universal metrics, top customers, product performance, renewals, overdue, revenue trend; UTF-8 BOM; `finance-report-<from>-to-<to>.csv` | |

Realtime: any change on `finance_invoices`, `finance_subscriptions`, `finance_refunds` or
`finance_transactions` invalidates the dashboard queries.

### 5.5 Documents engine: invoices, quotes and 10 more types [C]

**Twelve document types** share one table (`finance_documents`) and one editor:

| Type | Prefix | Can convert to |
|---|---|---|
| Quotation | QUO | invoice, proforma, sales order, purchase order, delivery challan |
| Estimate | EST | invoice, proforma, sales order, quotation |
| Proforma Invoice | PI | invoice, credit note, debit note, purchase order, delivery challan |
| **Invoice** | INV | credit note, debit note, purchase order, delivery challan |
| Sales Order | SO | invoice, proforma, delivery challan |
| Purchase Order | PO | invoice, proforma, quotation |
| Delivery Challan | DC | invoice |
| Credit Note / Debit Note | CN / DN | none |
| Payment Receipt / Payout Receipt | RCT / POR | none |
| Expense / Bill | EXP | none |

**State machine per type** (`*` = requires a balance):

| Type | Transitions |
|---|---|
| Quotation, Estimate | draft → sent → {client_approved, rejected, expired}; plus converted and void (terminal) |
| Proforma | draft → sent → {client_approved, rejected}; converted and void terminal |
| **Invoice** | **pending → {partially_paid\*, paid\*, cancelled}**; overdue → {partially_paid\*, paid\*, cancelled}; partially_paid → paid; paid → refunded; cancelled, refunded and converted terminal |
| Sales Order | draft → confirmed → fulfilled |
| Purchase Order | draft → submitted → {approved, rejected}; approved → received |
| Delivery Challan | draft → dispatched → delivered |
| Credit/Debit Note | draft → issued → applied; void |
| Expense/Bill | draft → approved → paid; void |
| Receipts | issued (terminal) |

The primary button on create is type-aware: **"Send"** for quotation and estimate; otherwise
"Create & Send". The initial status is `issued` for receipts, `pending` for invoices and `sent` for
everything else. There is also "Save as Draft".

**Line-item and total maths** (per line):

- `no_tax` (or rate 0): taxable = price × qty, tax = 0.
- **Exclusive:** taxable = price × qty; tax = taxable × rate; line total = taxable + tax.
- **Inclusive:** total = price × qty; taxable = total ÷ (1 + rate); tax = total − taxable.
- The rate comes from the chosen **tax slab** (`rate_percent`, `is_inclusive`), else the manual rate,
  else the tenant's default rate (applied to the first line only).
- Document: `subtotal = Σ taxable`, `tax_total = Σ tax`, `grand_total = subtotal + tax_total`.
  **There is no document-level discount in the editor**, and line `discount_amount` is written as 0.
- It writes **`igst = tax_total` and `cgst = sgst = tax_total/2` at the same time**. Consumers pick
  one (see §5.9 for how the GST report does it, and §10).
- "Mark as paid" at creation → `status = paid`, `amount_paid = grand_total`, `amount_due = 0`,
  `paid_date = now`. Editing a paid invoice keeps it paid and recomputes
  `amount_due = max(0, grand_total − amount_paid)`.
- Payment modes: Online (UPI, bank transfer NEFT/RTGS/IMPS, direct deposit, netbanking, card, wallet),
  Cash, Cheque, Credit-note adjustment.
- Party: contact search (name, email, phone, company, GSTIN) or quick-create. The GSTIN is saved back
  to the contact. Tax category and state come from the country.
- Line items come from **Products** or **Agency Plans**.

**Numbering:** RPC `generate_document_number(_tenant_id, _doc_type)` draws from
`finance_numbering_config` and `finance_number_counters`, per type and per fiscal period. A
**"Start New Financial Year"** action calls `roll_fiscal_year`. The invoice prefix is "only used the
first time a counter is created". Numbers can be edited, with a live uniqueness check.

**Around the document:**

- Templates: colours, font, paper A4/A5/Letter/Legal, orientation, margins, watermark text and
  opacity, signatory, field visibility.
- QR settings: which document types, encoded fields, size, position, payment link, UPI ID.
- Detail page: void, a follow-up with AI, "Messages to Client" log (`finance_document_message_logs`),
  converted-from link.
- Sending: `send-invoice-email` (SMTP connection picker), WhatsApp, copy link.
- **Meta Conversions API "Purchase" event** on paid invoices (`finance-capi-purchase`; per-row status
  `capi_purchase_status`/`_error`), gated by `finance_capi_settings.send_manual_invoices`.
- Credit notes are issued from the invoice table's actions. Invoices can be **bulk-generated as
  drafts** (pick customers and a product).
- Approval workflows (§5.11) can hold high-value documents.
- A document can be linked to or unlinked from a CRM opportunity
  (`crm_link_finance_document_to_opportunity`).

### 5.6 Sales, subscriptions, EMIs and autopay [C]

**A "sale" is a unified row across three tables:** `finance_subscriptions`, `customer_subscriptions`
and `finance_installment_plans`. It is enriched with the matching invoices and refunds. Its displayed
status is **derived in the browser**:

- recurring (a subscription with ≥1 paid invoice), active, paid, partially_paid (any linked invoice
  partially paid), overdue (with due or unpaid signals), `cancelling` (`cancel_at_period_end`),
  cancelled (also suspended or expired), refunded / partially_refunded, trialing, paused.
- Kind: one-time, installment or subscription. It is also inferred from notes such as "converted to
  one-time" or "converted to EMI".
- `paidAmount` and `pendingAmount` are computed per row. The next billing date is extrapolated from
  `start_date + interval × cycles` when missing.

**Product configuration** (the "Subscription" tab is really the product catalogue):

- Types: one-time, subscription, installment. Interval and count, trial, deposit, EMI down payment.
- **Cancellation and retention:** a win-back offer (percent, fixed, free extension, or downgrade;
  valid N days) and a cancellation survey with default reasons.
- **Upgrade/downgrade paths** with proration: *prorated*, *immediate full charge*, *end of cycle*,
  *none*; plus incentive text.
- Usage-alert rules on entitlements (threshold %, channel, message with `{{pct}}`/`{{limit}}`).
- Dependencies, entitlements, templates, folders, sunset migration, bulk import, AI product builder
  (`ai-product-builder`).
- **Multi-product checkout** groups, attached coupons (auto-apply or code), and custom checkout
  fields drawn from contact custom fields.
- Per-product analytics: subscription, one-time and installment revenue, cancellation rate, and a
  revenue AreaChart.

**Order detail / billing manager:**

- Totals: billed, lifetime paid, active subs, open invoices, pending amount.
- A timeline from `finance_events`.
- **Mark as Paid:** manual payment (cash, bank, UPI, cheque, other) with an "I confirm this payment has
  been received" checkbox. A **partial payment does not advance the billing cycle.**
- Cancel order. Status changes go through RPC `transition_subscription_status`.
- **EMI generation:** "Auto-generate equal installments" (count and interval) **replaces pending
  installments and preserves paid ones**.
- Deposits: `product-deposit`, `platform-plan-deposit`. Refunds: `refund-engine`.

**Razorpay Autopay** (`finance/recurring`):

- Mandate lifecycle: Active, Pending Auth, Paused, Cancelled, Failed, Completed, Mandate Revoked
  ("Customer cancelled the autopay mandate from their UPI app").
- Charge history per subscription.
- **Recurring schedules** (`finance_recurring_schedules`): "Auto-generate invoices on schedule" with
  client, type, frequency, next run, run count, auto-send.

### 5.7 Transactions, refunds, disputes, settlements [C][L]

- **Transactions** is a read-only "Payment Ledger": invoice, customer, product, gateway, amount and
  status, with failure reasons. There is a **Failed** view and a multi-currency banner.
- **Refunds** appear in the Refund report tab (§5.9), with statuses processed / pending / failed /
  reversed. **The "Retry" button only shows a toast ("Retry queued…") and sends no request.**
- **Disputes and chargebacks:** type (chargeback, dispute, inquiry, fraud), gateway and gateway
  dispute id, reason, deadline. KPIs: open, at-risk amount, won, lost.
- **Settlements and reconciliation:**
  - Settlement: id, gateway, date, gross, fees, **net = gross − fees (not editable)**, status.
  - Reconciliation: expected vs received, difference, reason, "Mark Resolved".
  - KPIs: total settled, pending, mismatches, "Est. Money Stuck".
  - The form rejects **past settlement dates**, which is odd for settlements.

### 5.8 Expenses [C]

- **Categories and vendors.** A vendor has PAN, GSTN, a full address (country, state, city,
  pincode), bank details (beneficiary, account, IFSC) and a default category.
- **Expense form:**
  - Vendor, category, amount, invoice date and period month.
  - **GST mode:** Exclusive / Inclusive / Exempt, plus a rate.
  - **TDS:** yes/no, plus a rate.
  - Payout status: pending, paid or cancelled.
  - A receipt, either uploaded or picked from the media vault.
- **Tax breakdown panel** (the same maths is used for products):
  - exempt or rate 0: net = gross = base.
  - inclusive: net = base ÷ (1 + r), tax = base − net, gross = base.
  - exclusive: net = base, tax = base × r, gross = base + tax.
  - **TDS = net × tds%**, and **final payout = gross − TDS**.
  - In India, tax is shown split as **CGST = SGST = tax/2**.
- **AI bank-statement import:** upload CSV or XLSX. `ai-import-analyze` maps the columns, then
  `expense-import-enrich` categorises rows and matches vendors, with "Low confidence", "New vendor"
  and "New category" flags and bulk approve/skip/set. `finance-import-commit` writes the result.
- **Recurring expenses:** name, category, frequency, amount, next due, vendor, auto-create on the due
  date, reminder 1/3/7/14 days before. KPIs: **est. monthly burn**, active, due soon, overdue.

### 5.9 Reports hub: `finance/reports?tab=…` [C]

There are **12 visible tabs and 5 hidden ones** (reachable by URL only). Thirteen tabs export CSV and
PDF through a shared helper that logs an audit context (`entity_type`, `row_count`). `income` has
its own un-audited CSV/PDF export. `forecast`, `revenue-recognition` and `proration` have no export.

| Tab | Source | Logic |
|---|---|---|
| `revenue` | `finance_daily_revenue` rollup | Daily revenue, refunds, net, transaction count, new customers. **Falls back to raw transactions + refunds** when the rollup is empty or under-reports by more than ₹0.02, and shows a banner explaining that "new customers" may then read 0. Chart: Area (revenue) + dashed Area (net) |
| `income` | transactions | Per-transaction list: category = payment type, customer, product, date, method |
| `expenses` | expenses | List converted to INR through an FX table (`convertToINR`) with "last updated"; total in INR |
| `profit-loss` | transactions + products + refunds + expenses | **Income by product:** successful transactions grouped by product (per currency); taxable value back-calculated as `value ÷ (1 + product GST%)`, GST = value − taxable. **Refunds by product:** taxable refund = amount − tax. **Net revenue** = total income − total refunds. **Net profit** = net revenue − Σ expenses by category |
| `outstanding` | open invoice documents + pending EMI installments | Unpaid invoices (`amount_due`) plus installments (pending / partial / overdue) as "EMI #n" rows |
| `overdue` | installments + invoices | Pending installments past due (pending = plan total − Σ paid installments) plus invoices that are overdue, or sent/issued/partial/pending past `due_date` |
| `refund` | `finance_refunds` (+ invoice → subscription → agency lookups) | Status filter; KPIs refunded amount, pending, failed; cosmetic Retry (§5.7) |
| `cancellation` | subscriptions + documents | Unified cancelled records with origin, reference, type and amount |
| `customer` | `finance_customer_ltv` view | LTV table sortable by total paid or invoice count |
| `plan-revenue` | `v_sa_all_subscriptions` | Per product: active count, **MRR (active only)**, total revenue = Σ `billing_amount` (all statuses). Bar: MRR |
| `forecast` | active subscriptions + `finance_daily_revenue` | **12-month forecast with a hard-coded 5 % monthly churn**: predicted MRR is flat at current MRR; churn-adjusted = MRR × 0.95ⁿ. **Cohort retention:** paid invoices (last 1,000), cohort = month of the contact's first paid invoice, retention % = contacts with a paid invoice in month k ÷ cohort size, up to 12 months; heat colours ≥80 / 60 / 40 / 20 |
| `tax` (GST) | invoices + items + transactions + business profile | See the GST logic below. Export: CSV, XLSX (auto-width) and PDF, with the seller's state in the subtitle |
| `consolidated-pl` *(hidden)* | `v_agency_consolidated_pl`, else transactions | Per sub-account per day: revenue, refunds, net, transactions, customers |
| `ar-aging` *(hidden)* | open invoice documents | Buckets from days past due: current (≤0), 1–30, 31–60, 61–90, 90+. Excludes paid, cancelled, void, refunded, converted and draft. `amount_due` falls back to `grand_total − amount_paid` |
| `revenue-recognition` *(hidden)* | `finance_revenue_schedule` | Total, recognised, deferred; % recognised; method (e.g. straight line); active or completed |
| `proration` *(hidden)* | calculator only | daily rate = price ÷ cycle days; used = rate × days used; credit = current rate × days remaining; new charge = new rate × days remaining; **net adjustment = new charge − credit** (+ = charge, − = credit) |
| `invoice` *(hidden)* | invoices | Invoice register with sale type (subscription / installment / one-time), GSTIN, coupon, status |

**GST report logic:**

- The seller's state code = the first two digits of the business GSTIN, else the state name mapped
  through the Indian GST state-code table (codes 01–38 and 97).
- If a row stores IGST/CGST/SGST, those are used. The taxable value falls back to
  `total − taxes`, and the rate is back-derived if it is missing.
- Otherwise, when a rate > 0: taxable = subtotal ÷ (1 + r). The row is **inter-state** when the
  customer GSTIN's state code ≠ the seller's; then IGST = full tax, else CGST = SGST = tax/2.
- Per-row columns: invoice #, customer, GSTIN, HSN/SAC, date, product, invoice value, rate, taxable,
  IGST, CGST, SGST, state of supply, payment method, transaction id and date, description.

### 5.10 Standalone statements [C]

| Screen | Logic | Chart |
|---|---|---|
| **Profit & Loss** (`finance/profit-loss`, default "Last 3 Months") | Gross revenue = Σ (`amount_paid` ∥ `amount`) over invoices with status paid or partially_paid created in the period; less discounts (Σ `discount_total`); less refunds (successful transactions with `payment_type = refund`); **net revenue**; expenses by category; **net income** (profit/loss badge). Each query `limit(500)` | statement + PDF |
| **Balance Sheet** (as of a date) | **Cash** = Σ successful non-refund transactions − Σ refunds, to date. **AR** = Σ `amount_due` (∥ amount − paid) over sent/partial/overdue invoices. **AP** = unpaid expenses (`payout_status ≠ paid`). **Equity = assets − liabilities**, followed by an **"Accounting Equation Check"** that is always balanced because equity is defined as the difference | statement + PDF |
| **Aged Receivables** | Buckets as above; top 10 customers by outstanding; per-invoice aging in days | bar per bucket, fixed colours with 90+ dark red |
| **Tax Summary** | Paid invoices: Σ tax, Σ total; Σ CGST/SGST/IGST from `finance_document_lines`; last 6 months tax vs revenue | grouped BarChart |
| **CLV** | Successful transactions (≤1,000) per customer: total, count, first and last; **LTV buckets** 0–1k, 1k–5k, 5k–25k, 25k–1L, 1L+; **churn risk** from `acp_customer_context.churn_risk` (high = "At Risk", medium = "Watch"); tenure in months | histogram + **ScatterChart** (x tenure, y LTV, z txn count, colour by risk) |
| **Finance Analytics** | Documents: total paid revenue, overdue amount and count, **collection rate = paid docs ÷ all docs (by count)**, active recurring schedules; overdue ageing 0–30/31–60/61–90/90+; settlements by gateway; document types | pie + 3 bar charts |
| **Expense Analytics** | Expenses (≤500): top 8 categories, top 6 vendors | donut + horizontal bar |

### 5.11 Payment operations [C][L]

**Gateways** (`finance/settings?tab=gateways`, `payment-gateway-config`):

- Razorpay: OAuth only ("API Key integration is disabled").
- Stripe: webhook at `/functions/v1/unified-webhook?gateway=stripe` for checkout.session.* ,
  payment_intent.payment_failed and charge.refunded, with a signing secret.
- Paystack: webhook recommended.
- Cashfree and Instamojo: an **agency credential policy** of *Sub-account only* / *Agency shared
  allowed* / *Agency only*, with default mode test or live.
- MyFatoorah, Paymentz.
- **Mock gateway**, which simulates payments with an **80 % success rate**.
- Checkout domains must be whitelisted: "Non-whitelisted domains will block payments".

**Other payment operations:**

- **Routing rules:** priority (lower wins), applies-to, conditions (country, currency, amount), a
  primary gateway and ordered fallbacks, a retry policy, and constraints such as "require autopay
  support" or "require refund support". A simpler screen offers primary + secondary, currency
  filter, min/max amount, and shows success rate and routed count per rule.
- **Retry rules:** gateway, fallback gateway, max retries, time window, *smart* vs *fixed*. KPIs:
  recovered, retries, recovery rate, plus a retry log.
- **Gateway health monitor:** a success-rate timeline per gateway and **failure reasons over the last
  24 h** (horizontal bar).
- **Dunning sequences:** name, **final action** (suspend account, cancel subscription, notify admin
  only, write off), max attempts, cooldown hours. Default steps: **Day 1 reminder email → Day 3
  follow-up → Day 7 final warning → final action**.
- **Payment reminders:** applies-to, "days before due" and "days after due" as comma lists, channels,
  message template.
- **Approval workflows:** applies to document types, minimum amount, stages (name, approver role,
  auto-approve after N hours). Pending items show document number, type, total and party.
- **Anomaly detection:** type, metric, threshold %, compare period 1/7/30 days, severity. Alerts carry
  expected, actual and deviation, with states open / acknowledged / resolved.
- **Wallets:** balance and **hold balance**, currency, optional contact link. Top-up; transaction
  history with before and after. A wallet can be deleted only at zero balance with no hold.
- **Commissions:** type, source (e.g. marketplace), rate, base, commission, payout ref. States
  pending → approved → settlement → paid, or rejected.
- **Audit log:** entity type (invoice, transaction, subscription, product, refund, wallet, dispute),
  action, user, changes.

### 5.12 Import and migration [C]

- **Finance import hub:** a JSON or CSV file up to 20 MB (products, invoices, payments, promo codes,
  recurring, expenses) is staged (`finance-import-stage`), then matched to CRM contacts
  (`finance-import-match`, `crm-contact-match`, with `match_confidence`, `match_method` and
  `match_status`). The user then resolves conflicts per record (Matched / Conflict / New / Invalid;
  Accept / Reject / Unlink), and `finance-import-commit` writes the result.
- **Legacy CSV/XLSX import** supports backdated entries and "Mark all as Paid".
- **Subscription import with AI** (`subscription-import-ai`) detects entity types, field mappings,
  foreign keys and processing order.
- **Sub-account → sub-account migration:** objects, mode (copy or move, where move archives the
  source), conflict policy (merge by natural key or always create), dry run first.

### 5.13 My Plan (the sub-account's own subscription to its agency) [C]

- Agency-published plans, including enquiry-only plans, founders plans and custom enterprise forms.
- **Upgrade preview:** days remaining, unused credit, new plan price, net after credit, **GST 18 %
  (hard-coded)**, total due today, then "Confirm & pay via Razorpay".
- **Downgrades are scheduled for the cycle end.**
- Usage against plan limits comes from RPC `sub_account_plan_usage`.

---

## 6. Finance and other modules at the agency and super-admin tiers

### 6.1 Finance routes that exist only above the sub-account [C]

- **Agency only:** `payments/platform-invoices` (the agency's own invoices from the platform) and
  `scheduled-changes`. The agency finance **index is `AgencyFinanceDashboard`**: agency-wide revenue
  trend (Area total + dashed Line net), revenue mix donut, quick actions. Its **analytics** is
  `AgencyRevenueAnalyticsPage`: sub-account MRR, ARR, **ARPA**, churn rate, paying and churned
  sub-accounts, MRR-by-plan donut, estimated cumulative-MRR trend and plan performance table.
- **Agency and super-admin:** `plans`, `gateway-policies`, `gateway-status`.
- **Super-admin only:** `platform-plans`, `platform-plans-dashboard` (includes a feature
  **"waste ratio"** bar), `addon-catalog`, `agency-subscriptions`, `platform-invoices`,
  `revenue-analytics` (agency MRR), `feature-registry`, `economics` (AI credit usage by provider),
  `rate-limits`, `ai-models` (LLM router), `credit-pricing`.
- The sub-account-only `my-plan` is the mirror image of these.

At those tiers every finance screen skips both the permission and plan-feature guards.

### 6.2 Agency tier (`/v2/a`, 224 routes) [R]

Finance (94), Ops Hub (67: idea manager, changelog, roadmap, onboarding manager, learn manager, job
queue), Settings (18), plus single screens:

- sub-accounts; customer / client / account success
- template library; snapshots; pricing; usage; credits
- approvals; reselling; wallet and wallet earnings; affiliate
- AI hub / AI studio; marketplace; GTM challenge
- docs branding; community defaults; help articles

The agency dashboard is a panel set: executive, revenue, sub-account performance, growth funnel,
operations, client success, finance, AI, system health.

### 6.3 Super-admin tier (`/v2/x`, 347 routes) [R]

Finance (93), QA console (57), Services (43), Ops Hub (19), Agentic AI (18), Settings (18), agency
affiliates (11), dashboards (9: executive, operations, platform health, intelligence, CEO…),
agencies (9), platform logs (9), sub-accounts (7), announcements, documentation, wallet and
transactions, billing plans, credit, device-slot and e-commerce pricing, site builder, branding, LLM
routing, AI performance diagnostics.

---

## 7. Chart system: conventions and catalogue

**Volume** [C]: 180 distinct chart definitions are reachable from the sub-account tier (Appendix C):

| Chart type | Count |
|---|---|
| Bar (vertical) | 49 |
| Pie / donut | 37 |
| Area | 36 |
| Bar (horizontal, `layout="vertical"`) | 29 |
| Line | 22 |
| Composed | 5 |
| Scatter | 1 |
| Radar | 1 |

**Visual conventions** (consistent enough to adopt as a spec) [C]:

- **Colours are theme tokens only:** `hsl(var(--primary))`, `--chart-1…5`, `--success`, `--warning`,
  `--destructive`, `--muted-foreground`. Categorical series cycle through a 6–8 token array. Status
  colours are semantic (paid = chart-2 green, pending = warning, failed = destructive, refunded =
  chart-4).
- **Area charts** use a vertical `linearGradient` from 5 % (opacity 0.10–0.15) to 95 % (opacity 0).
  The comparison or secondary series is a **dashed stroke** (`4 4` or `5 5`) with no fill.
- **Grid:** `CartesianGrid strokeDasharray="3 3"` in `--border`. Horizontal-bar rankings hide the
  horizontal grid lines.
- **Axes:** 11 px ticks in `--muted-foreground`. The Y tick formatter abbreviates ≥1000 to "12k".
  Horizontal-bar category labels are truncated at 12 characters with "…".
- **Tooltip:** card background, 1 px border, radius 8, 12 px text. Values go through the
  tenant-currency formatter.
- **Donuts:** inner/outer radius 40/65 (small) or 55/90–95 (large), `paddingAngle 2`, with a legend
  list beside them showing colour, name and value.
- **Motion off** (`isAnimationActive={false}`) on finance charts. Fixed 260 px card height.
- **Loading** is a full-card skeleton. **Empty** is an icon at 30 % opacity plus one sentence and
  sometimes a hint ("Create invoices to see revenue trends.").
- **Signed stacked bars** (`stackOffset="sign"` + `ReferenceLine y=0`) show gains against losses
  (MRR movement). A `ReferenceLine` labelled "Now" marks the present on projections.
- **Period comparison** is a dashed "Previous" series on the same axes (Contact stats: `ComposedChart`
  with bar = current, line = previous; plus a cumulative line).
- **Day × hour heatmap** (contact acquisition, WhatsApp groups) with sparklines.

**Data conventions** [C]:

- Nearly all charts aggregate **in the browser** from row fetches capped at 500 or 1,000 rows.
- Time bucketing adapts to range length (daily ≤45 d, weekly ≤180 d, monthly beyond).
- Period-over-period deltas use the preceding equal-length window.

**For Aura:**

- Adopt the visual conventions: they match Aura's token-based design system (`22_DESIGN_SYSTEM.md`)
  and the dataviz rules.
- Do **not** adopt browser-side aggregation over capped fetches (§10). Aura's Report Builder already
  aggregates server-side, and new finance charts should do the same, as SQL views or endpoints.

---

## 8. CRM (lead management): logic summary [C]

This is not the focus, but it is what the finance module links into.

- **Opportunities:**
  - Kanban and list views driven by keyset-paginated RPCs: `fetch_crm_opportunity_ids_page` (filters
    pipeline, owner(s), kind, stage, unassigned, search) → `fetch_crm_opportunities_by_ids`, and
    `get_crm_opportunity_totals` for column totals.
  - Stage moves go through `update_crm_opportunity_stage` and are recorded in
    `crm_opportunity_stage_history` (with days in stage).
  - Field history lives in `crm_opportunity_history` (field, before, after, source, batch).
  - **Multiple cards per contact per product interest** ("Separate cards per interest in the same
    pipeline"). Inquiries (`crm_opportunity_inquiries`) record every form or ad submission against a
    card, with `unmatched` product labels.
  - AI score (`ai_score`, `ai_scored_at`) and AI summary / deal intelligence edge functions.
  - Sequences (`crm_sequences` / `_steps` / `_enrollments`) and notes, assets, timeline.
  - Payment attribution to deals (`crm_opportunity_payment_attributions`) with reversal.
- **Pipelines:**
  - Folders; stages with colour and icon; pipeline templates.
  - A **product catalogue per pipeline**. Unmatched interests can be "Promote"d to the catalogue or
    "Map"ped to an existing product; either path links the history.
  - **"Auto-mark deals Won when their invoice is paid"** (off by default): move to a chosen stage,
    optionally set status Won, optionally reopen Lost. This is where CRM and finance join.
- **Contacts:**
  - Identity tables `contact_emails` (`email_normalized`) and `contact_phones` (`phone_e164`).
  - A merge flow with per-field choice. The dedupe queue is fed by a `contact-dedupe-scan` edge
    function, sorted by `duplicate_score`.
  - Dynamic **segments** (AND/OR rule groups, refreshed by an edge function).
  - A **stats dashboard**: new vs previous period, cumulative, source leaderboard, top cities,
    timezones, a day × hour heatmap, and DND suppression counts.
  - Search settings: per-field weights, AI semantic search, and **name transliteration maps**
    (e.g. محمد → mohammed, muhammad), with zero-result search analytics.
- **Follow-ups:**
  - Full edit history (`update_follow_up_with_history`), reminders, saved and shared views, snooze,
    completion outcome, priority, category, recurrence.
  - An AI assistant suggests best time, channel, tone, opening line and talking points.
- **Lead scoring:** rules with points, **max per day**, lookback (7 days to 1 year), score tiers with
  behaviour labels, and a preview breakdown per contact. Weights total 100. Turning scoring off does
  not backfill the gap.
- **Forecasting** (Pipeline Intelligence):
  - Total pipeline = Σ open value. **Weighted pipeline = Σ value × close_probability/100.**
  - **30/60/90-day forecast** = weighted value of deals whose `expected_close_date` falls within
    N days.
  - **Win rate** = won ÷ (won + lost). Average days in stage.
  - **At-risk** = more than 14 days in stage or less than 20 % probability.
  - Average cycle time (created → won), average deal size, a six-month revenue trend.
  - **Sales goals** (`crm_sales_goals`: period, revenue and deal targets). Attainment is capped at
    100 %. A "Goal vs Forecast" bar compares won + 30/90-day forecast against the target.
- **Lead sources:** RPC `get_lead_source_metrics(from, to)` returns a channel donut and a table of
  leads, new, converted and trend.
- **Imports:**
  - An async worker (`opportunity-import-worker`) runs dry runs, pauses, stops and **rollback of a
    completed import**.
  - Scheduled imports from **SFTP**, an **API push with an `x-import-token`**, or a vault inbox
    polled on a schedule.
  - Duplicate modes (create only, create or update, update only; skip, update or merge-fill-empty).
  - An optional completion webhook.

---

## 9. Gap analysis vs Aura

Aura today (verified in source): products and quotations (`0059`); invoices, items, payments, gateway
config and webhooks with Razorpay and Stripe (`0060`, `0099`); intra/inter-state CGST/SGST/IGST
columns decided by the API; `amount_paid` on invoices; a Report Builder with a server-side chart
surface (`0077`, `0088`); lead temperature (`0083`); merge and dedupe; saved views; tasks; the
permission grid (`0103`); org modules and features gating (`0072`/`0093`). Searching the Aura source
found **no** expenses, vendors, subscriptions / recurring billing / EMI, credit notes, refunds as an
entity, P&L, balance sheet, AR aging, GST return report, MRR/churn, collection rate or DSO, dunning,
reminder rules, approvals, settlements, wallets, deal close-probability, sales goals or lead-scoring
rules.

| # | Capability | MyAppz | Aura | Verdict |
|---|---|---|---|---|
| 1 | **Finance overview dashboard** (collection rate, DSO, outstanding, net revenue, period deltas, revenue trend, overdue list) | yes, §5.4 | no | **Port the design** (server-side maths) |
| 2 | **Partial payments + invoice state machine** (`partially_paid`, paid → refunded) | yes | `amount_paid` exists; no `partially_paid` status | **Port** |
| 3 | **Credit notes / refunds as documents** | yes | no | **Port** |
| 4 | Multi-type documents (estimate, proforma, SO, PO, challan, receipts) + conversion matrix | 12 types | quotation, invoice | Port selectively: proforma and credit/debit notes first |
| 5 | **AR aging + outstanding + overdue reports** | yes | no | **Port** (cheap, high value) |
| 6 | **Expenses, categories, vendors (GST/TDS)** | yes | no | **Port** (unlocks P&L) |
| 7 | **P&L, balance sheet, GST (tax) report** | yes | no | **Port P&L and GST**; the balance sheet only once there is a real ledger (§10) |
| 8 | Subscriptions / recurring invoices / EMI plans | yes, three tables | no | Port **one** model (§10); recurring invoices only as drafts |
| 9 | MRR / ARR / churn / MRR movement / cohort retention | yes (with defects) | no | Port after #8, with real expansion MRR |
| 10 | Dunning, payment reminders | auto-send | no | **Port as scheduled human work items** (Aura rule 3) |
| 11 | Approval workflows for high-value documents | yes | no | Port; fits the permission grid |
| 12 | Settlements + reconciliation | yes | Stripe/Razorpay webhooks only | Later; needs gateway settlement APIs |
| 13 | Gateway routing / retry / health / 7 gateways | yes | 2 gateways | Skip unless multi-gateway becomes a requirement |
| 14 | Wallets, commissions, disputes, anomaly detection | yes | no | Skip for now (business call, §12) |
| 15 | Numbering series + fiscal-year roll + editable numbers | yes | [I] per-type sequence | Port fiscal-year rollover if Indian FY numbering is required |
| 16 | Document templates (paper, watermark, signatory) + QR/UPI on PDF | yes | [I] basic PDF | Port the UPI QR (cheap, India-relevant) |
| 17 | **Deal close-probability, weighted pipeline, 30/60/90 forecast, win rate, at-risk, sales goals** | yes | temperature only | **Port** (small, high value) |
| 18 | "Auto-mark deal Won when invoice paid" | yes | no | **Port**; it is a state change, not a send, so rule 3 is unaffected |
| 19 | Lead-scoring rules engine (points, daily caps, lookback, tiers) | yes | temperature | Consider, next to temperature |
| 20 | **Per-user dashboard widget layout** (registry + show/hide/reorder/resize) | yes | fixed panels | Port the registry pattern |
| 21 | Industry-driven finance dashboard modes | yes | no | Port as a simple org setting |
| 22 | Import with staging, conflict resolution, rollback; SFTP/API scheduled imports | yes | import module exists | Compare against Aura's import; rollback is the notable piece |
| 23 | Contact search transliteration maps | yes | no | Low effort; relevant for Indian names |

**Where Aura is ahead; do not regress these:** server-side authority (NestJS + FORCE RLS, not
browser-side writes); one invoice table and one tax decision made by the API rather than both stored;
the AI call layer; httpOnly sessions; the Report Builder's server aggregation; merge references.

---

## 10. What must NOT be ported

Each item below was read in shipping code [C].

1. **Browser-side financial writes.** Invoice edits, status changes, expenses, wallet balances and
   settlements are written from the browser to PostgREST.
   - **Wallet top-up** reads `balance`, inserts a transaction with `balance_before/after`, then
     updates `balance`, as three separate calls. Two concurrent top-ups lose one: a classic
     read-modify-write race.
   - In Aura, every money mutation belongs in one server transaction, behind the API.
2. **Fail-open authorisation.** Permission checks return *allow* while loading, and feature gates
   return *allow* when their query errors. Aura gates are server-side, and must stay that way.
3. **Three subscription tables and two invoice tables**, reconciled in the browser by a status
   derivation function (§5.6). This is why the same "sale" can show different states on different
   screens. Aura should have **one** subscription/plan model and **one** document table.
4. **Aggregating money in the browser over capped fetches.** P&L, balance sheet and CLV each
   `limit(500)` or `limit(1000)` and then sum. **Above the cap the totals are silently wrong.** Every
   finance figure in Aura must be SQL aggregation.
5. **Placeholder analytics presented as real:**
   - expansion MRR hard-coded to 0;
   - forecast = flat MRR × 0.95ⁿ with a **hard-coded 5 % churn**;
   - the balance-sheet "equation check" that cannot fail;
   - a refund "Retry" that only shows a toast;
   - a Mock gateway, with an 80 % success rate, offered in production settings.
6. **Inconsistent metric definitions:**
   - **avg invoice** = invoiced ÷ *paid* count;
   - **collection rate** = transactions ÷ invoices on the dashboard but paid docs ÷ all docs (by
     count) on Finance Analytics;
   - two MRR normalisers with **different interval vocabularies** (`monthly/yearly/…` vs
     `month/year/…`), each treating unknown values as monthly;
   - trialing subscriptions counted in MRR.
   - Define each metric once, in SQL, and reuse it.
7. **Storing IGST and CGST/SGST simultaneously** on every document. Aura already decides the pair
   server-side; keep that.
8. **Hard-coded locale and tax:** GST 18 % in plan upgrades, `en-IN`/₹ formatting in some tiles, and
   INR conversion of expenses through a client FX table.
9. **Automated sending.** Dunning ("Day 1 email … Day 7 final warning → suspend"), reminder rules,
   auto-send invoice email and recurring auto-send all send on a timer. **Aura rule 3 (nothing
   automated sends)** means porting the *schedule* as **due work items a human sends**, the same
   adaptation used for B2's outreach ladder.
10. **Nav/route drift** (§3.4). Derive nav from routes, or test it.

---

## 11. Recommended build order for Aura

Each phase is a vertical slice. The house rules apply: migrations from `0124` on, `org_id` + FORCE RLS
on every new table, NestJS controllers behind the permission grid, and finance gated behind an org
module (`0072`) so it can be sold separately.

**F1: Receivables core (smallest slice with the largest payoff)**

- Add `partially_paid` to invoice status, a `payments` → invoice allocation, and credit notes (one
  documents table with `document_type`, with credit notes linked to their source invoice).
- Server endpoints for the §5.4 metrics, defined once in SQL: invoiced, collected, outstanding,
  collection rate, DSO, net revenue, period deltas.
- Screens: **Finance Overview** (hero KPIs, revenue trend, overdue list, top customers, product
  performance); **AR aging** and **Outstanding** reports.
- Charts to §7's conventions.

**F2: Expenses and statements**

- `expense_categories`, `vendors` (GSTIN, PAN, bank), `expenses` (GST mode, TDS, payout status,
  receipt in Aura storage).
- P&L by product and category, and the GST report (seller state from GSTIN, per-row
  inter/intra-state).
- CSV and PDF export.

**F3: Pipeline intelligence (CRM side, independent of F1 and F2)**

- `deals.close_probability`, `expected_close_date`; weighted pipeline; 30/60/90 forecast; win rate;
  at-risk rule; sales goals.
- "Auto-mark Won when invoice paid" per pipeline (this joins F1 to the CRM).

**F4: Collections as work (after F1)**

- Reminder schedules and dunning ladders that **create due tasks** for staff (Aura's tasks module),
  with templated messages the human sends.
- Approval workflows (threshold → role stages) on quotations and invoices.

**F5: Recurring revenue (only if the business needs it; see §12)**

- One `subscriptions` table plus `installment_schedules`. Recurring invoices are generated as
  **drafts**.
- Then MRR, ARR, churn, MRR movement with **real** new/expansion/contraction/churn, and cohort
  retention, all as SQL views.

**F6: Dashboard customisation**

- A widget registry (`id, label, category, variant, dataPath, format, defaultVisible, defaultOrder,
  colSpan, description`) with per-user layout persisted server-side (org × user), show/hide, reorder
  and resize.
- Optional industry "modes" choosing the hero row.

**Deliberately deferred:** gateway routing/retry/health, wallets, commissions, disputes, anomaly
detection, settlements/reconciliation, revenue recognition and multi-sub-account migration. Each is a
product decision first (§12).

---

## 12. Open questions (business calls, not engineering ones)

1. **Is Aura becoming an invoicing/accounting tool, or staying a CRM that issues invoices?** A
   balance sheet or settlements only make sense with a real double-entry ledger, which B2 had and
   which the B2 porting rule says not to port.
2. **Recurring billing:** do Aura's customers sell subscriptions or EMIs? If not, skip F5 entirely.
3. **GST/TDS depth:** is a GSTR-1-shaped export needed, or is the §5.9 GST register enough?
4. **Which industries matter:** do the six "dashboard modes" map to Aura's actual customer base
   (coaching and education appear often in Indian SMB)?
5. **Gateways:** is a third gateway (Cashfree / PhonePe / Instamojo) on the roadmap? If so, the
   routing and retry design in §5.11 becomes relevant.
6. **Should any of the other ~14 products (ads, social, LMS, HRM, voice AI…) be ported at all?** This
   document inventories them (Appendix A) but recommends nothing there, because each is its own
   product.

---
## Appendix A: Sub-account route inventory (`/v2/s/:id/…`), 611 routes

Generated from the shipped router. Paths are relative to `/v2/s/:id`. **Screen** is the lazy-loaded page component (chunk name; `#Name` where the chunk exports several; `A › B` = nested wrappers or tier-conditional alternatives). **Gates** accumulate from parent routes: `feature` = sub-account feature gate (`list_feature_gates` / `check_feature_access`), `perm` = staff permission key, `plan-features` = plan-feature keys (any one suffices, otherwise redirect to the finance home). A route listed here exists in code; whether a given tenant sees it depends on those gates. The 17 agency/super-admin-only finance routes are excluded (see §6.1).

### A.1 `(root)` (2)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/` | layout / outlet |  |
| ` (index)` | → redirect `dashboard` |  |

### A.2 `dashboard` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/dashboard` | `Dashboard#D` |  |

### A.3 `get-started` (2)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/get-started` | `GetStarted` |  |
| `/get-started/success` | `SubAccountCustomerSuccess` | feature `customer_success` |

### A.4 `updates` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/updates` | `ProductUpdatesPage` | feature `product_updates` |

### A.5 `profile` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/profile` | `Profile` |  |

### A.6 `business-profile` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/business-profile` | `BusinessProfile` |  |

### A.7 `billing` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/billing` | `SubAccountBillingPage` |  |

### A.8 `account-billing` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/account-billing` | → redirect `../billing` |  |

### A.9 `my-billing` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/my-billing` | → redirect `../billing` |  |

### A.10 `login-activity` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/login-activity` | `SubAccountLoginActivity` |  |

### A.11 `credits` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/credits` | `Credits` |  |

### A.12 `marketplace` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/marketplace` | `SubAccountMarketplace` |  |

### A.13 `custom-link` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/custom-link/:linkId` | `CustomLinkEmbedPage` |  |

### A.14 `lead-generation` (67)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/lead-generation/sites/:siteId/vibe/:pageId/preview` | `VibePreviewPage` |  |
| `/lead-generation/sites/:siteId/pages/:pageId/edit` | layout / outlet |  |
| `/lead-generation/site-builder-v2` | `SiteBuilderV2` | perm `lead_generation.funnel_builder.read` |
| `/lead-generation/sites/:siteId/vibe/:pageId` | `mermaid-GHXKKRXX#S` | perm `lead_generation.funnel_builder.read` |
| `/lead-generation/funnels/:funnelId` | `FunnelEditorPage` | perm `lead_generation.funnel_builder.read` |
| `/lead-generation/vibe-studio/:projectId` | `VibeStudioEditorPage` | perm `lead_generation.funnel_builder.read` |
| `/lead-generation/forms/builder/:formId` | `FormBuilder` | perm `lead_generation.form_builder.read` |
| `/lead-generation` | layout / outlet | feature `sub_lead_gen` |
| `/lead-generation (index)` | `LeadGenerationHub` | feature `sub_lead_gen` |
| `/lead-generation/sites` | layout / outlet | feature `sub_lead_gen` |
| `/lead-generation/sites (index)` | `Sites` | feature `sub_lead_gen` |
| `/lead-generation/sites/templates` | → redirect `../templates` | feature `sub_lead_gen` |
| `/lead-generation/sites/:siteId` | `FunnelDetail` | feature `sub_lead_gen` |
| `/lead-generation/shop` | `ShopAdminLayout` | feature `sub_lead_gen`, feature `sub_lg_shop` |
| `/lead-generation/shop (index)` | `ShopDashboard` | feature `sub_lead_gen`, feature `sub_lg_shop`, feature `sub_shop_dashboard` |
| `/lead-generation/shop/products` | `ShopProducts` | feature `sub_lead_gen`, feature `sub_lg_shop`, feature `sub_shop_products` |
| `/lead-generation/shop/products/new` | `ShopProductWizard` | feature `sub_lead_gen`, feature `sub_lg_shop`, feature `sub_shop_products` |
| `/lead-generation/shop/products/:productId/edit` | `ShopProductEditor` | feature `sub_lead_gen`, feature `sub_lg_shop`, feature `sub_shop_products` |
| `/lead-generation/shop/collections` | `ShopCollections` | feature `sub_lead_gen`, feature `sub_lg_shop`, feature `sub_shop_collections` |
| `/lead-generation/shop/orders` | `ShopOrders` | feature `sub_lead_gen`, feature `sub_lg_shop`, feature `sub_shop_orders` |
| `/lead-generation/shop/offers` | `ShopOffers` | feature `sub_lead_gen`, feature `sub_lg_shop`, feature `sub_shop_coupons` |
| `/lead-generation/shop/coupons` | → redirect `offers` | feature `sub_lead_gen`, feature `sub_lg_shop` |
| `/lead-generation/shop/shipping` | `ShopShipping` | feature `sub_lead_gen`, feature `sub_lg_shop`, feature `sub_shop_shipping` |
| `/lead-generation/shop/payments` | `ShopPayments` | feature `sub_lead_gen`, feature `sub_lg_shop`, feature `sub_shop_payments` |
| `/lead-generation/shop/design` | `ShopDesign` | feature `sub_lead_gen`, feature `sub_lg_shop`, feature `sub_shop_design` |
| `/lead-generation/shop/media` | `ShopMediaLibrary` | feature `sub_lead_gen`, feature `sub_lg_shop`, feature `sub_shop_media` |
| `/lead-generation/shop/analytics` | `ShopAnalytics` | feature `sub_lead_gen`, feature `sub_lg_shop`, feature `sub_shop_analytics` |
| `/lead-generation/shop/ai-studio` | `ShopAIStudio` | feature `sub_lead_gen`, feature `sub_lg_shop`, feature `sub_shop_ai_studio` |
| `/lead-generation/shop/reviews` | `ShopReviews` | feature `sub_lead_gen`, feature `sub_lg_shop`, feature `sub_shop_reviews` |
| `/lead-generation/shop/inventory` | `ShopInventory` | feature `sub_lead_gen`, feature `sub_lg_shop`, feature `sub_shop_inventory` |
| `/lead-generation/shop/settings` | `ShopSettings` | feature `sub_lead_gen`, feature `sub_lg_shop`, feature `sub_shop_settings` |
| `/lead-generation/shop/finance-sync` | `ShopFinanceSync` | feature `sub_lead_gen`, feature `sub_lg_shop`, feature `sub_shop_finance_sync` |
| `/lead-generation/vibe-studio` | `VibeStudioHomePage` | feature `sub_lead_gen`, feature `sub_lg_vibe_studio` |
| `/lead-generation/chat-widget` | `ChatWidgetPage` | feature `sub_lead_gen` |
| `/lead-generation/chat-widget/widgets` | `ChatWidgetDashboard` | feature `sub_lead_gen` |
| `/lead-generation/chat-widget/config/new` | `ChatWidgetConfigPage` | feature `sub_lead_gen` |
| `/lead-generation/chat-widget/config/:widgetId` | `ChatWidgetConfigPage` | feature `sub_lead_gen` |
| `/lead-generation/chat-widget/sessions` | `ChatWidgetSessions` | feature `sub_lead_gen` |
| `/lead-generation/chat-widget/page` | `ChatWidgetPage` | feature `sub_lead_gen` |
| `/lead-generation/forms` | layout / outlet | feature `sub_lead_gen`, perm `lead_generation.form_builder.read` |
| `/lead-generation/forms (index)` | `AllForms` | feature `sub_lead_gen`, perm `lead_generation.form_builder.read` |
| `/lead-generation/forms/new` | `NewForm` | feature `sub_lead_gen`, perm `lead_generation.form_builder.read` |
| `/lead-generation/forms/templates` | `FormTemplatesPage` | feature `sub_lead_gen`, perm `lead_generation.form_builder.read` |
| `/lead-generation/meta-lead-forms` | → redirect `..` | feature `sub_lead_gen` |
| `/lead-generation/surveys` | `AllSurveys` | feature `sub_lead_gen` |
| `/lead-generation/surveys/builder/:surveyId` | `SurveyBuilder` | feature `sub_lead_gen` |
| `/lead-generation/surveys/:surveyId/submissions` | `SurveySubmissions` | feature `sub_lead_gen` |
| `/lead-generation/surveys/:surveyId/analytics` | `SurveyAnalytics#a` | feature `sub_lead_gen` |
| `/lead-generation/ads-social` | layout / outlet | feature `sub_lead_gen` |
| `/lead-generation/ads-social (index)` | `AdLauncherDashboard` | feature `sub_lead_gen` |
| `/lead-generation/ads-social/campaign/create` | `CampaignCreate` | feature `sub_lead_gen` |
| `/lead-generation/ads-social/campaign/:campaignId` | `CampaignDrilldown` | feature `sub_lead_gen` |
| `/lead-generation/ads-social/creative-hub` | `CreativeHub` | feature `sub_lead_gen` |
| `/lead-generation/ai-social` | layout / outlet | feature `sub_lead_gen` |
| `/lead-generation/ai-social (index)` | `AISocialPage` | feature `sub_lead_gen` |
| `/lead-generation/reputation` | `ReputationPage` | feature `sub_lead_gen` |
| `/lead-generation/prospecting` | → redirect `search` | feature `sub_lead_gen` |
| `/lead-generation/prospecting/search` | `ProspectingSearch` | feature `sub_lead_gen` |
| `/lead-generation/prospecting/saved` | `ProspectingSaved` | feature `sub_lead_gen` |
| `/lead-generation/prospecting/dashboard` | `ProspectingDashboard` | feature `sub_lead_gen` |
| `/lead-generation/prospecting/settings` | `ProspectingSettings` | feature `sub_lead_gen` |
| `/lead-generation/prospecting/library` | → redirect `../prospecting/settings` | feature `sub_lead_gen` |
| `/lead-generation/prospecting/leads/:leadId/report` | `LeadAuditReport` | feature `sub_lead_gen` |
| `/lead-generation/prospecting/reports/:reportId` | `LeadAuditReport` | feature `sub_lead_gen` |
| `/lead-generation/urls` | `URLs` | feature `sub_lead_gen` |
| `/lead-generation/templates` | `TemplateLibrary` | feature `sub_lead_gen` |
| `/lead-generation/*` | catch-all ("module not found" page) | feature `sub_lead_gen` |

### A.15 `lead-management` (32)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/lead-management` | layout / outlet | feature `sub_lead_mgmt` |
| `/lead-management (index)` | → redirect `crm/opportunity` | feature `sub_lead_mgmt` |
| `/lead-management/crm/opportunity` | layout / outlet | feature `sub_lead_mgmt`, perm `lead_management.crm.read` |
| `/lead-management/crm/opportunity (index)` | `Opportunity#b` | feature `sub_lead_mgmt`, perm `lead_management.crm.read` |
| `/lead-management/crm/opportunity/imports` | `OpportunityImportActionsPage` | feature `sub_lead_mgmt`, perm `lead_management.crm.read` |
| `/lead-management/crm/opportunity/history` | `OpportunityExportHistoryPage` | feature `sub_lead_mgmt`, perm `lead_management.crm.read` |
| `/lead-management/crm/pipeline` | `Pipeline` | feature `sub_lead_mgmt`, perm `lead_management.pipeline.read` |
| `/lead-management/crm/bulk-import` | `BulkImport` | feature `sub_lead_mgmt` |
| `/lead-management/crm/lead-scoring` | `LeadScoringSettingsPage` | feature `sub_lead_mgmt` |
| `/lead-management/crm/forecasting` | `ForecastingPage` | feature `sub_lead_mgmt` |
| `/lead-management/crm/attribution` | → redirect `../../settings/analytics/utm` | feature `sub_lead_mgmt` |
| `/lead-management/crm/lead-sources` | `LeadSourceDashboard` | feature `sub_lead_mgmt` |
| `/lead-management/tasks` | → redirect `../../operations/tasks` | feature `sub_lead_mgmt` |
| `/lead-management/follow-up` | `FollowUp` | feature `sub_lead_mgmt`, perm `lead_management.follow_up.read` |
| `/lead-management/contacts` | layout / outlet | feature `sub_lead_mgmt`, perm `lead_management.contacts.read` |
| `/lead-management/contacts (index)` | `ContactsListPage` | feature `sub_lead_mgmt`, perm `lead_management.contacts.read` |
| `/lead-management/contacts/history` | `ImportExportHistoryPage` | feature `sub_lead_mgmt`, perm `lead_management.contacts.read` |
| `/lead-management/contacts/import-schedules` | `OpportunityImportSchedulesPage` | feature `sub_lead_mgmt`, perm `lead_management.contacts.read` |
| `/lead-management/contacts/import` | `ImportContactsPage` | feature `sub_lead_mgmt`, perm `lead_management.contacts.read` |
| `/lead-management/contacts/import-export` | `ImportExportHistoryPage` | feature `sub_lead_mgmt`, perm `lead_management.contacts.read` |
| `/lead-management/contacts/dedupe` | `DedupeQueuePage` | feature `sub_lead_mgmt`, perm `lead_management.contacts.read` |
| `/lead-management/contacts/portal-identity` | `PortalIdentityRemediationPage` | feature `sub_lead_mgmt`, perm `lead_management.contacts.read` |
| `/lead-management/contacts/segments` | `SegmentsPage` | feature `sub_lead_mgmt`, perm `lead_management.contacts.read` |
| `/lead-management/contacts/stats` | `ContactStatsPage` | feature `sub_lead_mgmt`, perm `lead_management.contacts.read` |
| `/lead-management/contacts/search-settings` | `SearchSettingsPage` | feature `sub_lead_mgmt`, perm `lead_management.contacts.read` |
| `/lead-management/contacts/:contactId` | `ContactProfilePage` | feature `sub_lead_mgmt`, perm `lead_management.contacts.read` |
| `/lead-management/contact-group` | `ContactGroupPage` | feature `sub_lead_mgmt` |
| `/lead-management/contact-group/:groupId` | `ContactGroupDetailPage` | feature `sub_lead_mgmt` |
| `/lead-management/dashboard` | `LeadDashboardPage` | feature `sub_lead_mgmt` |
| `/lead-management/agentic-ai` | `SubAccountACPPage` | feature `sub_lead_mgmt` |
| `/lead-management/settings` | `LeadManagementSettingsPage` | feature `sub_lead_mgmt` |
| `/lead-management/*` | catch-all ("module not found" page) | feature `sub_lead_mgmt` |

### A.16 `lead-automation` (31)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/lead-automation/workflows/chatflows/:flowId/edit` | `ChatFlowBuilder` | perm `lead_automation.automation_workflow.read` |
| `/lead-automation/workflows/builder/:workflowId` | `WorkflowBuilderPage` | perm `lead_automation.automation_workflow.read` |
| `/lead-automation` | layout / outlet | feature `sub_lead_auto` |
| `/lead-automation (index)` | `LeadAutomationHub` | feature `sub_lead_auto` |
| `/lead-automation/email` | `EmailMarketingPage` | feature `sub_lead_auto` |
| `/lead-automation/bulk-campaigns` | `BulkCampaignsPage` | feature `sub_lead_auto` |
| `/lead-automation/whatsapp` | `WhatsAppDashboard` | feature `sub_lead_auto` |
| `/lead-automation/telegram` | `TelegramDashboard` | feature `sub_lead_auto` |
| `/lead-automation/waba` | `WABADashboard` | feature `sub_lead_auto` |
| `/lead-automation/workflows` | layout / outlet | feature `sub_lead_auto` |
| `/lead-automation/workflows (index)` | `WorkflowsLanding` | feature `sub_lead_auto` |
| `/lead-automation/workflows/chatflows` | `ChatFlowList` | feature `sub_lead_auto` |
| `/lead-automation/workflows/reminder-flow` | `ReminderFlowGuard` | feature `sub_lead_auto` |
| `/lead-automation/workflows/reminder-flow (index)` | `ReminderFlowListPage` | feature `sub_lead_auto` |
| `/lead-automation/workflows/reminder-flow/:projectId` | `ReminderFlowDetailPage` | feature `sub_lead_auto` |
| `/lead-automation/logs` | `AllLogsPage` | feature `sub_lead_auto` |
| `/lead-automation/triggers` | `KeywordTriggersPage` | feature `sub_lead_auto` |
| `/lead-automation/triggers/logs` | `TriggerLogsPage` | feature `sub_lead_auto` |
| `/lead-automation/triggers/simulator` | `TriggerSimulatorPage` | feature `sub_lead_auto` |
| `/lead-automation/voice-agent` | `VoiceAgentProfilePage` | feature `sub_lead_auto` |
| `/lead-automation/voice-agent/calls` | `VoiceCallLogsPage` | feature `sub_lead_auto` |
| `/lead-automation/voice-agent/campaigns` | `VoiceCampaignsPage` | feature `sub_lead_auto` |
| `/lead-automation/voice-agent/providers` | `VoiceProvidersPage` | feature `sub_lead_auto` |
| `/lead-automation/voice-agent/models` | `VoiceModelConfigPage` | feature `sub_lead_auto` |
| `/lead-automation/voice-agent/routing` | `VoiceRoutingPage` | feature `sub_lead_auto` |
| `/lead-automation/voice-agent/memory` | `VoiceConversationMemoryPage` | feature `sub_lead_auto` |
| `/lead-automation/voice-agent/analytics` | `VoiceAnalyticsPage` | feature `sub_lead_auto` |
| `/lead-automation/voice-agent/compliance` | `VoiceCompliancePage` | feature `sub_lead_auto` |
| `/lead-automation/voice-agent/console` | `VoiceHandoffConsolePage` | feature `sub_lead_auto` |
| `/lead-automation/event-monitor` | `EventMonitor` | feature `sub_lead_auto` |
| `/lead-automation/*` | catch-all ("module not found" page) | feature `sub_lead_auto` |

### A.17 `sales` (49)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/sales` | layout / outlet | feature `sub_sales` |
| `/sales (index)` | `SalesPerformancePage` | feature `sub_sales` |
| `/sales/webinars` | layout / outlet | feature `sub_sales`, perm `sales.webinars.read` |
| `/sales/webinars (index)` | `WebinarsListPage` | feature `sub_sales`, perm `sales.webinars.read` |
| `/sales/webinars/create` | `CreateWebinarPage` | feature `sub_sales`, perm `sales.webinars.read` |
| `/sales/webinars/:projectId` | `WebinarProjectDetailPage` | feature `sub_sales`, perm `sales.webinars.read` |
| `/sales/assignments` | `SalesAssignments` | feature `sub_sales`, perm `sales.assignments.read` |
| `/sales/voice-agent` | layout / outlet | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-agent (index)` | `VoiceAgentProfilePage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-agent/calls` | `VoiceCallLogsPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-agent/campaigns` | `VoiceCampaignsPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-agent/providers` | `VoiceProvidersPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-agent/models` | `VoiceModelConfigPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-agent/routing` | `VoiceRoutingPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-agent/memory` | `VoiceConversationMemoryPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-agent/analytics` | `VoiceAnalyticsPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-agent/compliance` | `VoiceCompliancePage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-agent/console` | `VoiceHandoffConsolePage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/ivr` | `TelephonyPage` | feature `sub_sales`, perm `sales.ivr_calling.all` |
| `/sales/proposals` | `ProposalListPage` | feature `sub_sales`, feature `sales_proposals` |
| `/sales/proposals/:proposalId` | `ProposalBuilderPage` | feature `sub_sales`, feature `sales_proposals` |
| `/sales/events` | `EventsListPage` | feature `sub_sales`, feature `sales_events` |
| `/sales/events/create` | `CreateEventPage` | feature `sub_sales`, feature `sales_events` |
| `/sales/events/:eventId` | `EditEventPage` | feature `sub_sales`, feature `sales_events` |
| `/sales/events/:eventId/scan` | `ScanEventPage` | feature `sub_sales`, feature `sales_events` |
| `/sales/affiliate` | `SubaccountAffiliateDashboard` | feature `sub_sales`, perm `sales.affiliate.read` |
| `/sales/scoreboard` | `SalesPerformancePage` | feature `sub_sales`, perm `sales.performance.read` |
| `/sales/performance` | layout / outlet | feature `sub_sales`, perm `sales.performance.read` |
| `/sales/performance (index)` | `PerformanceIndexRouter` | feature `sub_sales`, perm `sales.performance.read` |
| `/sales/performance/*` | `PerformanceIndexRouter` | feature `sub_sales`, perm `sales.performance.read` |
| `/sales/incentives` | layout / outlet | feature `sub_sales`, perm `sales.incentives.read` |
| `/sales/incentives (index)` | `IncentivesIndexRouter` | feature `sub_sales`, perm `sales.incentives.read` |
| `/sales/incentives/*` | `IncentivesIndexRouter` | feature `sub_sales`, perm `sales.incentives.read` |
| `/sales/voice-ai` | layout / outlet | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-ai (index)` | `VoiceAIDashboard` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-ai/kyc` | `VoiceKYCPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-ai/numbers` | `VoiceNumbersPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-ai/agents` | `VoiceAgentsPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-ai/agents/new` | `VoiceAgentNewPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-ai/agents/:agentId` | `VoiceAgentDetailPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-ai/voices` | `VoiceLibraryPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-ai/campaigns` | `VoiceCampaignsPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-ai/campaigns/new` | `VoiceCampaignNewPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-ai/campaigns/:campaignId` | `VoiceCampaignDetailPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-ai/calls` | `VoiceCallLogsPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-ai/calls/:callUuid` | `VoiceCallDetailPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-ai/settings` | `VoiceSettingsPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/voice-ai/settings/:section` | `VoiceSettingsPage` | feature `sub_sales`, perm `sales.voice_ai.read` |
| `/sales/*` | catch-all ("module not found" page) | feature `sub_sales` |

### A.18 `ai-suite` (45)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/ai-suite` | layout / outlet | feature `sub_ai_suite` |
| `/ai-suite (index)` | `AISuiteDashboard` | feature `sub_ai_suite` |
| `/ai-suite/brain` | layout / outlet | feature `sub_ai_suite`, perm `ai_suite.brain.read` |
| `/ai-suite/brain (index)` | `AIBrain` | feature `sub_ai_suite`, perm `ai_suite.brain.read` |
| `/ai-suite/brain/:brainId` | `BrainDetail` | feature `sub_ai_suite`, perm `ai_suite.brain.read` |
| `/ai-suite/business-brain` | layout / outlet | feature `sub_ai_suite`, perm `ai_suite.brain.read` |
| `/ai-suite/business-brain (index)` | `BusinessBrainDashboard` | feature `sub_ai_suite`, perm `ai_suite.brain.read` |
| `/ai-suite/business-brain/dump` | `BusinessBrainPage` | feature `sub_ai_suite`, perm `ai_suite.brain.read` |
| `/ai-suite/business-brain/ask` | `AskTheBrainPage` | feature `sub_ai_suite`, perm `ai_suite.brain.read` |
| `/ai-suite/business-brain/knowledge` | `KnowledgeBasePage` | feature `sub_ai_suite`, perm `ai_suite.brain.read` |
| `/ai-suite/business-brain/analytics` | `BrainAnalyticsPage` | feature `sub_ai_suite`, perm `ai_suite.brain.read` |
| `/ai-suite/business-brain/settings` | `BrainSettingsPage` | feature `sub_ai_suite`, perm `ai_suite.brain.read` |
| `/ai-suite/business-brain/api` | `BrainAPIPage` | feature `sub_ai_suite`, perm `ai_suite.brain.read` |
| `/ai-suite/business-brain/training` | `BrainTrainingPage` | feature `sub_ai_suite`, perm `ai_suite.brain.read` |
| `/ai-suite/business-brain/agents` | `BrainAgentLinkerPage` | feature `sub_ai_suite`, perm `ai_suite.brain.read` |
| `/ai-suite/business-brain/import-export` | `BrainImportExportPage` | feature `sub_ai_suite`, perm `ai_suite.brain.read` |
| `/ai-suite/business-brain/automations` | `BrainAutomationsPage` | feature `sub_ai_suite`, perm `ai_suite.brain.read` |
| `/ai-suite/business-brain/manager` | `BrainManagerPage` | feature `sub_ai_suite`, perm `ai_suite.brain.read` |
| `/ai-suite/business-brain/versions` | `BrainVersioningPage` | feature `sub_ai_suite`, perm `ai_suite.brain.read` |
| `/ai-suite/business-brain/studio/:brainId` | `BrainStudioPage` | feature `sub_ai_suite`, perm `ai_suite.brain.read` |
| `/ai-suite/agents` | layout / outlet | feature `sub_ai_suite`, perm `ai_suite.agents.read` |
| `/ai-suite/agents (index)` | `AIAgents` | feature `sub_ai_suite`, perm `ai_suite.agents.read` |
| `/ai-suite/agents/templates` | `AgentTemplateLibrary` | feature `sub_ai_suite`, perm `ai_suite.agents.read` |
| `/ai-suite/agents/create-custom` | `CustomAgentCreate` | feature `sub_ai_suite`, perm `ai_suite.agents.read` |
| `/ai-suite/agents/core/:agentType` | `CoreAgentConfig` | feature `sub_ai_suite`, perm `ai_suite.agents.read` |
| `/ai-suite/agents/:agentId` | `AgentDetail` | feature `sub_ai_suite`, perm `ai_suite.agents.read` |
| `/ai-suite/agents/:agentId/chat` | `AgentChat` | feature `sub_ai_suite`, perm `ai_suite.agents.read` |
| `/ai-suite/voice-agent` | `AIVoiceAgentPage` | feature `sub_ai_suite`, perm `ai_suite.voice_ai.read` |
| `/ai-suite/use-cases` | `UseCasesPage` | feature `sub_ai_suite` |
| `/ai-suite/favorites` | `FavAgents` | feature `sub_ai_suite` |
| `/ai-suite/content-hub` | `ContentHubPage` | feature `sub_ai_suite` |
| `/ai-suite/ai-library` | `AILibraryPage` | feature `sub_ai_suite` |
| `/ai-suite/agent-flows` | `AgentFlows` | feature `sub_ai_suite` |
| `/ai-suite/skill-builder` | `SkillBuilder` | feature `sub_ai_suite` |
| `/ai-suite/command-center` | `AICommandCenter` | feature `sub_ai_suite` |
| `/ai-suite/council` | `AICouncil` | feature `sub_ai_suite` |
| `/ai-suite/operations` | → redirect `../approvals` | feature `sub_ai_suite` |
| `/ai-suite/approvals` | `AIApprovals` | feature `sub_ai_suite` |
| `/ai-suite/marketplace` | `AIMarketplace` | feature `sub_ai_suite` |
| `/ai-suite/nova-settings` | → redirect `..` | feature `sub_ai_suite` |
| `/ai-suite/settings` | `AISuiteSettings` | feature `sub_ai_suite` |
| `/ai-suite/nova/skills` | `NovaSkills` | feature `sub_ai_suite` |
| `/ai-suite/nova-skills` | → redirect `../nova/skills` | feature `sub_ai_suite` |
| `/ai-suite/agentic-ai` | → redirect `../agents` | feature `sub_ai_suite` |
| `/ai-suite/*` | catch-all ("module not found" page) | feature `sub_ai_suite` |

### A.19 `operations` (68)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/operations` | layout / outlet | feature `sub_operations` |
| `/operations (index)` | → redirect `tasks` | feature `sub_operations` |
| `/operations/tasks` | `Tasks` | feature `sub_operations` |
| `/operations/report-builder` | layout / outlet | feature `sub_operations` |
| `/operations/report-builder (index)` | → redirect `reports` | feature `sub_operations` |
| `/operations/report-builder/create` | `ReportBuilder` | feature `sub_operations` |
| `/operations/report-builder/create/:reportId` | `ReportBuilder` | feature `sub_operations` |
| `/operations/report-builder/reports` | `ReportsList` | feature `sub_operations` |
| `/operations/inventory` | `InventoryDashboard` | feature `sub_operations`, perm `operations.inventory.read` |
| `/operations/inventory (index)` | → redirect `warehouses` | feature `sub_operations`, perm `operations.inventory.read` |
| `/operations/inventory/warehouses` | `sections#WarehousesSection` | feature `sub_operations`, perm `operations.inventory.read` |
| `/operations/inventory/products` | `sections#ProductsSection` | feature `sub_operations`, perm `operations.inventory.read` |
| `/operations/inventory/stock-levels` | `sections#StockLevelsSection` | feature `sub_operations`, perm `operations.inventory.read` |
| `/operations/inventory/movements` | `sections#MovementsSection` | feature `sub_operations`, perm `operations.inventory.read` |
| `/operations/inventory/suppliers` | `sections#SuppliersSection` | feature `sub_operations`, perm `operations.inventory.read` |
| `/operations/inventory/purchase-orders` | `sections#PurchaseOrdersSection` | feature `sub_operations`, perm `operations.inventory.read` |
| `/operations/inventory/alerts` | `sections#AlertsSection` | feature `sub_operations`, perm `operations.inventory.read` |
| `/operations/hrm` | layout / outlet | feature `sub_operations` |
| `/operations/hrm (index)` | → redirect `dashboard` | feature `sub_operations` |
| `/operations/hrm/dashboard` | `HRDashboard` | feature `sub_operations`, perm `operations.hrm_dashboard.read` |
| `/operations/hrm/people` | `PeopleDirectoryPage` | feature `sub_operations`, perm `operations.people_directory.read` |
| `/operations/hrm/attendance` | layout / outlet | feature `sub_operations`, perm `operations.attendance.read` |
| `/operations/hrm/attendance (index)` | `AttendanceAdmin` | feature `sub_operations`, perm `operations.attendance.read` |
| `/operations/hrm/attendance/log` | `AttendanceLog` | feature `sub_operations`, perm `operations.attendance.read` |
| `/operations/hrm/attendance/admin` | `AttendanceAdmin` | feature `sub_operations`, perm `operations.attendance.read` |
| `/operations/hrm/leave` | layout / outlet | feature `sub_operations`, perm `operations.leave.read` |
| `/operations/hrm/leave (index)` | `LeaveAdmin` | feature `sub_operations`, perm `operations.leave.read` |
| `/operations/hrm/leave/requests` | `LeaveRequests` | feature `sub_operations`, perm `operations.leave.read` |
| `/operations/hrm/leave/approvals` | `LeaveApprovals` | feature `sub_operations`, perm `operations.leave.read` |
| `/operations/hrm/leave/balances` | `LeaveBalancesAdmin` | feature `sub_operations`, perm `operations.leave.read` |
| `/operations/hrm/payroll` | layout / outlet | feature `sub_operations`, perm `operations.payroll.read` |
| `/operations/hrm/payroll (index)` | `PayrollAdmin` | feature `sub_operations`, perm `operations.payroll.read` |
| `/operations/hrm/payroll/structures` | `SalaryStructures` | feature `sub_operations`, perm `operations.payroll.read` |
| `/operations/hrm/payroll/runs` | `PayrollRuns` | feature `sub_operations`, perm `operations.payroll.read` |
| `/operations/hrm/payroll/payslips` | `Payslips` | feature `sub_operations`, perm `operations.payroll.read` |
| `/operations/hrm/shifts` | `ShiftPlanner` | feature `sub_operations`, perm `operations.shifts.read` |
| `/operations/hrm/documents` | `DocumentsAdmin` | feature `sub_operations`, perm `operations.documents.read` |
| `/operations/hrm/performance` | `PerformanceAdmin` | feature `sub_operations` |
| `/operations/hrm/approvals` | `ApprovalsInbox` | feature `sub_operations` |
| `/operations/hrm/inventory` | → redirect `../../inventory` | feature `sub_operations` |
| `/operations/hrm/productivity` | `ProductivityDashboard` | feature `sub_operations`, perm `operations.productivity.read` |
| `/operations/hrm/health` | `Health` | feature `sub_operations` |
| `/operations/hrm/org-chart` | `OrgChartPage` | feature `sub_operations`, perm `operations.org_chart.read` |
| `/operations/hrm/announcements` | `AnnouncementsAdmin` | feature `sub_operations` |
| `/operations/hrm/home` | `EmployeeHRHome` | feature `sub_operations` |
| `/operations/hrm/my-attendance` | `MyAttendance` | feature `sub_operations` |
| `/operations/hrm/my-leave` | `MyLeave` | feature `sub_operations` |
| `/operations/hrm/my-payslips` | `MyPayslips` | feature `sub_operations` |
| `/operations/hrm/my-profile` | `MyProfile` | feature `sub_operations` |
| `/operations/hrm/hiring` | `HiringLayout` | feature `sub_operations` |
| `/operations/hrm/hiring (index)` | → redirect `roles` | feature `sub_operations` |
| `/operations/hrm/hiring/roles` | `Roles` | feature `sub_operations` |
| `/operations/hrm/hiring/roles/create` | `RoleCreate` | feature `sub_operations` |
| `/operations/hrm/hiring/roles/:roleId` | `RoleDetail` | feature `sub_operations` |
| `/operations/hrm/hiring/candidates` | `Candidates` | feature `sub_operations` |
| `/operations/hrm/hiring/candidates/:candidateId` | `CandidateDetail` | feature `sub_operations` |
| `/operations/hrm/hiring/interviews` | `Interviews` | feature `sub_operations` |
| `/operations/hrm/hiring/assessments` | `Assessments` | feature `sub_operations` |
| `/operations/hrm/hiring/onboarding` | `OnboardingDashboard` | feature `sub_operations` |
| `/operations/hrm/hiring/map` | `MapView` | feature `sub_operations` |
| `/operations/hrm/hiring/reports` | `Reports` | feature `sub_operations` |
| `/operations/hrm/hiring/email-outbox` | `ComingSoon#EmailOutbox` | feature `sub_operations` |
| `/operations/hiring/*` | → redirect `../hrm/hiring/roles` | feature `sub_operations` |
| `/operations/settings` | `SettingsPage` | feature `sub_operations` |
| `/operations/franchise/kit-orders` | `KitOrdersPage` | feature `sub_operations` |
| `/operations/enterprise` | → redirect `../operations/hrm` | feature `sub_operations` |
| `/operations/school/*` | `SchoolV2Routes` | feature `sub_operations` |
| `/operations/*` | catch-all ("module not found" page) | feature `sub_operations` |

### A.20 `inbox` (3)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/inbox` | layout / outlet | feature `sub_inbox`, perm `inbox.inbox.read` |
| `/inbox (index)` | `InboxLanding#I` | feature `sub_inbox`, perm `inbox.inbox.read` |
| `/inbox/*` | catch-all ("module not found" page) | feature `sub_inbox`, perm `inbox.inbox.read` |

### A.21 `calendar` (15)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/calendar` | layout / outlet | feature `sub_calendar` |
| `/calendar (index)` | → redirect `view` | feature `sub_calendar` |
| `/calendar/reports` | `CalendarReportsPage` | feature `sub_calendar`, perm `calendar.reports.read` |
| `/calendar/view` | `CalendarPage` | feature `sub_calendar`, perm `calendar.calendar.read` |
| `/calendar/events` | layout / outlet | feature `sub_calendar`, perm `calendar.events.read` |
| `/calendar/events (index)` | `ListEventsPage` | feature `sub_calendar`, perm `calendar.events.read` |
| `/calendar/events/create` | `CalendarSelectorPage` | feature `sub_calendar`, perm `calendar.events.read` |
| `/calendar/events/selector` | → redirect `../create` | feature `sub_calendar`, perm `calendar.events.read` |
| `/calendar/events/wizard` | `CalendarWizardPage` | feature `sub_calendar`, perm `calendar.events.read` |
| `/calendar/events/new` | `CalendarWizardPage` | feature `sub_calendar`, perm `calendar.events.read` |
| `/calendar/events/:eventId/edit` | `CalendarWizardPage` | feature `sub_calendar`, perm `calendar.events.read` |
| `/calendar/events/:eventId/checkin` | `EventCheckinPage` | feature `sub_calendar`, perm `calendar.events.read` |
| `/calendar/events/:eventId/space` | `EventSpaceAdminPage` | feature `sub_calendar`, perm `calendar.events.read` |
| `/calendar/appointments` | `AppointmentsPage` | feature `sub_calendar`, perm `calendar.appointments.read` |
| `/calendar/*` | catch-all ("module not found" page) | feature `sub_calendar` |

### A.22 `finance` (76)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/finance` | layout / outlet | feature `sub_finance` |
| `/finance (index)` | `PlatformPlansPage` › `AgencyFinanceDashboard` › `FinanceDashboard` | feature `sub_finance` |
| `/finance/plan/coupons` | `Coupons#Coupons` | feature `sub_finance`, perm `finance.coupons.read`, plan-features `sales_finance`/`payment_links` |
| `/finance/plan/links` | `PaymentLinks#PaymentLinks` | feature `sub_finance`, perm `finance.payment_link.read`, plan-features `sales_finance`/`payment_links` |
| `/finance/plan/subscription` | `Subscription#Subscription` | feature `sub_finance`, perm `finance.subscription.read`, plan-features `sales_finance`/`payment_links`/`subscriptions_finance` |
| `/finance/sales` | `SalesSubscription#SalesSubscription` | feature `sub_finance`, perm `finance.subscription.read`, plan-features `transactions_finance`/`subscriptions_finance`/`sales_finance` |
| `/finance/sales/autopay` | → redirect `../recurring` | feature `sub_finance` |
| `/finance/sales/:orderId` | `OrderDetail#OrderDetail` | feature `sub_finance`, perm `finance.subscription.read`, plan-features `transactions_finance`/`subscriptions_finance`/`sales_finance` |
| `/finance/payments/invoices` | `InvoiceTable#InvoiceTable` | feature `sub_finance`, perm `finance.invoices.read`, plan-features `transactions_finance`/`subscriptions_finance`/`sales_finance` |
| `/finance/invoices` | → redirect `../payments/invoices` | feature `sub_finance` |
| `/finance/invoices/create` | → redirect `../documents/create` | feature `sub_finance` |
| `/finance/invoices/setup` | `InvoiceSetup#a` | feature `sub_finance` |
| `/finance/invoices/quota` | → redirect `../documents?type=quotation` | feature `sub_finance` |
| `/finance/invoices/quota/create` | → redirect `../documents/create` | feature `sub_finance` |
| `/finance/import` | `FinanceImportPage` | feature `sub_finance` |
| `/finance/import/legacy` | `ImportFinanceCSV#ImportFinanceCSV` | feature `sub_finance` |
| `/finance/migration` | `FinanceMigrationPage` | feature `sub_finance` |
| `/finance/transactions` | `TransactionsList` | feature `sub_finance`, perm `finance.transactions.read`, plan-features `transactions_finance`/`subscriptions_finance`/`sales_finance` |
| `/finance/transactions/list` | → redirect `../transactions` | feature `sub_finance` |
| `/finance/transactions/failed` | `FailedTransactions` | feature `sub_finance`, perm `finance.transactions.read`, plan-features `transactions_finance`/`subscriptions_finance`/`sales_finance` |
| `/finance/expenses` | → redirect `categories` | feature `sub_finance` |
| `/finance/expenses/categories` | `ExpenseCategory#ExpenseCategory` | feature `sub_finance`, perm `finance.expense_category.read`, plan-features `expenses` |
| `/finance/expenses/vendors` | `Vendors#Vendors` | feature `sub_finance`, perm `finance.manage_expenses.read`, plan-features `expenses` |
| `/finance/expenses/vendors/add` | `AddVendor#AddVendor` | feature `sub_finance`, perm `finance.manage_expenses.read`, plan-features `expenses` |
| `/finance/expenses/vendors/:vendorId` | `VendorDetail#VendorDetail` | feature `sub_finance`, perm `finance.manage_expenses.read`, plan-features `expenses` |
| `/finance/expenses/list` | `ExpenseList#ExpenseList` | feature `sub_finance`, perm `finance.manage_expenses.read`, plan-features `expenses` |
| `/finance/expenses/table` | `ExpenseTable#ExpenseTable` | feature `sub_finance`, perm `finance.manage_expenses.read`, plan-features `expenses` |
| `/finance/expenses/add` | `AddExpense#AddExpense` | feature `sub_finance`, perm `finance.manage_expenses.read`, plan-features `expenses` |
| `/finance/expenses/import` | `ImportExpenses` | feature `sub_finance`, perm `finance.manage_expenses.read`, plan-features `expenses` |
| `/finance/expenses/:expenseId` | `ExpenseDetail#ExpenseDetail` | feature `sub_finance`, perm `finance.manage_expenses.read`, plan-features `expenses` |
| `/finance/reports` | `ReportsLanding#ReportsLanding` | feature `sub_finance`, perm `finance.reports.read`, plan-features `reports_finance` |
| `/finance/reports/expenses` | → redirect `../reports?tab=expenses` | feature `sub_finance` |
| `/finance/reports/profit-loss` | → redirect `../reports?tab=profit-loss` | feature `sub_finance` |
| `/finance/reports/overdue` | → redirect `../reports?tab=overdue` | feature `sub_finance` |
| `/finance/reports/customer` | → redirect `../reports?tab=customer` | feature `sub_finance` |
| `/finance/reports/gst` | → redirect `../reports?tab=tax` | feature `sub_finance` |
| `/finance/reports/invoice` | → redirect `../reports?tab=invoice` | feature `sub_finance` |
| `/finance/reports/refund` | → redirect `../reports?tab=refund` | feature `sub_finance` |
| `/finance/reports/cancellation` | → redirect `../reports?tab=cancellation` | feature `sub_finance` |
| `/finance/payment-gateway` | → redirect `../settings?tab=gateways` | feature `sub_finance` |
| `/finance/payment-gateway/template/:templateId` | `PaymentTemplatePreview` | feature `sub_finance` |
| `/finance/quotes` | `QuotesLanding#QuotesLanding` | feature `sub_finance`, perm `finance.quotes.read`, plan-features `documents_finance` |
| `/finance/documents` | `Documents#Documents` | feature `sub_finance`, perm `finance.invoices.read`, plan-features `documents_finance` |
| `/finance/documents/create` | `CreateDocument#CreateDocument` | feature `sub_finance`, perm `finance.invoices.read`, plan-features `documents_finance` |
| `/finance/documents/templates` | `DocumentTemplates#DocumentTemplates` | feature `sub_finance`, perm `finance.invoices.read`, plan-features `documents_finance` |
| `/finance/documents/:docId/edit` | `CreateDocument#CreateDocument` | feature `sub_finance`, perm `finance.invoices.read`, plan-features `documents_finance` |
| `/finance/documents/:docId` | `DocumentDetail#DocumentDetail` | feature `sub_finance`, perm `finance.invoices.read`, plan-features `documents_finance` |
| `/finance/recurring` | `RecurringInvoices#RecurringInvoices` | feature `sub_finance`, perm `finance.recurring.read` |
| `/finance/approvals` | `ApprovalWorkflows#ApprovalWorkflows` | feature `sub_finance`, perm `finance.approvals.read` |
| `/finance/reminders` | `ReminderRules#ReminderRules` | feature `sub_finance`, perm `finance.reminders.read` |
| `/finance/settings` | `SettingsLanding#SettingsLanding` | feature `sub_finance`, perm `finance.finance_settings.read` |
| `/finance/settings/tax` | → redirect `../settings?tab=tax` | feature `sub_finance` |
| `/finance/settings/qr` | `QRCodeSettings#QRCodeSettings` | feature `sub_finance`, perm `finance.finance_settings.read` |
| `/finance/settlements` | `Settlements#Settlements` | feature `sub_finance`, perm `finance.settlements.read` |
| `/finance/analytics` | `AgencyRevenueAnalyticsPage` › `FinanceAnalytics#FinanceAnalytics` | feature `sub_finance`, perm `finance.reports.read` |
| `/finance/disputes` | `DisputesPage#DisputesPage` | feature `sub_finance`, perm `finance.transactions.read` |
| `/finance/wallets` | `WalletsPage` | feature `sub_finance`, perm `finance.transactions.read` |
| `/finance/audit-log` | `FinanceAuditLog` | feature `sub_finance`, perm `finance.reports.read`, plan-features `reports_finance` |
| `/finance/dunning` | `DunningRulesPage` | feature `sub_finance`, perm `finance.recurring.read` |
| `/finance/gateway-routing` | `GatewayRoutingPage` | feature `sub_finance`, perm `finance.payment_gateways.all` |
| `/finance/commissions` | `CommissionsPage` | feature `sub_finance`, perm `finance.manage_expenses.read`, plan-features `expenses` |
| `/finance/recurring-expenses` | `RecurringExpensesPage` | feature `sub_finance`, perm `finance.manage_expenses.read`, plan-features `expenses` |
| `/finance/payment-retry` | `PaymentRetryPage` | feature `sub_finance`, perm `finance.transactions.read` |
| `/finance/anomaly-detection` | `AnomalyDetectionPage` | feature `sub_finance`, perm `finance.reports.read`, plan-features `reports_finance` |
| `/finance/credit-notes` | `CreditNotesPage#CreditNotesPage` | feature `sub_finance`, perm `finance.invoices.read`, plan-features `documents_finance` |
| `/finance/expense-analytics` | `ExpenseAnalyticsPage` | feature `sub_finance`, perm `finance.manage_expenses.read`, plan-features `expenses` |
| `/finance/clv` | `CLVDashboard` | feature `sub_finance`, perm `finance.reports.read`, plan-features `reports_finance` |
| `/finance/tax-summary` | `TaxSummaryPage` | feature `sub_finance`, perm `finance.reports.read`, plan-features `reports_finance` |
| `/finance/profit-loss` | `ProfitLossPage` | feature `sub_finance`, perm `finance.reports.read`, plan-features `reports_finance` |
| `/finance/balance-sheet` | `BalanceSheetPage` | feature `sub_finance`, perm `finance.reports.read`, plan-features `reports_finance` |
| `/finance/aged-receivables` | `AgedReceivablesPage` | feature `sub_finance`, perm `finance.reports.read`, plan-features `reports_finance` |
| `/finance/routing-rules` | → redirect `../gateway-routing` | feature `sub_finance` |
| `/finance/health-monitor` | → redirect `../settings?tab=health` | feature `sub_finance` |
| `/finance/retry-policies` | → redirect `../payment-retry` | feature `sub_finance` |
| `/finance/my-plan` | `SubAccountMyPlan` | feature `sub_finance` |
| `/finance/*` | catch-all ("module not found" page) | feature `sub_finance` |

### A.23 `community` (72)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/community` | layout / outlet | feature `sub_community` |
| `/community (index)` | → redirect `preview` | feature `sub_community` |
| `/community/preview` | `CommunityPreview` | feature `sub_community` |
| `/community/digital-store` | layout / outlet | feature `sub_community`, perm `community.digital_store.read`, feature `sub_comm_digital_store` |
| `/community/digital-store (index)` | `DigitalStore` | feature `sub_community`, perm `community.digital_store.read`, feature `sub_comm_digital_store` |
| `/community/digital-store/design` | `DigitalStoreDesign` | feature `sub_community`, perm `community.digital_store.read`, feature `sub_comm_digital_store` |
| `/community/courses` | layout / outlet | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_courses` |
| `/community/courses (index)` | `Courses` | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_courses` |
| `/community/courses/bundles` | `BundleCourses` | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_courses`, feature `sub_comm_courses_bundles` |
| `/community/courses/new` | `EditCourse` | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_courses` |
| `/community/courses/:courseId/edit` | `EditCourse` | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_courses` |
| `/community/courses/:courseId/analytics` | `CourseAnalytics` | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_courses` |
| `/community/courses/:courseId/player` | `CoursePlayer` | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_courses` |
| `/community/courses/:courseId/checkout` | `CourseCheckout` | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_courses` |
| `/community/enrollment-migration` | `SubAccountEnrollmentMigrationPage` | feature `sub_community` |
| `/community/certificates` | layout / outlet | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_courses` |
| `/community/certificates (index)` | `CertificateGallery` | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_courses` |
| `/community/certificates/new` | `CertificateBuilder` | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_courses` |
| `/community/certificates/:certificateId/edit` | `CertificateBuilder` | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_courses` |
| `/community/certificates/:certificateId/preview` | `CertificatePreview` | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_courses` |
| `/community/live-classes` | layout / outlet | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_live_classes` |
| `/community/live-classes (index)` | `LiveClasses` | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_live_classes` |
| `/community/live-classes/create` | `LiveClassBuilder` | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_live_classes` |
| `/community/live-classes/:classId` | `LiveClassDetail` | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_live_classes` |
| `/community/live-classes/:classId/edit` | `LiveClassBuilder` | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_live_classes` |
| `/community/live-classes/:classId/control-room` | `LiveControlRoom` | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_live_classes` |
| `/community/live-classes/:classId/watch` | `StudentLiveWatch` | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_live_classes` |
| `/community/live-classes/:classId/analytics` | `LiveClassAnalytics` | feature `sub_community`, perm `community.lms.read`, feature `sub_comm_live_classes` |
| `/community/engagement` | `CommunityEngagementLayout` | feature `sub_community`, perm `community.branding.all` |
| `/community/engagement (index)` | `CommunityLinksAdmin` | feature `sub_community`, perm `community.branding.all` |
| `/community/engagement/channels` | `CommunityChannels` | feature `sub_community`, perm `community.branding.all` |
| `/community/engagement/messages` | → redirect `../../inbox?source=community-deprecated` | feature `sub_community`, perm `community.branding.all` |
| `/community/engagement/promo-banners` | `CommunityPromoBannersAdmin` | feature `sub_community`, perm `community.branding.all` |
| `/community/engagement/categories` | `CommunityCategoriesAdmin` | feature `sub_community`, perm `community.branding.all` |
| `/community/links` | → redirect `../engagement` | feature `sub_community` |
| `/community/promo-banners` | → redirect `../engagement/promo-banners` | feature `sub_community` |
| `/community/categories` | → redirect `../engagement/categories` | feature `sub_community` |
| `/community/people` | layout / outlet | feature `sub_community`, perm `community.members.read`, feature `sub_comm_members` |
| `/community/people (index)` | `CommunityMembers` | feature `sub_community`, perm `community.members.read`, feature `sub_comm_members` |
| `/community/people/:contactId` | `CommunityMemberProfile` | feature `sub_community`, perm `community.members.read`, feature `sub_comm_members` |
| `/community/memberships` | `CommunityMembersMemberships` | feature `sub_community`, perm `community.members.read`, feature `sub_comm_access_tiers` |
| `/community/events` | `CommunityEvents` | feature `sub_community`, perm `community.events.read`, feature `sub_comm_events` |
| `/community/members` | → redirect `../people` | feature `sub_community` |
| `/community/members/memberships` | → redirect `../../memberships` | feature `sub_community` |
| `/community/members/progress` | → redirect `../../people` | feature `sub_community` |
| `/community/members/leaderboard` | → redirect `../../leaderboard` | feature `sub_community` |
| `/community/members/leaderboard-settings` | → redirect `../../leaderboard/point-rules` | feature `sub_community` |
| `/community/members/activity` | → redirect `../../people` | feature `sub_community` |
| `/community/leaderboard` | `CommunityLeaderboardLayout` | feature `sub_community`, perm `community.leaderboard_points.read` |
| `/community/leaderboard (index)` | `Leaderboard` | feature `sub_community`, perm `community.leaderboard_points.read` |
| `/community/leaderboard/point-rules` | `LeaderboardSettings` | feature `sub_community`, perm `community.leaderboard_points.read` |
| `/community/leaderboard/gamification` | `GamificationSettings` | feature `sub_community`, perm `community.leaderboard_points.read` |
| `/community/settings` | `CommunitySettingsLayout` | feature `sub_community`, perm `community.community_settings.read` |
| `/community/settings (index)` | `CommunitySettings` | feature `sub_community`, perm `community.community_settings.read` |
| `/community/settings/profile` | `CommunitySettings` | feature `sub_community`, perm `community.community_settings.read` |
| `/community/settings/general` | → redirect `..` | feature `sub_community`, perm `community.community_settings.read` |
| `/community/settings/notifications` | `CommunitySettingsNotifications` | feature `sub_community`, perm `community.community_settings.read` |
| `/community/settings/branding` | → redirect `..` | feature `sub_community`, perm `community.community_settings.read` |
| `/community/settings/permissions` | → redirect `..` | feature `sub_community`, perm `community.community_settings.read` |
| `/community/settings/gamification` | → redirect `..` | feature `sub_community`, perm `community.community_settings.read` |
| `/community/settings/domain` | → redirect `..` | feature `sub_community`, perm `community.community_settings.read` |
| `/community/settings/community` | → redirect `..` | feature `sub_community`, perm `community.community_settings.read` |
| `/community/settings/portal` | → redirect `..` | feature `sub_community`, perm `community.community_settings.read` |
| `/community/portal-preview` | `CommunityPortalPreview` | feature `sub_community` |
| `/community/leaderboard-settings` | → redirect `../leaderboard/point-rules` | feature `sub_community` |
| `/community/portal` | → redirect `../settings/branding` | feature `sub_community` |
| `/community/my-courses` | `MyCourses` | feature `sub_community`, perm `community.lms.read` |
| `/community/profile` | `CommunityProfile` | feature `sub_community` |
| `/community/feed` | `MyHealth` | feature `sub_community`, perm `community.health.read` |
| `/community/channels` | → redirect `../engagement/channels` | feature `sub_community` |
| `/community/messages` | → redirect `../../inbox?source=community-deprecated` | feature `sub_community` |
| `/community/*` | catch-all ("module not found" page) | feature `sub_community` |

### A.24 `staff` (2)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/staff` | → redirect `../settings/staff` |  |
| `/staff/*` | catch-all ("module not found" page) |  |

### A.25 `settings` (116)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/settings` | `SettingsHub` |  |
| `/settings/restore-deleted` | `RestoreDeletedItems` |  |
| `/settings/staff` | layout / outlet |  |
| `/settings/staff (index)` | `StaffActive` |  |
| `/settings/staff/active` | `StaffActive` |  |
| `/settings/staff/inactive` | `StaffInactive` |  |
| `/settings/staff/roles` | `StaffRoles` |  |
| `/settings/staff/permissions` | `PermissionsPage` |  |
| `/settings/staff/teams` | `StaffTeams` |  |
| `/settings/staff/assignments` | `StaffAssignments` |  |
| `/settings/staff/leadership` | `LeadershipPage` |  |
| `/settings/staff/departments` | `StaffDepartments` |  |
| `/settings/staff/departments/:departmentId` | `DepartmentDetailPage` |  |
| `/settings/staff/ai-staff` | `AIAvatarsPage` |  |
| `/settings/staff/ai-staff/training` | `AITrainingCenterPage` |  |
| `/settings/staff/ai-staff/memory` | `AIMemoryViewerPage` |  |
| `/settings/staff/ai-staff/daily-training` | `DailyTrainingDashboardPage` |  |
| `/settings/staff/marketplace-access` | `MarketplaceAccessRequests` |  |
| `/settings/staff/org-chart` | `OrgChartPage` |  |
| `/settings/staff/agents/*` | → redirect `../../../ai-suite/agents` |  |
| `/settings/staff/hrms` | → redirect `../../operations/hrm` |  |
| `/settings/staff/hrms/*` | → redirect `../../operations/hrm` |  |
| `/settings/tags` | `TagManager#a` |  |
| `/settings/tags/folders` | `TagManager#a` |  |
| `/settings/tags/folders/:folderId` | `TagManager#a` |  |
| `/settings/note-templates` | `NoteTemplates` |  |
| `/settings/outreach-templates` | `OutreachTemplates` |  |
| `/settings/templates` | `TemplatesHub` |  |
| `/settings/affiliate` | → redirect `../../sales/affiliate` |  |
| `/settings/referral` | layout / outlet |  |
| `/settings/referral (index)` | → redirect `dashboard` |  |
| `/settings/referral/dashboard` | `PartnerProgramDashboard` |  |
| `/settings/referral/affiliates` | `PartnerProgramAffiliates` |  |
| `/settings/referral/leaderboard` | `PartnerProgramLeaderboard` |  |
| `/settings/partner-dashboard/*` | → redirect `../referral/dashboard` |  |
| `/settings/values` | layout / outlet |  |
| `/settings/values (index)` | → redirect `contact` |  |
| `/settings/values/contact` | `Values` |  |
| `/settings/values/staff` | `Values` |  |
| `/settings/values/company` | `Values` |  |
| `/settings/values/additional` | `Values` |  |
| `/settings/values/calendar` | `Values` |  |
| `/settings/values/finance` | → redirect `subscription` |  |
| `/settings/values/finance/:financeCategory` | `Values` |  |
| `/settings/values/webinar` | `Values` |  |
| `/settings/values/time` | `Values` |  |
| `/settings/values/course` | `Values` |  |
| `/settings/values/custom` | `Values` |  |
| `/settings/values/folders` | `Values` |  |
| `/settings/values/folders/:folderId` | `Values` |  |
| `/settings/values/smart` | `SmartValuesPage` |  |
| `/settings/fields` | layout / outlet |  |
| `/settings/fields (index)` | `CustomFieldsStandard` |  |
| `/settings/fields/additional` | `CustomFieldsAdditional` |  |
| `/settings/fields/folders` | `CustomFieldsFolders` |  |
| `/settings/domain` | `SubaccountDomainSettings` |  |
| `/settings/beta-programs` | `BetaProgramsPage` |  |
| `/settings/smart-links` | → redirect `../lead-generation/urls?tab=links` |  |
| `/settings/domains` | `SubAccountDomains` |  |
| `/settings/analytics` | layout / outlet |  |
| `/settings/analytics (index)` | `AnalyticsOverview` |  |
| `/settings/analytics/utm` | `AnalyticsAttribution` |  |
| `/settings/analytics/utm/:view` | `AnalyticsAttribution` |  |
| `/settings/analytics/attribution` | → redirect `../utm` |  |
| `/settings/analytics/attribution/:view` | layout / outlet |  |
| `/settings/analytics/utm-parameters` | → redirect `../utm` |  |
| `/settings/analytics/email` | `AnalyticsEmail` |  |
| `/settings/analytics/calls` | `AnalyticsCalls` |  |
| `/settings/analytics/whatsapp` | `AnalyticsWhatsApp` |  |
| `/settings/analytics/instagram` | `AnalyticsInstagram` |  |
| `/settings/analytics/community` | `AnalyticsCourses` |  |
| `/settings/analytics/events` | `AnalyticsEvents` |  |
| `/settings/analytics/tracking` | `AnalyticsTracking` |  |
| `/settings/analytics/zoom` | `ZoomAnalytics` | analytics-tab `zoom` |
| `/settings/analytics/pipeline` | `AnalyticsPipeline` |  |
| `/settings/analytics/revenue` | `AnalyticsRevenue` |  |
| `/settings/analytics/forms` | `AnalyticsForms` |  |
| `/settings/analytics/traffic` | `AnalyticsTraffic` | analytics-tab `traffic` |
| `/settings/analytics/sms` | `AnalyticsSMS` |  |
| `/settings/analytics/ai-brain` | `AnalyticsAIBrain` |  |
| `/settings/analytics/shop` | `AnalyticsShop` |  |
| `/settings/analytics/surveys` | `AnalyticsSurveys` | analytics-tab `surveys` |
| `/settings/analytics/social` | `AnalyticsSocial` |  |
| `/settings/analytics/digital-human` | `AnalyticsDigitalHuman` | analytics-tab `digital-human` |
| `/settings/analytics/voice-agent` | `AnalyticsVoiceAgent` | analytics-tab `voice-agent` |
| `/settings/analytics/courses` | `AnalyticsCourseList` |  |
| `/settings/analytics/finance` | `AnalyticsFinance` |  |
| `/settings/analytics/expenses` | `AnalyticsExpenses` |  |
| `/settings/analytics/clv` | `AnalyticsCLV` |  |
| `/settings/analytics/tax-summary` | `AnalyticsTaxSummary` | analytics-tab `tax-summary` |
| `/settings/analytics/funnels` | `AnalyticsFunnels` |  |
| `/settings/analytics/heatmap` | `HeatmapDashboard` | analytics-tab `heatmap` |
| `/settings/branding` | `Branding` |  |
| `/settings/app-store` | `AppStore#A` |  |
| `/settings/addon-store` | `AddonStorePage` |  |
| `/settings/api` | `APISettings` |  |
| `/settings/webhooks` | `WebhooksManagementPage` |  |
| `/settings/integrations` | → redirect `../app-store` |  |
| `/settings/integrations/:integrationKey` | `IntegrationDetail` |  |
| `/settings/app-store/:integrationKey` | `IntegrationDetail` |  |
| `/settings/integration-health` | `IntegrationHealthPage` |  |
| `/settings/vault` | `Vault` |  |
| `/settings/notifications` | `Notifications` |  |
| `/settings/workspace` | `WorkspacePreferencesPage` |  |
| `/settings/experience-mode` | `ExperienceModePage` |  |
| `/settings/platform` | `PlatformSettingsPage` |  |
| `/settings/zoom` | `ZoomSettings` |  |
| `/settings/zoom/logs` | `ZoomLogsPage` |  |
| `/settings/zoom/sessions/:sessionId` | `ZoomSessionDetail` |  |
| `/settings/canva` | `CanvaSettings` |  |
| `/settings/google-integrations` | `GoogleIntegrationPage` |  |
| `/settings/ai-assistant` | `AIAssistantSettings` |  |
| `/settings/recover` | `Recover` |  |
| `/settings/mobile-nav` | `SubAccountMobileNavSettings` |  |
| `/settings/wallet` | `SubAccountWallet` |  |
| `/settings/ai-audit` | `AiAuditLogPage` |  |

### A.26 `domains` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/domains` | → redirect `../settings/domains` |  |

### A.27 `analytics` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/analytics` | `CrossModuleAnalytics` |  |

### A.28 `telephony` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/telephony` | `TelephonyPage` |  |

### A.29 `canva-hub` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/canva-hub` | `CanvaHub` |  |

### A.30 `help` (9)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/help` | `HelpCenterPage` |  |
| `/help/getting-started` | `HelpGettingStartedPage` |  |
| `/help/lead-management` | `HelpLeadManagementPage` |  |
| `/help/lead-management/:subSlug` | `HelpLeadManagementPage` |  |
| `/help/lead-generation` | `HelpLeadGenerationPage#H` |  |
| `/help/lead-generation/:subSlug` | `HelpLeadGenerationPage#H` |  |
| `/help/:moduleSlug` | `HelpModulePage` |  |
| `/help/lead-automation/waba` | `HelpWabaPage` |  |
| `/help/:moduleSlug/:subFeatureSlug` | `HelpSubFeaturePage` |  |

### A.31 `ai-hub` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/ai-hub` | `SubAccountACPPage` |  |

### A.32 `growth-intelligence` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/growth-intelligence` | `GrowthCommandCenter` |  |

### A.33 `messaging-wallet` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/messaging-wallet` | → redirect `../billing?tab=wallet` |  |

### A.34 `healthcare` (3)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/healthcare/intake-config` | `IntakeFormConfigPage` |  |
| `/healthcare/patient-queue` | `PatientQueuePage` |  |
| `/healthcare/analytics` | `HealthcareDashboardPage` |  |

### A.35 `*` (1)

| Path | Screen / behaviour | Gates |
|---|---|---|
| `/*` | catch-all ("module not found" page) |  |

## Appendix B: Sub-account navigation registry

The sidebar, module top-nav and in-page tabs are all rendered from one registry (`feature_key → label, route_suffix, nav_location, module_group, children`). `nav_location`: **L** = left sidebar, **T** = module top-nav, **I** = in-page tab, **S** = settings hub. Suffixes are relative to `/v2/s/:id/`. **↪** = resolved by a nested wildcard route (e.g. `sales/performance/*`) or wildcard redirect; **⚠** = no matching route, so the link lands on the module catch-all ("module not found") or a parent redirect — see §3.4.

- **Dashboard** `sub_dashboard` → `dashboard` L
- **Get Started** `sub_get_started` → `get-started` L
- **Profile** `sub_profile` → `profile` T
- **Business Profile** `sub_business_profile` → `business-profile` T
- **Billing** `sub_billing` → `billing` T
- **Login Activity** `sub_login_activity` → `login-activity` T
- **Credits** `sub_credits` → `credits` T
- **Lead Generation** `sub_lead_gen` → `lead-generation` L
  - **Shop** `sub_lg_shop` → `lead-generation/shop` T
    - **Dashboard** `sub_shop_dashboard` → `lead-generation/shop` I
    - **Products** `sub_shop_products` → `lead-generation/shop/products` I
    - **Collections** `sub_shop_collections` → `lead-generation/shop/collections` I
    - **Orders** `sub_shop_orders` → `lead-generation/shop/orders` I
    - **Offers** `sub_shop_coupons` → `lead-generation/shop/offers` I
    - **Shipping** `sub_shop_shipping` → `lead-generation/shop/shipping` I
    - **Payments & Finance** `sub_shop_payments` → `lead-generation/shop/finance` I ⚠
    - **Reviews** `sub_shop_reviews` → `lead-generation/shop/reviews` I
    - **Inventory** `sub_shop_inventory` → `lead-generation/shop/inventory` I
    - **Media Library** `sub_shop_media` → `lead-generation/shop/media` I
    - **Analytics** `sub_shop_analytics` → `lead-generation/shop/analytics` I
    - **Store Design** `sub_shop_design` → `lead-generation/shop/design` I
    - **AI Studio** `sub_shop_ai_studio` → `lead-generation/shop/ai-studio` I
    - **Settings** `sub_shop_settings` → `lead-generation/shop/settings` I
    - **Finance Sync** `sub_shop_finance_sync` → `lead-generation/shop/finance-sync` I
  - **Sites** `sub_lg_sites` → `lead-generation/sites` T
  - **Vibe Studio** `sub_lg_vibe_studio` → `lead-generation/vibe-studio` T
  - **Forms** `sub_lg_forms` → `lead-generation/forms` T
    - **All Forms** `sub_forms_list` → `lead-generation/forms` I
    - **New Form** `sub_forms_new` → `lead-generation/forms/new` I
    - **Templates** `sub_forms_templates` → `lead-generation/forms/templates` I
  - **Surveys** `sub_lg_surveys` → `lead-generation/surveys` T
  - **Ad Launcher** `sub_lg_ads` → `lead-generation/ads-social` T
    - **Dashboard** `sub_ads_dashboard` → `lead-generation/ads-social?tab=dashboard` I
    - **Campaigns** `sub_ads_campaigns` → `lead-generation/ads-social?tab=campaigns` I
      - **Campaigns List** `sub_ads_camp_list` → `lead-generation/ads-social?tab=campaigns&view=campaigns` I
      - **Ad Sets** `sub_ads_camp_adsets` → `lead-generation/ads-social?tab=campaigns&view=adsets` I
      - **Ads** `sub_ads_camp_ads` → `lead-generation/ads-social?tab=campaigns&view=ads` I
      - **Compare** `sub_ads_camp_compare` → `lead-generation/ads-social?tab=campaigns&view=compare` I
    - **Create** `sub_ads_create` → `lead-generation/ads-social?tab=create` I
    - **AI Operator** `sub_ads_operator` → `lead-generation/ads-social?tab=operator` I
    - **Agents** `sub_ads_agents` → `lead-generation/ads-social?tab=agents` I
    - **AI Optimization** `sub_ads_ai_optimization` → `lead-generation/ads-social?tab=ai-optimization` I
    - **Audit** `sub_ads_audit` → `lead-generation/ads-social?tab=audit` I
    - **Creative Hub** `sub_ads_creative_hub` → `lead-generation/ads-social/creative-hub` I
    - **Settings** `sub_ads_settings` → `lead-generation/ads-social?tab=settings` I
  - **AI Social** `sub_lg_ai_social` → `lead-generation/ai-social` T
    - **Dashboard** `sub_aisoc_dashboard` → `lead-generation/ai-social?tab=dashboard` I
    - **Planner** `sub_aisoc_planner` → `lead-generation/ai-social?tab=planner` I
    - **Posts** `sub_aisoc_posts` → `lead-generation/ai-social?tab=planner&view=list` I
    - **Content Hub** `sub_aisoc_content_hub` → `lead-generation/ai-social?tab=content-hub` I
    - **AI Studio** `sub_aisoc_ai_studio` → `lead-generation/shop/ai-studio` I
    - **Create Post** `sub_aisoc_create_post` → `lead-generation/ai-social?tab=create-post` I
    - **Comments** `sub_aisoc_comments` → `lead-generation/ai-social?tab=comments` I
    - **Analytics** `sub_aisoc_analytics` → `lead-generation/ai-social?tab=analytics` I
    - **Listening** `sub_aisoc_listening` → `lead-generation/ai-social?tab=listening` I
    - **Agents** `sub_aisoc_agents` → `lead-generation/ai-social?tab=agents` I
    - **Settings** `sub_aisoc_settings` → `lead-generation/ai-social?tab=settings` I
  - **Reputation** `sub_lg_reputation` → `lead-generation/reputation` T
  - **Chat Widget** `sub_lg_chat_widget` → `lead-generation/chat-widget` T
    - **Dashboard** `sub_cw_dashboard` → `lead-generation/chat-widget` I
    - **Sessions** `sub_cw_sessions` → `lead-generation/chat-widget/sessions` I
    - **Chat Page** `sub_cw_page` → `lead-generation/chat-widget/page` I
  - **Digital Human** `sub_lg_digital_human` → `lead-generation/digital-human` T ⚠
    - **Analytics** `sub_dh_analytics` → `lead-generation/digital-human/analytics` I ⚠
    - **Conversations** `sub_dh_conversations` → `lead-generation/digital-human/conversations` I ⚠
    - **Knowledge Base** `sub_dh_kb` → `lead-generation/digital-human/knowledge-base` I ⚠
    - **Embed** `sub_dh_embed` → `lead-generation/digital-human/embed` I ⚠
  - **Prospecting** `sub_lg_prospecting` → `lead-generation/prospecting` T
  - **Templates** `sub_lg_templates` → `lead-generation/templates` T
- **Lead Management** `sub_lead_mgmt` → `lead-management` L
  - **Opportunity** `sub_lm_opportunity` → `lead-management/crm/opportunity` T
  - **Pipeline** `sub_lm_pipeline` → `lead-management/crm/pipeline` T
  - **Bulk Import** `sub_lm_bulk_import` → `lead-management/crm/bulk-import` T
  - **Lead Scoring** `sub_lm_scoring` → `lead-management/crm/lead-scoring` T
  - **Forecasting** `sub_lm_forecasting` → `lead-management/crm/forecasting` T
  - **Attribution** `sub_lm_attribution` → `lead-management/crm/attribution` T
  - **Follow-up** `sub_lm_followup` → `lead-management/follow-up` T
  - **Contacts** `sub_lm_contacts` → `lead-management/contacts` T
    - **All Contacts** `sub_contacts_list` → `lead-management/contacts` I
    - **Import** `sub_contacts_import` → `lead-management/contacts/import` I
    - **Import/Export History** `sub_contacts_history` → `lead-management/contacts/import-export-history` I
    - **Dedupe Queue** `sub_contacts_dedupe` → `lead-management/contacts/dedupe` I
    - **Segments** `sub_contacts_segments` → `lead-management/contacts/segments` I
  - **Meta Leads** `sub_lm_meta_leads` → `lead-management/meta-leads` T ⚠
  - **Agentic AI** `sub_lm_agentic_ai` → `lead-management/agentic-ai` T
- **Lead Automation** `sub_lead_auto` → `lead-automation` L
  - **Email** `sub_la_email` → `lead-automation/email` T
  - **WhatsApp** `sub_la_whatsapp` → `lead-automation/whatsapp` T
    - **Dashboard** `sub_wa_dashboard` → `lead-automation/whatsapp?tab=dashboard` I
    - **Devices** `sub_wa_devices` → `lead-automation/whatsapp?tab=devices` I
    - **Campaigns** `sub_wa_campaigns` → `lead-automation/whatsapp?tab=campaigns` I
    - **Contacts** `sub_wa_contacts` → `lead-automation/whatsapp?tab=contacts` I
    - **Groups** `sub_wa_groups` → `lead-automation/whatsapp?tab=groups` I
    - **Labels** `sub_wa_labels` → `lead-automation/whatsapp?tab=labels` I
    - **Channels** `sub_wa_channels` → `lead-automation/whatsapp?tab=channels` I
    - **Status** `sub_wa_status` → `lead-automation/whatsapp?tab=status` I
    - **Verify** `sub_wa_verify` → `lead-automation/whatsapp?tab=verify` I
    - **Profile** `sub_wa_profile` → `lead-automation/whatsapp?tab=profile` I
  - **WABA** `sub_la_waba` → `lead-automation/waba` T
    - **Dashboard** `sub_waba_home` → `lead-automation/waba?tab=home` I
    - **Setup** `sub_waba_setup` → `lead-automation/waba?tab=setup` I
    - **Templates** `sub_waba_templates` → `lead-automation/waba?tab=templates` I
    - **Single Send** `sub_waba_single_send` → `lead-automation/waba?tab=single-send` I
    - **Campaigns** `sub_waba_campaigns` → `lead-automation/waba?tab=campaigns` I
    - **Team Inbox** `sub_waba_inbox` → `lead-automation/waba?tab=inbox` I
    - **Wallet** `sub_waba_wallet` → `lead-automation/waba?tab=wallet` I
    - **Compliance** `sub_waba_compliance` → `lead-automation/waba?tab=compliance` I
  - **Automation** `sub_la_workflows` → `lead-automation/workflows` T
    - **Dashboard** `sub_wf_dashboard` → `lead-automation/workflows?tab=dashboard` I
    - **Chat Flow** `sub_wf_chatflow` → `lead-automation/workflows?tab=chatflow` I
    - **Workflow** `sub_wf_workflow` → `lead-automation/workflows?tab=workflow` I
    - **Social Flow** `sub_wf_socialflow` → `lead-automation/workflows?tab=socialflow` I
    - **Settings** `sub_wf_settings` → `lead-automation/workflows?tab=settings` I
  - **Bulk Campaigns** `sub_la_bulk` → `lead-automation/bulk` T ⚠
- **Sales** `sub_sales` → `sales` L
  - **Dashboard** `sub_sales_dashboard` → `sales` I
  - **IVR Calling** `sub_sales_ivr` → `sales/ivr` I
  - **Voice AI** `sub_sales_voice` → `sales/voice-agent` I
    - **Agent Profile** `sub_va_profile` → `sales/voice-agent` I
    - **AI Pipeline** `sub_va_pipeline` → `sales/voice-agent/models` I
    - **Routing** `sub_va_routing` → `sales/voice-agent/routing` I
    - **Call Logs** `sub_va_calls` → `sales/voice-agent/calls` I
    - **Console** `sub_va_console` → `sales/voice-agent/console` I
    - **Campaigns** `sub_va_campaigns` → `sales/voice-agent/campaigns` I
    - **Memory** `sub_va_memory` → `sales/voice-agent/memory` I
    - **Providers** `sub_va_providers` → `sales/voice-agent/providers` I
    - **Analytics** `sub_va_analytics` → `sales/voice-agent/analytics` I
    - **Compliance** `sub_va_compliance` → `sales/voice-agent/compliance` I
  - **Assignments** `sub_sales_assignments` → `sales/assignments` I
  - **Affiliate Program** `sub_sales_affiliate` → `sales/affiliate` I
  - **Performance** `sub_sales_performance` → `sales/performance` I
    - **Overview** `sub_perf_overview` → `sales/performance` I
    - **Leaderboard** `sub_perf_leaderboard` → `sales/performance/leaderboard` I ↪
    - **Targets** `sub_perf_targets` → `sales/performance/targets` I ↪
    - **Scorecards** `sub_perf_scorecards` → `sales/performance/scorecards` I ↪
    - **Gamification** `sub_perf_gamification` → `sales/performance/gamification` I ↪
    - **SLA Monitoring** `sub_perf_sla` → `sales/performance/sla` I ↪
    - **Alerts** `sub_perf_alerts` → `sales/performance/alerts` I ↪
    - **Settings** `sub_perf_settings` → `sales/performance/settings` I ↪
  - **Incentives** `sub_sales_incentives` → `sales/incentives` I
- **AI Suite** `sub_ai_suite` → `ai-suite` L
  - **Dashboard** `sub_ai_dashboard` → `ai-suite/dashboard` I ⚠
  - **AI Brain** `sub_ai_brain` → `ai-suite/brain` I
  - **AI Skills** `sub_ai_skills` → `ai-suite/skill-builder` I
  - **AI Agents** `sub_ai_agents` → `ai-suite/agents` I
  - **AI Studio** `sub_ai_studio` → `ai-suite/ai-library` I
  - **AI Logs** `sub_ai_logs` → `ai-suite/command-center` I
  - **Approvals** `sub_ai_approvals` → `ai-suite/approvals` I
  - **Marketplace** `sub_ai_marketplace` → `ai-suite/marketplace` I
- **Operations** `sub_operations` → `operations` L
  - **Dashboard** `sub_ops_dashboard` → `operations` I
  - **Hiring: Roles** `sub_ops_hiring_roles` → `operations/hiring/roles` I ↪
  - **Hiring: Candidates** `sub_ops_hiring_candidates` → `operations/hiring/candidates` I ↪
  - **Hiring: Interviews** `sub_ops_hiring_interviews` → `operations/hiring/interviews` I ↪
  - **Hiring: Assessments** `sub_ops_hiring_assessments` → `operations/hiring/assessments` I ↪
  - **Hiring: Onboarding** `sub_ops_hiring_onboarding` → `operations/hiring/onboarding` I ↪
  - **Hiring: Map View** `sub_ops_hiring_map` → `operations/hiring/map` I ↪
  - **Hiring: Reports** `sub_ops_hiring_reports` → `operations/hiring/reports` I ↪
  - **Hiring: Email Outbox** `sub_ops_hiring_email` → `operations/hiring/email-outbox` I ↪
  - **Attendance (→ Staff)** `sub_ops_attendance` → `staff/hrms/attendance` I ↪
  - **Payroll (→ Staff)** `sub_ops_payroll` → `staff/hrms/payroll` I ↪
  - **Leave (→ Staff)** `sub_ops_leave` → `staff/hrms/leave` I ↪
  - **HRMS (→ Staff)** `sub_ops_hrms` → `staff/hrms` I ↪
  - **Inventory** `sub_ops_inventory` → `operations/inventory` I
  - **Productivity** `sub_ops_productivity` → `operations/productivity` I ⚠
  - **Kit Orders** `sub_franchise_kit_orders` → `operations/franchise/kit-orders` I
  - **Settings** `sub_ops_settings` → `operations/settings` I
- **Wallet** `sub_wallet` → `billing?tab=wallet` I
- **Inbox** `sub_inbox` → `inbox` L
- **Calendar** `sub_calendar` → `calendar` L
  - **Calendar View** `sub_cal_view` → `calendar/view` I
  - **Events** `sub_cal_events` → `calendar/events` I
    - **Events List** `sub_cal_events_list` → `calendar/events` I
    - **Create Event** `sub_cal_events_create` → `calendar/events/create` I
    - **Event Selector** `sub_cal_events_selector` → `calendar/events/selector` I
    - **Event Wizard** `sub_cal_events_wizard` → `calendar/events/wizard` I
  - **Appointments** `sub_cal_appointments` → `calendar/appointments` I
  - **Reports** `sub_cal_reports` → `calendar/reports` I
- **Finance** `sub_finance` → `finance` L
  - **Dashboard** `sub_fin_dashboard` → `finance` I
  - **Documents** `sub_fin_documents` → `finance/documents` I
    - **All Documents** `sub_fin_docs_list` → `finance/documents` I
    - **Create Document** `sub_fin_docs_create` → `finance/documents/create` I
    - **Templates** `sub_fin_docs_templates` → `finance/documents/templates` I
  - **Transactions** `sub_fin_transactions` → `finance/transactions` I
    - **Real-Time** `sub_fin_txn_realtime` → `finance/transactions` I
    - **Transactions List** `sub_fin_txn_list` → `finance/transactions/list` I
    - **Failed** `sub_fin_txn_failed` → `finance/transactions/failed` I
  - **Expenses** `sub_fin_expenses` → `finance/expenses` I
    - **Categories** `sub_fin_exp_category` → `finance/expenses` I
    - **Vendors** `sub_fin_exp_vendors` → `finance/expenses/vendors` I
    - **Expense List** `sub_fin_exp_list` → `finance/expenses/list` I
    - **Expense Table** `sub_fin_exp_table` → `finance/expenses/table` I
  - **Reports** `sub_fin_reports` → `finance/reports` I
  - **Recurring** `sub_fin_recurring` → `finance/recurring` I
  - **Approvals** `sub_fin_approvals` → `finance/approvals` I
  - **Reminders** `sub_fin_reminders` → `finance/reminders` I
  - **Quotes** `sub_fin_quotes` → `finance/quotes` I
  - **Settlements** `sub_fin_settlements` → `finance/settlements` I
  - **Import** `sub_fin_import` → `finance/import` I
  - **Migration** `sub_fin_migration` → `finance/migration` I
  - **Plan** `sub_fin_plan` → `finance/plan` I ⚠
    - **Coupons** `sub_fin_plan_coupons` → `finance/plan/coupons` I
    - **Payment Links** `sub_fin_plan_links` → `finance/plan/links` I
    - **Subscription** `sub_fin_plan_subscription` → `finance/plan/subscription` I
  - **Sales** `sub_fin_sales` → `finance/sales` I
  - **Settings** `sub_fin_settings` → `finance/settings` I
  - **Analytics** `sub_fin_analytics` → `finance/analytics` I
- **Community** `sub_community` → `community` L
  - **Dashboard** `sub_comm_preview` → `community/preview` I
  - **Digital Store** `sub_comm_digital_store` → `community/digital-store` I
  - **Courses** `sub_comm_courses` → `community/courses` I
    - **All Courses** `sub_comm_courses_list` → `community/courses` I
    - **Bundles** `sub_comm_courses_bundles` → `community/courses/bundles` I
  - **Live Classes** `sub_comm_live_classes` → `community/live-classes` I
  - **Events** `sub_comm_events` → `community/events` I
  - **Members** `sub_comm_members` → `community/members` I
    - **Memberships** `sub_comm_access_tiers` → `community/members/memberships` I
    - **Leaderboard** `sub_comm_leaderboard` → `community/members/leaderboard` I
  - **Engagement** `sub_comm_engagement` → `community/engagement` I
  - **Settings** `sub_comm_settings` → `community/settings` I
  - **Domain** `sub_comm_settings_domain` → `community/settings/domain` S
- **Staff** `sub_staff` → `staff` L
  - **Active** `sub_staff_active` → `staff/active` I ↪
  - **Inactive** `sub_staff_inactive` → `staff/inactive` I ↪
  - **Roles** `sub_staff_roles` → `settings/staff/roles` I
  - **Permissions** `sub_staff_permissions` → `staff/permissions` I ↪
  - **Teams** `sub_staff_teams` → `staff/teams` I ↪
  - **Assignments** `sub_staff_assignments` → `staff/assignments` I ↪
  - **Leadership** `sub_staff_leadership` → `staff/leadership` I ↪
  - **Departments** `sub_staff_departments` → `staff/departments` I ↪
  - **AI Staff** `sub_staff_ai` → `staff/ai-staff` I ↪
    - **Avatars** `sub_ai_avatars` → `staff/ai-staff` I ↪
    - **Training Center** `sub_ai_training` → `staff/ai-staff/training` I ↪
    - **Memory Viewer** `sub_ai_memory` → `staff/ai-staff/memory` I ↪
    - **Daily Training** `sub_ai_daily_training` → `staff/ai-staff/daily-training` I ↪
  - **Org Chart** `sub_staff_org` → `staff/org-chart` I ↪
    - **Org Chart** `sub_org_chart` → `staff/org-chart` I ↪
    - **Departments** `sub_org_departments` → `staff/org-chart/departments` I ↪
    - **Teams** `sub_org_teams` → `staff/org-chart/teams` I ↪
    - **Directory** `sub_org_directory` → `staff/org-chart/directory` I ↪
    - **Analytics** `sub_org_analytics` → `staff/org-chart/analytics` I ↪
    - **Settings** `sub_org_settings` → `staff/org-chart/settings` I ↪
  - **HRMS** `sub_staff_hrms` → `staff/hrms` I ↪
    - **Dashboard** `sub_hrm_dashboard` → `staff/hrms` I ↪
    - **People Directory** `sub_hrm_people` → `staff/hrms/people` I ↪
    - **Attendance** `sub_hrm_attendance` → `staff/hrms/attendance` I ↪
    - **Leave** `sub_hrm_leave` → `staff/hrms/leave` I ↪
    - **Payroll** `sub_hrm_payroll` → `staff/hrms/payroll` I ↪
    - **Shifts** `sub_hrm_shifts` → `staff/hrms/shifts` I ↪
    - **Documents** `sub_hrm_documents` → `staff/hrms/documents` I ↪
    - **Inventory** `sub_hrm_inventory` → `staff/hrms/inventory` I ↪
    - **Productivity** `sub_hrm_productivity` → `staff/hrms/productivity` I ↪
- **Settings** `sub_settings` → `settings` L
  - **Staff** `sub_set_staff` → `settings/staff` S
  - **Tags** `sub_set_tags` → `settings/tags` S
  - **Values** `sub_set_values` → `settings/values` S
    - **Values** `sub_values_main` → `settings/values` I
    - **Smart Values** `sub_values_smart` → `settings/values/smart` I
  - **Custom Fields** `sub_set_fields` → `settings/fields` S
    - **Standard** `sub_fields_standard` → `settings/fields` I
    - **Additional** `sub_fields_additional` → `settings/fields/additional` I
    - **Folders** `sub_fields_folders` → `settings/fields/folders` I
  - **Vault** `sub_set_vault` → `settings/vault` S
  - **App Store** `sub_set_app_store` → `settings/app-store` S
    - **Canva** `sub_app_canva` → `settings/canva` I
    - **Zoom** `sub_app_zoom` → `settings/zoom` I
    - **Inbox Triggers** `sub_app_inbox_triggers` → `settings/inbox-triggers` I ⚠
  - **Domains** `sub_set_domains_hub` → `settings/domains` S
  - **Smart Links** `sub_set_smart_links` → `settings/smart-links` S
  - **AI Settings** `sub_set_ai_assistant` → `settings/ai-assistant` S
  - **Analytics** `sub_set_analytics` → `settings/analytics` S
    - **Overview** `sub_analytics_overview` → `settings/analytics` I
    - **Email** `sub_analytics_email` → `settings/analytics/email` I
    - **Calls** `sub_analytics_calls` → `settings/analytics/calls` I
    - **Instagram** `sub_analytics_instagram` → `settings/analytics/instagram` I
    - **Courses** `sub_analytics_courses` → `settings/analytics/courses` I
    - **Events** `sub_analytics_events` → `settings/analytics/events` I
    - **Tracking** `sub_analytics_tracking` → `settings/analytics/tracking` I
    - **Zoom** `sub_analytics_zoom` → `settings/analytics/zoom` I
  - **Recover** `sub_set_recover` → `settings/recover` S
  - **Referral Program** `sub_set_referral` → `settings/referral` S
    - **Dashboard** `sub_referral_dash` → `settings/referral/dashboard` I
    - **Affiliates** `sub_referral_affiliates` → `settings/referral/affiliates` I
    - **Leaderboard** `sub_referral_leaderboard` → `settings/referral/leaderboard` I
  - **Notifications** `sub_set_notifications` → `settings/notifications` S
  - **Mobile Nav** `sub_set_mobile_nav` → `settings/mobile-nav` S
  - **API Settings** `sub_set_api` → `settings/api-settings` S ⚠
- **Cross-Module Analytics** `sub_cross_analytics` → `analytics` T
- **Telephony** `sub_telephony` → `telephony` T
- **Help Center** `sub_help` → `help` T
- **Healthcare** `sub_healthcare` → `healthcare` S ⚠
  - **Intake Config** `sub_hc_intake` → `healthcare/intake-config` I
  - **Patient Queue** `sub_hc_queue` → `healthcare/patient-queue` I
  - **Analytics** `sub_hc_analytics` → `healthcare/analytics` I

## Appendix C: Chart catalogue (sub-account tier)

Every Recharts chart reachable from a sub-account route, as declared in code. **X** is the category/time-axis `dataKey`; **Series** lists `mark:dataKey"legend"`; `[stack]` = stacked. Charts inside a child component name that component. A component mounted on several routes is listed once, under the first route.

| Route | Component | Chart | X | Series |
|---|---|---|---|---|
| `/lead-automation/workflows/chatflows/:flowId/edit` | `ChatFlowBuilder` | BarChart(horizontal) | label | bar:count |
| `/lead-automation/workflows/builder/:workflowId` | `WorkflowBuilderPage` | PieChart | — | pie:value |
| `/lead-automation/workflows/builder/:workflowId` | `WorkflowBuilderPage` | BarChart | date | bar:completed"Completed", bar:failed"Failed" |
| `/sales/webinars/:projectId` | `WebinarProjectDetailPage` | LineChart | minute | line:pct |
| `/sales/webinars/:projectId` | `WebinarProjectDetailPage` | BarChart | band | bar:people |
| `/sales/webinars/:projectId` | `WebinarProjectDetailPage` | LineChart | date | line:count |
| `/sales/webinars/:projectId` | `WebinarProjectDetailPage` | BarChart | date | bar:rate |
| `/sales/webinars/:projectId` | `WebinarProjectDetailPage` | BarChart | bucket | bar:count |
| `/sales/voice-agent/analytics` | `VoiceAnalyticsPage` | BarChart | label | bar:calls"Calls" |
| `/sales/voice-agent/analytics` | `VoiceAnalyticsPage` | PieChart | — | pie:value |
| `/sales/voice-agent/analytics` | `VoiceAnalyticsPage` | BarChart(horizontal) | name | bar:value"Calls" |
| `/sales/affiliate` | `AffiliateEngineDashboard` | LineChart | month | line:revenue"Revenue", line:commission"Commission" |
| `/sales/affiliate` | `AffiliateEngineDashboard` | BarChart(horizontal) | name | bar:revenue"Revenue" |
| `/sales/affiliate` | `AffiliateEngineDashboard` | BarChart | stage | bar:value |
| `/sales/affiliate` | `AffiliateEngineDashboard` | PieChart | — | pie:value |
| `/sales/performance (index)` | `PerformanceOverview` | LineChart | date | line:contacted"Contacted", line:followups"Follow-ups", line:calls"Calls", line:meetings"Meetings" |
| `/sales/performance (index)` | `PerformanceOverview` | PieChart | — | pie:value |
| `/sales/voice-ai (index)` | `VoiceAIDashboard` | LineChart | date | line:calls"Calls", line:connected"Connected", line:conversions"Conversions" |
| `/lead-generation/chat-widget` | `ChatWidgetPage` | AreaChart | date | area:visitors"Visitors", area:optins"Opt-ins" |
| `/lead-generation/chat-widget` | `ChatWidgetPage` | BarChart | date | bar:conversations"Conversations", bar:messages"Messages" |
| `/lead-generation/surveys/builder/:surveyId` | `SurveyAnalytics` | BarChart | label | bar:count |
| `/lead-generation/surveys/builder/:surveyId` | `SurveyAnalytics` | LineChart | date | line:views, line:starts |
| `/lead-generation/surveys/builder/:surveyId` | `SurveyAnalytics` | BarChart | date | bar:completions |
| `/lead-generation/surveys/builder/:surveyId` | `SurveyAnalytics` | BarChart | metric | bar:Original, bar:Variant |
| `/lead-generation/ads-social (index)` | `AdLauncherDashboard` | AreaChart | label | area:pct |
| `/lead-generation/ads-social (index)` | `AdLauncherDashboard` | LineChart | w | line:ctr |
| `/lead-generation/ads-social (index)` | `AdLauncherDashboard` | ComposedChart | date | area:spend"Spend", line:leads"Leads" |
| `/lead-generation/ads-social (index)` | `AdLauncherDashboard` | BarChart(horizontal) | platform | bar:spend |
| `/lead-generation/ads-social (index)` | `AdLauncherDashboard` | PieChart | — | pie:value |
| `/lead-generation/ads-social (index)` | `AdLauncherDashboard` | AreaChart | date | area:spend"Spend" |
| `/lead-generation/ads-social (index)` | `AdLauncherDashboard` | AreaChart | date | area:balance"Balance", area:spent"Cumulative Spend" |
| `/lead-generation/ads-social (index)` | `AdLauncherDashboard` | BarChart(horizontal) | displayName | bar:spend"Spend", bar:leads"Leads" |
| `/lead-generation/ads-social (index)` | `AdLauncherDashboard` | BarChart(horizontal) | name | bar:roas |
| `/lead-generation/ads-social (index)` | `AdLauncherDashboard` | AreaChart | day | area:revenue |
| `/lead-generation/ads-social/campaign/:campaignId` | `CampaignDrilldown` | BarChart(horizontal) | name | bar:spend"Spend", bar:leads"Leads" |
| `/lead-generation/ads-social/campaign/:campaignId` | `CampaignDrilldown` | BarChart(horizontal) | name | bar:ctr"CTR" |
| `/lead-generation/ads-social/campaign/:campaignId` | `CampaignDrilldown` | AreaChart | date | area:spendHigh, area:spendLow, area:spend |
| `/lead-generation/ads-social/campaign/:campaignId` | `CampaignDrilldown` | AreaChart | date | area:spend"Spend" |
| `/lead-generation/ads-social/campaign/:campaignId` | `CampaignDrilldown` | BarChart | date | bar:clicks"Clicks", bar:leads"Leads" |
| `/lead-generation/ads-social/campaign/:campaignId` | `CampaignDrilldown` | LineChart | date | line:ctr"CTR" |
| `/lead-generation/ads-social/campaign/:campaignId` | `CampaignDrilldown` | PieChart | — | pie:value |
| `/lead-generation/ai-social (index)` | `AISocialPage` | BarChart | platform | bar:Impressions, bar:Engagement, bar:Clicks |
| `/lead-generation/ai-social (index)` | `AISocialPage` | LineChart | date | line:? |
| `/lead-generation/ai-social (index)` | `AISocialAnalytics` | AreaChart | date | area:totalInteractions"Interactions", area:reach"Reach" |
| `/lead-generation/ai-social (index)` | `AISocialAnalytics` | AreaChart | date | area:reach"Reach", area:views"Views" |
| `/lead-management/crm/forecasting` | `ForecastingPage` | BarChart | period | bar:value |
| `/lead-management/crm/forecasting` | `ForecastingPage` | PieChart | — | pie:value |
| `/lead-management/crm/forecasting` | `ForecastingPage` | LineChart | month | line:revenue"Revenue", bar:deals"Deals Won" |
| `/lead-management/crm/forecasting` | `ForecastingPage` | BarChart | label | bar:actual"Actual + Forecast", bar:target"Target" |
| `/lead-management/crm/lead-sources` | `LeadSourceDashboard` | PieChart | — | pie:value |
| `/lead-management/contacts/stats` | `ContactStatsPage` | ComposedChart | label | bar:count"New", line:previous"Previous" |
| `/lead-management/contacts/stats` | `ContactStatsPage` | AreaChart | label | area:count"New", area:previous"Previous" |
| `/lead-management/contacts/stats` | `ContactStatsPage` | LineChart | label | line:count"New", line:cumulative"Cumulative", line:previous"Previous" |
| `/lead-management/contacts/stats` | `ContactStatsPage` | PieChart | — | pie:count |
| `/lead-management/contacts/stats` | `ContactStatsPage` | BarChart(horizontal) | label | bar:count |
| `/lead-management/contacts/stats` | `DayHourHeatmap` | AreaChart | — | area:y |
| `/lead-management/contacts/stats` | `DayHourHeatmap` | LineChart | — | line:y |
| `/lead-management/contacts/:contactId` | `ContactProfilePage` | AreaChart | date | area:value, area:secondary |
| `/lead-management/contacts/:contactId` | `ContactProfilePage` | LineChart | date | line:score |
| `/lead-management/contact-group` | `GroupJoinTrendChart` | BarChart | date | bar:count |
| `/lead-management/agentic-ai` | `ACPCostManagement` | AreaChart | date | area:successes[stack], area:failures[stack] |
| `/lead-management/agentic-ai` | `ACPCostManagement` | BarChart(horizontal) | name | bar:rate |
| `/lead-management/agentic-ai` | `ACPCostManagement` | AreaChart | date | area:cost |
| `/lead-management/agentic-ai` | `ACPCostManagement` | PieChart | — | pie:value |
| `/lead-management/agentic-ai` | `ACPCostManagement` | BarChart(horizontal) | name | bar:input"Input"[stack], bar:output"Output"[stack] |
| `/lead-automation/email` | `EmailMarketingPage` | AreaChart | date | area:sent"Sent", area:opened"Opened", area:clicked"Clicked" |
| `/lead-automation/email` | `EmailMarketingPage` | AreaChart | date | area:opens"Opens", area:clicks"Clicks" |
| `/lead-automation/email` | `EmailMarketingPage` | BarChart(horizontal) | name | bar:value |
| `/lead-automation/email` | `EmailMarketingPage` | PieChart | — | pie:value |
| `/lead-automation/email` | `EmailMarketingPage` | BarChart(horizontal) | name | bar:openRate"Open %", bar:clickRate"Click %" |
| `/lead-automation/bulk-campaigns` | `BulkCampaignDashboard` | AreaChart | hour | area:delivered"Delivered"[stack], area:sent"Sent"[stack], area:failed"Failed"[stack] |
| `/lead-automation/bulk-campaigns` | `BulkCampaignDashboard` | BarChart | channel | bar:Delivered, bar:Read, bar:Failed |
| `/lead-automation/bulk-campaigns` | `BulkCampaignDashboard` | PieChart | — | pie:value |
| `/lead-automation/whatsapp` | `WAHAProfile` | ComposedChart | label | bar:joins"Joins"[stack], bar:leaves"Leaves"[stack], line:net"Net" |
| `/lead-automation/whatsapp` | `WAHAProfile` | AreaChart | label | area:joins"Joins", area:leaves"Leaves", area:net"Net" |
| `/lead-automation/whatsapp` | `WAHAProfile` | LineChart | label | line:joins"Joins", line:leaves"Leaves", line:net"Net" |
| `/lead-automation/whatsapp` | `WAHAProfile` | PieChart | — | pie:count |
| `/lead-automation/whatsapp` | `WAHAProfile` | BarChart(horizontal) | label | bar:count |
| `/lead-automation/waba` | `WABADashboard` | AreaChart | date | area:sent"Sent", area:delivered"Delivered" |
| `/lead-automation/waba` | `WABADashboard` | AreaChart | date | area:sent"Sent"[stack], area:delivered"Delivered"[stack], area:read"Read"[stack], area:failed"Failed"[stack] |
| `/lead-automation/waba` | `WABADashboard` | BarChart | name | bar:value"Spend (${})" |
| `/lead-automation/workflows (index)` | `WorkflowsLanding` | AreaChart | date | area:completed"Completed", area:failed"Failed" |
| `/ai-suite (index)` | `TokenUsageChart` | BarChart | day | bar:$a |
| `/ai-suite (index)` | `AvgTokensChart` | BarChart(horizontal) | agent | bar:tokens |
| `/ai-suite (index)` | `AvgResponseChart` | BarChart(horizontal) | agent | bar:time |
| `/ai-suite/business-brain/analytics` | `BrainAnalyticsPage` | AreaChart | date | area:queries"Queries", area:confidence"Avg Confidence %" |
| `/ai-suite/business-brain/analytics` | `BrainAnalyticsPage` | PieChart | — | pie:value |
| `/ai-suite/business-brain/analytics` | `BrainAnalyticsPage` | BarChart(horizontal) | name | bar:value |
| `/operations/school/*` | `AdminDashboard` | AreaChart | month | area:institutions, area:users |
| `/operations/school/*` | `AdminDashboard` | PieChart | — | pie:value |
| `/operations/school/*` | `AdminDashboard` | BarChart(horizontal) | name | bar:value |
| `/operations/school/*` | `FranchiseCommandCenter` | BarChart | name | bar:value |
| `/operations/school/*` | `FranchiseCommandCenter` | PieChart | — | pie:value |
| `/operations/school/*` | `AccountabilityPage` | RadarChart | — | radar:value"Score" |
| `/operations/school/*` | `AnalyticsPage` | BarChart | snapshot_date | bar:metric_value |
| `/operations/school/*` | `InstitutionDashboard` | PieChart | — | pie:value |
| `/operations/school/*` | `InstitutionDashboard` | LineChart | date | line:rate |
| `/operations/school/*` | `InstitutionDashboard` | BarChart(horizontal) | className | bar:rate |
| `/operations/school/*` | `FeeCollectionDashboard` | BarChart | name | bar:paid"Paid", bar:pending"Pending", bar:overdue"Overdue" |
| `/operations/school/*` | `FinanceDashboard` | BarChart | month | bar:income"Income", bar:expense"Expense" |
| `/operations/school/*` | `AssessmentAnalytics` | BarChart | name | bar:avgPct"Avg %", bar:passRate"Pass %" |
| `/operations/school/*` | `AssessmentAnalytics` | PieChart | — | pie:value |
| `/operations/school/*` | `AssessmentAnalytics` | BarChart(horizontal) | name | bar:avgPct"Avg %" |
| `/operations/school/*` | `HomeworkAnalytics` | PieChart | — | pie:value |
| `/operations/school/*` | `HomeworkAnalytics` | BarChart(horizontal) | name | bar:rate |
| `/operations/school/*` | `HomeworkAnalytics` | BarChart | name | bar:assigned"Assigned", bar:submitted"Submitted" |
| `/operations/school/*` | `HomeworkAnalytics` | LineChart | day | line:assigned"Assigned", line:submitted"Submitted" |
| `/operations/school/*` | `MultiTermAnalytics` | LineChart | term | line:avgScore"Avg Score %", line:passRate"Pass Rate %" |
| `/operations/school/*` | `MultiTermAnalytics` | BarChart | type | bar:avgScore"Avg Score %" |
| `/inbox (index)` | `InboxDashboardTab` | ComposedChart | label | area:created"Created", bar:closed"Closed" |
| `/inbox (index)` | `InboxDashboardTab` | PieChart | — | pie:value |
| `/inbox (index)` | `InboxDashboardTab` | BarChart | hour | bar:count |
| `/calendar/reports` | `CalendarReportsPage` | BarChart | date | bar:bookings |
| `/calendar/reports` | `CalendarReportsPage` | BarChart | date | bar:revenue |
| `/calendar/reports` | `CalendarReportsPage` | PieChart | — | pie:value |
| `/finance (index)` | `PlanChangeRequests` | PieChart | — | pie:value |
| `/finance (index)` | `PlanChangeRequests` | AreaChart | month | area:mrr |
| `/finance (index)` | `PlanChangeRequests` | BarChart | plan | bar:count |
| `/finance (index)` | `SubAccountHealthDashboard` | BarChart | planName | bar:mrr"MRR", bar:arr"ARR" |
| `/finance (index)` | `SubAccountHealthDashboard` | AreaChart | month | area:mrr |
| `/finance (index)` | `SubAccountHealthDashboard` | PieChart | — | pie:value |
| `/finance (index)` | `AgencyFinanceDashboard` | AreaChart | label | area:totalRevenue, line:netRevenue |
| `/finance (index)` | `AgencyFinanceDashboard` | PieChart | — | pie:value |
| `/finance (index)` | `FinanceDashboard` | BarChart | month | bar:newMrr"New MRR"[stack], bar:expansionMrr"Expansion"[stack], bar:churnedMrr"Churned"[stack] |
| `/finance (index)` | `FinanceDashboard` | BarChart | name | bar:value |
| `/finance (index)` | `FinanceDashboard` | PieChart | — | pie:value |
| `/finance (index)` | `FinanceDashboard` | AreaChart | label | area:invoiced"Invoiced", area:paid"Collected" |
| `/finance (index)` | `FinanceDashboard` | BarChart(horizontal) | product_name | bar:revenue"Revenue" |
| `/finance/plan/subscription` | `Subscription` | LineChart | label | line:mrr |
| `/finance/plan/subscription` | `ProductAnalyticsDashboard` | AreaChart | day | area:revenue |
| `/finance/reports` | `ReportsLanding` | AreaChart | date | area:revenue"Revenue", area:net"Net" |
| `/finance/reports` | `ReportsLanding` | BarChart | name | bar:mrr"MRR" |
| `/finance/reports` | `ReportsLanding` | BarChart | name | bar:revenue"Revenue", bar:refunds"Refunds" |
| `/finance/reports` | `ReportsLanding` | AreaChart | month | area:predicted"Predicted MRR", area:churn_adjusted"Churn-Adjusted" |
| `/finance/settings` | `SettingsLanding` | LineChart | time | line:$o |
| `/finance/settings` | `SettingsLanding` | BarChart(horizontal) | reason | bar:count |
| `/finance/analytics` | `AgencyRevenueAnalyticsPage` | PieChart | — | pie:mrr |
| `/finance/analytics` | `AgencyRevenueAnalyticsPage` | AreaChart | month | area:cumulativeMRR"Est. MRR", area:newSubAccounts"New Sub-accounts" |
| `/finance/analytics` | `FinanceAnalytics` | PieChart | — | pie:value |
| `/finance/analytics` | `FinanceAnalytics` | BarChart | bucket | bar:amount |
| `/finance/analytics` | `FinanceAnalytics` | BarChart | name | bar:amount |
| `/finance/analytics` | `FinanceAnalytics` | BarChart(horizontal) | name | bar:count |
| `/finance/expense-analytics` | `ExpenseAnalyticsPage` | PieChart | — | pie:value |
| `/finance/expense-analytics` | `ExpenseAnalyticsPage` | BarChart(horizontal) | name | bar:value |
| `/finance/clv` | `CLVDashboard` | BarChart | label | bar:count |
| `/finance/clv` | `CLVDashboard` | ScatterChart | tenure | scatter:? |
| `/finance/tax-summary` | `TaxSummaryPage` | BarChart | label | bar:tax"Tax", bar:revenue"Revenue" |
| `/finance/aged-receivables` | `AgedReceivablesPage` | BarChart | name | bar:amount |
| `/community/preview` | `CommunityPreview` | AreaChart | date | area:enrollments |
| `/community/preview` | `CommunityPreview` | BarChart | name | bar:students |
| `/community/preview` | `CommunityPreview` | BarChart(horizontal) | name | bar:students |
| `/settings/analytics/events` | `AnalyticsEvents` | BarChart | date | bar:pixel"Pixel", bar:capi"CAPI" |
| `/settings/analytics/events` | `AnalyticsEvents` | BarChart | date | bar:pixel"Browser Pixel", bar:capi"Server CAPI" |
| `/settings/analytics/events` | `AnalyticsEvents` | AreaChart | date | area:matchPct"Match %" |
| `/settings/analytics/events` | `AnalyticsEvents` | PieChart | — | pie:value |
| `/settings/analytics/events` | `AnalyticsEvents` | BarChart(horizontal) | campaign | bar:value"Attributed Value" |
| `/settings/analytics/zoom` | `ZoomAnalytics` | BarChart | name | bar:value"Attendees" |
| `/settings/analytics/zoom` | `ZoomAnalytics` | PieChart | — | pie:value |
| `/settings/analytics/revenue` | `AnalyticsRevenue` | AreaChart | label | area:totalRevenue"Revenue", area:netRevenue"Net" |
| `/settings/analytics/digital-human` | `AnalyticsDigitalHuman` | LineChart | date | line:conversations |
| `/settings/analytics/digital-human` | `AnalyticsDigitalHuman` | BarChart | name | bar:value |
| `/settings/analytics/digital-human` | `AnalyticsDigitalHuman` | PieChart | — | pie:value |
| `/settings/analytics/digital-human` | `AnalyticsDigitalHuman` | BarChart | variant | bar:shown"Shown", bar:engaged"Engaged" |
| `/settings/zoom` | `ZoomAnalyticsDashboard` | PieChart | — | pie:value |
| `/settings/ai-assistant` | `NovaAnalyticsTab` | AreaChart | date | area:conversations, area:messages |
| `/settings/ai-assistant` | `NovaAnalyticsTab` | BarChart | date | bar:input, bar:output |
| `/settings/ai-assistant` | `NovaAnalyticsTab` | PieChart | — | pie:value |
| `/settings/ai-assistant` | `NovaFeedbackTab` | BarChart(horizontal) | name | bar:count |
| `/analytics` | `CrossModuleAnalytics` | BarChart | name | bar:value |
| `/analytics` | `CrossModuleAnalytics` | PieChart | — | pie:value |
| `/canva-hub` | `CanvaAnalyticsDashboard` | BarChart | date | bar:imports[stack], bar:exports[stack], bar:edits[stack], bar:clones[stack] |
| `/canva-hub` | `CanvaAnalyticsDashboard` | PieChart | — | pie:value |
| `/help/lead-management` | `StatsSection` | LineChart | — | line:y |
| `/help/lead-management` | `StatsSection` | ComposedChart | label | bar:count"New", line:previous"Previous" |
| `/help/lead-management` | `StatsSection` | AreaChart | label | area:count"New", area:previous"Previous" |
| `/help/lead-management` | `StatsSection` | LineChart | label | line:count"New", line:cumulative"Cumulative", line:previous"Previous" |
| `/help/lead-management` | `StatsSection` | PieChart | — | pie:count |
| `/help/lead-management` | `StatsSection` | BarChart(horizontal) | label | bar:count |
| `/healthcare/analytics` | `HealthcareDashboardPage` | BarChart | date | bar:count"Consultations" |
| `/healthcare/analytics` | `HealthcareDashboardPage` | PieChart | — | pie:value |

## Appendix D: Finance data surface

Every `finance_*` (and finance-adjacent) table the sub-account tier touches from the browser, the client operations seen, and the screens that issue them. Reads are `select`/`count`; `insert`/`update`/`upsert`/`delete` are **client-side writes** straight to PostgREST, so their safety rests entirely on the backend RLS, which this analysis cannot see.

| Table | Client ops | Screens |
|---|---|---|
| `aff_affiliates` | select, update, count, insert | `SubaccountAffiliateDashboard`, `InvoiceTable`, `PartnerProgramDashboard` |
| `aff_attributions` | delete | `SubaccountAffiliateDashboard` |
| `aff_audit_logs` | insert, select | `SubaccountAffiliateDashboard` |
| `aff_clicks` | delete, count | `SubaccountAffiliateDashboard` |
| `aff_commissions` | delete, select, update | `SubaccountAffiliateDashboard` |
| `aff_conversions` | delete, select | `SubaccountAffiliateDashboard` |
| `aff_coupon_mappings` | delete | `SubaccountAffiliateDashboard` |
| `aff_fraud_rules` | delete, select, update, insert | `SubaccountAffiliateDashboard` |
| `aff_payout_batches` | select, update, insert | `SubaccountAffiliateDashboard` |
| `aff_payout_profiles` | delete, select, insert | `SubaccountAffiliateDashboard`, `InvoiceTable`, `PartnerProgramDashboard` |
| `aff_program_calendars` | select | `ListEventsPage` |
| `aff_program_forms` | select | `AllForms` |
| `aff_program_products` | delete, insert | `SubaccountAffiliateDashboard` |
| `aff_programs` | select, insert, update, delete | `SubaccountAffiliateDashboard`, `PartnerProgramDashboard` |
| `aff_webhook_endpoints` | select, insert | `SubaccountAffiliateDashboard` |
| `affiliate_commission_transfers` | select | `InvoiceTable` |
| `credit_ledger` | select | `SalesSubscription` |
| `customer_subscriptions` | select, update | `AgencyFinanceDashboard`, `FinanceDashboard`, `SalesSubscription`, `RecurringInvoices`, `AnalyticsOverview`, `AnalyticsRevenue` |
| `finance_affiliate_commissions` | select | `AgencyFinanceDashboard`, `AnalyticsOverview`, `AnalyticsRevenue` |
| `finance_approval_items` | select, update | `ApprovalWorkflows`, `SettingsLanding` |
| `finance_approval_stages` | delete, insert | `ApprovalWorkflows`, `SettingsLanding` |
| `finance_approval_workflows` | select, update, insert, delete | `ApprovalWorkflows`, `SettingsLanding` |
| `finance_audit_logs` | insert | `SalesSubscription`, `InvoiceTable` |
| `finance_business_profiles` | select, update | `ShopDashboard`, `ShopOrders`, `ShopSettings`, `WABADashboard`, `AICouncil`, `SchoolV2Routes` +2 more |
| `finance_capi_settings` | select, upsert | `ContactProfilePage`, `QuotesLanding`, `Documents`, `AnalyticsTracking` |
| `finance_credit_notes` | insert, select | `InvoiceTable`, `CreditNotesPage` |
| `finance_customer_ltv` | select | `ReportsLanding` |
| `finance_customers` | select, update | `FinanceImportPage`, `SettingsLanding` |
| `finance_daily_revenue` | select | `ReportsLanding`, `DisputesPage` |
| `finance_disputes` | select, insert, update | `ReportsLanding`, `DisputesPage` |
| `finance_document_items` | insert, select | `InvoiceTable`, `QuotesLanding`, `Documents` |
| `finance_document_lines` | select | `TaxSummaryPage`, `AnalyticsTaxSummary` |
| `finance_document_message_logs` | select | `DocumentDetail` |
| `finance_document_settings` | select, upsert | `InvoiceTable`, `QuotesLanding`, `CreateDocument`, `SettingsLanding` |
| `finance_document_templates` | update, select, insert, delete | `ProposalBuilderPage`, `QuotesLanding`, `DocumentTemplates` |
| `finance_documents` | select, insert, update | `Opportunity`, `ContactProfilePage`, `LeadDashboardPage`, `SchoolV2Routes`, `InboxLanding`, `AgencyFinanceDashboard` +14 more |
| `finance_events` | select | `SalesSubscription` |
| `finance_expense_categories` | select | `ImportExpenses` |
| `finance_expenses` | insert, update, select | `ImportFinanceCSV`, `ExpenseDetail`, `ExpenseAnalyticsPage`, `ProfitLossPage`, `BalanceSheetPage`, `AnalyticsOverview` +1 more |
| `finance_gateway_health` | select | `SettingsLanding` |
| `finance_import_resolutions` | upsert | `FinanceImportPage`, `RecurringInvoices`, `SettingsLanding` |
| `finance_import_sessions` | insert, select | `FinanceImportPage`, `RecurringInvoices`, `SettingsLanding` |
| `finance_import_staging` | select | `FinanceImportPage`, `RecurringInvoices`, `SettingsLanding` |
| `finance_installment_plans` | select, update | `FinanceDashboard`, `SalesSubscription` |
| `finance_installments` | update, delete, insert, select | `SalesSubscription`, `ReportsLanding` |
| `finance_invoice_items` | select | `ReportsLanding` |
| `finance_invoices` | select, upsert, update | `SubAccountBillingPage`, `ContactProfilePage`, `LeadDashboardPage`, `SchoolV2Routes`, `AgencyFinanceDashboard`, `FinanceDashboard` +11 more |
| `finance_migration_logs` | select | `FinanceMigrationPage` |
| `finance_migration_sessions` | insert, select | `FinanceMigrationPage` |
| `finance_number_counters` | select | `InvoiceSetup`, `SettingsLanding` |
| `finance_payment_links` | select, insert | `ProposalBuilderPage`, `SchoolV2Routes` |
| `finance_product_audit_log` | select | `Subscription` |
| `finance_product_dependencies` | select, insert, delete | `Subscription` |
| `finance_product_entitlements` | select | `Subscription` |
| `finance_product_folders` | select, insert, delete, update | `Subscription` |
| `finance_product_groups` | select, delete, insert | `Subscription` |
| `finance_product_templates` | select | `Subscription` |
| `finance_product_upgrade_paths` | select, insert, delete | `Subscription` |
| `finance_products` | select, insert, update, delete | `mermaid-GHXKKRXX`, `WorkflowBuilderPage`, `ShopProducts`, `ShopFinanceSync`, `Pipeline`, `SchoolV2Routes` +2 more |
| `finance_qr_settings` | select, update, insert | `SettingsLanding`, `QRCodeSettings` |
| `finance_reconciliation_issues` | select | `FinanceDashboard` |
| `finance_reconciliation_matches` | select, update | `Settlements` |
| `finance_recurring_expenses` | update, delete | `RecurringExpensesPage` |
| `finance_recurring_schedules` | select, update, insert, delete | `RecurringInvoices`, `FinanceAnalytics`, `AnalyticsFinance` |
| `finance_refunds` | select | `AgencyFinanceDashboard`, `FinanceDashboard`, `SalesSubscription`, `ReportsLanding`, `DisputesPage`, `AnalyticsOverview` +1 more |
| `finance_reminder_rules` | select, update, insert, delete | `ReminderRules`, `SettingsLanding` |
| `finance_retry_policies` | select, update, insert, delete | `SettingsLanding` |
| `finance_revenue_schedule` | select | `ReportsLanding`, `DisputesPage` |
| `finance_routing_rules` | select, update, insert, delete | `SettingsLanding` |
| `finance_settlements` | select, insert, update | `Settlements`, `FinanceAnalytics`, `AnalyticsFinance` |
| `finance_subscriptions` | select, count, update | `AgencyFinanceDashboard`, `FinanceDashboard`, `Subscription`, `SalesSubscription`, `OrderDetail`, `InvoiceTable` +4 more |
| `finance_tax_slabs` | select | `ShopProducts`, `ShopProductWizard`, `ShopFinanceSync` |
| `finance_transactions` | select, insert, update | `Dashboard`, `SubAccountBillingPage`, `Opportunity`, `ContactProfilePage`, `SchoolV2Routes`, `InboxLanding` +14 more |
| `finance_usage_alert_rules` | select, insert, update, delete | `Subscription` |
| `finance_vendors` | update, select | `VendorDetail`, `ImportExpenses` |
| `payment_gateway_connections` | select, update, upsert, delete | `RecurringInvoices`, `SettingsLanding`, `AppStore`, `ZoomSettings` |
| `subscription_products` | select | `Subscription` |
| `v_agency_consolidated_pl` | select | `ReportsLanding`, `DisputesPage` |
| `v_sa_all_subscriptions` | select | `SubAccountBillingPage`, `ReportsLanding` |

## Appendix E: Finance RPCs and edge functions

These are names and parameters as called from the browser. Their implementations are server-side and
were **not** visible. The purpose column is [I] unless marked otherwise.

**RPCs (Postgres functions)**

| RPC | Parameters | Purpose |
|---|---|---|
| `generate_document_number` | `_tenant_id, _doc_type` | Next number in the type's series [C: used on create] |
| `roll_fiscal_year` | `_tenant_scope, _tenant_id, _next_period_key` | "Start New Financial Year" [C] |
| `transition_invoice_status` | `p_invoice_id, p_new_status, p_reason` | Server-validated invoice status change |
| `transition_subscription_status` | `p_subscription_id, p_new_status, p_actor_user_id` | Server-validated subscription status change |
| `soft_delete_invoice` | `_invoice_id` | Soft delete (restorable from "Restore Deleted Items") |
| `rpc_delete_subscription_cascade` | `p_subscription_id` | Delete a subscription and its dependants |
| `sub_account_plan_usage` | `_sub_account_id` | Usage against plan limits (My Plan) |
| `resolve_platform_plan_agency_for_subscription` | `_agency_id, _gateway_customer_id, _product_id` | Map a gateway subscription to an agency plan |
| `assign_next_agency_seq`, `reset_agency_seqs`, `preview_su_backfill`, `apply_su_backfill` | various | Sequence and backfill maintenance (super-admin tooling) |
| `bulk_soft_delete_contacts` | `p_sub_account_id, p_contact_ids, p_deleted_by, p_source, p_metadata, p_emit_workflow_events` | Contact deletion from the finance customer pickers |
| `admin_set_rate_limit_override` | entity, action, max, window, reason, expiry | Super-admin rate limits |

**Edge functions**

| Group | Functions |
|---|---|
| Dashboard | `dashboard-stats` (sub-account Overview), `analytics-track` |
| Payments | `payment-orchestrator`, `payment-gateway-config`, `razorpay-oauth`, `razorpay-api-payments`, `cashfree-payments`, `instamojo-payments`, `myfatoorah-payments`, `paymentz-test-connection`, `paystack-webhooks`, `unified-webhook?gateway=stripe`, `refund-engine`, `product-deposit`, `platform-plan-deposit` |
| Documents | `send-invoice-email`, `finance-capi-purchase` (Meta CAPI Purchase), `follow-up-ai` |
| Import / migration | `finance-import-stage`, `finance-import-match`, `finance-import-commit`, `crm-contact-match`, `ai-import-analyze`, `expense-import-enrich`, `subscription-import-ai`, `finance-migration`, `update-fx-rates` |
| Plans and billing | `subaccount-billing-upgrade`, `subaccount-billing-downgrade`, `superadmin-plan-provision`, `plan-provisioning`, `ai-plan-builder`, `ai-product-builder` |
| Affiliates | `marketplace-affiliate-transfer` (Razorpay Route transfer of affiliate commission on an invoice) |

---

## Appendix F: Reproducing this analysis

This run's scratch tooling lived in the session scratchpad and was **not** committed. The method is
simple enough to rebuild:

1. `GET /` → read `<script src="/assets/index-*.js">`; `GET /sw.js` for the precache list. Then
   crawl `/assets/*.js` breadth-first by regex on `name-<8-char-hash>.js`. That gave 2,166 files and
   49 MB for this build. **Only static asset `GET`s. Never call `/rest/v1`, `/auth/v1` or
   `/functions/v1`.**
2. Parse each chunk with `@babel/parser` (already in `platform/node_modules/.pnpm`). A route is any
   `jsx(Ident, {path|index, element|children})` call. Resolve `element` idents through
   `const X = lazy(() => import("./Chunk-hash.js"))`. Resolve `children: helperFn(tier)` by walking
   that function's body.
3. Map `vendor-charts` export aliases to real names through `chartName:"…"` / `displayName` strings,
   then collect `jsx(<chart alias>, {dataKey, name, stackId, layout…})`.
4. Per chunk: collect `.from("table")` chains (select strings, filters, write ops), `.rpc()`,
   `functions.invoke()` and `/functions/v1/…` literals, and `postgres_changes` subscriptions.
5. Read the logic of the chunks that matter with `@babel/generator` pretty-printing.

The analysis is valid for the build it ran against. Re-run it before relying on it after a
significant change on their side.
