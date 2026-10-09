# Finance module — API reference

The routes, what gates each one, and the rules that are not obvious from a
signature. All paths are under `/v1`; `main.ts` adds that prefix at bootstrap.

Every route except the webhook carries `AdminKeyGuard → TenantGuard →
CrmPermissionsGuard`, in that order, and a `@RequireCrmPermission` on the
`finance` or `incentive` grid object. Both objects are filed under the `finance`
OrgModule, so a tenant without it is refused exactly as if the grant were
missing. Money is **major units** in every request and response, as everywhere
else in this API; it is converted to integer paise once at the boundary and all
arithmetic happens there (`packages/shared/src/money.ts`).

---

## Deal templates and schedules (§5)

| Route | Grant | Notes |
| --- | --- | --- |
| `GET /finance/deal-templates` | `finance:view` | `?includeInactive=1` for superseded versions |
| `GET /finance/deal-templates/:id` | `finance:view` | |
| `POST /finance/deal-templates` | `finance:create` | 409 on a duplicate `templateKey` |
| `PATCH /finance/deal-templates/:id` | `finance:edit` | **Inserts a new version.** Only an `active`-only patch is a true update — see below |
| `POST /finance/deal-templates/:id/preview` | `finance:view` | Writes nothing. Same `generateSchedule()` the write path uses |
| `POST /finance/deals/:dealId/schedule` | `finance:create` | Generates the rows and posts the booking to the ledger |
| `GET /finance/periods` | `finance:view` | |
| `POST /finance/periods/:month` | `finance:create` | Only a month that has ended |
| `DELETE /finance/periods/:month` | `finance:create` | Re-opens. Audit-logged |

**Why a PATCH is an INSERT.** §5: "changing a template creates a new version;
existing deals keep the version they were created with." Editing in place would
retroactively change what a deal was sold under — a schedule generated in
January would stop matching its template, and a custom field a deal's data
depends on could disappear. So anything affecting generation supersedes the
active version. Changing `active` alone is a real update, because activating or
retiring a version is not a change *to* the version.

**Generating over an existing schedule** needs `replace: true`, and is refused
outright once any payment has been applied — deleting a schedule item money
points at would orphan the payment and silently reduce "collected".

---

## Payments, dues and matching (§6, §8)

| Route | Grant | Notes |
| --- | --- | --- |
| `GET /finance/payments` | `finance:view` | `matchStatus`, `status`, `dealId`, `from`/`to`, `pendingOnly` |
| `POST /finance/payments` | `finance:create` | Offline methods land `pending_verification` |
| `PATCH /finance/payments/:id/verify` | `finance:edit` | Cheque clearing. **Second person enforced in the handler** |
| `POST /finance/payments/:id/reverse` | `finance:create` | Reversing posting + status move. Reason required |
| `POST /finance/payments/:id/refund` | `finance:create` | Refuses more than is still refundable |
| `GET /finance/matching/queue` | `finance:view` | Candidates re-derived per read, not stored |
| `POST /finance/payments/:id/match` | `finance:edit` | One item or a split across several |
| `GET /finance/dues` | `finance:view` | `bucket`, `dealId`, `ownerUserId`. Whole-set aging summary |
| `PATCH /finance/dues/:id/promise` | `finance:edit` | What `slipped_promise` fires on |

**The second-person rule.** §6.2 requires a second approver above the org's
threshold (default ₹50,000). It is checked in the handler, not by a constraint,
because what has to be true is that the *actor of this request* is not the one
who recorded the payment — and only the request knows who that is. Below the
threshold any `finance:edit` holder may confirm: a ₹500 cash receipt needing two
signatures is a rule people route around rather than follow.

**Offline money moves nothing until confirmed.** A `pending_verification`
payment posts no ledger entry and pays down no instalment. Until a second pair of
eyes has seen the cash, a claim that it arrived must not change what the business
believes it collected — otherwise the threshold is a formality.

**A split across two deals is refused** (400). The canonical payment carries one
`deal_id`, so a cross-deal split would have to lose that link or become two
payments — and silently splitting one bank credit into two rows would break the
gateway idempotency key that stops double-crediting. Two receipts is the honest
answer.

---

## Connectors (§7)

| Route | Grant | Notes |
| --- | --- | --- |
| `GET /finance/connectors/available` | `finance:view` | What is wired, from the registry |
| `GET /finance/connectors` | `finance:view` | Health, queue depth, dead-lettered count |
| `POST /finance/connectors` | `finance:create` **+ owner** | Credentials validated against the gateway before they are stored |
| `POST /finance/connectors/:id/disconnect` | `finance:create` **+ owner** | Clears credentials; does **not** delete the account |
| `GET /finance/connectors/:id/events` | `finance:view` | `?failedOnly=1` |
| `POST /finance/connectors/:id/replay` | `finance:create` | 202. Safe to run twice |
| `POST /finance/connectors/:id/test` | `finance:create` | Maps to nothing — proves the pipeline without inventing a payment |
| `POST /finance/connectors/:id/reconcile` | `finance:create` | Capped at 30 days; runs inline |
| `POST /finance/webhooks/:connectorAccountId` | **none** | See below |

**The two owner-only routes** are the ones a secret arrives on. §3 gives the
finance handler everything *except* connector secrets, and a grid cell is the
wrong shape for "nobody but the owner, ever" — it can be ticked. So they carry
`OwnerRoleGuard` and `@RequireOwnerRole("owner")` on top of the grant, and they
are deliberately **not** marked `@OperatorMayCall()`: a platform operator holding
the bare admin key must not be able to write a client's gateway credentials.

**`credentials_enc` is never returned by anything.** The column is omitted from
every select; screens get a `hasCredentials` boolean.

**The webhook has no guards, and that is the design.** A gateway cannot present
an admin key. Its authentication is an HMAC over the raw body, verified against
the account named in its own path *before* the body is parsed. An unknown
account, a missing secret and a bad signature all return the same 202 — telling
the caller which would disclose whether a connector id exists. A rejected
delivery is still stored with `signature_ok = false`, because that row is the
evidence somebody wants when a secret has been rotated and nobody updated it
here.

Unlike 0060's Razorpay route, this one takes the account id in the **path**, so
the org is known from the URL and everything after the signature check runs
inside the ordinary tenant transaction.

---

## Expenses and cost drivers (§9, §12.3)

| Route | Grant | Notes |
| --- | --- | --- |
| `GET /finance/expenses` | `finance:view` | Returns `periodTotal` over the whole filter, not the page |
| `GET /finance/expenses/summary` | `finance:view` | §12.3's fixed/variable split by category |
| `POST /finance/expenses` | `finance:edit` | Not posted to the ledger until approved |
| `PATCH /finance/expenses/:id` | `finance:edit` | Classification only — see below |
| `PATCH /finance/expenses/:id/approve` | `finance:edit` (+ `finance:create` above the limit) | Somebody other than the enterer |
| `POST /finance/expenses/:id/reverse` | `finance:create` | Mirror row + reversing posting, dated today |
| `GET /finance/cost-drivers` | `finance:view` | |
| `POST /finance/cost-drivers` | `finance:edit` | A manual value is never overwritten by a measured one |

**`amount` and `incurredOn` are not patchable.** §6.3's rule covers costs:
editing a posted amount would silently change a month that may already have been
reported, and changing the date would move it between periods behind the period
lock's back. What *is* editable is classification — category, vendor, which
source or person it belongs to, fixed vs variable — because those are
bookkeeping judgements people legitimately revise and none of them change what
was spent.

**Ad spend is not entered here.** `marketing_source_spend` (0171) already
collects it and the cost layer reads that table. An `advertising` expense is for
the agency retainer, not the campaign.

---

## Incentives (§10)

| Route | Grant | Notes |
| --- | --- | --- |
| `GET /finance/incentive-plans` | `incentive:view` | |
| `POST /finance/incentive-plans` | `incentive:edit` | Rules must match the plan type |
| `PATCH /finance/incentive-plans/:id` | `incentive:edit` | Never recalculates an approved payout |
| `GET /finance/payouts` | `incentive:view` | **Scoped** |
| `GET /finance/payouts/:id` | `incentive:view` | **Scoped.** 404, not 403 |
| `POST /finance/payouts/calculate` | `incentive:edit` | Idempotent; skips anything past `calculated` |
| `PATCH /finance/payouts/:id/status` | `incentive:edit` | `calculated → approved → paid`. Not your own |

**The privacy rule.** §3: "a telecaller must never be able to read another
telecaller's pay or incentive, even by guessing an ID." Every payout read applies
`scopeClause("incentive", …)` against `incentive_payouts.user_id`, and
`CrmPermissionsGuard` narrows a telecaller or sales persona to `owned` even where
the grid said `all`. The single-payout read applies it too — that is the half
that answers the guessing — and returns **404** rather than 403, because a 403 on
a specific id confirms the id exists.

**Collected only.** §10 is a MUST: every earning query filters on
`COLLECTED_STATUSES`. An authorized card payment, an unverified cash claim and a
bounced cheque all earn nothing.

**Lines are apportioned, not computed per payment.** A slab plan is marginal, so
the incentive on a month is not the sum of the incentive on each payment taken
alone. The total is computed once from the month's collections and the lines are
that total apportioned by each payment's share — which keeps the statement's
lines summing exactly to the figure above them.

---

## Dashboards and the ledger (§11)

| Route | Grant | Notes |
| --- | --- | --- |
| `GET /finance/overview` | `finance:view` | Snapshots for complete days, live for today |
| `GET /finance/breakdown` | `finance:view` | `by=user\|source\|template` |
| `GET /finance/my-money` | `finance:view` | One person's own figures — a narrower *response*, not a filter |
| `GET /finance/ledger` | `finance:view` | Grouped by posting; publishes whether the window balances |
| `GET /finance/ledger/export` | `finance:export` | CSV, bounded to a page |

**`overview` falls back to live.** If the snapshot rows do not cover the whole
window — a nightly job that did not run, a tenant enabled mid-period — the
figures are computed live for the *whole* window rather than reporting a partial
sum. A dashboard that under-reports because a cron job failed is worse than a
slow one, because nothing on screen says anything is wrong. `freshness.label`
tells the reader which it got.

**`my-money` is a separate route** and not `overview?scope=user`, because of what
it must *not* return: `overview` publishes org-wide costs, the cash balance, the
burn and the health score. A narrower route with a narrower response is the only
version where the restriction is structural rather than a filter somebody has to
remember.

---

## The Advisor (§12)

| Route | Grant | Notes |
| --- | --- | --- |
| `GET /finance/advisor/alerts` | `finance:view` | `order=at_risk` for §12.6's ranking |
| `GET /finance/advisor/alerts/:id` | `finance:view` | Includes the full `alert_events` trail |
| `PATCH /finance/advisor/alerts/:id` | `finance:edit` | Acknowledge, resolve, dismiss (reason required), snooze |
| `GET /finance/advisor/rules` | `finance:view` | Catalogue merged with this org's overrides |
| `PATCH /finance/advisor/rules/:code` | `finance:create` | Params **merge**; an unknown param is a 400 |
| `GET /finance/advisor/suggestions` | `finance:view` | |
| `PATCH /finance/advisor/suggestions/:id` | `finance:create` | The only path from a suggestion to a threshold |
| `GET /finance/advisor/leaks` | `finance:view` | Ranked by money, severity as the tie-break |
| `GET /finance/advisor/forecast` | `finance:view` | 30/60/90, three scenarios, `lowConfidence` |
| `GET /finance/advisor/totals` | `finance:view` | The rollup without the dashboard's framing |

**No model, anywhere.** §12's MUST. Every decision is a pure function in
`packages/shared/src/finance-detectors.ts`; the only text production is
`renderMessage` substituting into a rule's own template. There is no `@aura/llm`
import in this module and there must not be one.

**Notify-only.** §12.5. An alert raises an in-app notification and a due
reminder creates a *task* — both for staff. No route here messages a customer or
moves money.

**Thresholds are never changed silently.** Repeated dismissals produce a row in
`advisor_suggestions`; only the PATCH above applies one, and nothing in the
worker may.

**`lowConfidence` is the most important field in the forecast response.** It is
true until the org's own collection history outweighs the conservative priors. A
forecast an owner acts on is worse than no forecast when its confidence is
fictional.
