# Finance module — DECISIONS

Written for the next person to touch `finance/*`, per §14 M0 and §15 of
`Build docs/finance-section-build-plan.md`. It records the stack that was found,
the defaults that were adopted, and — the part that matters — every place the
spec's default was **not** taken and why.

---

## 1. The stack that was found (§2: "inspect the repository and adopt it")

| Concern | What this repo already uses | Adopted |
| --- | --- | --- |
| Language / runtime | TypeScript 5.8, Node, pnpm workspace (`aura-platform`) | yes |
| API | NestJS 11 — controllers + guards, no service layer for thin surfaces | yes |
| Web | Next.js App Router (`apps/web`), server components + server actions | yes |
| Worker | plain Node process, `apps/worker`, RabbitMQ consumers + interval sweeps | yes |
| ORM | **none** — raw SQL through `pg`, inside `withOrgContext` transactions | yes |
| Migrations | numbered `.sql` in `packages/db/migrations`, mirrored to `supabase/migrations` by `scripts/sync-supabase-migrations.js` | yes |
| Tests | vitest (`pnpm -r test`), plus an integration config needing Docker | yes |
| UI | `@aura/ui` kit + Tailwind, lucide icons | yes |
| Multi-tenancy | `org_id` on every table, Postgres RLS **ENABLE + FORCE + `org_isolation`**, `aura_app` non-superuser role | yes |
| Secrets | `packages/db/src/secrets.ts`, AES-256-GCM envelope (`CRM_SECRET_KEY`) | yes |
| Files | `apps/api/src/s3` (MinIO locally, S3-compatible in prod) | yes |
| Audit | `audit_log (org_id, actor_type, actor_id, action, target_type, target_id, meta)` | yes |
| Permissions | three axes: `memberships.role`, `memberships.owner_role` persona, `role_permissions` grid | yes |

So §2's default table was used for almost nothing: the only row where this repo
had no prior art is the **queue for connector events**, and §9's advice there was
taken in spirit rather than literally (see 4.4).

---

## 2. Defaults adopted unchanged from §15

| Decision | Value |
| --- | --- |
| Currency / tax | INR + GST; `currency CHAR(3)`-shaped columns everywhere so a second currency is data, not a migration |
| Manual payment approval threshold | ₹50,000, per-org (`finance_settings.manual_approval_threshold`) |
| Advisor actions | **notify staff only.** No customer messaging, no money movement, ever |
| Auto-match threshold | 0.85 confidence, per-org |
| Min sample for statistical rules | 8 periods |
| Reminder offsets | T-3, T0, T+3, T+7 |
| Escalation | 24 h → manager, 48 h → owner |
| Quiet hours | 21:00–08:00, org timezone |
| Overpayment handling | credit balance on the deal |
| Partial payment application | oldest open schedule item first |

All ten live in one exported object — `FINANCE_DEFAULTS` in
`packages/shared/src/finance.ts` — and the per-org overrides are columns on
`finance_settings`. A default that exists in two places is a default that
disagrees with itself within a month.

---

## 3. Deviations from the spec, with reasons

### 3.1 Money is `numeric` in Postgres, integer paise in TypeScript

§2 says `BIGINT` minor units. This repo stores money as `numeric` — `invoices.total`,
`invoice_items.line_total`, `payments.amount`, `quotations.*`, `products.price`,
`marketing_source_spend.amount`.

`numeric` is an **exact decimal**, not a float, so the real requirement ("never
floats", §17) is already met by the column type. What the spec is actually
protecting against is binary floating point, and in this stack that danger lives
entirely in TypeScript, where every `number` is an IEEE-754 double — which is
exactly where the existing code does its money arithmetic
(`packages/shared/src/quotations.ts` multiplies and `round2()`s doubles).

So the rule was split:

* **Storage** stays `numeric`, matching every money column that already exists.
  A `BIGINT`-paise ledger beside a `numeric` invoice would put a
  `round(invoices.total * 100)` in the middle of every reconciliation query and
  every drill-down join — and the one thing §11 demands is that a dashboard
  number reconcile to the ledger.
* **Arithmetic** happens in integer minor units: `packages/shared/src/money.ts`
  parses a `numeric` string straight to paise without ever going through a
  fractional double, adds/splits/apportions in integers, and converts back once
  at the edge. `money.test.ts` pins the cases that catch a float
  (`0.1 + 0.2`, a 3-way split of ₹100, 18 % GST on ₹1,999.99).

`Number.MAX_SAFE_INTEGER` in paise is ≈ ₹90,071 crore, which is past anything
this product will invoice; `money.ts` refuses above that rather than losing
precision silently.

### 3.2 The canonical payment is a new table, `finance_payments`

§6.1 wants one canonical payment record. `payments` (migration 0060) cannot be
it: `invoice_id` is `NOT NULL`, its status CHECK is `created|paid|failed`, and it
means "a gateway payment link raised against an invoice". Widening it would have
to relax a `NOT NULL` that three controllers depend on.

`finance_payments` is the canonical record (§6.1's methods, sources and
statuses). Migration 0060's `payments` keeps its job as a **source**: when the
Razorpay webhook captures one, the ledger writer normalizes it into
`finance_payments` with `source = 'connector'` and `origin_payment_id` pointing
back. Nothing about today's invoice collection changes, and "collected" has one
definition.

### 3.3 No "finance handler" persona. Two new grid objects instead

§3 lists four roles. This repo's personas (`memberships.owner_role`) are
`owner | manager | telecaller | sales | marketing`, and `resolveOwnerRole()` is
**fail-open** — an unrecognised value resolves to `owner`, full access — so
adding a sixth persona means new data meeting old code during a rolling deploy
grants more access, not less.

The spec's roles therefore map onto the axes that already exist:

| §3 role | How it is expressed |
| --- | --- |
| Owner | `owner_role = 'owner'` + `finance:*` grants |
| Finance handler | any persona holding `finance:edit` — in practice an `owner` or `manager` membership whose role has the grant. Connector **secrets** are owner-only and gated by `OwnerRoleGuard`, per §3's "no connector secrets" |
| Manager | `owner_role = 'manager'`, `finance:view` + `expense:edit` up to the approval limit |
| Telecaller | `owner_role = 'telecaller'`; `incentive:view` scoped `owned` |

Two objects join `PermissionObjectType`: **`finance`** (payments, ledger,
expenses, periods, the matching queue) and **`incentive`** (plans, payouts,
statements). `incentive` carries a real owner column (`incentive_payouts.user_id`),
so `owned` scope is meaningful and is what makes §3's "a telecaller must never
read another telecaller's pay" true by query rather than by convention.
`finance` is in `ALL_SCOPE_ONLY_OBJECTS`: a ledger entry has no owner.

Migration 0172 seeds every system role's grants for both objects in the same
file that widens the enum. Skipping that step locks every user out, which this
codebase has learned once per object (0041, 0059/0060, 0103, 0158).

### 3.4 `finance` is a new OrgModule, default OFF

The back office is entitled separately (`organizations.enabled_modules`), so no
existing tenant wakes up to a Finance section they did not buy, and
`CrmPermissionsGuard`'s module join denies it exactly like a missing grant.
`PERMISSION_OBJECT_MODULE` widens from `"aura" | "crm"` to `OrgModule`.

Invoicing correctness stays in `crm` — `invoice:*` keeps its module — matching
what doc 26 decided.

### 3.5 Connector events are drained from the database, not from RabbitMQ

§7.2 wants a queue with retries and a DLQ. RabbitMQ is here and is used for the
call pipeline, but §7.2.5 also requires that **the normalizer be re-runnable
from stored raw events after a bug fix**, and a message that has been acked is
gone. So `connector_events` is the queue: the webhook verifies the signature,
writes the raw body, and acks in one statement; a worker sweep claims unprocessed
rows with `FOR UPDATE SKIP LOCKED`, and `attempts`/`next_attempt_at`/`error`
carry the backoff. `attempts >= 8` is the dead letter — a row, listable and
replayable from the connector health page, which is what §7.2.4 asks the DLQ to
be. Replay is then `UPDATE … SET processed_at = NULL`, over any window.

### 3.6 Period locking is enforced in one function, not in each handler

§13 says "period locking enforced in the data layer". There is no data-access
layer to put it in — controllers issue SQL directly — so it is a **trigger**
(`finance_refuse_locked_period`) on `finance_payments`, `ledger_entries` and
`expenses`. A handler that forgets the check gets a `23514`-class error from
Postgres rather than a silent write into a closed month. `pg-errors.ts` maps it
to a 409.

### 3.7 Snapshots and detectors are interval sweeps in `apps/worker`

Matching `startTelecallerStatsSweep`, `startDocumentDateSweep` and the eleven
others: whole-tenant aggregates on a timer belong on the worker's single-replica
side. Noted here because it is the reason they must not be moved to a second
replica without a lock.

### 3.8 The module needs `crm`, not just `finance`

Discovered while wiring the nav, and it is a correction to 3.4 rather than an
addition. The `finance` module is its own entitlement, but the module's SPINE is
`deals`: a payment schedule hangs off one, the incentive calculation credits the
deal's owner, and every collections figure is "what this deal owes". A tenant
with `finance` and no `crm` would get a dashboard of zeros and nothing capable of
producing a non-zero.

So the finance pages are in `CRM_GATED_HREFS` as well as behind their own
features. `nav.test.ts` is what found it: `sales` is a `CRM_PRIMARY_SECTION`, and
`crmPrimary`'s promotion of it is a no-op today only because the section is
*empty* once CRM is off — a non-CRM-gated page in `sales` broke that silently.

### 3.9 Deciders are pure; finders are SQL

§14 M8's acceptance criterion is "each seeded rule has a fixture test that fires
it and a test that does not". Thirty-four tests against live Postgres would be
slow, and would mostly be testing JOINs.

So each of §12.4's seventeen rules is split: a **finder** (SQL in
`apps/worker/src/pipeline/finance-advisor.ts`) that pulls candidate rows, and a
**decider** (`packages/shared/src/finance-detectors.ts`) that takes one candidate
plus the rule's params and returns fire/don't-fire with the explain payload. The
71 tests in `finance-detectors.test.ts` cover the deciders.

This also makes §12's "no LLM call may create, suppress or re-rank an alert"
structural: a decider takes no client and cannot reach a network, so there is
nowhere a model *could* be consulted.

### 3.10 Migration 0179 exists because of a parallel build

0176 widened `notifications.kind` for `finance_alert`/`finance_payout` by reading
the live constraint and appending. While this module was being built, another
effort in the same tree landed 0177/0178 (the organization chart), and 0177 does
a **DROP + ADD with an explicit list** — written before 0176 existed, so it drops
the finance values. Apply order is 0176 → 0177, so the net effect was that the
kinds were added and then silently removed, and the first symptom would have been
the Advisor's first notification failing with 23514 on a live tenant.

0179 restates the whole list, literally. It started as another dynamic append and
that was wrong for a specific reason: `notification-kinds.test.ts` pins the enum
against the **last literal** `notifications_kind_check` in apply order, and a
dynamic rewrite does not match that pattern — so it would have left the test
comparing the enum to 0177's list forever while the live constraint said
something else. A drift guard that cannot see the last change is worse than none.

### 3.11 Scope actually built in this pass

M0–M9 of §14 are implemented. §14 M10 ("additional gateways, accounting export,
ad-spend connectors") is **not**: it is explicitly a roadmap milestone, and its
acceptance criterion — "a second gateway ships with only a new mapper and
config" — is met by the connector registry's shape and proven by
`connector-registry.test.ts`'s fixture connector, without shipping Cashfree.

Ad spend already has a home (`marketing_source_spend`, migration 0171) and the
cost layer reads it rather than re-importing it.

---

## 4. Things a reader will otherwise trip over

* **`finance_payments` vs `payments`.** See 3.2. If you are asking "what did we
  collect", the answer is `finance_payments`; `payments` is one of its sources.
* **A ledger row is never updated or deleted.** Corrections are a `reverses_id`
  row plus a new one (§6.3). The table has no `updated_at` for that reason, and
  `aura_app` holds `SELECT, INSERT` on it and nothing else.

  **That took an explicit `REVOKE`, and the first version did not have one.**
  0001 ends with `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,
  INSERT, UPDATE, DELETE ON TABLES TO aura_app`, so every new public table
  arrives with full DML — which makes a `GRANT SELECT, INSERT` a no-op that
  reads like a restriction. 0172–0176 shipped that mistake across seventeen
  (table, privilege) pairs, with the headers and this file both asserting
  enforcement that was not there. It was found by running the claim as SQL
  rather than reading it: an `UPDATE` and a `DELETE` on `ledger_entries` as
  `aura_app` both succeeded. 0176 now asserts every pair from
  `information_schema` and raises if one is missing.

  The general rule, which the `marketing` schema hit first: **in this schema a
  GRANT narrows nothing.** A new append-only surface needs a REVOKE and a test.
* **`finance_snapshots` is a cache, not a source.** Every number it holds is
  recomputable from the ledger by `recomputeSnapshot()`; the dashboards read the
  snapshot for speed and the drill-downs read the records. If the two disagree,
  the snapshot is wrong.
* **The Advisor never calls a language model.** §12's "rules and statistics
  decide; language only explains" is enforced structurally: the detector
  functions in `packages/shared/src/finance-advisor.ts` are pure and take no
  client, and the only text an alert carries is rendered from
  `message_template`. There is no LLM call anywhere under `finance/`.
