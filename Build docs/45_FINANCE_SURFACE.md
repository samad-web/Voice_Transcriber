# 45 · Everything financial in Aura

Every money feature in the platform: what it does, where it lives, what gates
it, and which parts are reachable from a screen today. Written for someone who
has to answer "can Aura do X with money" without reading seven controllers.

State of play as of **2026-10-12**, verified against production rather than
assumed: all finance code is committed and included in the deployed commit
`e7659bb`, and every finance migration (`0149`, `0172`–`0182`) is applied on the
production database. Three of the four organizations have the `finance` module
switched on.

Source documents, if you need the arguments rather than the map:
`26_FINANCE_FORECAST_DASHBOARD_BUILD_PLAN.md`, `finance-section-build-plan.md`,
`37_BILLING_AND_CPQ_REVAMP.md`,
`indian-business-finance-documents-cycles-import.md`,
`platform/apps/api/src/modules/finance/README.md` (route-level reference) and
`platform/FINANCE_RUNBOOK.md` (on-call procedures).

---

## 1. There are three money systems, on purpose

They are easy to confuse, and confusing them is how someone ends up building a
fourth.

| | **Sell-side (CPQ)** | **Finance back office** | **Platform billing** |
| --- | --- | --- | --- |
| Question it answers | What did we quote and invoice this customer? | What did we actually collect, what does it cost us, and what is owed? | What does this tenant owe *us*, the platform? |
| Spine | `quotations` → `invoices` | `deals` → `payment_schedules` → `finance_payments` → `ledger_entries` | `usage_events`, `calls`, storage |
| Owed-money record | `invoices` (with `due_date`, `overdue`) | `payment_schedules` (instalments, status derived) | — |
| Routes | `/owner/quotations`, `/owner/invoices`, `/owner/products` | `/owner/finance/*` | `/v1/usage`, operator `/instances/[id]/usage` |
| Migrations | 0059, 0060, 0099, 0126, **0149** | **0172–0176**, 0179, 0180, 0181, 0182 | 0192–0195 (insights tier) |

**Both of the first two track money owed, and they do not talk to each other.**
An invoice is a document you send; a payment schedule is an instalment plan
hanging off a deal. A business can use one, the other, or both. Nothing
reconciles an invoice against a schedule item today — if that is ever wanted,
it is a design decision, not a bug fix.

---

## 2. Sell-side: products, quotations, invoices, payment links

### 2.1 Products and the price list — `/owner/products`

`products`: name, SKU, description, unit price, currency, tax rate, active or
archived. `GET/POST/PATCH /v1/products`.

This is the catalogue quotation and invoice lines are picked from. Until doc 37
R0 it was decorative: `quotation_items.product_id` had shipped in migration 0059
along with the zod field, the in-org check and the web row model — **and no
control anywhere that could set it**. Every line was hand-typed and every
`product_id` in the database was NULL while the price-list page told people
quotations picked their lines from it. `price-list-picker.tsx` (a combobox on
the kit Popover) is what closed that.

### 2.2 Quotations — `/owner/quotations`

Line items with quantity, unit price, per-line discount, a header discount, and
live totals computed from `packages/shared/src/quotations.ts` — the same module
the API uses, so the preview and the saved document cannot drift.

**Status is a state machine, since migration 0149.** `draft → sent →
accepted | rejected`, all ends terminal. `expired` and `superseded` cannot be
set by hand: the hourly sweep owns one and the revise endpoint owns the other.
Before 0149 a PATCH took any status from any status, and the statuses themselves
were spelled out in seven places.

**Past draft, a quotation locks.** `items`, `discount` and `validUntil` are
refused with a 409. The way forward is `POST /v1/quotations/:id/revise`, which
clones the header, the lines and their `product_id`s into a new draft numbered
off the **root** — `-r2`, `-r3`, never `-r2-r3`.

### 2.3 Invoices — `/owner/invoices`

Line items with HSN/SAC and per-line tax, a discount, and GST.

**The GST split derives itself; it is not a dropdown.**
`isInterStateSupply()` in `shared/gstin.ts` compares the org's own
`org_business_profile.state_code` (0126) against the place of supply, and
returns `true`, `false`, or `null` meaning *cannot tell*. The API
(`common/gst-treatment.ts`) and the console's live preview share that one
function. Under GST the comparison **is** the rule, so there is no override once
both codes are known. No stored invoice changed its split when this landed:
`place_of_supply` was free text until then, so every existing row fails
`isGstStateCode` and keeps whatever it was saved with.

### 2.4 Getting paid — payment links and gateways

- **`POST /v1/invoices/:id/payment-link`** creates a Razorpay or Stripe payment
  link. The gateway is a **parameter, not a setting**, because which gateway
  suits a payment is decided by who is paying, not once per company.
- **It cannot mark anything paid.** Only the webhook controllers, verifying a
  signed delivery, move an invoice to paid.
- **`/v1/invoices/payment-settings`** is where a client's own gateway keys live
  (`payment_gateway_config`, migration 0060). **Owner only**, enforced in its own
  controller rather than on the CRM permission grid — these keys decide which
  bank account the money lands in, which is not the same authority as "may edit
  an invoice". The secret is never read back; `GET` returns the publishable key
  id and booleans.

### 2.5 The hourly sweep

`apps/worker/src/pipeline/document-dates.ts` sets quotations `expired` and
invoices `overdue`. Both statuses were legal since 0059/0060 with *nothing ever
setting them*, so `valid_until` and `due_date` were decorative and the 0088
"overdue" report filtered on a word only a human could type.

It compares against `org_reporting_today()`, never `current_date`, uses `<` not
`<=`, and skips `amount_paid >= total` so a paid-but-unmoved invoice is not
chased. It notifies nobody and sends nothing. **It has no test** — that was
declined mid-build — so it is covered by reading only.

---

## 3. The finance back office — `/owner/finance/*`

Nine screens, 57 API routes, two worker sweeps. Everything here is gated on the
`finance` OrgModule plus a `finance` or `incentive` grant on the CRM permission
grid.

### 3.1 Deal templates and payment schedules

An owner-defined schedule shape (deposit, instalments, milestones) versioned per
org. Generating one against a deal creates `payment_schedules` rows and posts
the booking to the ledger.

**A PATCH on a template is an INSERT.** Editing in place would retroactively
change what a deal was sold under. Anything affecting generation supersedes the
active version; changing `active` alone is a true update, because retiring a
version is not a change *to* it.

Regenerating over an existing schedule needs `replace: true` and is refused once
any payment has been applied — deleting an item money points at would orphan the
payment and silently reduce "collected".

> **The most common "finance shows nothing" cause**: no deal template exists, so
> no deal has a schedule, so dues, aging and collections are all empty. Check
> this first.

### 3.2 Payments, dues and matching — `/owner/finance/payments`, `/owner/finance/dues`

One canonical payment table for every source: recorded by hand, drained from a
gateway connector, or staged through the import centre. All three go through
**one** function, `record-payment.ts` — extracted precisely so there would not be
three copies. The module already carries that scar: `schedule_item_id` was left
null on every deal-referenced payment because one field was forgotten in one of
two places, and days-to-collect returned null forever without failing a test.

- **Eleven statuses, four of which are money in.** The API publishes a
  `collected` boolean per row rather than letting each screen re-derive
  `COLLECTED_STATUSES`.
- **Offline money moves nothing until a second person confirms it.** Above the
  org's threshold (default ₹50,000) a cheque or cash receipt lands
  `pending_verification`, posts no ledger entry and pays down no instalment. The
  second-person rule is checked in the handler, not by a constraint, because
  what must be true is that the *actor of this request* is not the one who
  recorded it. Below the threshold any `finance:edit` holder may confirm — a
  ₹500 cash receipt needing two signatures is a rule people route around.
- **A split across two deals is refused** (400). The payment carries one
  `deal_id`; splitting one bank credit into two rows would break the gateway
  idempotency key that stops double-crediting. Two receipts is the honest answer.
- **Due status is computed, never stored.** `payment_schedules.status` cannot
  hold `overdue` — 0172's CHECK refuses it — and the API derives it per row
  against the org's own today. A status that depends on the date is only ever as
  correct as the last sweep; this one cannot drift because it is never written.
- Dues carry promise-to-pay dates, which is what the `slipped_promise` alert
  fires on, and aging totals are over the whole filter, not the page.

### 3.3 Gateway connectors

Razorpay today, with the registry and drain built so a second gateway is a
mapper plus config (proven by a fixture connector in the tests; the second real
one is roadmap milestone M10).

- `connector_events` **is** the queue: the webhook verifies, stores and acks;
  the worker's drain normalizes. A failed event is a row, not a lost message.
- **Replay is safe to run twice** — every insert is keyed on the gateway's own
  id with `ON CONFLICT DO NOTHING`. After a mapper bug: ship the fix, replay the
  window, and the normalizer re-runs over the original stored bytes. `payload`
  is immutable; a trigger refuses an edit.
- A refund whose payment has not been normalized yet **throws on purpose** and
  stays queued until the capture ahead of it is processed.
- `reconcile` pulls the gateway's own payment list for anything the webhook never
  delivered; the worker does this every six hours by itself.
- **The webhook has no guards, by design** — a gateway cannot present an admin
  key. It authenticates by HMAC over the raw body, verified *before* the body is
  parsed. An unknown account, a missing secret and a bad signature all return the
  same 202, because distinguishing them would disclose whether a connector id
  exists. Rejected deliveries are still stored with `signature_ok = false` — that
  row is the evidence somebody wants after a secret rotation.
- Connecting and disconnecting are **owner-only and not `@OperatorMayCall()`**:
  a platform operator holding the bare admin key must not be able to write a
  client's gateway credentials. `credentials_enc` is omitted from every select;
  screens get a `hasCredentials` boolean.

### 3.4 Expenses and cost drivers — `/owner/finance/expenses`

Fixed vs variable split by category, net of recoverable tax (an invoice total
includes GST the business gets back; counting it as cost would overstate every
margin by the tax rate, and disagree with the overview).

- **Only approved costs count.** An entered bill is a claim.
- **`amount` and `incurredOn` are not patchable.** Editing a posted amount would
  silently change a month that may already have been reported; changing the date
  would move it between periods behind the period lock's back. Classification —
  category, vendor, attribution, fixed vs variable — *is* editable, because those
  are bookkeeping judgements people legitimately revise.
- **Ad spend does not go here.** `marketing_source_spend` (0171) collects it and
  the cost layer reads that table. An `advertising` expense is the agency
  retainer, not the campaign.

### 3.5 Period close — `/owner/finance/close`

A month-end checklist beside the period lock. `finance_periods` can only close a
month that has ended; re-opening is audit-logged.

**The checklist warns, it does not block.** Three steps are marked blocking —
payments matched, bank reconciled, expenses approved — and the lock still works
with them outstanding. An owner closing a month with one reconciliation open has
a reason, and a system that refuses leaves them unable to close the books at all.
The page shows what is outstanding and lets them decide.

### 3.6 Incentives and payouts — **API only, no screen**

`incentive_plans` with slab, flat and percentage types; `incentive_payouts`
moving `calculated → approved → paid`, never your own.

- **Collected only.** Every earning query filters `COLLECTED_STATUSES`. An
  authorized card payment, an unverified cash claim and a bounced cheque all earn
  nothing.
- **Lines are apportioned, not computed per payment.** A slab plan is marginal,
  so the incentive on a month is not the sum of the incentive on each payment
  taken alone. The total is computed once from the month's collections and the
  lines are that total apportioned by each payment's share — so the statement's
  lines sum exactly to the figure above them.
- **A telecaller must not read another's pay, even by guessing an ID.** Every
  payout read applies the incentive scope clause, the single-payout read
  included, and returns **404 rather than 403** — a 403 on a specific id confirms
  the id exists.

### 3.7 The ledger — **API only, no screen**

Double-entry postings, grouped by posting, publishing whether the window
balances. CSV export behind `finance:export`.

**Append-only is enforced by REVOKE, not by hope.** Migration 0001 ends with
`ALTER DEFAULT PRIVILEGES … GRANT SELECT, INSERT, UPDATE, DELETE`, so every new
`public` table arrives with full DML — a narrow `GRANT SELECT, INSERT` in a later
migration narrows **nothing**. 0172–0176 shipped exactly that, with headers
asserting append-only, while an UPDATE and a DELETE as `aura_app` both
succeeded. Seventeen (table, privilege) pairs needed explicit REVOKEs, and 0176
now asserts all seventeen from `information_schema` and raises if one is missing.

### 3.8 The finance dashboard — `/owner/finance`

Booked, collected, costs, margin, outstanding, runway — plus collection rate,
DSO, aging, CAC, gateway fee rate, refund rate, days-to-collect, cost per lead
and revenue per call, from the `FINANCE_METRICS` catalogue.

- **Every number drills down**, and the destination comes from the catalogue, not
  the page — so a metric cannot be rendered on a tile the console has no route
  for, and adding one without a drill-down fails a test rather than a click.
- **Snapshots for complete days, live for today.** If the snapshot rows do not
  cover the whole window (a nightly job that did not run, a tenant enabled
  mid-period), the figures are computed live for the *whole* window rather than
  reporting a partial sum. `freshness.label` tells the reader which they got.
- **`my-money` is a separate route**, not `overview?scope=user`, because of what
  it must *not* return — org-wide costs, cash balance, burn, health score. A
  narrower route with a narrower response makes the restriction structural rather
  than a filter somebody has to remember.

### 3.9 The Advisor — `/owner/finance/advisor`, `/owner/finance/forecast`

Twenty-two rules, money-leak ranking, and a 30/60/90-day cash forecast in three
scenarios.

The rules: `aging_breach`, `books_not_closed`, `call_cost_no_results`,
`cash_runway_low`, `closed_unpaid`, `compliance_due`, `compliance_overdue`,
`connector_unhealthy`, `discount_abuse`, `document_expired`,
`document_expiring`, `duplicate_expense`, `expense_outlier`,
`failed_not_retried`, `fee_drift`, `idle_spend`, `incentive_not_clawed_back`,
`negative_roi_source`, `refund_spike`, `settlement_mismatch`,
`slipped_promise`, `unmatched_money`.

- **No model, anywhere.** Every decision is a pure function in
  `packages/shared/src/finance-detectors.ts`; the only text production is
  `renderMessage` substituting into a rule's own template. There is no
  `@aura/llm` import in this module and there must not be one.
- **Every alert is reproducible**: it carries the rule that fired, the formula
  with its numbers substituted, the named inputs and a link per record — and the
  payload is **stored on the alert**, not recomputed. That is what keeps it
  honest a month later, when the median it fired against has moved.
- **Notify-only.** An alert raises an in-app notification; a due reminder creates
  a *task*. Both for staff. Nothing here messages a customer or moves money.
- **Thresholds are never changed silently.** Repeated dismissals produce a row in
  `advisor_suggestions`, and only an explicit PATCH applies one.
- **Quiet on day one is correct.** The four statistical rules (`fee_drift`,
  `refund_spike`, `expense_outlier`, `call_cost_no_results`) refuse to fire below
  eight periods of history and say so in `explain.silentBecause`.
- **`lowConfidence` is the most important field in the forecast**, and the page
  renders it above the numbers rather than as a badge in a corner. It stays true
  until the org's own collection history outweighs the conservative priors.

### 3.10 The document vault — `/owner/finance/documents`

Statutory, whole-business documents with a category, an expiry, an owner and
reminder offsets.

- **The gap list comes first**, before the inventory: the point is not filing, it
  is that a business discovers a lapsed trade licence at the worst moment. Gaps
  name only *singleton* categories — "no vendor bill this week" is not a gap.
- **The bytes never pass through the API.** The browser PUTs straight to object
  storage against a 15-minute presigned URL; reads get a 300-second signed GET and
  every read is logged.
- **A renewal is a new row.** `supersedesId` stamps the old one and resolves its
  expiry alerts; the old object stays downloadable, because the one time anybody
  needs the superseded version is a dispute about what was in force.
- **Per-person documents are not here.** Offer letters, contracts and NDAs live in
  `contract_documents` (0178) behind the org chart's own permission, and a test
  enforces the split.

### 3.11 The compliance calendar — `/owner/finance/compliance`

Indian statutory filings — GST, TDS, PF/ESI, ROC, advance tax — generated a
financial year at a time from the org's own profile (entity type, registrations,
FY window).

- **The calendar is data, not code.** `compliance_items` is seeded once from the
  catalogue and owned by the tenant after that; nothing resolves a due date from
  the shared catalogue at read time, because a CA must be able to correct a date
  without a deploy.
- **There is no `status` column.** Upcoming / due soon / overdue / filed / waived
  is derived on every read against the org's today. `due_on` is stored and never
  recomputed.
- **"Verify with your CA" is printed per row**, not only in a banner at the top —
  a banner is read once, a marker on the filing somebody is about to act on is
  read every time.

### 3.12 The import centre

Finance imports (payments, expenses, schedules) go through the **existing**
importer, not a finance-only one: `import_jobs` (0062) grew the columns for
staging, dry run, saved mappings and undo, and `ImportEntity` grew three finance
members. One import centre was the explicit requirement — employee, contract,
call log and lead imports are meant to land in the same flow.

Imported payments go through `record-payment.ts`, the same normalizer and
matching engine connector payments use.

---

## 4. Two earnings systems — do not confuse them

| | `commission_plans` (0070/0071) | `incentive_plans` / `incentive_payouts` (0172+) |
| --- | --- | --- |
| What it is | A **calculator input** | A payout engine with a trail |
| Has accruals? | No | Yes |
| Claw-back? | No | Yes (`incentive_not_clawed_back` alert) |
| Approval trail? | No | `calculated → approved → paid` |
| Survives a rate edit? | No | Yes |
| Where it surfaces | `/owner/reports` (team commissions); channel partners see the **rate only**, never a figure | API only |

The partner portal deliberately shows no "you have earned ₹X": a number printed
there would be read as an amount owed to somebody who is not an employee and who
has a contract, and the first time it disagreed with what the tenant actually
paid, the portal would be the reason for the argument.

---

## 5. Platform billing — what tenants owe *us*

`/v1/usage` meters the contract month: call count and seconds (excluding
`NO_AUDIO` rows, which are missed calls from the handset log — nothing was
recorded or processed, so they are not usage), storage, and ASR minutes against
the org's budget. Operators see it per tenant at `/instances/[id]/usage`.

**Billing runs on the platform's UTC month**, explicitly, even though tenant
transactions run on the org's clock. A contract month is not a reporting month.
Invoices to tenants are stubbed — metering is the durable ledger; nothing bills
a card.

The insights tier (0192–0195) is the other half of this: a plan with its own
entitlements for API-only customers.

---

## 6. Rules that hold across all of it

- **Money is `numeric`, not BIGINT minor units.** Every pre-existing money column
  is numeric, numeric is exact decimal, and a paise ledger beside a numeric
  invoice would put `round(total * 100)` in the middle of every drill-down join —
  while those joins are required to reconcile. The arithmetic lives in
  `packages/shared/src/money.ts`.
- **Major units on the wire**, converted to integer paise once at the boundary.
- **The ledger is append-only, by REVOKE.** See §3.7.
- **Collected means collected.** Four of eleven payment statuses.
- **Nothing in finance sends anything to a customer.** Alerts notify staff;
  reminders create tasks.
- **No LLM in the finance module**, by requirement.

---

## 7. Who can see what

Three independent gates, all of which must pass:

1. **The `finance` OrgModule**, off for every tenant until an operator turns it
   on: `PATCH /v1/admin/tenants/<orgId>/modules`.
2. **`crm` must be on too.** Finance's spine is `deals` — a schedule hangs off
   one, the incentive credits the deal's owner, every collections figure is "what
   this deal owes". The nav hides the pages without it (`CRM_GATED_HREFS`),
   because a tenant with finance and no CRM gets a dashboard of zeros and no way
   to create a non-zero.
3. **The CRM permission grid**, objects `finance` and `incentive`, verbs
   view / create / edit / export.

Two things sit **above** the grid, because a grid cell can be ticked and these
must not be: connector credentials and invoice gateway keys are **owner-only**.

Finance has no rail section of its own — `OWNER_RAIL_MAX_TOP_LEVEL` is 7 and the
rail was already full — so it lives under **Sales** with two nav entries
(`/owner/finance`, `/owner/finance/advisor`); the other seven pages are governed
by a prefix match.

---

## 8. Turning it on for a tenant

1. Operator grants the modules: `["aura", "crm", "finance"]`.
2. In the tenant's console, set the approval threshold (default ₹50,000),
   auto-match confidence (0.85) and minimum cash — **but see §9, this page does
   not exist yet**; the defaults apply until it does.
3. Connect Razorpay if they collect online — owner only.
4. **Create a deal template.** Nothing produces a schedule without one.

Expect day one to be quiet. See `FINANCE_RUNBOOK.md` for replaying connector
events, closing and re-opening a period, and what the common failures look like.

---

## 9. Known gaps

Things that are built-but-unreachable, or referenced-but-missing. None of these
are breakages; they are honest holes.

| Gap | Detail |
| --- | --- |
| **`/owner/settings/finance` does not exist** | `finance-overview.tsx:458` links to it for the approval threshold, auto-match confidence and minimum cash. The link 404s. The settings themselves work — they fall back to `FINANCE_DEFAULTS` — but they cannot be changed from a screen. |
| **The runbook names two more missing pages** | `/owner/finance/connectors` and `/owner/finance/deal-templates` are both in the operator runbook's setup steps and neither has a route. Connector setup and deal templates are API-only today. |
| **Four API surfaces have no screen** | The matching queue, incentive payouts, connector health and the ledger read/CSV. The overview deliberately does not link them — a `Link` to a missing route is a 404 no test catches. |
| **The hourly date sweep has no test** | `document-dates.ts`. Covered by reading only. |
| **Only one gateway is real** | Razorpay. The second-gateway claim is proven by a fixture connector in tests, not by a shipped integration (roadmap M10). |
| **Invoices and payment schedules do not reconcile** | Two independent records of money owed. Deliberate today; a decision rather than a defect. |
| **CPQ R6–R9 are still a plan** | See `37_BILLING_AND_CPQ_REVAMP.md`. |
