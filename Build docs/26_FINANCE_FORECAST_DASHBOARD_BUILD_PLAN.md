# 26 — Finance, forecasting and dashboard: build plan (from the MyAppz teardown)

**Written 2026-09-21** on branch `crm-phases-on-origin` (latest migration `0123`). It turns the
observations in `25_MYAPPZ_CRM_TEARDOWN.md` into Aura features. It uses a same-day read of Aura's
code, so it extends what exists instead of rebuilding it.

**What this doc gives you:**

- the end-to-end user flows (§5);
- every screen and dialog (§7);
- the gaps and how each is filled (§12);
- the exact routes, navigation and transitions between screens (§8);
- the data model, API and delivery order behind them (§9–§13).

Nothing in it is built yet.

**Scope in one sentence.** Doc 25 describes a GoHighLevel-class suite of about 15 products. Its own
recommendation (§11) is to port three things: the **finance module**, **pipeline forecasting** and
the **customisable dashboard**. This plan does exactly that, and §1.2 lists what stays out.

**How to use this doc:**

- Work phase by phase, in the order given in §13. F0 fixes defects in today's invoicing. It comes
  first because every later phase builds on those tables, and several of the defects corrupt money
  figures.
- Each phase lists its migrations, routes, screens, tests and exit check.
- Line numbers were correct on 2026-09-21. Re-check them before editing.
- Nothing here is merged or deployed without an explicit yes, and every production migration needs a
  separate yes.

**What was read vs run.** Aura's current state comes from reading code: three read-only sweeps plus
spot checks of the two worst findings. Nothing was executed. The F0 defects are therefore code-read,
and each F0 item starts by reproducing its bug.

**Porting rule (unchanged).** Designs port, code never does. No MyAppz code is used anywhere.

---

## Contents

1. Scope
2. Decisions this plan assumes
3. Starting point: what Aura has today, and what is broken
4. Access model: modules, features, personas, permissions, gate order
5. User flows, end to end
6. Document state machines
7. Screen inventory and screen specs
8. Navigation and routing
9. Data model and the metric dictionary
10. API surface
11. Shared building blocks
12. Missing features and how they are filled
13. Delivery plan
14. Verification
15. Risks and traps
16. Open questions for you

---

## 1. Scope

### 1.1 In scope

| Phase | What | Source in doc 25 |
|---|---|---|
| **F0** | Fix the defects in today's invoicing (§3.2) | Aura-side findings, not in doc 25 |
| **F1** | **Receivables core:**<br>• issue/void lifecycle<br>• manual receipts, customer TDS, refunds<br>• credit notes<br>• financial-year numbering<br>• seller/buyer GST snapshots<br>• print view and public invoice link<br>• Finance overview and payments ledger<br>• billing settings | §9 rows 1–5, 15, 16 |
| **F2** | **Expenses and statements:**<br>• vendors, categories, expenses with GST/TDS<br>• P&L, GST, AR aging, outstanding and five more reports<br>• CSV export and print | §9 rows 5–7 |
| **F3** | **Pipeline forecasting:**<br>• stage and deal probability<br>• weighted pipeline and 30/60/90-day forecast<br>• win rate, cycle time, at-risk deals<br>• goals in the owner console<br>• auto-Won when the invoice is paid | §9 rows 17–18 |
| **F4** | **Collections and approvals:**<br>• reminder/dunning ladders that create work for a person<br>• approval policies on quotations, invoices, credit notes and expenses | §9 rows 10–11 |
| **F5** | **Recurring billing and instalments,** with MRR/ARR/churn. **Only if D6 says yes** | §9 rows 8–9 |
| **F6** | **Customisable dashboard:** a widget registry and a per-user layout | §9 rows 20–21 |
| **F7** | Optional follow-ons. Each one is its own decision (§13.8) | — |

### 1.2 Out of scope

- **The other MyAppz products.** These are site/funnel/form builders, ad launcher, AI social,
  reputation, shop, LMS/community, HRM/payroll/inventory, voice AI/IVR, webinars, affiliates,
  healthcare, the school vertical, and the agency and super-admin tiers. Doc 25 inventories them
  (Appendix A) and recommends none of them.
- **Finance items that doc 25 deferred:**
  - gateway routing, retry and health;
  - wallets;
  - commissions (Aura already has commission plans);
  - disputes and anomaly detection;
  - settlements and reconciliation;
  - revenue recognition;
  - sub-account migration;
  - a balance sheet, which needs a double-entry ledger (D5).
- **Lead-scoring rules engine** (§9 row 19). Aura already has a point ledger
  (`apps/worker/src/pipeline/lead-scoring.ts`, migration 0064) plus lead temperature (0083).
- **Contact-search transliteration** (§9 row 23). It is small and unrelated to the rest, so it goes
  to the CRM backlog.

### 1.3 Rules every phase keeps

Each rule is the inverse of a defect doc 25 §10 found in shipping MyAppz code.

1. **Money is written in one server transaction, behind the API.** The browser never writes money
   and never computes a stored figure. (§10.1)
2. **Gates are server-side and fail closed.** (§10.2)
3. **One table per concept:** one invoice table, one payments table, and one schedule table covering
   both recurring billing and instalments. (§10.3)
4. **Every figure is a SQL aggregation defined once** in the metric dictionary (§9.4), and never
   computed over a capped fetch. (§10.4, §10.6)
5. **No placeholder maths shown as real.** If there is not enough data, the screen says so.
   (§10.5)
6. **Nothing automated sends** (CRM rule 3). A schedule produces due work, and a person sends it.
   (§10.9)
7. **A human's edit outranks the machine** (CRM rule 2). A per-deal probability beats the stage
   default, and auto-Won never overrides a person's close.
8. **Nav comes from one registry,** and a test proves every nav target resolves to a page.
   (§10.10)

---

## 2. Decisions this plan assumes

These are defaults. Say which ones are wrong and the affected sections change. §16 lists the
questions behind them.

| # | Decision | Default used here | If you choose otherwise |
|---|---|---|---|
| D1 | What to build | Finance, forecasting and the dashboard only (§1) | Every other MyAppz product needs its own teardown-to-plan pass |
| D2 | Module split | **Invoicing correctness stays in `crm`:** every tenant that invoices gets correct invoices, credit notes and receipts. **Back office and analysis form a new `finance` module**, sellable separately. `finance` requires `crm` | Putting everything in `finance` would take working invoices away from current CRM tenants who don't buy it |
| D3 | Who does finance work | The **owner** and **manager** personas. No new persona in v1 (§4.5) | A `finance` persona is F7-1 |
| D4 | Invoice numbering | Assigned **when the invoice is issued**, not when the draft is created. One series per financial year, starting in April by default. Format `INV/2026-27/0001` (GST allows at most 16 characters). Existing numbers are untouched | Numbering at creation leaves gaps whenever a draft is deleted |
| D5 | Accounting depth | **No general ledger and no balance sheet.** P&L and GST are built from documents | A ledger is a separate, larger project (doc 25 §12 Q1) |
| D6 | Recurring billing | **F5 is not scheduled** until you confirm customers sell subscriptions or EMIs | F5 slots in after F4 |
| D7 | GST depth | Outward and inward registers, HSN summary, net liability, and CSV in GSTR-1 column order. **No GSTR-1 JSON and no e-invoice IRN in v1** | GSTR-1 JSON is F7-4; e-invoicing is F7-5 |
| D8 | PDFs | **Print routes plus `window.print()`** for v1, as the report builder does (design doc D1). A parallel session (2026-09-21) is adding **`pdfkit` plus bundled fonts to the API** for a Call Insights export. If that lands, F7-3 renders invoice PDFs with it instead of adding a dependency. That session has confirmed its bundled Noto Sans renders ₹ | Server PDFs matter only for email attachments (F7-3) |
| D9 | How customers receive invoices | A **public, tokenised invoice page on the public origin.** A person sends its link by email or WhatsApp. Today's composer cannot attach files | Without it, "send invoice" means a person printing a PDF and attaching it by hand |
| D10 | Auto-Won when an invoice is paid | Per pipeline and **off by default.** It never reopens a Lost deal and never moves a deal a person already closed | — |
| D11 | Top-level rail | Stays capped at 7 entries. Finance becomes a **section under More**, with a **Finance strip** across its pages and dashboard tiles that link in | Promoting Finance means demoting one of Home/Leads/Deals/Contacts/Tasks/Reports |
| D12 | URLs | `/owner/invoices`, `/owner/quotations` and `/owner/products` **keep their URLs.** New screens live under `/owner/finance/…` | Moving invoices needs redirect stubs (§8.7) |
| D13 | Invoice status values | The stored value `sent` keeps meaning "issued, awaiting payment". **`overdue` stops being stored** and is derived instead | Renaming `sent` to `issued` would also mean migrating the report templates stored in the database |
| D14 | Payment gateways | Razorpay and Stripe only. Stripe gets the settings UI it currently lacks | A third gateway brings doc 25 §5.11 routing back into play |
| D15 | Currency | Every money figure is **per currency** and nothing is converted. The base currency is set in the business profile (default INR) | FX conversion is F7-9 |

---

## 3. Starting point

### 3.1 What exists (read 2026-09-21)

| Area | State today | Where |
|---|---|---|
| **Products** | CRUD and a tax rate. **No HSN/SAC** | `0059`, `modules/products`, `/owner/products` |
| **Quotations** | Statuses draft/sent/accepted/rejected/expired, all freely settable. No HSN. The create dialog has **no account/contact/deal picker** | `0059`, `modules/quotations`, `/owner/quotations` |
| **Invoices** | Created by `POST` or from a quotation.<br>Columns include `cgst`/`sgst`/`igst`, `customer_gstin`, `place_of_supply` and `amount_paid`.<br>Statuses draft/sent/paid/overdue/void, all freely settable.<br>**No issue date, no `tax_total` and no seller/buyer snapshot** | `0060`, `modules/invoices`, `/owner/invoices` |
| **Payments** | Razorpay payment links and Stripe Checkout. The webhooks credit `amount_paid`. The provider `manual` is allowed but never written | `0060`, `0099`, `razorpay-webhook.controller.ts`, `stripe-webhook.controller.ts` |
| **Numbering** | `INV-YYYY-NNNN` / `Q-YYYY-NNNN`: calendar year, `count(*)+1` under an advisory lock | `next_invoice_number`, `next_quotation_number` |
| **Seller profile** | **None.** No legal name, GSTIN, home state, PAN or address anywhere. `accounts` has no GSTIN, state or address either | `0001`, `0035`, `0065` |
| **Money reports** | Only the report builder's `invoices` source reads invoices, plus the "Cash & collections" template from 0088. Both are gated on `deal:view`. `/v1/reports/*` reads only `deals.amount` | `crm-sources.ts`, `0088` |
| **Deals** | `amount` and `expected_close_date` (**never shown in the UI**). Status open/won/lost. **No probability and no `closed_at`.** Reports use a positional stage probability, `(i+1)/(open+1)` | `0036`, `reports.service.ts` `stageProbability` |
| **Targets** | `sales_targets` (0050), with attainment helpers. They can be managed **only in the operator console, which 403s on that route**, so owners cannot set targets at all | `targets.controller.ts`, `(platform)/targets` |
| **Tasks** | No link to invoices or quotations | `0041`, `0095` |
| **Outreach cadences** | The precedent for "a schedule creates due work that a person does": a ledger of steps, a sweep, and a human "done/skip" | `0058`, `worker/pipeline/outreach.ts` |
| **Review queue** | A web-only aggregator with one adapter per source. Approval cards plug in here | `lib/review-queue.ts`, `owner/review/sources.ts` |
| **Dashboard** | Five persona layouts fixed in JSX. No per-user storage | `owner/page.tsx`, `dashboard-panels.tsx` |
| **Charts** | Recharts is used only in the report builder, through one seam (`chart-surface.tsx`). Dashboard charts are hand-rolled CSS with an sr-only summary | `reports/builder/chart-surface.tsx` |
| **UI kit gaps** | **No Tabs component, no date or date-range picker, no chart components** | `packages/ui/src/index.ts` |
| **Missing entirely** | Expenses, vendors, credit notes, refunds, manual receipts, TDS, recurring billing, P&L, GST report, aging, collections, approvals, a finance dashboard, PDF output, invoice sending | — |

### 3.2 Defects in today's invoicing (fixed in F0)

| # | Defect | Where | Effect |
|---|---|---|---|
| 1 | Migration 0099 re-keyed `payment_gateway_config` to `(org_id, provider)`, but the save still upserts `ON CONFLICT (org_id)`. No unique constraint matches, so Postgres should reject every save (42P10). **Verified by reading** | `payment-settings.controller.ts:122` | Owners cannot save Razorpay keys. The required onboarding step `billing` depends on this save |
| 2 | The Razorpay webhook and the payment-settings GET read gateway config with **no provider filter** | `razorpay-webhook.controller.ts:68`, `payment-settings.controller.ts:75` | Once a Stripe row exists, either can pick up the Stripe row and its secret |
| 3 | The webhook credits the amount set when the link was created, not the captured amount. `amount_paid` is not capped. Several live links per provider are allowed. The idempotency key includes the event type | `razorpay-webhook.controller.ts:86-113` | Over-crediting and double-crediting are possible |
| 4 | `PATCH /invoices/:id` can set any status, `paid` included, without touching `amount_paid` or `payments`. Line items stay editable after the invoice is sent or paid | `invoices.controller.ts:60-72, 267-303` | Payment status can be faked, and issued invoices can be rewritten |
| 5 | `interState` is never stored and the UI never sends it, so every invoice made in the UI is CGST+SGST. An edit that omits `interState` leaves the GST split stale against a recomputed total. The web renders `tax_total`, which the API never returns | `invoices.controller.ts:49-52, 287-302`; `invoice-detail-client.tsx:440` | GST on inter-state invoices is wrong |
| 6 | Quotation → invoice: no check that the quotation is accepted, repeat conversion allowed, the quotation is not marked, `notes` and owner are dropped | `invoices.controller.ts:189-232` | Duplicate invoices; owner missing |
| 7 | The feature switch never reaches the API: there is no `@RequireFeature` on products, quotations, invoices or payments. The nested detail pages `invoices/[id]` and `quotations/[id]` don't gate | controllers; `owner-features.guard.test.ts` scans only catalogue hrefs | Switching Invoices off hides only the list page |
| 8 | `owner_user_id` is stamped only for `owned`-scope callers | `invoices.controller.ts:389` | The Owner column in reports reads mostly "Unassigned" |
| 9 | Stripe is only half wired:<br>• no settings UI<br>• the web always sends Razorpay<br>• `STRIPE_*` and `PUBLIC_APP_URL` are not in the env examples<br>• `/pay/thanks` and `/pay/cancelled` don't exist<br>• the Stripe webhook publishes no realtime event | `stripe.ts:121-122`, `invoices/actions.ts:160` | Stripe cannot be used from the product |
| 10 | "Linked to" shows raw UUIDs, and `linked-records` formats money without a currency | `invoice-detail-client.tsx:483-512`, `linked-records.tsx` | Unreadable pages; wrong currency symbol |
| 11 | Six bare `<a href="/owner/…">` links miss the `/admin` basePath in production, the reports CSV export among them | `reports/page.tsx:628` and five others | Downloads 404 in production |
| 12 | Nothing ever sets `overdue` or quotation `expired`, yet the 0088 template's "Overdue" KPI filters on `status='overdue'` | `0088:426-483` | Overdue always reads 0 |
| 13 | The commission-plans and pipelines controllers mount only AdminKey+Tenant guards | `commission-plans.controller.ts:62`, `pipelines.controller.ts:64` | Any member can edit commission rates and pipelines. F3 touches pipelines |
| 14 | `roles.ts` describes the manager as "No billing or branding", but the nav gives managers Invoices and Branding | `roles.ts:67`, `nav.ts` | The persona description and the product contradict each other. D3 settles it |

---

## 4. Access model

Three axes gate the console today: tenant tier, persona and the permission grid (see the memory note
`permission-grid`). On top of those, provisioning has two axes: modules (0072) and features (0093).
Finance adds one module, some features, three grid objects and no new persona.

### 4.1 Modules and features

- A new `OrgModule` value `finance` goes into `packages/shared/src/org-modules.ts`. There is no
  database CHECK on `enabled_modules`; zod validates it.
- The admin `PATCH /v1/admin/tenants/:orgId/modules` must **refuse `finance` without `crm`**.
- Every feature below is `defaultEnabled: true`, because `features.test.ts:65-71` requires it. The
  **module** is the commercial switch; features are visibility inside it.

| Feature key | Module | Nav hrefs | Requires | Notes |
|---|---|---|---|---|
| `products`, `quotations`, `invoices` | crm | existing | existing chain | Unchanged |
| `credit_notes` | crm | `/owner/finance/credit-notes` | `invoices` | Correcting an invoice is part of invoicing, so it lives in crm |
| `billing_settings` | crm | `/owner/finance/settings` | — | **`locked: true`.** A tenant must always be able to reach its GSTIN and numbering, the same reasoning as `/owner/features` |
| `forecast` | crm | `/owner/reports/forecast` | `deals` | F3 |
| `finance_overview` | finance | `/owner/finance` | `invoices` | F1 |
| `payments_ledger` | finance | `/owner/finance/payments` | `invoices` | F1 |
| `finance_reports` | finance | `/owner/finance/reports` | `invoices` | F2 |
| `expenses` | finance | `/owner/finance/expenses`, `/owner/finance/vendors` | — | F2 |
| `collections` | finance | `/owner/finance/collections` | `invoices` | F4 |
| `finance_approvals` | finance | none (panel feature, like `sheets_sync`) | — | F4 |
| `recurring_billing` | finance | `/owner/finance/recurring` | `invoices` | F5 |

Three further rules:

- A finance feature may **require a crm feature** (for example `finance_overview` requires
  `invoices`). F1 adds a test proving `resolveFeatures` handles that cross-module dependency.
- The **settings tabs follow the module:**
  - Business, Numbering, Taxes, Gateways and Documents are crm, since correct invoicing needs them.
  - Categories, Collections and Approvals are finance.
- The **API enforces features too, from F0 on:** `@RequireFeature` on every finance controller,
  fixing defect 7. `org-feature.guard.ts:34-38` already names this exact case as the one that must
  not happen.

### 4.2 Personas (D3)

Legend: **E** = can act, **R** = read-only, **own** = scoped to the caller's own records, **—** =
hidden, and the page redirects.

| Screen / action | owner | manager | sales | telecaller | marketing |
|---|---|---|---|---|---|
| Finance overview, Payments, Finance reports | E | R | — | — | — |
| Invoices: list, detail, issue, send, record payment, credit note | E | E | — | — | — |
| Void an invoice; write-off credit note | E | E *(subject to approval policy)* | — | — | — |
| Collections queue | E | E | — | — | — |
| Expenses and vendors | E | E | — | — | — |
| Finance settings | E | R | — | — | — |
| Approval decisions | per policy stage | per policy stage | — | — | — |
| Quotations (unchanged) | E | E | E own | — | — |
| Forecast | E | E | R own | — | — |
| Goals | E | E | R own | — | — |
| Customise own dashboard | E | E | E | E | E |

Why these defaults:

- **Sales stops at the quotation,** as it does today (the comment on the `nav.ts` Invoices entry).
- **Marketing sees no invoices,** as `roles.ts` promises.
- **The manager gets operational finance but not settings,** matching the house pattern of a
  settings page that renders read-only for a manager. F0 corrects the "No billing" line in
  `roles.ts` to say this (defect 14).

### 4.3 Permission-grid objects

`PermissionObjectType` gains three objects, and `PERMISSION_OBJECT_MODULE` widens from
`"aura" | "crm"` to include `"finance"`.

| Object | Module | Actions used | Seeded from |
|---|---|---|---|
| `payment` | crm | `view`; `create` (record receipt/TDS); `edit` (refund, reverse); `export` | Each role's existing `invoice` grants, action for action |
| `expense` | finance | `view`/`create`/`edit`/`delete`/`export`. Covers vendors and categories | Each role's `invoice` grants |
| `finance_report` | finance | `view`, `export` | `invoice:view` and `invoice:export` |

- **Credit notes reuse `invoice:*`,** because issuing one is an invoicing act. That avoids a fourth
  object to seed.
- **Seeding goes in the same migration that widens the enum.** A missing grant 403s every user
  (0041, 0103). The migration `RAISE WARNING`s a count of stranded memberships rather than aborting,
  as 0103 does.
- `ENFORCED_PERMISSIONS` stays machine-derived. Never hand-edit it; `permissions-inventory.spec.ts`
  reflects over real controller metadata.

### 4.4 Gate order and failure behaviour

Every layer fails closed. This is the direct inverse of doc 25 §3.2's two fail-open behaviours.

| # | Layer | Web page | API | On failure |
|---|---|---|---|---|
| 1 | Session and membership | `(owner)/layout.tsx` `getOwner()` | `AdminKeyGuard` → `TenantGuard` | Web: `redirect("/dashboard")`. API: 401/403 |
| 2 | Module + feature | `requireOwnerFeature("<key>")` **first line, before any fetch.** This applies to **nested pages too** (§8.8) | `OrgFeatureGuard` + `@RequireFeature("<key>")` | Web: `notFound()`. API: 403 |
| 3 | Persona | `if (!roles.includes(owner.ownerRole)) redirect("/owner")` (the `sops/page.tsx:39-44` shape) | `OwnerRoleGuard` + `@RequireOwnerRole(...)` | Web: back to Home. API: 403 |
| 4 | Permission grid | none (the API decides) | `CrmPermissionsGuard` + `@RequireCrmPermission(obj, action)`, with the module taken from the object | Web: `LoadFailure kind="forbidden"`, which names the permission and says "ask an owner". API: 403 |
| 5 | Record scope | none | `scopeFilter` (`owned` narrows to `owner_user_id`) | Out-of-scope reads 404 and never 403, so a record's existence isn't disclosed |
| 6 | Approval (F4) | the document shows a "Needs approval" state | the service refuses issue/send/void with 409 `approval_required` | Web: the approval panel with a "Submit for approval" button |

**Server actions** re-resolve the owner through `ownerHeaders()` in every export (house pattern).
F0 adds the guard test the owner console lacks: every owner `actions.ts` export must call
`ownerHeaders()` first. `(platform)` already has the equivalent in `platform-actions.guard.test.ts`.

**Operator console.** A platform operator holds no membership, so any grid-guarded route 403s for
them (memory note `permission-grid`). Finance therefore gets **no operator pages.** Doc 25 §6's
agency and super-admin finance screens are not ported.

### 4.5 The bookkeeper gap (F7-1)

No current persona fits an accountant: they must see all money but never a call transcript or the
lead board. v1 routes finance work to the owner and manager.

The proposed F7-1 is a `finance` persona that sees:

- Finance, Invoices, and Quotations read-only;
- the billing card on Contacts and Accounts;
- nothing under Conversations and no lead board.

It touches the `OwnerRole` enum and its DB CHECK, the persona dashboards, the `nav.test` persona
matrix, the review-queue persona lists and `OWNER_ROLE_ADMINS` decisions. That breadth is why it is
a separate decision.

---

## 5. User flows, end to end

Screen IDs (S1…, P1…) and dialog IDs (D-…) refer to §7. Every flow ends with a person pressing the
button that reaches a customer. The system only prepares, records and reminds.

### 5.0 The whole picture

```
 CRM module                                                         Finance module
 ──────────                                                         ──────────────
 Lead ─► Deal ─────────► Quotation ─► [approval] ─► Invoice ─► issue ─► money in ─► settled
          │ probability,   S19          F4, S24       S2/S3     number,   S3 dialogs   │
          │ close date                                          snapshot, receipt,    │
          ▼                                                     lock      TDS, credit │
       Forecast + goals (F3, S22)                                  │      note, refund │
                                                                   ▼                   ▼
                      public invoice page (P1) ─► gateway ─► webhook ─► recompute ─► deal auto-Won (opt-in)
                                                                   │
                                                                   ▼
                                           Collections ladder: due work for a person (F4, S8)

 Expenses + vendors (F2, S9-S12) ───────────────────────────────► P&L, GST input credit (S13)
 Finance overview (S1) and the dashboard tiles (F6, S23) read all of the above
```

### 5.1 First-run setup (F1)

Trigger: the operator enables the `finance` module in `/admin`, or an owner opens Invoices for the
first time.

1. **S1 Finance overview** shows a **"Set up billing" card** listing five steps. Each step opens a
   tab of **S15 Finance settings** and returns to S1 when saved:
   1. **Business profile** (`?tab=business`): legal name, trade name, GSTIN, state, PAN, address,
      base currency, financial-year start month, default payment terms.
      - GSTIN is validated for format and checksum, and its first two digits must match the chosen
        state.
   2. **Numbering** (`?tab=numbering`): prefix per document type, with a live preview such as
      `INV/2026-27/0001`.
   3. **Taxes** (`?tab=taxes`): GST rates and the default rate. A link goes to `/owner/products`
      to add HSN/SAC codes.
   4. **Get paid** (`?tab=gateways`): Razorpay and/or Stripe keys, plus the webhook URL to copy.
      - This step is **optional**: manual receipts work without a gateway.
   5. **Invoice look** (`?tab=documents`): terms, signatory, bank details and UPI ID for the QR,
      and which fields to print.
      - The logo and colours come from `/owner/branding` and are not duplicated here.
2. The card disappears once steps 1 and 2 are done.
3. **Hard rule:** issuing an invoice (§6.1) returns 409 `business_profile_incomplete` until legal
   name and state exist. The dialog links straight to `?tab=business`.
4. **Onboarding change.** The setup checklist's required `billing` step
   (`packages/shared/src/onboarding.ts:139-146`) currently means "Razorpay keys saved". It becomes
   "business profile complete", and the gateway becomes optional.
   - This affects only tenants whose setup is still open, because `setupCompletedAt` is already set
     for the rest. It needs your yes (Q10).

### 5.2 Quote to cash

```
Deals board / drawer (S21)
  │ "New quotation" (sales, manager, owner)
  ▼
Quotation draft (S19) ── lines from product picker, HSN, live totals
  │ Mark sent / Share ── (F4: blocked with "Needs approval" if a policy matches → S24)
  ▼
Sent ──► customer accepts (a person records it: "Mark accepted")
  │ "Create invoice" (owner, manager)  – all lines, or "invoice part" (a % or chosen lines)
  ▼
Invoice draft (S3) ── carries account/contact/deal/owner/notes; quotation marked as invoiced
  │ Issue (D-Issue): number assigned, seller + buyer snapshot frozen, GST split decided
  │                  server-side, lines lock, due date = issue date + terms
  ▼
Sent ──► Send (D-Send: composer prefilled with a template, the public link and the pay link)
  │        a person presses Send (email or WhatsApp). Nothing goes out on its own
  ▼
Customer opens P1 ─► pays ─► webhook ─► recompute ─► partially_paid / paid ─► S1 feed, notification
                                                         └► deal moves to Won (if the pipeline opted in, F3)
```

Step by step:

1. **Deal → quotation.** From the deal drawer (S21), "New quotation" opens D-NewQuote with account,
   contact and deal prefilled.
   - F0/F1 add the account/contact/deal pickers the dialog lacks.
   - On success the flow goes to `/owner/quotations/<id>`.
2. **Build the quotation.** The line editor gains a **product picker** (name, price, tax rate and
   HSN come from the catalogue) and **live totals** from the shared `computeDocumentTotals`. Today
   totals read "unsaved" until saved.
3. **Send the quotation.** "Share" builds a copyable summary and, if D9 is extended to quotations
   (F7-6), a public link. "Mark sent" records it.
   - F4: if an approval policy matches the amount, both are blocked until a decision exists (§5.6).
4. **Accept.** A person records the customer's yes. "Expired" is derived: `valid_until` has passed
   while the status is still `sent`.
5. **Convert.** "Create invoice" is allowed only on `accepted`.
   - It copies lines, discount, notes, owner, account, contact and deal, and sets
     `quotations.invoiced_total`.
   - A second conversion is allowed only as **"Invoice part"** (staged or advance billing), and it
     is refused once `invoiced_total` reaches the quotation total. This fixes defect 6.
6. **Issue** (D-Issue). A confirmation lists what becomes permanent: number, date, customer GSTIN,
   place of supply, and the GST split it produces.
   - After issue, lines are read-only. A correction means a credit note (§5.4).
7. **Send** (D-Send). The dialog creates the public link (P1) and a gateway payment link if a
   gateway is connected, then opens the **existing composer** prefilled with the "Invoice" template:
   - email via `POST /contacts/:id/email`, behind `EMAIL_SENDING_ENABLED`;
   - or WhatsApp via `POST /conversations/:id/messages`.

   The person edits and presses Send, and the invoice records `last_sent_at` and the channel. Where
   neither channel is available, "Copy link" is the fallback.
8. **Paid.** The webhook or a person's receipt runs `recompute_invoice` (§9.3). Then:
   - the status changes;
   - the invoice owner gets a `payment_received` notification;
   - S1's "Recent payments" feed updates live over the existing `invoice` realtime topic;
   - F4's collection ladder cancels its remaining steps;
   - F3's auto-Won runs if the deal's pipeline opted in.

**Direct invoices without a quotation.** "New invoice" on S2 opens D-NewInvoice (customer, deal,
currency, due terms) and goes to the S3 draft. Many small businesses never quote.

### 5.3 Getting paid: the three paths (F1)

| Path | Who starts it | What is written | Status effect |
|---|---|---|---|
| **Gateway** | The customer on P1 (Razorpay link or Stripe Checkout) | A `payments` row: `provider`=razorpay/stripe, `kind=payment`, **`amount` = the captured amount from the event.** Idempotency key = the gateway **payment id**, not the event type | `recompute_invoice` |
| **Manual receipt** (D-RecordPayment) | Owner or manager, from S3, S8 or S20 | A `payments` row: `provider=manual`, `method` (UPI, bank transfer, cash, cheque, card, other), `reference`, `received_on`, `recorded_by`. An "I confirm this money has been received" checkbox is required | `recompute_invoice` |
| **TDS deducted by the customer** (same dialog, "Customer deducted TDS") | Owner or manager | A `payments` row with `kind=tds` and the section/rate note. It counts toward settlement but not toward cash collected | `recompute_invoice` |

Guards:

- A manual amount above the balance is refused.
- A gateway capture above the balance, for example from two live links, is recorded in full and
  flags the invoice **"Overpaid by ₹X — record a refund"**. Money that arrived is never silently
  dropped.
- Creating a payment link **cancels the previous live link** from the same provider. A link is
  refused when the balance is 0.
- A mistaken manual entry is **reversed** (D-Reverse: reason required; the row keeps `reversed_at`),
  never deleted. Gateway rows cannot be reversed.

### 5.4 Corrections: void, credit note, refund, write-off (F1)

```
Issued invoice
  ├─ nothing paid, no credit notes ─► Void (D-Void, reason) ─► status void; the number stays in the register
  ├─ price or quantity wrong ───────► Credit note (D-CreditNote: all or chosen lines, or an amount)
  │                                      draft ─► Issue ─► reduces the balance
  │                                      └─ if the invoice was already paid ─► "Refund due ₹X"
  │                                                        └─► Record refund (D-Refund) ─► payments kind=refund
  └─ customer will never pay ───────► Credit note, reason "bad debt" (= write-off; owner, or per F4 policy)
```

- Credit notes have their own series (`CN/2026-27/0001`), their own print view, and appear in the
  GST report as negative outward supply.
- A credit note can never exceed the invoice total minus what was already credited.
- A refund records money already sent back outside Aura. **Gateway-initiated refunds are F7-8.**
  There is no "Retry" button that does nothing, unlike MyAppz (doc 25 §5.7).

### 5.5 Collections (F4)

The ladder is configured once in S15 `?tab=collections`. The default ladder:

| Offset from due date | Channel | Step |
|---|---|---|
| −3 days | email | Friendly reminder |
| +1 day | WhatsApp | Payment overdue |
| +7 days | call | Call the customer |
| +15 days | email | Final notice |
| +30 days | none | Escalate to owner |

Each step has a template the person sends. Offsets are **relative to the due date,** unlike outreach
cadences, which count from enrolment.

```
Issue invoice ─► ladder materialised (all steps "waiting", due_at = due_date + offset)
worker sweep (5 min): waiting ─► due when due_at ≤ now; `collection_due` notification to the assignee
                      remaining steps ─► cancelled when the invoice settles, is voided or is credited
S8 Collections queue (oldest first, "Mine" / "All")
  └─ row: invoice, customer, balance, days overdue, last touch, step guidance
       ├─ "Send reminder" ─► composer prefilled from the step template ─► the person sends ─► step done
       ├─ "Log call" ─► outcome: reached / no answer / promised / disputed / paid
       ├─ "Promise to pay" (D-Promise: date) ─► later steps paused until date + grace
       ├─ "Record payment" ─► D-RecordPayment (same dialog as S3)
       └─ "Skip" (note required)
Final step "Escalate" ─► notifies the owner; offers "Write off" (credit note, §5.4)
```

- **Assignee:** the invoice owner, falling back to the ladder's default assignee (an owner or
  manager).
- **Why a ledger and not tasks:** it is the outreach precedent. A ladder must stop as a unit when
  the invoice settles, and tasks can't do that. Due collection steps also appear in the dashboard's
  NextActions for owners and managers.
- **Rule 3 holds structurally:** the ladder tables have **no column that can hold a message
  recipient,** and the sweep imports no dispatcher. A test asserts both, as `e2e-report-schedule.cjs`
  does.

### 5.6 Approvals (F4)

1. An owner defines policies in S15 `?tab=approvals`. Each policy has:
   - an object type: quotation, invoice, credit note or expense;
   - a minimum amount;
   - ordered stages, each naming the persona that decides (manager, then owner).
2. When a document would be issued, sent, voided or paid and a policy matches, the service returns
   409 `approval_required`. The document shows an **Approval panel** with "Submit for approval".
3. Submitting creates an `approval_requests` row pinned to the document's current **revision**, and
   raises `review_pending` for that stage's persona.
4. Approvers see a card in **S24 Review queue** (a new `finance_approval` source) showing the
   document number, type, amount, customer and requester. Approve or reject needs a comment on
   reject.
   - Multi-stage policies advance to the next stage.
   - **The requester can never approve their own request.**
5. **Any edit after approval bumps the revision** and supersedes the request, so an approved ₹50,000
   quote cannot become an unapproved ₹5,00,000 one.
6. Once approved, the blocked action proceeds, performed by the requester.

### 5.7 Expense to P&L (F2)

```
Bill arrives ─► S9 "New expense" (D-NewExpense)
                 vendor (pick, or quick-create D-NewVendor) · category · bill no/date · amount
                 GST mode (exclusive / inclusive / exempt) + rate · ITC eligible? · TDS rate · receipt upload
                 live breakdown: taxable · CGST+SGST or IGST (vendor state vs your state) · TDS · payable
               ─► saved as "unpaid" ─► [F4: approval if a policy matches] ─► Mark paid (D-MarkPaid: date,
                 method, reference) ─► "paid"
Recurring expense (rent, SaaS) ─► the worker creates a DRAFT expense N days before it is due
                                  ─► notification ─► a person reviews it and saves it as unpaid
P&L (S13 ?tab=pnl) and GST input credit (S13 ?tab=gst) read expenses by expense date
```

### 5.8 Month-end and GST (F2)

1. **Aging.** S13 `?tab=aging` with `asOf` set to the last day of the month. The person checks each
   90+ customer, and each bucket drills to S2 filtered by `aging`.
2. **Collections check.** The outstanding tab, grouped by customer, gives statement links (S18) to
   send.
3. **GST.** S13 `?tab=gst` for the month shows:
   - outward B2B rows (GSTIN present) and B2C rows;
   - credit notes as negatives;
   - an HSN summary;
   - inward ITC from expenses;
   - net liability by IGST/CGST/SGST.

   Export CSV (GSTR-1 column order) and hand it to the accountant.
4. **P&L.** S13 `?tab=pnl` for the month, compared with the previous month, then Print (S14).

### 5.9 Forecasting and goals (F3)

1. **Setup.** An owner or manager opens **D-PipelineSettings** from the Deals page and sets a
   probability per stage (for example Qualified 20 %, Proposal 50 %, Negotiation 75 %). The Won and
   Lost stages are fixed at 100 and 0. Optionally they enable "Mark deal Won when its invoice is
   paid" and choose which Won stage.
2. **Daily use.** A rep sets **expected close date** and, only if they know better than the stage,
   a **deal probability** in the drawer (S21). The drawer shows "Stage default 50 % — overridden by
   you".
3. **Review.** A manager opens **S22 Forecast** and sees:
   - open pipeline, weighted pipeline, and the 30/60/90-day forecast;
   - win rate, cycle time, average deal;
   - expected close by month;
   - goal vs forecast.

   The **at-risk list** has a reason chip per deal: *idle 16 d* (pipeline `stale_after_days`),
   *probability 10 %*, or *close date passed*. Each row opens `/owner/deals?focus=<id>`. A "No close
   date: 14 deals" link opens the deals table filtered to them.
4. **Goals.** S22 `?tab=goals`: owners and managers create or edit team or per-person targets for a
   period (won value or won count). Attainment is shown against pace (the existing
   `attainmentStatus` helper) and **not capped at 100 %** (MyAppz caps it).

### 5.10 Recurring billing (F5, only if D6 = yes)

1. From S16, "New schedule" (D-NewSchedule): customer, product lines, interval (monthly, quarterly,
   yearly), start date, then either an end date/cycle count (**instalments**) or open-ended
   (**subscription**), plus lead days (default 5).
2. The worker creates a **draft invoice** `lead_days` before each cycle and raises
   `billing_draft_ready`. S16 "Drafts to review" lists them.
3. A person opens the draft, checks it and issues it. **Nothing is auto-issued or auto-sent.**
4. Pause, resume, change quantity or price (applies from the next cycle; recorded as an expansion or
   contraction event), or cancel (at period end or immediately).
5. MRR, ARR, churn and MRR movement come from `billing_schedule_events` (§9.4). Expansion is
   **real**, not hard-coded to 0.

### 5.11 Dashboard customisation (F6)

1. Any persona presses **Customise** on `/owner`, and the page enters edit mode.
2. Each widget gets a drag handle, move up/down buttons (keyboard), a size control (1–4 columns) and
   Hide.
3. "Add widget" opens a drawer of **only the widgets this persona and tenant can see,** grouped by
   category. Each shows its info text: Source, Formula, Period.
4. Save writes `PUT /v1/me/dashboard-layout`. Cancel discards. "Reset to default" restores the
   persona default.
5. The layout is a **preference, not a grant.** If a persona or module later changes, widgets the
   person can no longer see are dropped at render, and their stored entries stay harmless.

### 5.12 A day per persona

| Persona | Lands on | Typical path |
|---|---|---|
| Owner | `/owner`, with Finance tiles once F6 or F1 lands | Outstanding tile → S2 (overdue) → S3 → D-RecordPayment. Or S1 → S13 P&L. Approves in S24 |
| Manager | `/owner` | NextActions shows due collection steps → S8 → composer. S22 forecast review. Records expenses in S9 |
| Sales | `/owner` | Deal drawer → quotation → "Mark accepted" → hands off to invoicing (a manager or owner converts). S22 own forecast and goals |
| Telecaller, marketing | unchanged | They see no finance screens |

---

## 6. Document state machines

Every transition below is an API action inside one database transaction. **No status is settable
through a generic PATCH.** PATCH edits fields of drafts only. That is the fix for defect 4.

### 6.1 Invoice

The stored `status` is one of `draft`, `sent`, `partially_paid`, `paid`, `credited` or `void`.
`overdue` is **derived**: status is `sent` or `partially_paid` and `due_date` is before the org's
reporting today.

| From | Action (endpoint) | To | Who | Guard / side effects |
|---|---|---|---|---|
| — | create (`POST /invoices`, `…/from-quotation/:id`) | draft | o, m | `invoice_number` is NULL while in draft |
| draft | edit (`PATCH /invoices/:id`) | draft | o, m | Lines and fields. `revision` +1 |
| draft | delete (`DELETE /invoices/:id`) | — | o, m | Only if never issued. Goes to the recycle bin (0108 pattern) |
| draft | **issue** (`POST /invoices/:id/issue`) | sent | o, m | Needs: business profile; at least one line; `due_date` (or terms); approval if a policy matches. Then:<br>• assigns the number (§9.3)<br>• freezes `seller_snapshot` and `buyer_snapshot`<br>• sets `is_inter_state` = seller state ≠ place of supply<br>• sets the per-line tax split and `issue_date`, `issued_at`, `issued_by`<br>• locks lines<br>• F4: materialises the collection ladder |
| sent, partially_paid, paid, credited | payment / TDS / refund / credit note / reversal | recomputed | o, m, webhook | `recompute_invoice()` (§9.3) decides:<br>• `paid` when the balance is ≤ 0 and at least one payment or TDS exists<br>• `credited` when the balance is ≤ 0 and settled only by credit<br>• `partially_paid` when something has settled<br>• otherwise `sent`<br>A negative balance sets the `overpaid` flag |
| sent | **void** (`POST /invoices/:id/void`) | void | o (m if policy allows) | No payments and no issued credit notes. Reason required. The number stays in the register as cancelled. Remaining collection steps are cancelled |
| any issued | send (`POST /invoices/:id/sent`) | unchanged | o, m | Records `last_sent_at` and the channel after the person sends from the composer. Not a status change |

### 6.2 Quotation

| From | Action | To | Notes |
|---|---|---|---|
| draft | edit | draft | `revision` +1 |
| draft | mark sent / share | sent | F4: needs approval if a policy matches |
| sent | mark accepted / rejected | accepted / rejected | A person records the customer's answer |
| sent | *(derived)* `valid_until` < today | shown as "expired" | Not stored. Stops defect 12 recurring |
| accepted | create invoice (whole or part) | accepted, and `invoiced_total` increases | Refused once `invoiced_total` reaches `total` |

### 6.3 Credit note

`draft` → **issue** (numbered `CN/…`; applied to the source invoice; approval if a policy matches) →
`issued`. `issued` → **void** is allowed only if no refund references it. Reasons are `return`,
`price_correction`, `discount`, `bad_debt` and `other`.

### 6.4 Payment

| Kind | States |
|---|---|
| Gateway link | `created` → `paid` / `failed` / `expired` (a new link supersedes the previous one) |
| Manual receipt, TDS | written as `paid`. A mistaken entry can be reversed (`reversed_at`, reason) |
| Refund | written as `paid` (money already returned). It links `refund_of_payment_id` or the credit note |

### 6.5 Expense

`draft` (from a recurring template) → `unpaid` → **mark paid** → `paid`. Both `draft` and `unpaid`
can go to **void**. F4 approval applies before mark-paid when a policy matches. Deleting an unpaid
or draft expense sends it to the recycle bin.

### 6.6 Approval request

`pending` → `approved` / `rejected` / `withdrawn`. It becomes `superseded` automatically when the
document's revision changes. A CHECK requires `decided_by`, `decided_at` and a comment on reject,
following the `call_access_requests` precedent from 0122.

### 6.7 Collection step

`waiting` → `due` → `done` / `skipped`. Both `waiting` and `due` can go to `cancelled` (invoice
settled, voided or credited) or `paused` (a promise to pay, until a date). `paused` returns to
`waiting` at the promised date plus a grace period.

### 6.8 Billing schedule (F5)

`active` ⇄ `paused`. `active` → `cancelling` (at period end) → `ended`, or `active` → `ended`
(immediate cancel). An instalment schedule ends by itself after its last cycle.

### 6.9 Deal additions (F3)

Status stays derived from the stage's `terminal` flag (unchanged). A new trigger on `deals` sets
`closed_at` whenever status becomes `won` or `lost`, and clears it on reopen. A trigger covers all
five code paths that move stages (deals PATCH, lead propagation, automation `move_stage`, stage-pack
apply, the worker's entry move) without editing each one.

---

## 7. Screens

### 7.1 Inventory

**Owner console (`/owner`, basePath `/admin` in production):**

| ID | Screen | Route | Phase | Personas | Feature |
|---|---|---|---|---|---|
| S1 | Finance overview | `/owner/finance` | F1 | o, m (R) | `finance_overview` |
| S2 | Invoices list *(rework)* | `/owner/invoices` | F0/F1 | o, m | `invoices` |
| S3 | Invoice detail *(rework)* | `/owner/invoices/[id]` | F0/F1 | o, m | `invoices` |
| S4 | Invoice print | `/owner/invoices/[id]/print` | F1 | o, m | `invoices` |
| S5 | Payments ledger | `/owner/finance/payments` | F1 | o, m (R) | `payments_ledger` |
| S6 | Credit notes list | `/owner/finance/credit-notes` | F1 | o, m | `credit_notes` |
| S7 | Credit note detail (+ `/print`) | `/owner/finance/credit-notes/[id]` | F1 | o, m | `credit_notes` |
| S8 | Collections queue | `/owner/finance/collections` | F4 | o, m | `collections` |
| S9 | Expenses list | `/owner/finance/expenses` | F2 | o, m | `expenses` |
| S10 | Expense detail | `/owner/finance/expenses/[id]` | F2 | o, m | `expenses` |
| S11 | Vendors list | `/owner/finance/vendors` | F2 | o, m | `expenses` |
| S12 | Vendor detail | `/owner/finance/vendors/[id]` | F2 | o, m | `expenses` |
| S13 | Finance reports (tabbed) | `/owner/finance/reports?tab=…` | F2 (`mrr` tab F5) | o, m (R) | `finance_reports` |
| S14 | Finance report print | `/owner/finance/reports/print?tab=…` | F2 | o, m | `finance_reports` |
| S15 | Finance settings (tabbed) | `/owner/finance/settings?tab=…` | F1 (F2/F4 add tabs) | o (E), m (R) | `billing_settings` (locked) |
| S16 | Recurring billing list | `/owner/finance/recurring` | F5 | o, m | `recurring_billing` |
| S17 | Billing schedule detail | `/owner/finance/recurring/[id]` | F5 | o, m | `recurring_billing` |
| S18 | Statement of account (print) | `/owner/finance/statement?account=…` or `?contact=…` | F1 | o, m | `invoices` |
| S19 | Quotations list/detail *(changes)* | `/owner/quotations`, `/[id]` | F0/F1 | o, m, s | `quotations` |
| S20 | Contact / account record: Billing card | `/owner/contacts/[id]`, `/owner/accounts/[id]` | F1 | o, m | `invoices` |
| S21 | Deals: drawer, table, pipeline settings *(changes)* | `/owner/deals` | F3 | o, m, s | `deals` |
| S22 | Forecast and goals | `/owner/reports/forecast?tab=forecast\|goals` | F3 | o, m, s (own) | `forecast` |
| S23 | Dashboard, customise mode | `/owner` | F6 | all | — |
| S24 | Review queue: approval cards | `/owner/review` | F4 | per policy | `finance_approvals` |

**Public origin (D9; never under `/admin`):**

| ID | Screen | Route | Phase |
|---|---|---|---|
| P1 | Public invoice | `/i/[token]` | F1 |
| P2 | Payment received | `/pay/thanks?t=<token>` | F0 (fixes defect 9) |
| P3 | Payment cancelled | `/pay/cancelled?t=<token>` | F0 |

### 7.2 Screen specs

Conventions apply to every screen unless it says otherwise:

- **Chrome:** `PageHeader` with a literal title and the context "Finance", then the **Finance
  strip** (§8.2), then content.
- **Loader:** a sibling `loading.tsx` whose header matches the page.
- **Primary fetch:** `ownerTry`, falling back to `LoadFailure`.
- **Links:** built with `<Link>`, from the params the API echoed.
- **Colours** follow the console colour rule:
  - no red on finance screens;
  - "overdue" is the `warning` token plus text;
  - failed payments are the orange error state;
  - everything else is grey.

#### S1 Finance overview (`/owner/finance`, F1)

- **Purpose:** "Is money coming in, and who owes us?" in one screen.
- **Layout, top to bottom:**
  1. Header, with the **PeriodPicker** (§8.4) and a currency select on the right.
  2. **Set-up card** (§5.1), shown only until setup is done.
  3. **KPI band:** six `StatCard`s — Billed, Collected, Outstanding, Overdue, Collection rate, DSO.
     - Each shows the change against the previous equal-length period ("new" when the previous
       value was 0).
     - Each has an info hint with Source / Formula / Period, taken from §9.4.
  4. Two charts: **Billed vs collected** (area chart; collected solid, billed dashed; daily, weekly
     or monthly buckets by range length) and **AR aging** (five bars; each opens S2 with that
     `aging`).
  5. Two lists: **Overdue invoices** (top 8 by days overdue, with "Record payment") and **Due in
     the next 7 days**.
  6. **Top customers** (by net billed, with the count, collected and outstanding) and **Product
     performance** (horizontal bars by taxable value).
  7. F2 adds **Expenses by category** (donut) and a **Net profit** tile.
  8. **Recent payments,** live over the realtime `invoice` topic.
- **Data:** one call, `GET /v1/finance/overview?from&to&currency`, returns every panel plus the
  echoed range. One call means the page can't render half-loaded, the same reasoning as the report
  builder's print render.
- **Exits:** see §8.5, rows S1-*.
- **Empty states:**
  - no invoices ever: the setup card plus "Create your first invoice";
  - none in the period: each panel shows an icon and one sentence (for example "No invoices issued
    in this period").

#### S2 Invoices list (`/owner/invoices`, rework)

- **Header actions:** **New invoice** (D-NewInvoice). Export CSV comes in F2.
- **Filters,** all in the URL (§8.4):
  - status pills: All, Draft, Awaiting payment, Partially paid, Overdue (derived), Paid, Credited,
    Void;
  - search (number or customer);
  - customer, owner and due-date range;
  - currency;
  - `aging`, and `balance=open`.
  - Saved views (F1 should): add `invoices` to `SavedViewList` and `LIST_DEFINITIONS`.
- **KPI strip,** each tile a link: Outstanding, Overdue, Billed this month, Collected this month.
- **Table columns:**
  - Number ("Draft" while a draft)
  - Customer (name, not UUID)
  - Issue date
  - Due date, plus an "n days overdue" chip
  - Total
  - Balance
  - Status
  - Owner
- **Paging:** `Pager`, 50 per page. A row opens S3 with `?back=` holding the current list URL.
- **Empty states:** a filter that matches nothing offers "Clear filters". An empty tenant offers "Create an invoice, or convert an
  accepted quotation".

#### S3 Invoice detail (`/owner/invoices/[id]`, rework)

- **Header:** the title is the number, or "Draft invoice". It carries the status chip and, when
  derived, an overdue chip.
- **Action bar by state:**
  - draft: Save, **Issue**, Delete;
  - sent / partially_paid: **Record payment**, **Send**, Share link, Credit note, Void;
  - paid: Credit note, Record refund (only when overpaid), Print;
  - void: Print.
- **The free "Status" select is removed.**
- **Summary band:** Total · Settled (paid + TDS + credited) · **Balance due** · Due date.
- **Main column:**
  1. **Line items.** Editable only in draft, using the product picker, HSN and live totals.
     Read-only after issue.
  2. **Payments and adjustments.** One chronological ledger of payments, TDS, refunds, credit notes
     and reversals, with a running balance and a link to each credit note.
  3. **Collections** (F4): ladder steps with their state, promise-to-pay, and "Pause ladder".
  4. **History:** `audit_log` entries for this invoice (who issued, voided, recorded, changed what).
- **Side column:**
  - **Customer:** account or contact link, GSTIN, place of supply, billing address. It shows the
    snapshot after issue, marked "as issued".
  - **Details:** issue date, due date, terms, currency, owner (editable), deal link and quotation
    link, all by name.
  - **Tax:** taxable value, CGST+SGST *or* IGST, round-off, total, total in words.
  - **Share and pay:** public-link state (active or revoked; copy, rotate, revoke) and live
    payment links by provider.
  - **Approval** (F4).
- **Deep actions:** `?do=record-payment|credit-note|send|share` opens that dialog once, then strips
  the parameter (the `use-focus-param` pattern).
- **Back link:** "← Invoices" goes to `?back=` when it is valid, otherwise to `/owner/invoices`.

#### S4 Invoice print (`/owner/invoices/[id]/print`, F1)

- A4 layout. The document title is:
  - "Tax Invoice" when the seller has a GSTIN;
  - "Invoice" otherwise;
  - "Bill of Supply" when every line is exempt.
- Contents:
  - seller and buyer blocks, place of supply;
  - line table with HSN/SAC, quantity, rate, taxable value, GST rate and the CGST/SGST or IGST
    columns;
  - totals, with **amount in words in Indian numbering** (lakh, crore);
  - bank details and a **UPI QR** (`upi://pay?pa=…&am=…&tn=<number>`) while a balance remains;
  - terms and signatory.
- Drafts print a **DRAFT** watermark.
- The same render component (`components/finance/invoice-document.tsx`) serves P1, so print and the
  public page can't drift apart.
- It follows the report builder's print route: server-rendered in full, then `window.print()`.

#### S5 Payments ledger (`/owner/finance/payments`, F1)

- **KPI strip:** Received, Refunded, Net, TDS deducted, Failed attempts, Open links.
- **Filters:** period, provider (razorpay, stripe, manual), kind (payment, tds, refund), status,
  method, currency, search (reference, invoice number, customer).
- **Table columns:** Date, Invoice (link), Customer, Kind, Method/provider, Reference, Amount,
  Status, Recorded by.
- **Row actions:**
  - open the invoice at `/owner/invoices/<id>#payment-<pid>`;
  - reverse (manual rows only, D-Reverse).
- **"Stale links" quick filter:** `created` links older than 7 days.

#### S6 / S7 Credit notes (F1)

- **List:** Number, Date, Invoice, Customer, Reason, Amount, Status, filtered by period, reason and
  status.
- **Detail:** header with status; the source-invoice link; lines; and an **Effect** panel, for
  example "Reduced INV/2026-27/0042's balance by ₹4,000. ₹1,000 refund due → Record refund". Issue,
  Void and Print follow the §6.3 rules.

#### S8 Collections queue (F4)

- **Tabs** (`?view=due|upcoming|promised|escalated`) and a **Mine / All** toggle (`?mine=1`).
- **Row:** customer, invoice, balance, days overdue, step label and channel, last touch, and a
  one-line guidance.
- **Row actions:** Send reminder (composer), Log call, Promise to pay, Record payment, Skip, Open
  invoice.
- **Header KPIs:** due today, overdue steps, promised this week (amount), escalated.
- **Empty state:** "Nothing to chase today", plus a link to the upcoming view.

#### S9 / S10 Expenses (F2)

- **List:**
  - KPIs: this period total, unpaid (payable), TDS deducted, ITC-eligible GST, top category.
  - Filters: period, category, vendor, status, "has receipt", currency.
  - Columns: date, vendor, category, description, taxable, GST, total, TDS, payable, status, and a
    receipt icon.
  - Bulk actions: mark paid, change category.
  - Tab `?tab=recurring` lists recurring templates with next due date and amount.
- **Detail:**
  - the fields plus a breakdown panel;
  - receipt preview (image or PDF via a presigned GET);
  - payout block (Mark paid);
  - history;
  - Delete (to the recycle bin).

#### S11 / S12 Vendors (F2)

- **List columns:** name, GSTIN, state, default category, billed this FY, unpaid.
- **Detail:**
  - profile: GSTIN, PAN, state, address;
  - bank details, masked: the account number is stored sealed with `packages/db/secrets.ts` and
    only the last 4 digits are shown;
  - expense list and totals.

#### S13 Finance reports (`/owner/finance/reports?tab=…`, F2)

Every tab has the same toolbar:

- a PeriodPicker, or an "as at" date for `aging`;
- a currency select;
- "Basis: Accrual | Cash" on `pnl`;
- **Export CSV** and **Print**, both carrying the current params.

| `tab` | Content | Drill-down |
|---|---|---|
| `pnl` | Income by product/category (taxable value) − credit notes = net revenue. Expenses by category. **Net profit**, with a previous-period column | Income line → S2 filtered by product. Expense line → S9 filtered by category |
| `gst` | Outward: B2B rows (GSTIN), B2C summary, credit notes as negatives. HSN summary. Inward ITC from expenses. Net liability by IGST/CGST/SGST | Row → S3 or S10 |
| `aging` | Customers × buckets (current, 1–30, 31–60, 61–90, 90+) as at a date, with a bar chart | Cell → S2 with `customer` and `aging` |
| `outstanding` | Open invoices grouped by customer, with a statement link each | → S3; → S18 |
| `receipts` | Collected by day and method/provider, refunds, net | → S5 filtered |
| `expenses` | By category, vendor and month | → S9 filtered |
| `customers` | Billed, collected, outstanding, count, average, first and last invoice | → S2 filtered |
| `products` | Taxable value and quantity by product and by HSN | → S2 filtered |
| `mrr` (F5) | MRR, ARR, active schedules, churn, and MRR movement (new, expansion, contraction, churned) | → S16 |

#### S14 Report print (F2)

Same params as S13, rendered as a print sheet. There is one print route for all tabs.

#### S15 Finance settings (`/owner/finance/settings?tab=…`)

The owner edits; the manager sees the same page read-only.

| `tab` | Module | Contents |
|---|---|---|
| `business` | crm | Legal and trade name, GSTIN (validated), state, PAN, address, email and phone, base currency, FY start month, default payment terms, round-off on/off |
| `numbering` | crm | Per document type: prefix and pattern, with a live preview, and the next number for the current FY. A new FY starts its own counter automatically, so there is no manual "roll year" button |
| `taxes` | crm | GST rate list and default. `prices_include_tax` default for new documents |
| `gateways` | crm | Razorpay and Stripe cards: keys (secrets write-only), webhook URL, status, last event received. This replaces `payment-settings.tsx` on S2 |
| `documents` | crm | Terms, notes, signatory name, bank details, UPI ID, QR on/off, visible fields. The logo and colours are shown read-only, with a link to `/owner/branding` |
| `categories` | finance (F2) | Expense categories (add, rename, archive) |
| `collections` | finance (F4) | Ladders and steps with templates, and the default assignee |
| `approvals` | finance (F4) | Policies: object, minimum amount, ordered stages |

#### S16 / S17 Recurring billing (F5)

- **List:** schedules with customer, amount per cycle, interval, next invoice date, status and
  cycles done/total. A "Drafts to review" tab shows the generated drafts.
- **Detail:**
  - schedule terms and lines;
  - cycle ledger: each cycle's invoice link and status;
  - events timeline (created, paused, changed, cancelled);
  - actions: Pause, Resume, Change (effective from the next cycle), Cancel.

#### S18 Statement of account (print, F1)

- For one account or contact over a period.
- Contents: opening balance, then invoices, payments, credit notes and refunds in date order with a
  running balance, then the closing balance and an aging summary.
- Linked from S20, the S13 outstanding tab and S3.

#### S19 Quotations (changes)

- An **account/contact/deal picker** in D-NewQuote.
- A product picker, HSN and live totals.
- Accepted-only conversion, with "Invoice part".
- "Invoiced ₹X of ₹Y" with links to each invoice.
- Linked records shown by name.
- F4: an approval panel.

#### S20 Contact / account Billing card (F1)

A card on the record page (which is one scrolling page with no tabs, by design):

- outstanding, overdue, billed this FY, last payment;
- the five latest invoices;
- actions: "New invoice" (prefilled), "Record payment" (picks the oldest open invoice), "Statement"
  (S18).

It is visible only to personas who can see invoices. On accounts it also holds the new **billing
fields**: GSTIN, state, billing address.

#### S21 Deals (changes, F3)

- **Drawer:**
  - expected close date, now shown and editable;
  - probability, with the stage default as placeholder and "overridden" when set;
  - weighted value;
  - linked quotations and invoices with balances;
  - "New quotation" and "New invoice".
- **Table:** Close date and Probability columns; a `noCloseDate=1` filter.
- **D-PipelineSettings,** from the pipeline picker:
  - per-stage probability;
  - stale-after days (moved here from its inline editor);
  - auto-Won on invoice paid.

  Writes require owner or manager, and the pipelines controller gains that guard (defect 13).

#### S22 Forecast and goals (`/owner/reports/forecast`, F3)

- **Header:** tabs `?tab=forecast|goals`.
- **Filters:** pipeline, owner (owner and manager only; sales is fixed to self), period (for
  win-rate statistics).
- **Forecast tab:**
  - KPIs: Open pipeline, Weighted, Next 30/60/90 days, Win rate, Avg cycle, Avg deal.
  - Expected close by month: grouped bars (weighted and unweighted) with a "Now" reference line.
  - Goal vs forecast: won to date + 30-day and 90-day forecast against each goal.
  - **At-risk table** with reason chips.
  - "No close date" link.
- **Goals tab:**
  - goals for the period, with attainment and pace;
  - New goal (D-Goal), edit and delete for owner and manager;
  - sales sees its own goals, read-only.

#### S23 Dashboard customise mode (F6)

Covered in §5.11. The entry is a "Customise" button in the `/owner` header, and the state is
client-side (no URL param). The widget catalogue is in §11.3.

#### S24 Review queue: approval cards (F4)

- A new `finance_approval` source in `lib/review-queue.ts` (`REVIEW_SOURCES`) and
  `review/sources.ts` (`REVIEW_ADAPTERS`).
- The card shows document type and number, amount, customer, requester, stage "1 of 2", Approve and
  Reject (comment required), and "Open document".
- `review-queue.test.ts` pins the per-persona source lists, so it must be updated.

#### P1 Public invoice (`/i/[token]`, F1)

- Contents:
  - the tenant's logo and colours;
  - the invoice render from S4;
  - status (Paid, or Balance due ₹X);
  - **Pay ₹X**, which uses the live payment link made when the invoice was shared (the public page
    never creates links);
  - Print / Save as PDF.
- `noindex`. No other org data is shown, and no customer data beyond this invoice's own snapshot.
- A revoked or unknown token gets the same neutral "This link is no longer active" page, so it
  doesn't disclose which case applies.

#### P2 / P3 Payment result pages

- **P2:** "Thank you — your payment is being confirmed. It can take a minute to show on the
  invoice." with a link back to P1 when `t` is present.
- **P3:** "Payment cancelled — nothing was charged." with a link back to P1.

### 7.3 Dialogs

| ID | Dialog | Opened from | Fields | Endpoint | After success |
|---|---|---|---|---|---|
| D-NewInvoice | New invoice | S2, S20, S21 | Customer (account or contact), deal, currency, terms | `POST /invoices` | → S3 draft |
| D-NewQuote | New quotation *(pickers added)* | S19, S21 | Customer, deal, currency, valid until | `POST /quotations` | → quotation detail |
| D-InvoicePart | Invoice part of a quotation | S19 | % or chosen lines | `POST /invoices/from-quotation/:id` | → S3 draft |
| D-Issue | Issue invoice / credit note | S3, S7 | Issue date (defaults to today), a read-only review of what freezes | `POST …/issue` | stay; toast with the number |
| D-Send | Send invoice | S3, S8 | Channel (email, WhatsApp, copy link), prefilled template | creates the share link and pay link, opens the composer; `POST /invoices/:id/sent` | stay |
| D-Share | Share link | S3 | Copy / rotate / revoke | `POST`/`DELETE /invoices/:id/share-link` | stay |
| D-RecordPayment | Record payment / TDS | S3, S5, S8, S20, S1 | Amount (≤ balance), date, method, reference, "TDS deducted" amount, confirmation checkbox | `POST /invoices/:id/payments` | stay; S1 feed |
| D-Reverse | Reverse a manual entry | S3, S5 | Reason | `POST /payments/:id/reverse` | stay |
| D-Refund | Record refund | S3, S7 | Amount (≤ overpaid), date, method, reference | `POST /invoices/:id/refunds` | stay |
| D-CreditNote | New credit note | S3 | Reason, all lines / chosen lines / amount | `POST /invoices/:id/credit-notes` | → S7 draft |
| D-Void | Void invoice | S3 | Reason; type-to-confirm (the house `confirm({tone:"danger"})`) | `POST /invoices/:id/void` | stay |
| D-NewExpense | New expense | S9, S12 | §5.7 fields with a live breakdown | `POST /expenses` (+ presigned receipt upload) | → S10 |
| D-MarkPaid | Mark expense paid | S9, S10 | Date, method, reference | `POST /expenses/:id/pay` | stay |
| D-NewVendor | New vendor | S11, D-NewExpense (inline) | Name, GSTIN, PAN, state, address, bank, default category | `POST /vendors` | → S12, or back into the expense |
| D-Promise | Promise to pay | S8, S3 | Date, amount, note | `PATCH /collections/steps/:id` | stay |
| D-Ladder | Ladder editor | S15 | Steps: offset, channel, label, template | `POST`/`PATCH /collections/ladders` | stay |
| D-Policy | Approval policy | S15 | Object, minimum amount, stages | `POST`/`PATCH /approval-policies` | stay |
| D-SubmitApproval | Submit for approval | S3, S7, S10, S19 | Note | `POST /approvals` | stay; panel shows pending |
| D-PipelineSettings | Pipeline settings | S21 | Stage probabilities, stale days, auto-Won | `PATCH /pipelines/:id` | stay |
| D-Goal | New / edit goal | S22 | Owner or team, metric, period, target | `POST /targets`, `PATCH /targets/:id` (new) | stay |
| D-NewSchedule | New billing schedule | S16, S20 | §5.10 fields | `POST /billing-schedules` | → S17 |
| Customise drawer | Add widget | S23 | Widget catalogue | `PUT /me/dashboard-layout` on Save | stay |

---

## 8. Navigation and routing

### 8.1 Where Finance sits in the rail

The rail is already at its cap: `OWNER_PRIMARY_NAV` holds Home, Leads, Deals, Contacts, Tasks and
Reports, plus "More", making 7. `owner-rail.test.ts` enforces that. So Finance is **not promoted**
(D11). People reach it three ways:

- **More → Finance section → page:** two clicks from anywhere.
- **The Finance strip** (§8.2): one click between finance pages.
- **Links in:** dashboard tiles, the NextActions list, notifications, the global search, and the
  billing card on contacts and accounts (§8.5 E-rows).

**Section order** (`OWNER_NAV_SECTIONS`) becomes: pipeline, crm ("Customers"), conversations, sales,
**finance ("Finance")**, insights, connectors, workspace.

- Finance sits right after Sales, so a quotation and its invoice are neighbours in the rail.
- It is **not** in `CRM_PRIMARY_SECTIONS`.

**New and changed `OWNER_NAV_ITEMS`:**

- Section order follows `OWNER_SECTION_OF` key order.
- `title` and `context` must equal the page's literal `PageHeader`. `console-loading.test.ts`
  checks that parity.

| Order | href | label | title | context | ownerRoles | Feature | Phase |
|---|---|---|---|---|---|---|---|
| 1 | `/owner/finance` | Finance | Finance | Finance | owner, manager | `finance_overview` | F1 |
| 2 | `/owner/invoices` | Invoices | Invoices | **Finance** (was "Pipeline") | owner, manager | `invoices` | moved from `sales` in F1 |
| 3 | `/owner/finance/payments` | Payments | Payments | Finance | owner, manager | `payments_ledger` | F1 |
| 4 | `/owner/finance/credit-notes` | Credit notes | Credit notes | Finance | owner, manager | `credit_notes` | F1 |
| 5 | `/owner/finance/collections` | Collections | Collections | Finance | owner, manager | `collections` | F4 |
| 6 | `/owner/finance/expenses` | Expenses | Expenses | Finance | owner, manager | `expenses` | F2 |
| 7 | `/owner/finance/vendors` | Vendors | Vendors | Finance | owner, manager | `expenses` | F2 |
| 8 | `/owner/finance/recurring` | Recurring billing | Recurring billing | Finance | owner, manager | `recurring_billing` | F5 |
| 9 | `/owner/finance/reports` | Finance reports | Finance reports | Finance | owner, manager | `finance_reports` | F2 |
| 10 | `/owner/finance/settings` | Finance settings | Finance settings | Finance | owner, manager | `billing_settings` | F1 |
| insights | `/owner/reports/forecast` | Forecast | Forecast | Pipeline | owner, manager, sales | `forecast` | F3 |

Notes:

- **Insights order** becomes `/owner/reports`, `/owner/reports/forecast`, `/owner/reports/builder`,
  `/owner/reports/sla`.
- **Sales section** keeps `/owner/products` and `/owner/quotations`.
- **Every `/owner/finance/*` href also goes in `CRM_GATED_HREFS`.** Finance requires CRM, so a
  caller that passes no entitlement still hides these pages when CRM is off. With an entitlement,
  the feature resolver hides them when the `finance` module is off.
- **Active state** stays the existing longest-prefix match:
  - `/owner/finance/expenses/abc` highlights Expenses.
  - `/owner/finance/statement` highlights Finance.
  - `/owner/reports/forecast` highlights Forecast, with Reports marked as its primary parent.

### 8.2 The Finance strip

Messaging already has a second-level strip across its pages; Finance copies that pattern
(`MESSAGING_CHANNELS` + `ChannelBar`, `nav.ts:1164-1286`):

- **Definition:** `FINANCE_TABS: {key, label, href, blurb, group: "receivables"|"payables"|"other"}[]`
  in `nav.ts`, in the order Overview, Invoices, Payments, Credit notes, Collections | Expenses,
  Vendors | Recurring, Reports, Settings.
- **Derived, never listed twice:** `financeTabsFor(role, crmPrimary, crmEnabled, callIntelEnabled,
  entitlement)` filters through `ownerNavItemsFor`, exactly like `messagingChannelsFor`. It can
  therefore never offer a tab that would 403.
  - A CRM-only tenant (no `finance` module) gets **Invoices · Credit notes · Settings**.
  - A tenant with the Finance module gets everything.
- **Where it renders:** `FinanceBar` is a one-line server component each of the ten top-level
  finance pages drops in, under the header. It is not a route-group layout, for the reason
  `channel-bar.tsx:9-17` gives.
  - Detail and print pages show **breadcrumbs instead** of the strip.
- **Behaviour:**
  - it hides itself when fewer than 2 tabs survive;
  - on a phone it scrolls sideways, with the active tab scrolled into view;
  - it uses a `<nav>` with `aria-current` and no tablist, like the channel switcher;
  - a hairline separates the groups.
- **Loading and tests:**
  - loaders draw `FinanceStripSkeleton`;
  - `finance-tabs.test.ts` asserts containment both ways (every tab is a rail item the reader can
    see) and that the strip collapses below 2 tabs.

### 8.3 Route table

Page files sit under `apps/web/app/(owner)/owner/`. Every page has a sibling `loading.tsx` unless it
is marked "NO_LOADER". Page gates apply in the order of §4.4.

| Route | Page file | Kind | Phase | Feature gate | Page personas | Main API call (permission) | Breadcrumb |
|---|---|---|---|---|---|---|---|
| `/owner/finance` | `finance/page.tsx` | overview | F1 | `finance_overview` | o, m | `GET /v1/finance/overview` (`finance_report:view`) | none (top level) |
| `/owner/invoices` | `invoices/page.tsx` | list | F0/F1 | `invoices` | o, m (**added**) | `GET /v1/invoices` (`invoice:view`) | none |
| `/owner/invoices/[id]` | `invoices/[id]/page.tsx` | detail | F0/F1 | `invoices` (**added**) | o, m | `GET /v1/invoices/:id` (`invoice:view`) | Home › Invoices › *number or "Draft"* |
| `/owner/invoices/[id]/print` | `invoices/[id]/print/page.tsx` | print | F1 | `invoices` | o, m | same | none (print sheet) |
| `/owner/finance/payments` | `finance/payments/page.tsx` | list | F1 | `payments_ledger` | o, m | `GET /v1/payments` (`payment:view`) | Home › Finance › Payments |
| `/owner/finance/credit-notes` | `finance/credit-notes/page.tsx` | list | F1 | `credit_notes` | o, m | `GET /v1/credit-notes` (`invoice:view`) | Home › Finance › Credit notes |
| `/owner/finance/credit-notes/[id]` | `…/[id]/page.tsx` | detail | F1 | `credit_notes` | o, m | `GET /v1/credit-notes/:id` | … › Credit notes › *CN number* |
| `/owner/finance/credit-notes/[id]/print` | `…/[id]/print/page.tsx` | print | F1 | `credit_notes` | o, m | same | none |
| `/owner/finance/statement` | `finance/statement/page.tsx` | print | F1 | `invoices` | o, m | `GET /v1/finance/statement` (`invoice:view`) | none |
| `/owner/finance/settings` | `finance/settings/page.tsx` | tabs | F1 | `billing_settings` | o (edit), m (read) | `GET`/`PUT /v1/finance/settings/*` (PUT: `@RequireOwnerRole("owner")`) | Home › Finance › Finance settings |
| `/owner/finance/expenses` | `finance/expenses/page.tsx` | list + tab | F2 | `expenses` | o, m | `GET /v1/expenses` (`expense:view`) | Home › Finance › Expenses |
| `/owner/finance/expenses/[id]` | `…/[id]/page.tsx` | detail | F2 | `expenses` | o, m | `GET /v1/expenses/:id` | … › Expenses › *ref or vendor* |
| `/owner/finance/vendors` | `finance/vendors/page.tsx` | list | F2 | `expenses` | o, m | `GET /v1/vendors` (`expense:view`) | Home › Finance › Vendors |
| `/owner/finance/vendors/[id]` | `…/[id]/page.tsx` | detail | F2 | `expenses` | o, m | `GET /v1/vendors/:id` | … › Vendors › *name* |
| `/owner/finance/reports` | `finance/reports/page.tsx` | tabs | F2 | `finance_reports` | o, m | `GET /v1/finance/reports/:tab` (`finance_report:view`) | Home › Finance › Finance reports |
| `/owner/finance/reports/print` | `…/print/page.tsx` | print | F2 | `finance_reports` | o, m | same | none |
| `/owner/finance/export/[report]` | `…/export/[report]/route.ts` | CSV route handler | F2 | re-derives the owner | o, m | `GET /v1/finance/reports/:tab/export` (`finance_report:export`) | — |
| `/owner/finance/collections` | `finance/collections/page.tsx` | queue | F4 | `collections` | o, m | `GET /v1/collections/due` (`invoice:view`) | Home › Finance › Collections |
| `/owner/finance/recurring` | `finance/recurring/page.tsx` | list + tab | F5 | `recurring_billing` | o, m | `GET /v1/billing-schedules` (`invoice:view`) | Home › Finance › Recurring billing |
| `/owner/finance/recurring/[id]` | `…/[id]/page.tsx` | detail | F5 | `recurring_billing` | o, m | `GET /v1/billing-schedules/:id` | … › *schedule name* |
| `/owner/finance/[...missing]` | `finance/[...missing]/page.tsx` | calls `notFound()` | F1 | — | — | — | NO_LOADER |
| `/owner/reports/forecast` | `reports/forecast/page.tsx` | tabs | F3 | `forecast` | o, m, s | `GET /v1/reports/forecast` (`deal:view`, scoped) | Home › Reports › Forecast |
| `/owner` | `page.tsx` (customise mode) | dashboard | F6 | — | all | `GET`/`PUT /v1/me/dashboard-layout` | — |
| `/owner/review` | `review/page.tsx` (+ source) | queue | F4 | source-level `finance_approvals` | per policy | `GET /v1/approvals?mine=1` | — |
| **public** `/i/[token]` | public app (D9) | public | F1 | none | anonymous | `GET /v1/public/invoices/:token` (throttled) | — |
| **public** `/pay/thanks`, `/pay/cancelled` | public app | public | F0 | none | anonymous | none | — |

### 8.4 URL state contract

All list and report state lives in the URL, so every view can be bookmarked, shared and saved as a
view. No finance screen keeps filter state in client memory.

**The period model**, shared by S1, S5, S6, S9, S13, S14, S18 and S22:

| Param | Values | Default |
|---|---|---|
| `period` | `this_month`, `last_month`, `this_quarter`, `last_quarter`, `this_fy`, `last_fy`, `last_30`, `last_90`, `custom` | `this_month` |
| `from`, `to` | `YYYY-MM-DD`; read only when `period=custom` | — |
| `asOf` | `YYYY-MM-DD` (aging and outstanding) | the org's reporting today |
| `currency` | ISO 4217 | the business profile's base currency |

How the period is resolved:

- **Presets resolve on the server,** in the org's reporting timezone (0090), with FY boundaries from
  the business profile.
- The API **echoes** what it applied: `{period, from, to, previousFrom, previousTo, clamped}`.
- A custom range is clamped to 3 years, and the UI says "Range shortened to 3 years". This is the
  honest version of MyAppz's "Range corrected by server".
- **Every drill-down link carries the echoed `from`/`to`, not the preset.** A number and the list it
  opens therefore always agree, even across midnight. This is the Phase 6 reports rule, reused.

**Parameters by screen:**

| Screen | Params |
|---|---|
| S1 | period model, `currency` |
| S2 | `status`, `q`, `account`, `contact`, `owner`, `issuedFrom`, `issuedTo`, `dueFrom`, `dueTo`, `aging` (`current`, `1-30`, `31-60`, `61-90`, `90+`), `balance=open`, `product`, `currency`, `offset`, `view` (saved view) |
| S3, S7, S10, S12, S17 | `back` (the list URL to return to), `do` (`record-payment`, `credit-note`, `send`, `share`, `refund`, `mark-paid`) |
| S5 | period model, `provider`, `kind`, `status`, `method`, `q`, `stale=1`, `offset` |
| S6 | period model, `reason`, `status`, `offset` |
| S8 | `view` (`due`, `upcoming`, `promised`, `escalated`), `mine=1`, `offset` |
| S9 | period model, `category`, `vendor`, `status`, `receipt` (`with`, `without`), `tab` (`recurring`), `offset` |
| S11 | `q`, `offset` |
| S13, S14 | `tab`, period model or `asOf`, `currency`, `basis` (`accrual`, `cash`), `groupBy` (on `expenses`: `category`, `vendor`, `month`) |
| S15 | `tab` |
| S16 | `status`, `tab` (`drafts`), `offset` |
| S18 | `account` or `contact`, `from`, `to`, `currency` |
| S21 | existing params, plus `noCloseDate=1`, `closedFrom`, `closedTo` |
| S22 | `tab` (`forecast`, `goals`), `pipeline`, `owner`, period model |

**Helpers and tests:**

- **`packages/shared/src/finance-period.ts`** (pure): preset resolution, FY maths and labels. The web
  and the API resolve identically.
- **`app/(owner)/owner/finance/finance-url.ts`:** href builders for each list, following the
  `deals-url.ts` pattern:
  - a filter change resets `offset`;
  - params that mean nothing on the target page are dropped;
  - `finance-url.test.ts` covers it.
- **`safeBackHref(value, fallback)`:** `back` must start with `/owner/` and contain no `//` or
  scheme; otherwise the fallback is used. That closes the open-redirect risk.
- **`useActionParam("do")`:** opens the named dialog once on arrival, then strips the param. This
  generalises `owner/lib/use-focus-param.ts`.
- **Saved views:** `invoices` (F1) and `expenses` (F2) join the `SavedViewList` shared enum and
  `LIST_DEFINITIONS`. `list-views.test.ts` pins that the two agree.

### 8.5 Transition map

"In place" means a dialog opens on the current page, with no navigation. Every link below is built
with `<Link>` or `redirect()`, which add the basePath.

**Entry points from elsewhere in the console:**

| # | From | Trigger | To |
|---|---|---|---|
| E1 | Rail → More → Finance | click an item | that page |
| E2 | `/owner` owner and manager dashboards | **Outstanding** / **Overdue** tiles. F1 adds these two to the fixed layouts; F6 makes them widgets | S2 `?balance=open` / S2 `?status=overdue` |
| E3 | `/owner` NextActions (F4) | a due collection step | S8 `?view=due&mine=1`, or S3 `?do=record-payment` |
| E4 | Notification bell | `payment_received` / `collection_due` / `review_pending` (approval) / `billing_draft_ready` | S3 / S8 `?view=due&mine=1` / S24 / S16 `?tab=drafts` |
| E5 | Global search (`owner/api/search`) | an invoice number or customer; a vendor name | S3 / S12 |
| E6 | Contact or account record (S20) | Billing card: invoice row, "See all", Statement, Record payment, New invoice | S3 / S2 `?account=`/`?contact=` / S18 / in place / D-NewInvoice → S3 |
| E7 | Deal drawer (S21) | a linked quotation or invoice; "New invoice" | quotation detail / S3 / D-NewInvoice → S3 |
| E8 | Quotation detail (S19) | Create invoice / Invoice part; a linked invoice | S3 (new draft) / S3 |
| E9 | Setup checklist (`SetupGate`) | the "Business profile" step | S15 `?tab=business` |
| E10 | S24 Review queue | "Open document" on an approval card | S3 / S7 / S10 / quotation detail |

**Inside Finance:**

| # | From | Trigger | To |
|---|---|---|---|
| S1-a | S1 | the **Billed** tile | S2 `?issuedFrom=&issuedTo=` (echoed) |
| S1-b | S1 | the **Collected** tile | S5 `?period=custom&from=&to=&kind=payment` |
| S1-c | S1 | **Outstanding** / **Overdue** | S2 `?balance=open` / `?status=overdue` |
| S1-d | S1 | **Collection rate** | S2 `?issuedFrom=&issuedTo=` (the cohort the rate is computed over) |
| S1-e | S1 | **DSO** | S13 `?tab=aging&asOf=<to>` |
| S1-f | S1 | an aging bar | S2 `?aging=31-60&balance=open` |
| S1-g | S1 | an overdue/due row; "Record payment" | S3 `?back=/owner/finance…`; in place |
| S1-h | S1 | a top customer; a product bar | S2 `?account=` / `?product=` (with the echoed dates) |
| S1-i | S1 | a recent payment | S3 `#payment-<id>` |
| S1-j | S1 | an expense donut slice; the Net profit tile (F2) | S9 `?category=&period=custom&from=&to=`; S13 `?tab=pnl&…` |
| S1-k | S1 | a setup-card step | S15 `?tab=…` |
| S2-a | S2 | a row | S3 `?back=<current list URL>` |
| S2-b | S2 | New invoice | D-NewInvoice → S3 |
| S2-c | S2 | a KPI tile or status pill | S2 with that filter |
| S2-d | S2 | Export CSV (F2) | `/owner/finance/export/invoices?<current params>` (basePath-prefixed) |
| S3-a | S3 | the customer name | `/owner/accounts/[id]` or `/owner/contacts/[id]` |
| S3-b | S3 | the deal / quotation link | `/owner/deals?focus=<id>` / `/owner/quotations/[id]` |
| S3-c | S3 | Issue, Record payment, Refund, Void, Share, Send | in place (D-…); Send also opens the composer |
| S3-d | S3 | Credit note | D-CreditNote → S7 (new draft) `?back=/owner/invoices/<id>` |
| S3-e | S3 | a credit-note row in the ledger | S7 |
| S3-f | S3 | Print; Statement | S4 (new tab); S18 `?account=` |
| S3-g | S3 | Back | `back` if valid, otherwise S2 |
| S5-a | S5 | a row | S3 `#payment-<id>` |
| S6-a / S7-a | S6 / S7 | a row / the source invoice | S7 / S3 |
| S7-b | S7 | Record refund | in place (D-Refund, against the source invoice) |
| S8-a | S8 | invoice, Send reminder, Log call, Promise, Record payment, Skip | S3 / composer / in place ×4 |
| S9-a | S9 | a row; the vendor chip; New expense | S10 / S12 / D-NewExpense → S10 |
| S11-a / S12-a | S11 / S12 | a row; an expense row; "New expense for this vendor" | S12 / S10 / D-NewExpense (prefilled) → S10 |
| S13-a | S13 | a drill-down (see the §7.2 S13 table) | S2 / S3 / S5 / S9 / S10 / S16 with echoed params |
| S13-b | S13 | Print; Export | S14 (same params); CSV route |
| S15-a | S15 | "Edit logo and colours"; "Add HSN to products" | `/owner/branding`; `/owner/products` |
| S16-a | S16 | a schedule; a draft | S17; S3 |
| S21-a | S21 | Pipeline settings | D-PipelineSettings (in place) |
| S22-a | S22 | an at-risk row; "No close date" | `/owner/deals?focus=<id>`; `/owner/deals?view=table&status=open&noCloseDate=1` |
| S22-b | S22 | a goal's "won so far" | `/owner/deals?view=table&status=won&owner=<id>&closedFrom=&closedTo=` |
| S23-a | `/owner` widgets | as for the S1 tiles | same targets |

**Public origin:**

| # | From | Trigger | To |
|---|---|---|---|
| P-a | Customer's email or WhatsApp | the link a person sent | P1 `/i/<token>` |
| P-b | P1 | Pay | Razorpay or Stripe hosted page, then P2 `/pay/thanks?t=` or P3 `/pay/cancelled?t=` |
| P-c | P2 / P3 | "Back to invoice" | P1 |

**Return paths** follow a fixed precedence:

1. an explicit `back`;
2. otherwise the breadcrumb trail (detail pages);
3. otherwise the Finance strip (top-level pages).

Dialogs never navigate on cancel.

### 8.6 Guards in code

The page skeleton every finance page follows:

```tsx
// app/(owner)/owner/finance/expenses/page.tsx
export const metadata = { title: "Expenses" };
export default async function ExpensesPage({ searchParams }: Props) {
  await requireOwnerFeature("expenses");            // module + feature; notFound(); BEFORE any fetch
  const owner = await requireOwnerRoles(FINANCE_ROLES); // persona; redirect("/owner")
  const state = parseExpensesState(await searchParams);
  const result = await ownerTry<ExpenseList>(`/v1/expenses?${expensesQuery(state)}`);
  if (!result.ok) {
    return (<><PageHeader title="Expenses" context="Finance" /><FinanceBar />
             <LoadFailure what="expenses" failure={result} /></>);
  }
  return (<><PageHeader title="Expenses" context="Finance" actions={…} /><FinanceBar /> … </>);
}
```

Two helpers:

- **`requireOwnerRoles(roles)`** is new, in `lib/owner-features.ts`. It replaces the hand-rolled
  persona redirect copied across 9 pages today.
- **`FINANCE_ROLES`** is `["owner", "manager"]`, defined once next to the nav items so the nav and
  the page cannot disagree.

API controllers declare the same three things:

```ts
@UseGuards(AdminKeyGuard, TenantGuard, OrgFeatureGuard, OwnerRoleGuard, CrmPermissionsGuard)
@RequireFeature("expenses") @RequireOwnerRole("owner", "manager")
@Controller("expenses")
export class ExpensesController {
  @Get() @RequireCrmPermission("expense", "view") list(...) {}
  @Post() @RequireCrmPermission("expense", "create") create(...) {}
}
```

### 8.7 Not found, redirects, basePath, public routes

- **Unknown finance URLs.**
  - `finance/[...missing]/page.tsx` calls `notFound()`.
  - `finance/not-found.tsx` renders **inside** the owner chrome, with "Back to Finance". Today the
    only 404 is the root `app/not-found.tsx`, which has no chrome.
  - Put the catch-all on `console-loading.test.ts`'s `NO_LOADER` list.
  - A static segment always beats `[...missing]`, so the catch-all shadows nothing.
- **No redirects needed** (D12). If invoices later move to `/owner/finance/invoices`, the old path
  becomes a `redirect()` stub page on `NO_LOADER` (house convention, see `owner/team`).
- **basePath.** Production serves the console under `/admin`.
  - `<Link>`, `redirect()` and the router add it automatically.
  - Raw `<a href>` (CSV downloads) and `fetch` **do not.** Build them with `withBasePath(path)` in
    a new `lib/base-path.ts`, fix the six existing bare links (defect 11), and add a test (§8.8).
- **Public routes** live on the **public origin, never under `/admin`** (D9). A customer must not
  see "admin" in a URL they were sent.
  - Default host: the marketing app, which is already public and has no console session.
  - The API endpoint is `GET /v1/public/invoices/:token`. It has **no tenant guard;** the token is
    the only credential.
  - Tokens are 32 random bytes, stored only as a SHA-256 hash, with rotate and revoke.
  - Requests are rate-limited per IP, and responses carry `noindex` headers.
  - `PUBLIC_APP_URL` is documented in both env examples (defect 9). Stripe's `success_url` becomes
    `${PUBLIC_APP_URL}/pay/thanks?t=<token>`.

### 8.8 Structural tests to add or update

| Test | Change |
|---|---|
| `lib/nav.test.ts` | Pin the `finance` section and its order. Every new href filed in `OWNER_SECTION_OF`. Persona matrix: finance hidden from sales, telecaller and marketing; forecast visible to sales |
| `lib/owner-rail.test.ts` | Unchanged assertions must still pass: cap of 7, each page exactly once |
| `lib/finance-tabs.test.ts` (new) | Strip ⊆ rail both ways; collapses below 2; CRM-only tenant gets Invoices, Credit notes, Settings |
| `app/console-loading.test.ts` | Loaders for every new page. `NO_LOADER` for the catch-all. The Invoices context changes to "Finance" in the page, NavItem and loader **together** |
| `app/(owner)/owner-features.guard.test.ts` | **Extend to nested pages:** every `page.tsx` under a gated href must call its gate before the first fetch. Also check `ownerTry` and `Promise.all`, not only `ownerGet` (fixes defect 7 and the checker's own blind spot) |
| `lib/feature-gating.test.ts`, `packages/shared/src/features.test.ts` | New features: catalogue ↔ nav agreement; all default on; cross-module `requires` resolves |
| `app/(owner)/owner-actions.guard.test.ts` (new) | Every owner `actions.ts` export calls `ownerHeaders()` first (the `(platform)` precedent) |
| `app/base-path.test.ts` (new) | No `<a href="/owner` or `fetch("/owner` in `(owner)` or `components` without `withBasePath` |
| `apps/api/src/common/guard-mounting.spec.ts` | Every new route listed and the counts updated (it is treated as a security control). Public routes listed explicitly as public |
| `permissions-inventory.spec.ts` | New `payment`, `expense` and `finance_report` cells appear as enforced |
| `packages/shared/src/notification-kinds.test.ts` | The last CHECK equals the zod enum after each kind is added |
| `packages/shared/src/automation.test.ts` | Actions list unchanged. Only a trigger (`invoice.paid`) is added, if F3 takes that option |
| `apps/web/lib/review-queue.test.ts` | Per-persona sources include `finance_approval` for owner and manager |

---

## 9. Data model and the metric dictionary

### 9.1 Migrations

The numbers are provisional: take the next free number at the time. Two files already share 0083,
so check before writing.

Every new table follows the 0059 pattern:

- `org_id NOT NULL`, with ENABLE + **FORCE** RLS and an `org_isolation` policy on
  `current_setting('app.org_id')`;
- GRANT to `aura_app`, REVOKE from anon/authenticated/service_role/PUBLIC;
- an `updated_at` trigger;
- a rollback file in `packages/db/rollback` (0059, 0060 and 0099 lack one);
- a mirror in `supabase/migrations`, via `node scripts/sync-supabase-migrations.js`.

| # | Phase | File | Contents |
|---|---|---|---|
| 0124 | F0 | `invoicing_repairs` | • `payments.gateway_payment_id` plus a partial unique index on `(provider, gateway_payment_id)`, backfilled from the Razorpay and Stripe ids. This is the idempotency key that stops double credit<br>• `payments.amount_captured` |
| 0125 | F1 | `finance_module_permissions` | • Seeds `payment`, `expense` and `finance_report` grants from `invoice` grants, with a `RAISE WARNING` count of stranded memberships<br>• Notification kind `payment_received`, restating the **full** CHECK<br>• The module value needs no SQL (zod-validated) |
| 0126 | F1 | `billing_profile` | • `org_billing_profiles` (PK `org_id`): legal and trade name, `gstin` (loose format CHECK; checksum in the app), `state_code` (01–38, 97), `pan`, `address jsonb`, `email`, `phone`, `base_currency`, `fy_start_month` 1..12 default 4, `default_terms_days` default 15, `round_off bool`, `upi_id`, `bank` (sealed with `packages/db/secrets.ts`), `doc_settings jsonb`, `numbering jsonb`, `prices_include_tax_default`<br>• `accounts` gains `gstin`, `state_code`, `pan`, `billing_address jsonb`<br>• `contacts` gains `state_code`, `billing_address jsonb` (place of supply for B2C) |
| 0127 | F1 | `document_numbering` | • `document_counters (org_id, doc_type, fiscal_year, next_value, PK(org_id, doc_type, fiscal_year))`<br>• `next_document_number(org, doc_type, on_date)`<br>• `invoices.invoice_number` becomes **nullable** (drafts). The unique index already allows many NULLs<br>• `next_invoice_number` stays for rollback only |
| 0128 | F1 | `invoice_lifecycle` | **`invoices`:** `issue_date`, `issued_at`, `issued_by`, `paid_at`, `voided_at`, `voided_by`, `void_reason`, `is_inter_state`, `seller_snapshot jsonb`, `buyer_snapshot jsonb`, `tax_total` (fixes the phantom column), `amount_credited`, `prices_include_tax`, `round_off`, `revision`, `last_sent_at`, `last_sent_channel`, `share_token_hash` (unique), `share_token_created_at`, `share_revoked_at`. Status CHECK becomes `draft, sent, partially_paid, paid, credited, void`<br>**`invoice_items`:** `taxable_value`, `tax_amount`, `cgst`, `sgst`, `igst`<br>**`quotation_items`, `products`:** `hsn_sac`<br>**`quotations`:** `invoiced_total`, `accepted_at`, `revision`<br>**`payments`:** `kind` (payment, tds, refund), `method`, `reference`, `received_on`, `note`, `recorded_by_user_id`, `reversed_at`, `reversed_by`, `reverse_reason`, `refund_of_payment_id`, `credit_note_id`; status adds `expired`<br>**Functions and views:** `recompute_invoice()`, view `invoice_balances` (§9.3)<br>**Backfill:**<br>• `issue_date` = `created_at::date` for issued invoices<br>• `tax_total` = cgst + sgst + igst<br>• recompute every status; stored `overdue` becomes `sent` or `partially_paid`<br>• set `is_inter_state` from `igst > 0` |
| 0129 | F1 | `credit_notes` | • `credit_notes`: `invoice_id NOT NULL`, number (NULL until issued), status, reason CHECK, `issue_date`, currency, subtotal, tax_total, cgst/sgst/igst, total, `is_inter_state` (from the invoice), notes, revision, issued and voided audit columns<br>• `credit_note_items`: carries `invoice_item_id` |
| 0130 | F2 | `expenses` | • `vendors`: name, gstin, pan, state_code, address, email, phone, sealed bank details, default category, `deleted_at`<br>• `expense_categories`: name, archived; defaults are seeded lazily per org<br>• `expenses`: vendor, category, `expense_date`, `bill_number`, `bill_date`, description, currency, `gst_mode` (exclusive, inclusive, exempt), `gst_rate`, taxable, tax, cgst/sgst/igst, `itc_eligible`, `tds_rate`, `tds_amount`, `payable`, status, `paid_on`, method, reference, `receipt_key` (S3), revision, `deleted_at`<br>• `recurring_expenses`: template, `frequency`, `next_due`, `lead_days`, `active`<br>• All wired into the recycle-bin registry (0108) |
| 0131 | F3 | `pipeline_forecast` | • `deals.probability smallint NULL CHECK 0..100`<br>• `deals.closed_at` with a trigger, backfilled from `deal_stage_transitions` (latest move into won or lost). Deals closed with no ledger row fall back to `stage_changed_at`, and are counted in the migration output<br>• `deal_pipelines.won_on_invoice_paid jsonb NULL` (NULL = off; `{stageKey}`)<br>• Stage probability lives in `deal_pipelines.stages` jsonb and needs the zod change in §11.1 |
| 0132 | F4 | `collections` | • `collection_ladders`: name, active, `min_amount`, `default_assignee_user_id`<br>• `collection_ladder_steps`: `step_index`, `offset_days`, channel, label, template, `escalate bool`<br>• `invoice_collection_steps`: copies of the step at issue; status; `due_at`; `acted_by`/`acted_at`; outcome; `promised_on`; `promised_amount`; note; `UNIQUE(invoice_id, ladder_id, step_index)` is the double-fire guard<br>• Notification kind `collection_due` |
| 0133 | F4 | `approvals` | • `approval_policies` (object_type, min_amount, active)<br>• `approval_policy_stages` (index, persona)<br>• `approval_requests` (object_type, object_id, revision, policy, stage_index, status, requested_by, decided_by, decided_at, comment). CHECKs require a complete decision and requested_by ≠ decided_by |
| 0134 | F5 | `billing_schedules` | • `billing_schedules`: customer, currency, interval (month, quarter, year) × count, `start_date`, `end_date` or `total_cycles`, `lead_days`, status, `cancel_at_period_end`, deal, owner<br>• `billing_schedule_lines`<br>• `billing_schedule_cycles` (cycle_no, invoice_id, `UNIQUE(schedule, cycle_no)`)<br>• `billing_schedule_events` (kind, mrr_delta, occurred_at)<br>• Notification kind `billing_draft_ready` |
| 0135 | F6 | `dashboard_layouts` | `dashboard_layouts (org_id, user_id, layout jsonb, version, updated_at, PK(org_id, user_id))`. The API also filters on `user_id`, following the `saved_views` precedent |

**Never** a second invoice table, a second payments table, or a table per subscription kind (rule 3).

### 9.2 Snapshots: what freezes at issue

An issued document must not change when the account behind it is edited later. That is a GST
requirement, and it is also why erasure keeps invoiced records (`erasure.controller.ts:209-218`).

| Frozen into | Fields | Source at issue |
|---|---|---|
| `seller_snapshot` | legal name, trade name, GSTIN, state code, PAN, address, bank, UPI | `org_billing_profiles` |
| `buyer_snapshot` | name, GSTIN, state code, billing address, email, phone | the account, else the contact |
| `place_of_supply` | a state code | buyer state, else seller state (India B2C default); editable before issue |
| `is_inter_state` | boolean | seller state ≠ place of supply. Decided **server-side only**, and `interState` is removed from the API input (defect 5) |

### 9.3 Functions and views

- **`next_document_number(org, doc_type, on_date)`:**
  - derives the fiscal-year key (`2026-27`) from `fy_start_month`;
  - increments `document_counters` with `INSERT … ON CONFLICT … DO UPDATE … RETURNING`, which is
    atomic, with **no `count(*)+1`** and no retry loop;
  - renders the org's pattern, validates the 16-character limit, and refuses to save a pattern that
    could exceed it.
- **`recompute_invoice(invoice_id)`:**
  - takes `SELECT … FOR UPDATE` on the invoice;
  - sums **paid** payment rows (payment + TDS − refunds, excluding reversed rows) and **issued**
    credit notes;
  - writes `amount_paid`, `amount_credited`, `status` and `paid_at`.

  **Every writer calls it inside its own transaction:** both webhooks, manual receipt, TDS, refund,
  reversal, and credit-note issue and void. Nothing else writes those four columns, and a test
  greps for other writers.
- **`invoice_balances`,** a view with `WITH (security_invoker = true)`, provides per invoice:
  `settled`, `balance`, `overpaid`, `is_overdue`, `days_overdue`, `aging_bucket` (against
  `org_reporting_today()`).
  - ⚠ **This will be the first view in the schema.** A plain Postgres view runs with its owner's
    rights and **bypasses FORCE RLS**, which would leak across tenants.
  - `security_invoker` needs Postgres 15 or later: check the self-hosted Supabase version first.
    If it is older, use a `SECURITY INVOKER` SQL function instead.
  - Add an isolation-suite case for it either way.
- **`deals` trigger** (F3): `closed_at = now()` when status becomes won or lost; NULL when the deal
  reopens.
- **Money arithmetic:**
  - `numeric`, rounded **per line** to 2 decimal places;
  - document totals are sums of rounded lines;
  - CGST = round(tax / 2, 2) and SGST = tax − CGST, so the pair always adds up exactly;
  - an optional round-off line rounds the grand total to the rupee.

  One shared function computes this (§11.1), and the API stores its output. The browser previews
  with the same function but never submits totals.

### 9.4 The metric dictionary

Each metric is defined **once** as a named SQL fragment in
`apps/api/src/modules/finance/metrics.sql.ts`. The overview, reports, dashboard widgets and CSV
exports all use it. `verify-finance.cjs` executes it (§14).

**Conventions:**

- A period P is a pair of calendar dates in the org's reporting timezone, inclusive at both ends.
- Timestamps are converted `AT TIME ZONE` that timezone.
- Date columns are emitted with `to_char`: the day-early bug from memory note `crm-track-a`.
- Every money metric filters on one currency.
- Drafts and voided documents are excluded unless stated.

| Metric | Definition | Why it differs from MyAppz (doc 25) |
|---|---|---|
| **Billed** | Σ `invoices.total`, status ∉ {draft, void}, `issue_date` ∈ P | — |
| **Billed (taxable)** | Σ (`total` − `tax_total`), same filter | Revenue excludes GST, which is owed to the government |
| **Credited** | Σ `credit_notes.total`, issued, `issue_date` ∈ P | MyAppz has no credit notes in its revenue maths |
| **Net billed** | Billed − Credited | — |
| **Collected** | Σ paid `payments.amount` with `kind=payment` received in P − Σ `kind=refund` in P. "Received" = `received_on` (manual) or `captured_at` in org tz (gateway) | TDS is excluded: it isn't cash |
| **TDS deducted** | Σ paid `kind=tds` received in P | Not in MyAppz |
| **Outstanding (as at D)** | Σ positive balances over invoices issued on or before D and not voided by D, counting only payments, TDS, refunds and credits dated on or before D | MyAppz can only answer for "now" |
| **Overdue (as at D)** | Outstanding restricted to `due_date` < D | — |
| **Collection rate (P)** | For invoices **issued in P**: Σ min(settled now, total) ÷ Σ total × 100, 1 decimal place | MyAppz divides cash collected in P, from any invoice, by billed in P and clamps to 100 (§5.4), a cohort mismatch. Its Analytics page uses a count ratio instead (§10.6). One definition here |
| **DSO (P)** | Outstanding at the end of P ÷ Net billed in P × days in P; "—" when net billed = 0 | MyAppz divides by cash, not credit sales |
| **Average invoice (P)** | Billed ÷ count of invoices issued in P | MyAppz divides by the *paid* count (§10.6) |
| **Invoices paid (P)** | count with `paid_at` ∈ P | — |
| **Change %** | (cur − prev) ÷ \|prev\| × 100 against the preceding equal-length window. prev = 0 and cur > 0 shows "new"; both 0 shows "—" | MyAppz shows 100 % |
| **Aging bucket** | days = D − `due_date`: ≤ 0 current, 1–30, 31–60, 61–90, 90+ | Same buckets |
| **Expenses (P)** | Σ (taxable + GST where `itc_eligible` = false), `expense_date` ∈ P, status ∈ {unpaid, paid} | Recoverable GST is not a cost |
| **Net revenue (accrual)** | Billed (taxable) − Credited (taxable) | — |
| **Net profit (accrual)** | Net revenue − Expenses | MyAppz's P&L uses `limit(500)` fetches (§10.4) |
| **Cash basis** | Revenue = each receipt × its invoice's taxable share (taxable ÷ total). Expenses = paid expenses by `paid_on` | Offered as a toggle, labelled |
| **GST output (P)** | Σ line tax on invoices issued in P − credit-note tax in P; IGST when `is_inter_state`, else CGST/SGST | Stored once per document, never both pairs (§10.7) |
| **GST input / ITC (P)** | Σ expense GST where `itc_eligible`, `bill_date` (else `expense_date`) ∈ P | — |
| **Net GST payable** | Output − input, per tax head | — |
| **Open pipeline** | Σ `deals.amount`, status open | Deals have no currency: base currency assumed, and stated on screen |
| **Weighted pipeline** | Σ amount × p ÷ 100, p = COALESCE(deal probability, stage probability, the existing positional default) | Today's positional default stays as the last fallback, so nothing moves until someone sets a probability |
| **Forecast N days** | Weighted value of open deals with `expected_close_date` ∈ [today, today + N] | — |
| **Win rate (P)** | won ÷ (won + lost) with `closed_at` ∈ P | Uses the new `closed_at`, not `stage_changed_at` |
| **Cycle time (P)** | avg(`closed_at` − `created_at`) in days, over deals won in P | — |
| **At risk** | open AND (idle ≥ pipeline `stale_after_days` OR p < 20 OR `expected_close_date` < today) | MyAppz hard-codes 14 days; this uses each pipeline's own threshold |
| **Goal attainment** | won value (or count) with `closed_at` in the goal period ÷ target. **Not capped** | MyAppz caps at 100 % |
| **MRR** (F5) | Σ active schedules' monthly amount (month ÷ 1, quarter ÷ 3, year ÷ 12). Paused and trialling schedules are excluded | One interval vocabulary. Trials are not revenue (§10.6) |
| **MRR movement** (F5) | Per month from `billing_schedule_events`: new, **expansion**, contraction, churned, reactivated | Expansion is real, not 0 (§10.5) |
| **Churn rate** (F5) | Churned MRR in the month ÷ MRR at the start of the month | — |
| **MRR forecast** (F5) | Current MRR with the trailing-6-month observed churn applied. **Fewer than 3 months of history shows "Not enough history yet"** | Not a hard-coded 5 % (§10.5) |

**Commission:** today's commission report also windows on `stage_changed_at`. F3 moves goals,
forecast and team to `closed_at`, but **leaves commission unchanged** unless you decide otherwise,
because it changes payouts (Q11).

---

## 10. API surface

The global prefix is `/v1`. "Guards" lists the feature, persona and grid permission; record scope
applies everywhere. Every route goes into `guard-mounting.spec.ts` and gets an isolation-suite case
that **reaches the handler** (memory note `isolation-suite-drift`: a case that 403s at the guard
proves nothing).

### 10.1 F0: repairs to existing routes

| Route | Change |
|---|---|
| `PUT /owner/payment-settings` | `ON CONFLICT (org_id, provider)`; takes `provider` (razorpay or stripe); Stripe fields added |
| `GET /owner/payment-settings` | Filter on provider; return both cards |
| `POST /webhooks/razorpay`, `/webhooks/stripe` | Config read filtered on provider. Idempotency on `gateway_payment_id`. Credit the **captured** amount. Call `recompute_invoice` (after F1; until then cap `amount_paid`). Both publish realtime |
| `POST /invoices/:id/payment-link` | Honour `provider`. Cancel the previous live link. Refuse when the balance is 0 |
| `PATCH /invoices/:id` | **Refuse status changes** and refuse line edits outside draft (409). `interState` removed from input |
| `POST /invoices/from-quotation/:id` | Accepted only. Copy notes and owner. Stamp the owner as caller or quotation owner. Refuse repeat conversion (F1 adds "part") |
| products, quotations, invoices, payments controllers | Add `OrgFeatureGuard` + `@RequireFeature` |
| `pipelines`, `commission-plans` controllers | Writes gain `@RequireOwnerRole("owner","manager")` |

### 10.2 F1: receivables core

| Method and path | Guards | Purpose |
|---|---|---|
| `GET /finance/settings` · `PUT /finance/settings/{business,numbering,taxes,documents}` | `billing_settings` · GET o,m; PUT **owner** | Business profile and document settings |
| `POST /invoices` · `PATCH /invoices/:id` · `DELETE /invoices/:id` | `invoices` · o,m · `invoice:create/edit/delete` | Drafts |
| `POST /invoices/:id/issue` · `POST /invoices/:id/void` | `invoices` · o,m · `invoice:edit` | §6.1 |
| `POST /invoices/:id/sent` | `invoices` · o,m · `invoice:edit` | Record that a person sent it |
| `POST /invoices/:id/share-link` · `DELETE /invoices/:id/share-link` | `invoices` · o,m · `invoice:edit` | Create or rotate, and revoke, the public token |
| `POST /invoices/:id/payments` · `POST /invoices/:id/refunds` | `invoices` · o,m · `payment:create` / `payment:edit` | Manual receipt and TDS; refund |
| `POST /payments/:id/reverse` · `GET /payments` | `invoices` / `payments_ledger` · o,m · `payment:edit` / `payment:view` | Reverse; ledger |
| `POST /invoices/:id/credit-notes` · `GET /credit-notes` · `GET`/`PATCH /credit-notes/:id` · `POST /credit-notes/:id/{issue,void}` | `credit_notes` · o,m · `invoice:*` | §6.3 |
| `GET /finance/overview` | `finance_overview` · o,m · `finance_report:view` | S1, one call |
| `GET /accounts/:id/billing` · `GET /contacts/:id/billing` | `invoices` · o,m · `invoice:view` | S20 card |
| `GET /finance/statement` | `invoices` · o,m · `invoice:view` | S18 |
| `GET /public/invoices/:token` | **public**, throttled | P1 render model |
| `GET /invoices` (extended) | as today | New filters from §8.4, plus `balance` and `is_overdue` in rows |

### 10.3 F2: expenses and reports

| Method and path | Guards | Purpose |
|---|---|---|
| `GET`/`POST /vendors` · `GET`/`PATCH`/`DELETE /vendors/:id` | `expenses` · o,m · `expense:*` | Vendors |
| `GET`/`POST /expense-categories` · `PATCH`/`DELETE /expense-categories/:id` | `expenses` · owner for writes · `expense:*` | Categories |
| `GET`/`POST /expenses` · `GET`/`PATCH`/`DELETE /expenses/:id` · `POST /expenses/:id/pay` | `expenses` · o,m · `expense:*` | Expenses |
| `POST /expenses/receipt-upload` · `GET /expenses/:id/receipt` | `expenses` · o,m · `expense:create` / `expense:view` | Presigned PUT and GET through the existing `S3Service` (prefix `finance/receipts/<org>/`) |
| `GET`/`POST /recurring-expenses` · `PATCH`/`DELETE /recurring-expenses/:id` | `expenses` · o,m · `expense:*` | Templates |
| `GET /finance/reports/:tab` · `GET /finance/reports/:tab/export` | `finance_reports` · o,m · `finance_report:view` / `:export` | S13 and CSV. Every tab is server-side SQL from §9.4 |

### 10.4 F3: forecasting

| Method and path | Guards | Purpose |
|---|---|---|
| `PATCH /pipelines/:id` (extended) | o,m (new) | Stage probabilities; `wonOnInvoicePaid` |
| `PATCH /deals/:id` (extended) | `deal:edit` | `probability` (0–100 or null), `expectedCloseDate` |
| `GET /deals` (extended) | `deal:view` | `noCloseDate`, `closedFrom`, `closedTo` filters |
| `GET /reports/forecast` | `forecast` · o,m,s · `deal:view` (scoped) | S22 |
| `PATCH /targets/:id` (new) · `GET`/`POST`/`DELETE /targets` (existing) | `forecast` · writes o,m · `deal:edit` | Goals in the owner console |

**Auto-Won** runs inside the transaction that makes an invoice `paid`, whether by webhook or manual
receipt:

- **Conditions:** the invoice has a `deal_id`, that pipeline has `won_on_invoice_paid`, and the deal
  is `open`.
- **Effect:** the deal moves to the configured Won stage, the ledger gets a row with
  `source='billing'`, and `deal.stage_changed` is queued. A webhook is neither the rule executor nor
  a sweep, so this does not reopen the loop guard.

### 10.5 F4: collections and approvals

| Method and path | Guards | Purpose |
|---|---|---|
| `GET`/`POST /collections/ladders` · `PATCH`/`DELETE /collections/ladders/:id` | `collections` · owner | Ladders |
| `GET /collections/due` | `collections` · o,m · `invoice:view` | S8 (`view`, `mine`) |
| `PATCH /collections/steps/:id` | `collections` · o,m · `invoice:edit` | done, skip, outcome, promise |
| `POST /invoices/:id/collections/{pause,resume}` | `collections` · o,m · `invoice:edit` | Per-invoice control |
| `GET`/`POST /approval-policies` · `PATCH`/`DELETE /approval-policies/:id` | `finance_approvals` · owner | Policies |
| `POST /approvals` · `GET /approvals` · `POST /approvals/:id/{approve,reject,withdraw}` | `finance_approvals` · per stage persona | Requests and decisions |

### 10.6 F5 and F6

| Method and path | Guards | Purpose |
|---|---|---|
| `GET`/`POST /billing-schedules` · `GET`/`PATCH /billing-schedules/:id` · `POST /billing-schedules/:id/{pause,resume,cancel}` | `recurring_billing` · o,m · `invoice:*` | F5 |
| `GET /finance/reports/mrr` | `finance_reports` · o,m | F5 |
| `GET`/`PUT`/`DELETE /me/dashboard-layout` | any member; the service pins `user_id` | F6 |

### 10.7 Worker jobs

Every job follows the `sla-breach.ts` / `followup-reminders.ts` shape:

- find work across tenants on the admin pool;
- write under `withOrgContext`;
- use `ON CONFLICT` dedupe;
- gate with `org_feature_enabled()`;
- set its interval from an env var;
- ship with a test.

**None imports a dispatcher.**

| Job | Phase | Interval | Does |
|---|---|---|---|
| `recurring-expenses.ts` | F2 | hourly | Creates **draft** expenses `lead_days` before they are due; raises a notification |
| `collections.ts` | F4 | 5 min | Moves waiting steps to due and raises `collection_due` (dedupe per step). Cancels the steps of settled invoices. Wakes paused steps after the promise date plus grace |
| `billing-schedules.ts` | F5 | hourly | Creates **draft** invoices for due cycles (unique per schedule and cycle) and raises `billing_draft_ready` |

---

## 11. Shared building blocks

### 11.1 `packages/shared/src`

| File | Contents |
|---|---|
| `finance.ts` (new) | Status enums and zod inputs for invoices, payments, credit notes and expenses. They **replace** the copies declared locally in controllers and web `actions.ts`, following the "import, don't re-declare" rule. ⚠ PATCH schemas must not be `Input.partial()` over fields with `.default()` (memory note `zod-partial-default-trap`) |
| `gst.ts` (new) | GSTIN format and checksum; the state-code table (01–38, 97); place-of-supply and inter-state decision; CGST/SGST split with exact rounding; amount in words (Indian numbering) |
| `quotations.ts` (extend) | `computeDocumentTotals` returns a per-line breakdown (taxable, tax) and supports tax-inclusive prices (taxable = total ÷ (1 + r)). Fix the two stale comments (defect 5) |
| `finance-period.ts` (new) | Presets, FY boundaries, previous window, labels |
| `leads.ts` (`LeadStage`) | Add an optional `probability` (0–100). The lead board shares this schema and ignores the field. Zod currently **drops unknown keys**, which is why the field must be declared |
| `org-modules.ts`, `features.ts`, `permissions.ts`, `notifications.ts` | New module, features, objects and kinds (§4, §9.1) |
| `collections.ts`, `approvals.ts`, `billing-schedules.ts`, `dashboard-widgets.ts` | Per-phase shapes |

### 11.2 Web components

| Component | Notes |
|---|---|
| `components/finance/invoice-document.tsx` | One render used by S4, S7-print and P1 |
| `components/finance/line-item-editor.tsx` | Replaces the bare `use-line-item-rows` use: a **product picker** (reusing `record-picker.tsx`), HSN, live totals from the shared function, and inclusive/exclusive switching |
| `components/finance/money.tsx` | `formatMoney(amount, currency)` everywhere. Fixes `linked-records`, which ignores currency |
| `components/finance/doc-status-chip.tsx`, `overdue-chip.tsx` | Tones follow the colour rule: no red; overdue = `warning` + text; failed = orange error; the rest grey. The palette test must pass |
| `components/finance/*-dialog.tsx` | One component per D-dialog, usable in place from any screen (for example D-RecordPayment from S1, S3, S5, S8, S20) |
| `components/finance/finance-bar.tsx` + `FinanceStripSkeleton` | §8.2 |
| `components/period-picker.tsx` | Preset `FilterLink`s plus two native `<input type="date">` for custom. **No new dependency;** the kit has no date picker |
| `components/link-tabs.tsx` | URL-driven tabs extracted from the Staff page pattern (`?tab=` links with `aria-current`). The kit has no Tabs, and S13, S15, S22, S8 and S9 need them |
| `components/charts/` | **One Recharts seam** for finance, the way `chart-surface.tsx` is for the report builder. It provides area (dashed comparison), aging bars, donut with legend list, ranked horizontal bars, grouped bars, and signed stacked bars (F5). Doc 25 §7 conventions, in brief:<br>• theme tokens only; 260 px cards<br>• no animation; loading via `ChartCardSkeleton`; empty = icon + one sentence<br>• an **sr-only summary plus table fallback,** as the hand-rolled charts have today |
| `components/finance/kpi-tile.tsx` | `StatCard` plus a change chip and an `InfoHint` showing Source / Formula / Period from §9.4 |
| `lib/base-path.ts` | `withBasePath()`, fixing defect 11 |

### 11.3 Dashboard widget registry (F6)

- **Shape:** `{id, label, category, variant: "stat"|"chart"|"list"|"panel", source, dataPath,
  format, personas, module?, feature?, defaultFor: Partial<Record<OwnerRole, {order, colSpan}>>,
  description}`.
- **Initial catalogue:**
  - today's panels: NextActions, PipelineByStage, CallOutcomes, ActivityChart, TelecallerTable,
    TeamRollup, RecentActivity, SourceBreakdown, CampaignTable, and the four KPI tiles per persona;
  - finance tiles: Outstanding, Overdue, Collected, Billed, Collection rate, DSO, Expenses, Net
    profit;
  - forecast tiles: Weighted pipeline, 30-day forecast, Goal attainment.
- **Persona defaults** reproduce today's five fixed layouts exactly, so shipping F6 changes nothing
  until someone presses Customise.
- **Server-only persistence** (`dashboard_layouts`). MyAppz keeps a second copy in `localStorage`;
  that is not copied.
- **Validation:** unknown ids are dropped, and `version` enables one-time layout migrations.

---

## 12. Missing features and how they are filled

### 12.1 Gaps in Aura that doc 25 shows how to fill

| Gap | Solution | Phase |
|---|---|---|
| No finance dashboard | S1 with the §9.4 metrics | F1 |
| No partial payments, manual receipts or refunds | Payment kinds plus `recompute_invoice` | F1 |
| No credit notes | `credit_notes` + S6/S7 | F1 |
| No AR aging or outstanding reports | S13 `aging`, `outstanding` | F2 |
| No expenses or vendors | 0130 + S9–S12 | F2 |
| No P&L or GST report | S13 `pnl`, `gst` | F2 |
| No FY numbering | `document_counters` | F1 |
| No UPI QR on invoices | S4 QR from the business profile's UPI ID | F1 |
| No probability, forecast, win rate or at-risk view | F3, S22 | F3 |
| No "Won when paid" | Per-pipeline opt-in | F3 |
| No reminders, dunning or approvals | Ladders as human work; approval policies in the review queue | F4 |
| No recurring billing or MRR | One schedule model, drafts only | F5 |
| Fixed dashboards | Widget registry and per-user layout | F6 |

### 12.2 Gaps neither product fills, or MyAppz fills wrongly

| # | Gap | Solution | Phase |
|---|---|---|---|
| 1 | Issued invoices can be edited (MyAppz edits paid invoices; Aura edits everything) | Lines lock at issue; corrections only by credit note | F0/F1 |
| 2 | Numbers consumed by drafts; calendar-year series | Number at issue, per FY, 16-character limit | F1 |
| 3 | Seller and buyer data not frozen | Snapshots at issue (§9.2) | F1 |
| 4 | **TDS deducted by customers** (common in Indian B2B) not handled | `kind=tds` settles without counting as cash | F1 |
| 5 | Tax-inclusive prices (MyAppz has them; Aura doesn't) | `prices_include_tax` per document | F1 |
| 6 | No way to hand a customer their invoice (Aura: no PDF, no attachments) | P1 public page and D-Send through the existing composer | F1 |
| 7 | No customer statement of account | S18 | F1 |
| 8 | Overpayment silently absorbed or capped | Recorded, flagged, refundable | F1 |
| 9 | Owners can't set sales targets in their own console | S22 goals tab + `PATCH /targets/:id` | F3 |
| 10 | `expected_close_date` exists but is never shown | Drawer, table, filter | F3 |
| 11 | No `closed_at`, so "won when" is read from `stage_changed_at` | Trigger + backfill | F3 |
| 12 | Line editor lacks a product picker and live totals | `line-item-editor.tsx` | F1 |
| 13 | Linked records show UUIDs | Names from the API | F0 |
| 14 | No date-range picker, no Tabs, no chart kit | `period-picker`, `link-tabs`, `components/charts` | F1 |
| 15 | Nav/route drift and nested pages ungated | §8.8 tests | F0/F1 |
| 16 | Invoice history invisible (`audit_log` exists but isn't shown) | History section on S3 | F1 |
| 17 | Nobody is told when money arrives | `payment_received` notification to the invoice owner | F1 |
| 18 | Setup demands gateway keys even for cash-and-UPI businesses | The required step becomes the business profile (Q10) | F1 |
| 19 | Staged or advance billing of a quotation | "Invoice part" + `invoiced_total` | F1 |
| 20 | Report builder's invoices source gated on `deal:view` | Gate on `invoice:view`; add payments, credit-note and expense sources | F7-10 |
| 21 | No accountant persona | F7-1 | F7 |

### 12.3 MyAppz traps, and what this plan does instead (doc 25 §10)

| Doc 25 §10 item | This plan |
|---|---|
| 1. Browser-side money writes; the wallet race | Every money write is an API transaction; `recompute_invoice` holds `FOR UPDATE` |
| 2. Fail-open gates | Every layer fails closed (§4.4) |
| 3. Three subscription tables, two invoice tables | One of each (§9.1) |
| 4. Aggregation over capped fetches | SQL only (§9.4). `verify-finance.cjs` runs every query |
| 5. Placeholder analytics | Real expansion MRR, observed churn, "not enough history"; no fake Retry; no mock gateway |
| 6. Inconsistent metric definitions | One dictionary (§9.4), one interval vocabulary |
| 7. IGST and CGST/SGST both stored | Only the applicable pair, decided server-side |
| 8. Hard-coded locale and tax | Base currency and rates from settings; no client FX |
| 9. Automated sends | Ladders and schedules create work; tables can't hold a recipient; a test asserts it |
| 10. Nav/route drift | Nav-derived strip; §8.8 tests |

---

## 13. Delivery plan

Sizes are rough estimates for one engineer who knows the codebase (S ≈ 1–3 days, M ≈ 1 week, L ≈
2–3 weeks). They are estimates, not commitments.

```
F0 ─► F1 ─┬─► F2 ─────────────┐
          ├─► F4 ─────────────┼─► F6 ─► (F5 if D6 = yes) ─► F7 items as decided
F3 ───────┴─ (auto-Won needs F1)┘
```

F3 is independent and can run in parallel from day one. Only its auto-Won half waits for F1's
status machine.

### 13.1 F0: repair today's invoicing (M)

- **Scope:** every §3.2 defect; §10.1 routes; P2 and P3 pages; migration 0124; Stripe settings UI.
- **Tests:**
  - reproduce defects 1–5 against local Postgres first;
  - webhook replay: same payment id twice, and both Razorpay events;
  - payment-settings save for both providers;
  - `PATCH` refuses a status change;
  - guard tests from §8.8 for nested gates, owner actions and basePath.
- **Exit:**
  - a saved Razorpay key survives a reload;
  - a Stripe checkout lands on P2;
  - replaying a webhook changes nothing;
  - no UI path can set "paid".
- **Deploy note:** defect 1 means every production tenant is currently unable to save gateway
  keys. **F0 is worth shipping on its own.**

### 13.2 F1: receivables core (L)

- **Scope:**
  - migrations 0125–0129;
  - §10.2 routes;
  - S1–S7, S15 (business, numbering, taxes, gateways, documents), S18, S20, P1;
  - D-NewInvoice, D-Issue, D-Send, D-Share, D-RecordPayment, D-Reverse, D-Refund, D-CreditNote,
    D-Void, D-InvoicePart;
  - nav section, strip, period picker, link tabs, charts seam;
  - Outstanding and Overdue tiles on the owner and manager dashboards.
- **Build order inside F1:**
  1. schema and `recompute_invoice`;
  2. issue, void and payments API;
  3. S3 rework;
  4. credit notes;
  5. print and P1;
  6. overview;
  7. ledger.
- **Tests:**
  - golden fixture (§14);
  - numbering concurrency: 50 parallel issues produce 50 distinct consecutive numbers;
  - two simultaneous receipts cannot overpay;
  - inter- vs intra-state split;
  - FY rollover on 1 April;
  - public token (revoked or unknown → the same page; rate limit);
  - persona walkthrough.
- **Exit:**
  - an invoice goes draft → issued → partially paid (manual) → paid (gateway), with the correct
    statuses, balances, S1 numbers and GST split throughout;
  - a credit note on a paid invoice produces "refund due", and recording the refund zeroes it.

### 13.3 F2: expenses and statements (L)

- **Scope:** 0130; §10.3; S9–S14; the `categories` tab; the recurring-expenses job; the Expenses
  and Net-profit panels on S1; CSV exports.
- **Tests:**
  - golden fixture extended with expenses, including ITC and non-ITC, TDS, and inter-state vendors;
  - P&L, GST and aging totals equal the hand-computed values;
  - the CSV export equals what the screen shows.
- **Exit:** a month-end run (§5.8) on the fixture matches the hand-computed P&L and GST liability to
  the paisa.

### 13.4 F3: pipeline forecasting (M)

- **Scope:** 0131; §10.4; S21 changes; D-PipelineSettings; S22; D-Goal; auto-Won after F1.
- **Tests:**
  - the `closed_at` trigger across all five stage writers;
  - backfill count report;
  - a probability override beats the stage default;
  - weighted and 30/60/90 values against a fixture;
  - auto-Won fires once, never on a Lost deal, and never when the pipeline is off;
  - goals visible to sales read-only.
- **Exit:** a manager can set stage probabilities and goals, and the forecast numbers equal the
  deals list they link to.

### 13.5 F4: collections and approvals (M–L)

- **Scope:** 0132–0133; §10.5; the collections job; S8; the `collections` and `approvals` tabs of
  S15; S24 source; approval panels on S3, S7, S10 and S19; NextActions integration.
- **Tests:**
  - a ladder materialises on issue and stops when paid;
  - promise-to-pay pauses and resumes;
  - **no-send proof:** count the outbound queues before and after a sweep (the
    `e2e-report-schedule.cjs` method);
  - approvals: no self-approval; an edit after approval supersedes; a multi-stage policy advances.
- **Exit:** an overdue invoice appears in S8 for its owner, and the reminder leaves only when that
  person presses Send.

### 13.6 F5: recurring billing (L, only if D6 = yes)

- **Scope:** 0134; the schedule routes; the job; S16, S17; the `mrr` report tab.
- **Tests:** draft generation is idempotent per cycle; MRR movement categories sum to the MRR
  change; the churn forecast refuses when there are fewer than 3 months of history.

### 13.7 F6: dashboard customisation (M)

- **Scope:** 0135; `/me/dashboard-layout`; the registry; customise mode.
- **Tests:**
  - each persona's default reproduces today's layout exactly (snapshot of widget ids and order);
  - a widget hidden by persona or module never renders even when it is in a stored layout;
  - keyboard reordering.

### 13.8 F7: optional follow-ons (each needs its own yes)

| # | Item | Notes |
|---|---|---|
| F7-1 | `finance` persona (bookkeeper) | §4.5 |
| F7-2 | One receipt covering several invoices; customer credit balance and advances | Needs an allocations table |
| F7-3 | Server PDFs and email attachments | Reuse `pdfkit` and the Noto Sans fonts the Call Insights session is adding (it has confirmed ₹ renders) |
| F7-4 | GSTR-1 JSON export | D7 |
| F7-5 | E-invoicing (IRN, signed QR) and e-way bill | Only for tenants above the turnover threshold |
| F7-6 | Public quotation page with online accept | Mirrors P1 |
| F7-7 | Bank-statement import and reconciliation (AI categorisation) | Doc 25 §5.8 |
| F7-8 | Gateway-initiated refunds | Razorpay and Stripe refund APIs |
| F7-9 | FX conversion for cross-currency totals | D15 |
| F7-10 | Report-builder sources for payments, credit notes and expenses; invoices source gated on `invoice:view` | §12.2 row 20 |
| F7-11 | Razorpay autopay mandates for F5 | Doc 25 §5.6 |

---

## 14. Verification

- **SQL can't be typechecked, so it is executed.** `apps/api/verify-finance.cjs` (needs
  `DATABASE_URL`) runs every §9.4 fragment and every S13 tab, each as a read-only query in a
  rolled-back transaction. This is the report-builder precedent (`verify-report-builder.cjs`, which
  caught a `date_trunc` type bug no test saw).
- **Golden fixture.** A seeded org carries a hand-computed ledger:
  - 12 invoices over 3 months, in 2 currencies, both intra- and inter-state;
  - partial payments, TDS, a credit note on a paid invoice, a refund, a void and an overpayment;
  - 10 expenses (F2).

  Every metric and report total is asserted against numbers worked out by hand in a spreadsheet
  committed next to the fixture. This is the main defence against the MyAppz failure mode, where
  two screens disagree about the same figure.
- **Concurrency.** Numbering (50 parallel issues) and double receipts (2 parallel receipts on one
  invoice).
- **Webhooks.** Replay the same payment id; send both Razorpay events; send an unknown link; send a
  Stripe event for an org whose Razorpay row exists (defect 2).
- **Isolation suite.** One cross-tenant case per new route that reaches the handler, plus one for
  `invoice_balances`.
- **Browser pass per persona.** Run with `DEV_OWNER_ROLE` set, one web server per persona, as in
  the Phase 8 harness. Every row of §8.5 is clicked once; P1–P3 are checked on the public origin.
- **Local setup (Windows).** Docker is often stopped: run `docker start platform-postgres-1` and
  the redis/rabbitmq/minio containers first. The Next build's EPERM symlink crash is an environment
  issue, not a code bug (memory note `windows-build-quirks`).

---

## 15. Risks and traps

1. **Seeding permission grants.** Widening `PermissionObjectType` without seeding in the same
   migration 403s every user (0041, 0103).
2. **Notification kinds drift.** Each new kind needs the DB CHECK restated in full, the zod enum and
   the web label map. `notification-kinds.test.ts` catches drift in the first two only.
3. **The first view in the schema.** Without `security_invoker`, `invoice_balances` would bypass
   FORCE RLS (§9.3).
4. **Date columns arrive a day early** through node-postgres on a +05:30 host. Always use `to_char`
   (memory note `crm-track-a`).
5. **The zod partial/default trap** in PATCH schemas (memory note `zod-partial-default-trap`).
6. **The route counts in `guard-mounting.spec.ts` are exhaustive.** Every new route means an update
   there. Other sessions are editing it too (the Call Insights session moved it to 425 today), so
   rebase the counts and don't overwrite them.
7. **Migration numbering.**
   - Two files share 0083, and the production names have diverged from this tree before (memory
     note `crm-integrity-fixes`).
   - Check production's migration list read-only before any deploy.
   - Every production migration needs its own yes.
8. **The public repository.** Scan every commit's patch before pushing (memory note
   `github-repo-public`). Gateway keys and GSTINs in fixtures must be fake.
9. **Rule 3 drift.** "Send reminder" must open the composer, never call a send endpoint. Test it the
   way `automation.test.ts` pins the actions list.
10. **Auto-Won is the first built-in machine move to a terminal stage.** Keep it opt-in, logged
    with `source='billing'`, and never touching Lost or human-closed deals.
11. **Status migration.** Converting stored `overdue` changes what the 0088 "Cash & collections"
    template and any **user copies** of it show. Migrate the seeded template to `is_overdue`.
    User-made copies that filter on `status='overdue'` keep reading 0, as they do today. List them
    in the migration output.
12. **Concurrent sessions.** `nav.ts`, `features.ts`, `guard-mounting.spec.ts` and the invoices
    pages are shared files. Check `ListAgents` before editing them (memory note
    `crm-dashboard-phased-build`).
13. **Operator console.** Grid-guarded routes always 403 for operators, so build no `(platform)`
    finance page on them (memory note `permission-grid`).
14. **basePath.** Any raw `<a>` or `fetch` added without `withBasePath` works locally and breaks in
    production. The §8.8 test exists for this.
15. **Colour.** Finance screens must not use red. The palette test fails the build for stock
    Tailwind colours and hand-rolled state chips.

---

## 16. Open questions for you

Each has a default in §2 already, so the work can start without answers. They matter most in the
order listed.

| # | Question | Default |
|---|---|---|
| Q1 | Is the scope right: finance + forecasting + dashboard, with none of the other MyAppz products? | Yes (D1) |
| Q2 | Should the new `finance` module be sold separately, with invoicing correctness staying in `crm`? | Yes (D2) |
| Q3 | Do your customers sell subscriptions or EMIs? This decides F5 | Not scheduled (D6) |
| Q4 | Who does finance work at your customers: the owner, or a separate bookkeeper? This decides F7-1 | Owner and manager (D3) |
| Q5 | Is a GST register and HSN summary enough, or do customers need GSTR-1 JSON or e-invoicing? | Register + CSV (D7) |
| Q6 | Where should customer-facing pages (P1–P3) live: the marketing app, or another public host? | Marketing app (D9) |
| Q7 | Invoice number format and FY start: is `INV/2026-27/0001` with an April start right? | Yes (D4) |
| Q8 | Should managers be able to void invoices, or only owners? | Managers only when a policy allows |
| Q9 | Should auto-Won on payment be available per pipeline at all? | Yes, off by default (D10) |
| Q10 | May the required onboarding step change from "gateway keys" to "business profile"? | Yes, pending your OK |
| Q11 | Should commission move to `closed_at` along with goals and forecast? This changes payouts | No |
| Q12 | Ship F0 on its own first, given defect 1 blocks every tenant's gateway setup? | Yes |

