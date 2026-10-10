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

---

## Setting up a tenant's compliance calendar and document vault

Migrations 0180–0182. Three steps, in this order, because each one narrows the
next.

### 1. Tell the system what shape of business it is

```
PATCH /v1/finance/compliance/profile
{ "entityType": "private_limited",
  "registrations": ["gst", "tds", "income_tax", "payroll", "roc"] }
```

`entityType` is one of `proprietorship`, `partnership`, `llp`,
`private_limited`, `public_limited`, `trust`. `registrations` is what they
actually hold.

**This is not cosmetic.** It decides which filings and which document categories
are seeded. A one-person proprietorship seeded with the company set gets ROC
filings and board minutes it must ignore, and a calendar people ignore is worse
than no calendar.

The financial year start is **not** set here — it lives on
`org_business_profile.fy_start_month` (migration 0126, default 4 for April) and
is edited at `/owner/account/time`. Change it there before generating filings,
because a filing's period label is written at generation time.

### 2. Seed the calendar and the vault

```
POST /v1/finance/compliance/items/seed      { "applicableOnly": true }
POST /v1/finance/documents/categories/seed  { "applicableOnly": true }
```

Both are idempotent on `(org_id, code)`: safe to re-run after a deploy that adds
a new catalogue entry, and a row the tenant has edited is left exactly as it is.

Pass `applicableOnly: false` only if somebody wants the whole catalogue
regardless of the profile.

### 3. Generate a year of filings

```
POST /v1/finance/compliance/filings/generate   { }                       # this FY
POST /v1/finance/compliance/filings/generate   { "fyStartYear": 2027 }   # next FY
```

Idempotent on `(org_id, item_id, period_start, period_end)`, so it can be run
nightly and insert nothing. It never updates an existing filing's `due_on` —
see DECISIONS.md §5.3 for why rewriting a generated due date would make a
return filed on time look late.

Run it again in March for the coming year, or whenever an item is added.

---

## When a date is wrong

It will be. §2's own callout says so: "Dates, thresholds and forms change by
budget, notification and extension."

**One filing moved by a notification** (the common case):

```
PATCH /v1/finance/compliance/filings/:id/due-date
{ "dueOn": "2026-11-15", "notes": "Extended by notification" }
```

Sets `due_on_overridden`, so a regeneration can tell its own output from a
human's correction.

**The rule itself is wrong** (so every future period is wrong):

```
PATCH /v1/finance/compliance/items/:id
{ "dueRule": { "kind": "day_of_month_after", "day": 22, "monthsAfter": 1 } }
```

Then regenerate — existing filings keep the date they were generated with, which
is correct, and new periods get the new rule.

**The item does not apply to this business at all:**

```
PATCH /v1/finance/compliance/items/:id   { "enabled": false }
```

Existing open filings stay. Waive each one with a reason, which clears the red
without erasing the record that it was considered:

```
PATCH /v1/finance/compliance/filings/:id/waive   { "reason": "Turnover below the threshold" }
```

A reason is required — 0181's `compliance_filings_waiver` CHECK enforces it, for
the reason §12.5 requires one to dismiss an alert: "not applicable" with no note
is indistinguishable from somebody clearing a row they did not understand.

---

## Importing a bank statement or a payment file

The whole flow is the console's: `/owner/import`. What an operator needs to know
when it goes wrong.

**"Importing payments needs permission to create finance records."** The caller
holds the import role (owner / manager / marketing) but not `finance:create`.
Grant it in the permission grid; do not widen the import role.

**The wizard asks how the dates should be read.** That means no date in the
mapped column has a day past the 12th, so the file genuinely cannot be read
either way. Ask the person who exported it. Never guess — DECISIONS.md §5.12.

**"This file cannot be imported as it is - two rows disagree about the
format."** The file mixes dd/mm and mm/dd. There is no safe import; it has to be
fixed at source.

**A staged job sitting in the history as "Not applied."** Somebody abandoned the
wizard between staging and committing. Nothing was written. Discard it:

```
DELETE /v1/import/jobs/:jobId
```

**Undoing a committed import:**

```
POST /v1/import/jobs/:jobId/rollback   { "reason": "Wrong file" }
```

Returns `{ undone, kept, problems }`, and `kept > 0` is normal rather than a
failure. What it will not touch:

| Row | Behaviour |
| --- | --- |
| Bank statement line | deleted, unless it has been reconciled to a payment |
| Expense, unapproved | deleted |
| Expense, approved | **left alone** — it is in the margin; reverse it instead |
| Payment | **reversed**, never deleted (§6.3): a reversing ledger posting, the schedule re-derived, status `reversed` |
| Anything in a locked month | the whole rollback fails on 0172's period trigger |

The last row is deliberate. A locked period means the books are closed on that
month, and an undo would silently change a figure somebody may have filed a
return against. Reopen the period first if the correction is genuinely needed.

---

## The five reminder rules

They are Advisor rules, so everything in the Advisor section above applies —
same inbox, same routing, same snooze, same escalation. They run in the
**nightly** sweep.

| Code | Fires | Goes to |
| --- | --- | --- |
| `compliance_due` | on each of a filing's reminder offsets | finance handler |
| `compliance_overdue` | day 1 past due, then weekly | finance handler → manager → owner |
| `document_expiring` | on each of a document's reminder offsets | owner |
| `document_expired` | day 1 past expiry, then fortnightly | owner |
| `books_not_closed` | 10 days after a month ends, then weekly | finance handler → owner |

**A quiet inbox is not a broken one.** Each has a `silentBecause` that the
explain panel shows: already filed, not a reminder day, inside the grace period,
a newer version uploaded. If somebody insists a reminder is missing, check that
the item is `enabled`, that the filing exists for the period (generate if not),
and that `reminder_offsets` is not empty — an item with no offsets reminds only
on the rule's own `fallbackDays`.

**Filing a return resolves its alerts immediately** rather than waiting for the
next sweep, and uploading a renewal with `supersedesId` resolves the document's.
If an alert for a filed return is still open, the filing was marked filed by
something other than `PATCH /filings/:id/file`.
