# Finance module — operator runbook

Written for whoever is on call, not for whoever built it. Three procedures §17
asks for by name — turning a tenant on, replaying failed connector events,
closing a period — plus the things that go wrong and what they look like.

Everything here assumes the deploy sequence in `DEPLOYMENT.md`. The one
module-specific rule: **migrations before the API**, because the finance
controllers select columns that do not exist before 0172–0179 and an unmigrated
database answers every finance route with a 500.

---

## 1. Turning the module on for a tenant

The module is `finance`, and it is **off for every tenant** until an operator
turns it on.

```
PATCH /v1/admin/tenants/<orgId>/modules   { "modules": ["aura", "crm", "finance"] }
```

**`crm` must be in that list.** Finance's spine is `deals`: a payment schedule
hangs off one, the incentive calculation credits the deal's owner, and every
collections figure is "what this deal owes". A tenant with `finance` and no
`crm` gets a dashboard of zeros and no way to create a non-zero — the nav hides
the pages for that reason (`CRM_GATED_HREFS` in `apps/web/lib/nav.ts`).

Then, in the tenant's own console:

1. **`/owner/settings/finance`** — the approval threshold (default ₹50,000),
   the auto-match confidence (0.85), the minimum cash the forecast warns
   against. All optional: every one falls back to `FINANCE_DEFAULTS`.
2. **`/owner/finance/connectors`** — connect Razorpay if they collect online.
   Owner only; see §3.
3. **A deal template** — `/owner/finance/deal-templates`. Nothing in the module
   produces a schedule until a template exists, and a deal with no schedule
   appears nowhere in dues, aging or collections. **This is the most common
   "finance shows nothing" cause.**

### What to expect on day one

Quiet. The four statistical rules (`fee_drift`, `refund_spike`,
`expense_outlier`, `call_cost_no_results`) refuse to fire below eight periods of
history, and say so in their `explain.silentBecause`. That is working, not
broken.

---

## 2. Replaying failed connector events

A failed event is a **row**, not a lost message. `connector_events` is the
queue: the webhook verifies, stores and acks; the worker's drain normalizes.

### Reading the state

```
GET /v1/finance/connectors                    -- queue depth, failures, last event
GET /v1/finance/connectors/<id>/events?failedOnly=1
```

`deadLettered: true` on an event means `attempts >= 8` with nothing processed —
the drain has stopped picking it up. Its `error` is the last exception.

### Replaying

```
POST /v1/finance/connectors/<id>/replay   { "failedOnly": true }
POST /v1/finance/connectors/<id>/replay   { "from": "2026-03-01", "to": "2026-03-07", "failedOnly": false }
```

This sets `processed_at = NULL, attempts = 0` and the drain picks them up within
~30 s. **A replay is safe to run twice**: every insert the normalizer makes is
keyed on the gateway's own id with `ON CONFLICT DO NOTHING`, so replaying an
event that already succeeded changes nothing.

### The order that matters

A refund or dispute whose payment has not been normalized yet **throws on
purpose** — `refund <id> precedes its payment`. It is not an error to chase: the
row stays queued and succeeds once the capture event ahead of it is processed.
If you see it stuck past a few minutes, the CAPTURE event is the one to look at.

### After a mapper bug

This is what the design is for. Ship the fix, then replay the window — the
normalizer re-runs over the original stored bytes. Do **not** try to re-fetch
from the gateway for this: `payload` is immutable (a trigger refuses an edit),
and the stored bytes are the only record of what was actually sent.

### A missed webhook

`POST /v1/finance/connectors/<id>/reconcile  { "days": 3 }` pulls the gateway's
own payment list and stores anything never delivered. The worker does this every
six hours by itself. A non-zero `missing` in the log is worth noticing:

```
[finance-reconcile] <org>/razorpay: recovered 2 of 54 payment(s) the webhook never delivered
```

---

## 3. Closing and re-opening a period

```
POST   /v1/finance/periods/2026-03        -- close
DELETE /v1/finance/periods/2026-03        -- re-open
GET    /v1/finance/periods
```

Only a month that has **ended** can be closed, and only `finance:create` (the
three admin roles) may do either.

Once closed, any INSERT or UPDATE on `finance_payments`, `ledger_entries` or
`expenses` dated inside it is refused by a trigger with a `23514`, which the API
maps to a 409 reading *"2026-03 is a closed period — date this in the current
open month"*. That includes a legitimate late receipt, which is the point.

**Re-opening is the most consequential action in the module** — it makes a
figure somebody has already reported changeable again. It is audit-logged as
`finance.period.reopened` with the actor. There is no soft version.

To correct a locked month without re-opening it: reverse in the current period.
`POST /v1/finance/payments/<id>/reverse` and the expense reversal both date
their reversing ledger entry **today**, deliberately, so they do not need the
lock lifted.

---

## 4. What goes wrong, and what it looks like

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every finance route 500s after a deploy | API ahead of migrations | Run 0172–0179 |
| Every finance route 403s | module not granted, or the role has no `finance:*` grant | §1; then Team & permissions |
| Dashboard is all zeros, dues empty | no deal has a payment schedule | Create a template, apply it to a deal |
| A collection figure disagrees with the ledger | the snapshot is stale | Snapshots are a cache: delete the day's rows from `finance_snapshots` and the next sweep (hourly) rebuilds them from the ledger. If they disagree again, the ledger is right |
| "Connector synced N days ago" but status says connected | webhooks stopped; `last_event_at` only moves on a VERIFIED delivery | Check the gateway's webhook config points at `/v1/finance/webhooks/<connectorAccountId>`, then reconcile |
| Webhook returns 202 but nothing appears | signature failed — stored with `signature_ok = false` and never processed | Re-save the webhook secret from the connector screen (owner only) |
| Advisor raises nothing at all | the module's orgs are read by `'finance' = ANY(enabled_modules)`; also check `advisor_rules.enabled` and `snooze_until` | §1 |
| An alert is assigned to nobody | no member holds the target persona or `finance:edit` | Assign a persona, or grant `finance:edit` |
| `notifications` insert fails with 23514 | `notifications.kind` does not admit `finance_alert` | 0179 restates the CHECK; confirm it applied **after** 0177 |
| Incentives all zero | the plan's rules do not match its type, or payouts are already `approved` | `GET /v1/finance/incentive-plans`; a plan past `calculated` is deliberately not recomputed |
| A payout cannot be approved | the approver is the payee | Somebody else approves it. There is no override |

### Proving the ledger is sound

```sql
SELECT posting_id, sum(debit), sum(credit)
  FROM ledger_entries WHERE org_id = '<org>'
 GROUP BY posting_id HAVING sum(debit) <> sum(credit);
```

Zero rows is the invariant (§16). `unbalancedPostings()` in
`apps/api/src/modules/finance/ledger.ts` is the same query.

If it ever returns rows, **do not edit them** — `aura_app` holds only
`SELECT, INSERT` on that table, which is deliberate. Post a correcting
adjustment and open a bug with the `posting_id`.

---

## 5. Things that are deliberately impossible

Worth knowing before somebody is asked to do one of them under pressure.

- **Nothing in this module messages a customer.** There is no outbox, no
  template and no send path. A due reminder creates a *task* for the collector.
  If a client asks for automated dunning, that is a new feature with an explicit
  owner-thrown switch — not a configuration change.
- **No payment or ledger row can be edited or deleted.** Corrections are
  reversals. The grants enforce it.
- **No connector credential is readable through any API**, including by an
  operator. `credentials_enc` is omitted from every response; the screens get a
  boolean. Recovering a lost key means getting it from the gateway.
- **The Advisor calls no language model.** Every decision is a pure function in
  `packages/shared/src/finance-detectors.ts`. If an alert looks wrong, it is
  reproducible: the `explain` payload holds the formula and every input.
- **Thresholds are never changed automatically.** Repeated dismissals produce a
  row in `advisor_suggestions` that an owner approves.

---

## 6. Verifying a deploy

```bash
cd platform/packages/db
DATABASE_URL=... node migrate.js
DATABASE_URL=... node verify-rls.js --structural-only   # safe against prod
```

`verify-rls` is the one that matters here: all 23 finance tables carry `org_id`,
RLS forced, an `org_isolation` policy **and** 0163's restrictive `partner_wall`.
A missing wall means a channel partner can read the tenant's ledger, and the
structural half catches it before a deploy finishes.

Then, as a smoke test on one tenant:

```
GET /v1/finance/overview?from=<first of month>&to=<today>
GET /v1/finance/advisor/alerts
GET /v1/finance/connectors
```

A 200 with `freshness.label` reading *"not computed yet"* is correct on a fresh
deploy — the first snapshot sweep runs within the hour, and the figures are
computed live until it does.
