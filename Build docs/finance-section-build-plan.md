# Finance Module: Build Specification (for the implementing agent)

> **How to use this file.** This is a build spec. Follow the sections in order, build in the milestones of section 14, and treat every item marked **MUST** as required. Where a decision is not specified, use the default stated in section 15 and record it in `DECISIONS.md`. Do not invent business-specific logic: the module is business-agnostic by design.

---

## 1. Goal and scope

Build the **Finance module** of a telecaller-management application. It sits on top of the existing KPI/performance module and answers three questions: what did the work earn, what did it cost, and what do we owe people.

**Three non-negotiable requirements**

1. **Business-agnostic.** The module must not assume what the customer sells. It only knows deals, payment schedules and payments. Owners configure deal templates; no code change is needed for a new business model.
2. **Any payment type, from outside.** Payments happen outside the app. The app ingests them through a **connector framework** (Razorpay first) and through manual/offline entry. Every payment is normalized into one canonical record.
3. **Finance Advisor driven by logic.** A deterministic rules-and-statistics engine produces forecasts, cost analysis and leak detection, and reminds the right person. Language models may only rephrase explanations; they never decide anything.

**Quality bar:** dashboards must be clear, smooth and statistically sound. Every number is defined once, drills down to its source records, and shows data freshness.

**Out of scope:** full double-entry accounting replacement, tax filing, payroll tax compliance. Integrate or export to Tally/Zoho Books instead.

---

## 2. Assumptions and defaults

The stack of the host application is not given. **First step: inspect the repository** and adopt its language, framework, ORM, migration tool, test runner and UI library. Only where nothing exists, use these defaults:

| Concern | Default |
| --- | --- |
| Database | PostgreSQL 14+ (JSONB, partitioning, partial indexes) |
| Money | Integer minor units (`BIGINT`, paise) plus ISO currency code. **Never floats.** |
| Time | Store UTC (`timestamptz`); display in the organization's timezone (default `Asia/Kolkata`) |
| Queue / jobs | A durable queue with retries and a dead-letter queue; a scheduler for cron jobs |
| Secrets | Connector credentials encrypted at rest (envelope encryption / KMS); never logged |
| Files | Object storage for payment proofs and invoices |
| Multi-tenancy | Every table has `org_id`; every query is scoped by it; enforce in a data-access layer, not only in handlers |
| Currency / tax | INR with GST first; schema multi-currency-ready |
| Audit | Append-only audit log for every create/update/approve on money tables |

---

## 3. Roles and permissions

| Role | Can do |
| --- | --- |
| Owner | Everything: setup, connectors, approvals, rules, all reports, all people's incentives |
| Finance handler | Record/verify payments, manage matching queue, expenses, dues, reminders, reports (no connector secrets) |
| Manager | View team collections, dues, alerts for their team; approve small expenses/payments up to limit |
| Telecaller | View only their own sales, collections, dues to chase and incentive |

**MUST:** enforce permissions server-side on every endpoint and every query. A telecaller must never be able to read another telecaller's pay or incentive, even by guessing an ID.

---

## 4. Architecture overview

```
 Payment gateways / bank / cost sources
        │ webhook / poll / import
        ▼
 [Connector layer] verify signature → store raw event (immutable)
        ▼
 [Queue] → [Normalizer] → [Matcher] → [Ledger writer]
                                         │
                       ┌─────────────────┼──────────────────┐
                       ▼                 ▼                  ▼
              [Metrics layer]     [Advisor engine]    [Incentive engine]
              (snapshots)         (rules, forecast)   (uses KPI + collected $)
                       │                 │
                       ▼                 ▼
                 [Dashboards]   [Alerts → routing → reminders → escalation]
```

Modules to create (names are suggestions; match the repo's conventions):

`finance/deals`, `finance/payments`, `finance/connectors`, `finance/matching`, `finance/ledger`, `finance/expenses`, `finance/incentives`, `finance/metrics`, `finance/advisor`, `finance/notifications`, `finance/reports`.

---

## 5. Business-agnostic deal layer

**Deal template** (owner-defined in setup):

- `name`, `schedule_type`: `one_time | installments | recurring | commission | custom`
- Schedule parameters (number of installments, interval, first due offset, recurrence period, commission %)
- `custom_fields`: list of `{key, label, type, required}` where type is `text | number | date | select | boolean`
- `tax`: GST rate and whether price is tax-inclusive

**Behavior (MUST)**

- Creating a deal from a template **generates its `payment_schedule` rows**.
- Custom field values are stored in `deal.custom_fields` (JSONB) and validated against the template.
- Core metrics (booked, collected, outstanding) work for every template.
- Model-specific metrics switch on by `schedule_type` (for example MRR for `recurring`, commission earned for `commission`).
- Changing a template creates a new version; existing deals keep the version they were created with.

**Acceptance:** an owner can create a one-time template and an installment template without code changes, create a deal from each, and see correct schedules and dues.

---

## 6. Payment ingestion

### 6.1 Canonical payment

All sources normalize into one `payment` record.

**Methods:** `upi, card, netbanking, wallet, bank_transfer (NEFT/IMPS/RTGS), cheque, cash, demand_draft, emi_bnpl, international, custom`. Owners can add custom methods.

**Sources:** `connector, bank_import, csv_import, manual`.

**Statuses:** `initiated, authorized, received, failed, refunded, partially_refunded, disputed, reversed, pending_verification, cheque_cleared, cheque_bounced`.

### 6.2 Manual and offline payments (MUST)

- Cash, cheque and demand draft enter as `pending_verification`.
- Require **proof** (image/PDF upload or reference number).
- Require a **second person's approval** when the amount exceeds the org's threshold (default ₹50,000, configurable).
- Cheques have a clearing step: `pending_verification → cheque_cleared | cheque_bounced`. A bounce reverses the ledger entry and re-opens the schedule item.

### 6.3 Correction rule (MUST)

Never edit or delete a posted payment or ledger row. Correct by **reversal entry** (`reverses_id`) plus a new entry. All corrections are audit-logged with a reason.

---

## 7. Connector framework

### 7.1 Interface

Implement connectors as plugins against one interface so a new gateway is a mapper plus config, not new core code.

```ts
interface Connector {
  type: string;                                   // "razorpay", "cashfree", ...
  authenticate(cfg: ConnectorConfig): Promise<AuthResult>;
  verifyWebhook(rawBody: Buffer, headers: Headers, secret: string): boolean;
  handleWebhook(rawBody: Buffer, headers: Headers): RawEvent[];
  backfill(since: Date): AsyncIterable<RawEvent>;  // historical load
  poll(since: Date): AsyncIterable<RawEvent>;      // for missed webhooks
  map(raw: RawEvent): CanonicalEvent[];            // Payment | Refund | Settlement | Dispute
  health(): Promise<ConnectorHealth>;              // last_event_at, failures, token expiry
}
```

### 7.2 Pipeline rules (MUST)

1. **Verify the signature** on the raw request body before parsing. Reject unverified requests with 4xx and log.
2. **Store the raw event first**, immutable, then ack the webhook quickly (respond fast; process asynchronously).
3. **Idempotency:** unique key on `(connector_account_id, external_id)`. Duplicate deliveries must be harmless.
4. **Retries with exponential backoff**, then a dead-letter queue. Provide a UI to view, fix and replay failed events.
5. **Replayability:** the normalizer must be re-runnable from stored raw events after a bug fix.
6. **Daily reconciliation job:** pull the gateway's payment list for the last N days and compare it with delivered webhooks; create missing payments and flag discrepancies.
7. **Settlements are first-class:** store gross, gateway fee, tax on fee, net, and the bank credit amount. Flag any settlement where `net != bank_credit`.
8. **Credentials:** stored encrypted per org; rotating or revoking must be possible from the UI; never returned by any API.

### 7.3 Razorpay connector (build first)

Verify details against the current Razorpay documentation before implementing; the points below are the expected shape.

- Webhook signature: HMAC-SHA256 of the **raw body** with the webhook secret, compared (constant-time) to the signature header sent by Razorpay. Use the event ID header for idempotency when present.
- Events to handle at minimum: payment authorized, captured and failed; order paid; refund created, processed and failed; settlement processed; dispute created and closed.
- Link payments to deals using the **notes/reference fields** set when the payment link or order is created (for example `deal_id`, `schedule_item_id`). Provide a helper in the app that creates Razorpay payment links with these notes pre-filled.
- Backfill uses the list APIs with time-range pagination.

### 7.4 Connector catalog (roadmap)

| Type | Connectors |
| --- | --- |
| Gateways | Razorpay (M3), Cashfree, PayU, Stripe, PhonePe, Paytm, Instamojo, CCAvenue |
| Bank | CSV/PDF statement import (M5), Account Aggregator later |
| Accounting (outbound) | Tally, Zoho Books, QuickBooks |
| Cost sources | Telephony provider call charges, Meta/Google ad spend, WhatsApp/SMS usage |

### 7.5 Connector UI

- Connect / disconnect / re-authenticate flow
- **Health page:** last event time, failure count, queue depth, token expiry, "Synced N minutes ago"
- Failed-event list with replay
- Test webhook button

---

## 8. Matching engine

Match each incoming payment to a deal/schedule item. Try in order and stop at the first confident match:

1. **Exact reference:** payment link ID, order ID, or notes field → confidence 1.0
2. **Customer identity + amount:** phone or email plus exact amount against open schedule items → confidence 0.9
3. **Fuzzy:** amount and date window against open schedule items, single candidate → confidence 0.6; multiple candidates → no auto-match
4. **Otherwise:** place in the **unmatched queue**

**MUST**

- Store `match_status` (`matched, suggested, unmatched`) and `match_confidence` on every payment.
- Auto-apply only matches with confidence at or above an org-configurable threshold (default 0.85); lower ones appear as *suggestions* for a human to confirm.
- Partial payments apply to the oldest open schedule item first (configurable); overpayments create a credit balance on the deal.
- Unmatched queue UI: filter, suggest candidates, one-click match, split a payment across items.

---

## 9. Data model

All money columns are `BIGINT` minor units. All tables include `org_id`, `created_at`, `updated_at`. Adapt syntax to the repo's migration tool.

```sql
-- Deals
deal_template (id, org_id, name, version, schedule_type, params JSONB,
               custom_fields JSONB, tax JSONB, active)
deal          (id, org_id, template_id, template_version, lead_id, caller_id,
               campaign_id NULL, lead_source NULL, customer_id NULL,
               total_minor, currency CHAR(3), status, custom_fields JSONB, closed_at)
payment_schedule (id, org_id, deal_id, due_date, amount_minor, paid_minor,
                  status)  -- open | partial | paid | overdue | cancelled

-- Payments
payment (
  id, org_id, deal_id NULL, schedule_item_id NULL, customer_id NULL,
  amount_minor BIGINT, currency CHAR(3), fx_rate NUMERIC NULL,
  method TEXT, method_detail JSONB,
  status TEXT, source TEXT,
  connector_account_id NULL, external_id TEXT NULL,
  received_at TIMESTAMPTZ, settled_at TIMESTAMPTZ NULL,
  fee_minor BIGINT DEFAULT 0, tax_on_fee_minor BIGINT DEFAULT 0, net_minor BIGINT,
  match_status TEXT, match_confidence NUMERIC,
  proof_url TEXT NULL, raw_event_id NULL, verified_by NULL, verified_at NULL,
  UNIQUE (connector_account_id, external_id)
)
refund   (id, org_id, payment_id, amount_minor, reason, status, external_id, created_at)
dispute  (id, org_id, payment_id, amount_minor, status, opened_at, due_by, resolved_at)
settlement (id, org_id, connector_account_id, gross_minor, fee_minor, tax_minor,
            net_minor, bank_credit_minor NULL, settled_on, mismatch_minor)

-- Ledger (append-only)
ledger_entry (id, org_id, account TEXT, debit_minor, credit_minor,
              ref_type, ref_id, posted_at, reverses_id NULL, memo)

-- Connectors
connector_account (id, org_id, type, credentials_enc, status, last_event_at, config JSONB)
connector_event   (id, connector_account_id, external_id, payload JSONB, signature_ok,
                   received_at, processed_at NULL, error NULL, attempts)

-- Costs
expense (id, org_id, category, vendor, amount_minor, currency, incurred_on,
         is_fixed BOOL, approved_by NULL, attachment_url NULL, source)  -- manual | connector
cost_driver (id, org_id, kind, value, period)  -- e.g. call_minutes, leads_bought

-- Incentives
incentive_plan   (id, org_id, type, rules JSONB, clawback_days, effective_from, effective_to)
incentive_payout (id, org_id, user_id, period, calculated_minor, adjustments_minor,
                  status, approved_by NULL, paid_at NULL)  -- calculated|approved|paid
incentive_line   (id, payout_id, deal_id, payment_id, basis_minor, amount_minor, type)  -- earn | clawback

-- Advisor
advisor_rule  (id, org_id, code, params JSONB, severity, enabled,
               route_to_role, schedule, snooze_until NULL)
advisor_alert (id, org_id, rule_code, subject_ref, amount_at_risk_minor, severity,
               status, assignee_id, due_at, escalated_at NULL, resolved_reason NULL,
               explain JSONB, first_seen_at, last_seen_at)
alert_event   (id, alert_id, kind, actor_id NULL, note, at)  -- opened|ack|escalated|resolved|reopened|dismissed
forecast_run  (id, org_id, horizon_days, scenario, generated_at, inputs_hash, output JSONB)

-- Rollups
finance_snapshot (org_id, date, scope TEXT, scope_id NULL,  -- org|user|campaign|source
                  booked_minor, collected_minor, refunded_minor, fees_minor,
                  costs_minor, outstanding_minor, ...)

-- Audit
audit_log (id, org_id, actor_id, action, entity, entity_id, before JSONB, after JSONB, at)
```

**Indexes (minimum):** `payment(org_id, received_at)`, `payment(org_id, match_status)`, `payment_schedule(org_id, status, due_date)`, `connector_event(connector_account_id, processed_at)`, `advisor_alert(org_id, status, assignee_id)`, `ledger_entry(org_id, ref_type, ref_id)`.

**Period locking:** add `finance_period (org_id, month, locked_at, locked_by)`. Writes dated in a locked period are refused unless made as an explicit adjustment entry in the current open period.

---

## 10. Incentives

- Plan types: `slab`, `percent_of_collected`, `kpi_linked` (uses the overall KPI score from the KPI module), and combinations.
- **MUST:** compute incentives from **collected (confirmed) payments only**, never from booked deals.
- **Clawback:** a refund or chargeback within `clawback_days` creates a negative `incentive_line` in the current period.
- Payout flow: `calculated → approved → paid`, with an owner/manager approval and a statement per telecaller.
- Effective-dated plans: a change never recalculates closed periods.

---

## 11. Metrics layer and dashboards

**One metrics layer.** Each metric has a single definition and code path; dashboards, reports and the Advisor all call it. Precompute into `finance_snapshot` nightly, plus live counters for today.

| Metric | Definition |
| --- | --- |
| Booked | Sum of deal totals closed in period |
| Collected | Sum of received payments (net of refunds) in period |
| Collection rate | collected ÷ billed in period |
| Outstanding | Sum of unpaid schedule amounts |
| DSO | outstanding ÷ credit sales × days in period |
| Aging buckets | Outstanding in 0-30, 31-60, 61-90, 90+ days past due |
| CAC | (marketing + calling + incentive cost) ÷ new customers |
| Cost per lead / revenue per call | By telecaller, campaign and source |
| Net margin | (collected − all costs) ÷ collected |
| Gateway fee % | fees ÷ gross captured |
| Refund / chargeback rate | refunded or disputed ÷ captured |
| Runway | cash ÷ average monthly net burn |
| Days-to-collect | **median and 90th percentile**, not just the mean |

**UX requirements (MUST)**

- Every number is clickable and drills down to the underlying payments, schedule items or expenses.
- Show a **freshness stamp** ("data as of 15:42; Razorpay synced 3 min ago").
- Show period-over-period comparison and cohort views (collection rate by month of sale, by source, by telecaller).
- Empty, loading and error states for every widget; no layout jumps while loading.
- Consistent number formatting (Indian digit grouping option, ₹ symbol, negative numbers clear).

**Screens**

- **Owner:** finance dashboard (booked, collected, costs, margin, outstanding, runway), per-telecaller profitability, per-campaign/source ROI, aging, incentive approvals, expenses, connector health, advisor inbox.
- **Finance handler:** unmatched queue, pending verification, dues list, reminders, reconciliation.
- **Manager:** team collections vs target, overdue by telecaller, team alerts.
- **Telecaller:** my sales and collection status, my incentive (projected vs confirmed), my dues to chase.

---

## 12. Finance Advisor (logic-based)

**Principle (MUST):** rules and statistics decide; language only explains. Every advisory must be reproducible from data and must show the rule that fired, the calculation, and links to the underlying records (`advisor_alert.explain`). No LLM call may create, suppress or re-rank an alert.

### 12.1 Pipeline

```
ledger + schedule + expenses → detectors + forecaster → alerts
   → routing (role, severity) → reminders / escalation → resolution + feedback
```

Run detectors on a schedule (default hourly for dues and connector issues; nightly for statistical rules) and on relevant events (for example after a payment is posted).

### 12.2 Cash-flow forecast (30 / 60 / 90 days)

```
expected_inflow(day)  = Σ schedule_item.amount × P(collected | aging_bucket, source, plan_type)
                      + new_sales_run_rate × seasonality_index
expected_outflow(day) = scheduled fixed costs + variable_rate × driver
projected_balance(d)  = opening + cumulative inflow − cumulative outflow
```

- `P(collected | ...)` is learned from the org's own last 6-12 months; fall back to conservative global priors when history is thin, and label the forecast "low confidence".
- `new_sales_run_rate`: weighted moving average of recent weeks; move to Holt-Winters only when at least two seasonal cycles exist.
- Output **low / base / high** scenarios using the 25th / 50th / 75th percentile of historical collection variance. Persist to `forecast_run` with an `inputs_hash`.
- Alert when projected balance crosses the owner's minimum-cash threshold within the horizon.
- Show the forecast as a line chart with a shaded low-high band, plus the table of assumptions.

### 12.3 Cost analysis

- Fixed vs variable split; cost as % of revenue; budget vs actual variance by category.
- Cost per lead, per acquisition and revenue per call, by telecaller, campaign and source.
- Trend against each category's **own baseline** (rolling 8-12 weeks), so thresholds are relative to what is normal for this business.

### 12.4 Leak detection rules

Seed these as `advisor_rule` rows with editable params. Each alert carries severity, estimated ₹ at risk, target role, and recommended action.

| Code | Fires when | Default params | Routes to |
| --- | --- | --- | --- |
| `closed_unpaid` | Deal closed with no payment after N days | N=3 | Telecaller → Manager |
| `slipped_promise` | Promised pay date passed with no receipt | grace=1 day | Telecaller |
| `aging_breach` | Dues cross a bucket boundary | 30/60/90 | Finance handler |
| `unmatched_money` | Payment received but not linked to a deal | age>24h | Finance handler |
| `settlement_mismatch` | `net != bank_credit` | tolerance=₹1 | Finance handler → Owner |
| `fee_drift` | Gateway fee % above trailing average | +0.3 pp | Owner |
| `failed_not_retried` | Failed attempt, no retry or follow-up | N=2 days | Telecaller |
| `refund_spike` | Refund/chargeback rate above baseline | z>2.5 | Manager |
| `duplicate_expense` | Same vendor + amount within X days | X=7 | Finance handler |
| `expense_outlier` | Category spend is an outlier | modified z>3.5 | Manager |
| `discount_abuse` | Discount above policy, grouped by telecaller | policy% | Manager |
| `negative_roi_source` | Source cost > revenue over N weeks | N=4 | Owner |
| `call_cost_no_results` | Call spend up while conversions flat/down | 2 periods | Manager |
| `incentive_not_clawed_back` | Payout not reversed after refund | window | Finance handler |
| `idle_spend` | Recurring subscription/seats unused | 30 days | Owner |
| `cash_runway_low` | Forecast balance below minimum | min cash | Owner |
| `connector_unhealthy` | No events or repeated failures | 24h / 5 fails | Owner |

**Outlier test (robust to a few extreme values):**

```
modified_z = 0.6745 × (x − median) / MAD        flag when |modified_z| > 3.5
```

Add week-over-week change limits and an EWMA control chart for gradual drift. Require a minimum sample size (default 8 periods) before statistical rules fire; otherwise stay silent rather than guess.

**Example rule definition:**

```json
{
  "code": "slipped_promise",
  "severity": "medium",
  "enabled": true,
  "schedule": "hourly",
  "params": { "grace_days": 1 },
  "route_to_role": "telecaller",
  "escalate_after_hours": [24, 48],
  "escalation_path": ["telecaller", "manager", "owner"],
  "message_template": "Payment of {amount} from {customer} promised for {date} not received.",
  "recommended_action": "Call the customer and record a new promise date."
}
```

### 12.5 Reminders, routing and escalation

- **Routing by role** (table above); the assignee is the person closest to the money (for dues, the deal's telecaller).
- **Due reminders:** T-3, T0, T+3, T+7 relative to the due date, each creating a task for the collector.
- **Escalation ladder:** if not acknowledged within N hours, escalate assignee → manager → owner; record each step in `alert_event`.
- **Lifecycle:** `open → acknowledged → resolved | dismissed (reason required) → reopened if condition returns`.
- **Controls:** de-duplication (one open alert per rule+subject), snooze, quiet hours, channel choice (in-app, email, WhatsApp, push), daily and weekly digest.
- **Feedback loop:** dismissal reasons feed **suggested** threshold changes ("dismissed 8 times; raise the limit?"). The owner approves; thresholds are never changed silently.
- **Notify-only by default:** the Advisor notifies staff. It must not message customers or move money unless the owner enables a specific action.

### 12.6 Outputs

- **Money-leak report:** leaks ranked by estimated ₹/month with rule, owner and action.
- **Finance health score (0-100):** weighted from collection rate, margin, runway, leakage ratio and DSO. Weights and each component are visible on screen.
- **Explain panel** on every alert: data used, formula, linked records.

---

## 13. Non-functional requirements

- **Security:** encrypt credentials; verify every webhook; rate-limit public endpoints; no secrets in logs or error messages; PII minimized in raw event views.
- **Performance:** dashboards load from snapshots, not raw scans; p95 under 2 s for dashboard endpoints at the target data volume; webhook endpoint acks in under 1 s.
- **Reliability:** webhook handling is idempotent and replayable; jobs are retried; nothing is lost on deploy.
- **Observability:** structured logs with request/event IDs; metrics for queue depth, webhook failures, match rate, alert volume; health endpoint.
- **Data integrity:** DB constraints for money invariants (for example `paid_minor <= amount_minor` unless overpayment is explicitly credited); period locking enforced in the data layer.
- **Accessibility and UX:** keyboard navigable tables, readable contrast, responsive down to tablet.

---

## 14. Build order (milestones with acceptance criteria)

Do each milestone fully, with tests, before starting the next.

**M0: Discovery.** Inspect the repo; write `DECISIONS.md` (stack found, defaults applied, assumptions). *Done when:* decisions recorded and a hello-world migration runs.

**M1: Foundations.** Money utilities (minor units, formatting), roles/permissions, audit log, deal templates, deals, payment schedules, period locking. *Done when:* an owner can define two templates, create deals, and see generated schedules; permission tests pass.

**M2: Payments core.** Canonical `payment`, manual entry with proof and second-person approval, cheque clearing, refunds, ledger with reversals, dues and aging views. *Done when:* a cash payment above the threshold stays pending until approved; a bounced cheque reverses cleanly; ledger always balances.

**M3: Connector framework + Razorpay.** Connector interface, raw event store, idempotency, queue, retries, DLQ, health page, Razorpay mapper, payment-link helper with notes, backfill, daily reconciliation. *Done when:* replaying the same webhook twice creates one payment; a missed webhook is recovered by reconciliation; a bad signature is rejected.

**M4: Matching and reconciliation.** Matching engine, confidence threshold, unmatched queue UI, settlements with fee/net/bank-credit and mismatch flag. *Done when:* match rules behave per section 8 on fixtures and mismatches are flagged.

**M5: Expenses, costs, bank import.** Expenses with approvals, cost drivers, telephony cost import, bank statement CSV import with auto-match. *Done when:* a statement import matches known payments and surfaces the rest.

**M6: Metrics and dashboards.** Metrics layer, nightly snapshots, owner/manager/telecaller/finance-handler screens, drill-down, freshness stamps. *Done when:* every dashboard number reconciles with the ledger and drills to its records.

**M7: Incentives.** Plan types, calculation from collected payments, clawback, payout approval flow, statements. *Done when:* a refunded sale inside the window produces a clawback line next period.

**M8: Advisor v1.** Rules engine, seed rules from 12.4 (non-statistical first), alert lifecycle, routing, due reminders, escalation, digests, explain panel. *Done when:* each seeded rule has a fixture test that fires it and a test that does not.

**M9: Advisor v2.** Cash-flow forecast with scenarios, outlier/EWMA detection, health score, leak report, threshold suggestions from feedback. *Done when:* forecast backtests on fixture history within a documented error band and statistical rules stay silent below minimum sample size.

**M10: Hardening and roadmap connectors.** Additional gateways, accounting export (Tally first), ad-spend connectors, load and security review. *Done when:* a second gateway ships with only a new mapper and config.

---

## 15. Defaults for open decisions

Use these unless the owner of the project says otherwise; record them in `DECISIONS.md`.

| Decision | Default |
| --- | --- |
| Currency / tax | INR with GST; multi-currency-ready schema |
| Manual payment approval threshold | ₹50,000 (org-configurable) |
| Advisor actions | Notify staff only; no customer messaging or money movement |
| Auto-match threshold | 0.85 confidence |
| Min sample for statistical rules | 8 periods |
| Reminder offsets | T-3, T0, T+3, T+7 |
| Escalation | 24 h → manager, 48 h → owner |
| Quiet hours | 21:00-08:00 org timezone |
| Overpayment handling | Credit balance on the deal |
| Partial payment application | Oldest open schedule item first |

---

## 16. Testing requirements

- **Unit:** money math, matching rules, incentive calculation, each advisor rule (fires / does not fire), outlier and forecast functions.
- **Integration:** webhook → payment → ledger → snapshot → alert, end to end, with signed fixture payloads.
- **Idempotency and replay:** duplicate and out-of-order events; replay from raw store yields identical state.
- **Permissions:** negative tests proving each role cannot read what it must not (especially telecaller-to-telecaller).
- **Invariants (property-style):** ledger debits equal credits; `sum(payments applied) <= deal total + credits`; locked periods reject writes.
- **Fixtures:** provide a seed dataset with at least 6 months of deals, payments, refunds and expenses so dashboards, forecasts and rules are testable without live gateways.

---

## 17. Definition of done (module level)

- All milestones M1-M9 accepted against their criteria.
- No floats for money anywhere in code or schema.
- Every dashboard number drills down and reconciles to the ledger.
- Every advisor alert has an explain panel and a fixture test.
- Connector credentials never appear in logs, APIs or UI.
- `DECISIONS.md`, API docs, and a short operator runbook (connector setup, replaying failed events, closing a period) are written.
