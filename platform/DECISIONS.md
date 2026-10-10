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

---

## 5. Documents, reporting cycles and the import centre

`Build docs/indian-business-finance-documents-cycles-import.md` was implemented
on top of the module above. Its §4 files itself under this spec — "add 'document
vault and compliance calendar' and 'import center' as new sections and
milestones" — so its decisions belong in this file. Migrations **0180–0182**.

### 5.1 The compliance dates are data, and the running code cannot see the defaults

§2 is unusually direct about this:

> Store them in an editable **compliance calendar table** (name, frequency,
> due-date rule, applicability, reminder offsets) and ship seed data that a CA
> or admin can edit, rather than putting dates in code.

So `COMPLIANCE_CATALOGUE` in `packages/shared/src/compliance.ts` is **seed data
only**. `POST /finance/compliance/items/seed` is the single caller; the API
generates filings from the tenant's own `compliance_items` rows, and nothing in
the API or the worker resolves a due date from the shared array. A CA's
correction therefore survives a deploy, and a deploy that improves a default
does not overwrite one.

The same paragraph is why `verify_with_ca` is a column on every item and is
printed next to every row on screen, rather than being a banner at the top of
the page. A banner is read once; a marker on the filing somebody is about to act
on is read every time.

**And the catalogue names no legal references.** §2: "Section numbers and portal
screens changed with the new Act, so the module must not hard-code legal
references." Items are identified by the form a person files (GSTR-3B, Form 16A)
and the authority they file it with, both of which survived the renaming.
`compliance.test.ts` asserts it with a regex scan, so a well-meant citation
added later fails the build.

### 5.2 `DueRule` has three kinds because advance tax needs the third

Two of them are obvious — a day of a later month, or a day offset. The third,
`fy_month_day`, exists for one shape the other two cannot express: a deadline
that falls **inside** the period it relates to. §2 works the case through: the
first advance-tax instalment is due 15 June, which is inside the April–June
quarter and nine months before the year it is paying tax on has closed. Any rule
phrased as an offset *after* the period end gets it wrong by a year.

The four instalments are four catalogue rows rather than one quarterly item,
because each has its own date, its own cumulative share, its own challan and its
own reminder.

`day_of_month_after` also carries an optional per-month `overrides` map, which
earns its complexity on one rule: **TDS deducted in March is due on 30 April**,
not 7 April like every other month's. Without an escape hatch the catalogue
would ship that date wrong for every tenant every year, and it is data, so a CA
can add or remove an exception without a deploy.

### 5.3 `due_on` is stored; every status is derived

The opposite choices for two columns that look similar, and the reason differs:

* **`due_on` is stored.** A due date is a fact about the past once a period has
  been generated. If a CA corrects the rule in November, last July's filing was
  still due on the date everybody worked to, and recomputing from the current
  rule would silently rewrite history and make a return filed on time look late.
  `due_on_overridden` records that a human moved it — which happens every year,
  because extensions are announced after the calendar is generated.
* **`upcoming` / `due_soon` / `overdue` are derived**, by
  `complianceStatus(filing, today)` against the **org's** today. 0181 asserts
  that `compliance_filings` has no `status` column at all, so the derivation
  cannot drift. The scar is `invoices.status`, which has allowed `'overdue'`
  since migration 0060 with nothing ever setting it: a stored status is only as
  correct as the last sweep, and a sweep that stops running makes every due date
  decorative.

The same split governs `business_documents.expires_on` (stored) versus
`documentExpiryStatus` (derived).

### 5.4 Two document stores, and the boundary is access rather than tidiness

`contract_documents` (0178) holds **per-person** documents: offer letters,
signed contracts, NDAs, amendments. `business_documents` (0180) holds
**whole-business** documents: the GST certificate, the rent agreement, the
insurance policy, the salary register.

Putting somebody's offer letter in the finance vault would widen who can read it
— `finance:view` instead of the org chart's own permission — and split the audit
trail in two. `documents.test.ts` keeps the catalogue honest about it.

The two stores **share `document_access_log`** rather than each having one. That
table was built in 0178 with `document_id text` and a nullable `contract_id`,
and its header explains why the id is not an FK ("the log must survive the
document it records being deleted") — both of which make it fit this vault
unchanged. The payoff is that "who read what" is one query across both stores
rather than a UNION somebody has to remember to write.

### 5.5 The vault soft-deletes, and a REVOKE is what makes that true

`business_documents.deleted_at`, with `DELETE` revoked from `aura_app` and the
revocation asserted from `information_schema` in 0180. This is §4's general rule
applied again: in this schema a GRANT narrows nothing, because 0001's
`ALTER DEFAULT PRIVILEGES` hands every new public table all four verbs. A bug
that could hard-delete a signed lease deed is not a bug anybody recovers from.

### 5.6 The reminders are Advisor rules, not a second reminder mechanism

§2's last bullet — "Reminders through the Advisor, using the same routing and
escalation as the leak alerts" — is a design instruction, and it was taken
literally. Five rule codes (`compliance_due`, `compliance_overdue`,
`document_expiring`, `document_expired`, `books_not_closed`) joined
`ADVISOR_RULES`, five pure deciders joined `finance-detectors.ts`, and one
finder joined the nightly sweep.

**No migration was needed**, because `advisor_alerts.rule_code` and
`subject_type` are free text with the catalogue in code. The reminders inherit
`raiseAlert`'s upsert (so one re-raised tomorrow updates rather than
duplicates), the routing, the escalation ladder, the snooze and the explain
panel — four mechanisms an owner has already tuned.

They are **nightly**, not hourly: `remindsToday` matches an exact date, so an
hourly sweep would evaluate the same reminder twenty-four times for one alert.

The five deciders are deliberately thin. Every date judgement delegates to
`complianceStatus`, `remindsToday`, `documentExpiryStatus` and `closeReadiness`
— the same functions the console and the API read. A second implementation here
is how the inbox and the page end up disagreeing about what is overdue.

### 5.7 The close checklist warns; it does not block

Three of the eight steps carry `blocksLock`, and the lock still succeeds with
them outstanding. An owner closing a month with one reconciliation open has a
reason, and a system that refuses leaves them unable to close the books at all —
they would lock nothing, and an unlocked month is worse than a month closed with
a known gap. So the page names what is outstanding, backs it with two real
counts (unmatched payments, unapproved expenses) read from the database rather
than from a ticked box, and lets them decide.

### 5.8 One import centre, extended — not a second one under Finance

§4 asks for one: "Org chart spec: employee and contract imports plug into the
same import center. KPI section: call logs and lead lists come in through the
same import flow." So `ImportEntity` grew three members, `import_jobs` grew the
columns §3 needs, and the wizard at `/owner/import` gained the steps — rather
than a finance importer appearing under `/owner/finance`.

That is why the whole existing apparatus came for free: `FIELD_ALIASES`,
`REQUIRED_FIELDS`, the downloadable template, `suggestMapping` and the mapping
step are all derived from `IMPORT_FIELDS`, and the entity picker is now derived
from `ImportEntity.options` as well — it used to be three hard-coded rows, which
is precisely how a console list drifts from the API.

**The widened `entity` CHECK is restated literally.** 0182 writes out all six
values rather than widening dynamically, which is a direct repeat of the lesson
0179 records about `notifications.kind`: 0176 widened that one dynamically, a
parallel session's 0177 then did DROP + ADD with a list written before 0176
existed, and two kinds vanished silently. A literal list is also what lets
`import.test.ts` read the migration and pin the zod enum against it.

### 5.9 Imported payments go through `recordFinancePayment`, and so does the console

§3's key design point is really an architectural constraint:

> Imports feed the same pipelines: imported payments go through the **same
> normalizer and matching engine** as connector payments, so reconciliation and
> the Advisor behave identically.

So the insert, the §8 match, the §6.2 offline handling, the schedule application
and the ledger posting were lifted out of `FinancePaymentsController.record()`
into `finance/record-payment.ts`, and both the controller and the import call
it. `reverseFinancePayment` was lifted out the same way for the rollback.

This was not tidiness. The module already carries a long comment about
`schedule_item_id` being left null on every deal-referenced payment — one field
forgotten in one of two places, which made §11's days-to-collect return null
forever and failed no test. A third copy was not going to end differently. The
rollback's first version proved the point by setting a payment's status to
`reversed` without reversing the ledger posting.

### 5.10 A bank statement line is not a payment

`bank_transactions` (0182) is a separate table from `finance_payments`, and that
is the whole design of the reconciliation:

* a **payment** is what the business believes it collected
* a **statement line** is what the bank says happened

Reconciliation is the act of comparing the two, and you cannot compare two
things that are rows in the same table. Importing statement lines as payments
would also double every collection that arrived through a gateway — once from
the webhook, once from the bank — and the dashboard would report twice the
revenue with no way to tell which half was real.

`amount` is **signed**, one column rather than a debit/credit pair, because
every bank formats that pair differently (two columns, one signed column, one
column plus a Dr/Cr marker) and `parseAmountCell` normalises all three on the
way in.

`reconcileBankTransactions` claims a match only on an exact amount plus either a
reference hit or a three-day window, **and only when exactly one payment fits**.
§8's matcher is allowed to suggest because a person works its queue; this runs
unattended, and a wrong reconciliation marks money as accounted for when it is
not — the exact condition the reconciliation exists to detect.

### 5.11 Imported expenses arrive unapproved

`approved_at` is left NULL by `importExpenseRow`, and it is the most
consequential line in that file. §11's cost figures count only approved expenses
— the Expenses page and the dashboard disagreed once because one of them forgot
that filter — so an import that marked its own rows approved would let anybody
with import rights move the margin on the owner's dashboard by uploading a
spreadsheet.

`expenses.category` is also a **closed CHECK enum** (0175), not free text.
`EXPENSE_CATEGORY_ALIASES` maps common spreadsheet wording onto the thirteen
allowed values and files anything unrecognised under `other` with the original
word kept in the memo, so no row fails for a category name and nothing the
person wrote is lost.

### 5.12 The date-order detector refuses to guess

`detectDateOrder` returns `ambiguous` for a column where no day exceeds the
12th, and `parseDateCell` then returns null for every two-number date in it — so
the rows land in the error report instead of in the database.

This is the single most dangerous question in a finance import. A file of Indian
dates read as American moves 05/09/2026 from 5 September to 9 May, and every
figure derived from it (aging, days-to-collect, a period lock, a GST return's
month) is then wrong in a way no later check can catch, because the result is a
perfectly valid date. A column that mixes both orders returns `conflict` and
cannot be staged at all.

The resolved order is **stored on the job** (`import_jobs.date_order`), because
it is the thing somebody asks about six weeks later.

### 5.13 The .xlsx reader is hand-rolled, which needs justifying

§3 suggests "SheetJS or ExcelJS". Neither was taken:

* **SheetJS** stopped publishing to npm at 0.18.5, and that version carries two
  advisories fixed only in releases distributed from the vendor's own CDN. A
  knowingly vulnerable parser in front of files that arrive from a tenant's
  accountant is the last place in this product to accept a known hole.
* **ExcelJS** is maintained and would work, but it is a write-capable workbook
  model: around a megabyte into the console bundle, for a feature whose whole
  requirement is "read the cells of a sheet". The wizard runs in the browser, so
  that cost is paid by every person who opens the page.

What is actually needed is small and stable — a ZIP has a central directory, a
sheet is XML, and `DecompressionStream("deflate-raw")` is everywhere — so
`packages/shared/src/xlsx-read.ts` is ~300 lines with no dependency, tested
against archives built byte-by-byte in its spec.

It **evaluates nothing**: a formula cell yields the cached value the writing
application stored, and one with no cached value yields null. §3's "no formula
execution" is free because there is no evaluator to disable. Legacy `.xls` is
refused by name with the one-click fix, and `.xlsm` is refused outright.

### 5.14 Parsing stays in the browser, so no file reaches the server

The existing wizard's architecture (0062) was kept: the browser parses and posts
cell values as JSON. That answers several of §3's security bullets by
construction rather than by control — there is no uploaded file to virus scan,
no workbook for a server-side parser to be exploited through, and no formula
engine in the path.

What it does **not** answer is validation, so none is trusted: every amount and
date is re-parsed server-side with the same shared functions, required fields
are re-checked, and the row count and body size are capped. CSV injection on the
way back out was already handled — `csv.ts` neutralises a leading `=`, `+`, `-`
or `@` — and the failed-rows download goes through it.

### 5.15 Finance imports need `finance:create` on top of the import role

§3: "Sensitive imports (payroll, contracts) need elevated roles." The controller
keeps `ImportController`'s persona list (owner, manager, marketing) because the
console shows one "Import" entry, and a finance entity additionally requires
`finance:create`, checked inside the handler. A decorator cannot express "only
when the body names a payment", and a marketing persona who may legitimately
load a bought lead list must not be able to post into the ledger by uploading a
spreadsheet.

### 5.16 No new rail entry, no new feature key, no new permission object

* **Rail.** `OWNER_RAIL_MAX_TOP_LEVEL` is 7 and the rail is at it, so the three
  new pages are filed under `sales` and reached from the Finance overview's own
  link strip — the same arrangement the existing four non-rail finance pages
  have. They are in `CRM_GATED_HREFS` too, not because they need the CRM (they
  read neither deals nor contacts) but because `sales` is a
  `CRM_PRIMARY_SECTION` and a non-CRM-gated page there breaks the promotion
  invariant `nav.test.ts` guards.
* **Feature.** `featureForPath`'s longest-prefix match already puts
  `/owner/finance/*` under `finance_collections`. A third key would have had to
  be navigable to satisfy the catalogue's own rule.
* **Permission.** The vault and the calendar are on the existing `finance`
  object. A statutory document and a GST filing are the finance handler's work,
  and a third grid object would have been a column nobody could explain the
  difference of.

### 5.17 The period selector shares one piece of arithmetic

`fiscal.ts` owns the financial-year maths and all three consumers read it: the
console's `date-range.ts` (for the quarter/half/year pills), the API (for
generating filings and resolving a window) and the worker (for labelling a
month). A console that disagreed with the compliance calendar about when the
quarter started would be the worst possible place for that bug, because both
numbers look plausible.

`fy_start_month` comes from `org_business_profile` (migration 0126, default 4)
and is threaded through as an argument everywhere. There is no second copy of it
and no hard-coded `4` outside that default — `fiscal.test.ts` runs every unit
through every start month to prove it.

### 5.18 What was NOT built

Stated plainly so nobody looks for it:

* **Saved mapping templates are API-only.** `import_templates` and its four
  routes exist and work; the wizard does not yet offer "use the template you
  saved last month". §3's "after the first import, a saved template makes later
  imports one click" is therefore half-built: the storage is there, the one
  click is not.
* **No reconciliation screen.** `bank_transactions` is imported and
  auto-reconciled, and the unmatched count surfaces on the close checklist.
  There is no page for working the remainder by hand.
* **No scheduled or emailed imports.** §3 lists them as optional-later and they
  are not built.
* **Employee and call-log imports are recognised and refused.** `detectKind`
  identifies a payroll sheet or a call log and says where that data actually
  comes from, which is deliberate: §4 wants them in this centre eventually, and
  until they are, recognising them beats mis-mapping them onto contact columns.
* **The staged flow covers the three finance entities only.** Contacts,
  accounts and deals still use 0062's one-shot `run`. Both paths share the same
  row importers, so there is no second definition of how a contact row becomes a
  contact — but a contact import does not get a dry run yet.
