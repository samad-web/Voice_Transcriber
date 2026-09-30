# 35 - The data export engine: view, section and whole-tenant exports

**Written for:** the Claude Code session or engineer who will build this in `platform/`.
**Status:** 2026-09-30. **PLAN ONLY.** Nothing in this doc is built. No migration is written.
**Companion docs:**
- 11 (data inventory; what tables exist and what is in them)
- 13 (route and guard inventory; the guard stack every route mounts)
- 23 (CRM integrity; the scope intersection and why it exists)
- 31 (enterprise roadmap; `@OperatorMayCall`, `auditActor`)
- `report_builder_design.md` (D6, the rule that nothing automated sends)

**How to read the citations.** Every claim about today's code carries a `file:line`. Those numbers
were read on 2026-09-30 from a working tree with one untracked migration (0146). They will drift.
Re-read the file before you edit it.

**Short path prefixes used below:**

| Prefix | Path |
|---|---|
| `api/` | `platform/apps/api/src/` |
| `worker/` | `platform/apps/worker/src/` |
| `web/` | `platform/apps/web/app/` |
| `shared/` | `platform/packages/shared/src/` |
| `db/` | `platform/packages/db/` |

---

## 0. Context

### 0.1 What was asked

A data export engine with **three** scopes: the **current view** (export the leads on this board
matching these filters), **everything in a section** (all of CRM, all of Calls - unfiltered, every
dataset that section owns), and a **global bulk export** across the whole platform. Asynchronous so a
large tenant does not time out a request. CSV, XLSX and JSON. Strict RBAC. A frontend with live
progress, a notification when the job finishes, and a download link that expires.

**Every export alerts the owners** - not only the bulk one. An extract leaving the workspace is a
governance event regardless of how much of the workspace it covers, and the owner is the person
accountable for it. SS4.5 specifies the alert and how it avoids becoming noise the owners learn to
ignore.

The request named Redis/Celery or AWS SQS as the queue. SS1.3 declines both, and says why. Every
other part of the request is taken as specified.

**Revision, 2026-09-30 (same day).** The first draft had two scopes and alerted owners only on a bulk
export. The section scope (SS1.1, SS3.4) and the owner alert on every export (SS4.5) were added on
request. Nothing else changed.

### 0.2 What exists today

Two synchronous export routes, and nothing else:

| Route | File | Shape |
|---|---|---|
| `GET /v1/reports/:report/export` | `api/modules/reports/reports.controller.ts:207` | builds rows in memory, `toCsv`, `res.send` |
| `GET /v1/report-builder/:id/widgets/:widgetId/export` | `api/modules/report-builder/report-builder.controller.ts:795` | same, gated on `deal:export` |

Both render inside the request. Both hold the whole result set in memory. Neither has a row cap that
survives a tenant getting large, neither can be resumed, and a browser that walks away mid-download
gets nothing. That is the ceiling this doc raises.

The useful prior art is **`import_jobs` (migration 0062)** - a job table with `status`, per-row
counters and a child error table, RLS'd and granted exactly the way every tenant table here is. Its
one flaw is instructive: `status` DEFAULTs to `'done'` (`db/migrations/0062_import_jobs.sql:9`)
because the import runs inline in the API controller and nothing ever consumes the job
asynchronously - there is no `import` pipeline in `worker/pipeline/`. The export engine is the same
table shape with the missing half actually built.

Three more pieces already exist and are reused rather than rebuilt:

- **The CSV encoder.** `shared/csv.ts`, re-exported at `api/modules/reports/csv.ts:12`, with
  quoting, escaping and formula-neutralisation in one place, plus `safeFilename` at
  `api/modules/reports/csv.ts:20` for the `Content-Disposition` header.
- **S3/MinIO presigning.** `api/s3/s3.service.ts` - `presignedGetUrl` (`:168`) already signs
  time-limited GETs against the *public* endpoint, which is exactly the download primitive
  SS7 needs. Note the `contentType` parameter: it exists because the bucket also holds APKs.
- **The `export` permission action.** `PermissionAction` at `shared/permissions.ts:127` already
  includes `"export"`, and the grid at `/owner/staff` already renders it. Today exactly one route
  uses it. This engine is what makes that column mean something.

### 0.3 What this doc decides

D1 (SS1.3) RabbitMQ, not Redis/Celery or SQS.
D2 (SS2) `export_jobs` is the source of truth; the queue is only a wake-up.
D3 (SS3) One shared dataset registry; a dataset cannot exist without declaring its module and grant.
D4 (SS4) RBAC is evaluated twice - at enqueue, and again in the worker against re-materialised scope.
D5 (SS5) Streaming serialization, keyset pagination, a hard byte budget per job.
D6 (SS7) The artifact lives in S3; the job row stores the *key*, never a URL. Download is a 302.
D7 (SS4.4) The global bulk export is owner-only, per-tenant only, and never includes call content
without `recordings:export`.
D8 (SS1.1, SS3.4) Three scopes - `view`, `section`, `bulk` - are one engine over a list of datasets,
not three code paths. A section is a preset list; bulk is every list.
D9 (SS4.5) Every export notifies the org's owners. Instant for `section` and `bulk` and for anything
carrying call content or financial data; digested for a routine `view` extract.

---

## 1. The shape

### 1.1 Three scopes, one engine

They differ in exactly two things: how many datasets the job names, and whether the caller's filters
are applied. Nothing else.

| Scope | Datasets | Filters | Started from | Output |
|---|---|---|---|---|
| `view` | 1 | the ones on screen | a list page's Export action | one file |
| `section` | the section's preset list (SS3.4) | none | the section's Export action, or the exports centre | ZIP + manifest |
| `bulk` | every dataset the requester is entitled to | none | `/owner/account/data` | ZIP + manifest |

A section export is a job with N datasets. A bulk export is a job with all of them. **There is no
third code path, and no second query builder.** Anything true of one dataset's `view` extract is true
of its slice of a section or bulk export, including every gate in SS4.

This is the single most important structural decision in the doc: **there is no "admin export" that
reads rows a normal export would have refused.** If a bulk export can see a row, a `view` extract of
that dataset could have too. The scopes differ in breadth, never in authority.

The practical consequence for the build: implement `view` first (E1/E2), and `section` and `bulk` are
then a preset list and a ZIP writer, not a feature.

### 1.2 The state machine

Postgres is the record. The queue is a wake-up signal. This is the same contract the call pipeline
already runs on, stated at `packages/queue/src/index.ts:6-12`, and it is why a lost message here
costs latency rather than a job.

```
                 +-----------+
  POST /exports  |  queued   |  row written, message published
                 +-----+-----+
                       |  worker claims it (conditional UPDATE)
                 +-----v-----+
                 |  running  |  rows streaming, rows_written ticking
                 +-----+-----+
                       |  last dataset done
                 +-----v-----+
                 | packaging |  zip + upload to S3
                 +-----+-----+
                       |
        +--------------+--------------+
        |                             |
  +-----v-----+                 +-----v-----+
  |   ready   |                 |  failed   |  error recorded, retry_count++
  +-----+-----+                 +-----------+
        |  expires_at passes
  +-----v-----+
  |  expired  |  artifact deleted by the purge sweep
  +-----------+
```

Plus `cancelled`, reachable from `queued` and `running` only (SS6.5).

The claim from `queued` to `running` is a **conditional UPDATE**, exactly as the report schedule
sweep claims a due schedule (`worker/pipeline/report-schedules.ts`, the "claim" note in its header):
two workers racing the same job means one UPDATE matches zero rows and that worker moves on. Do not
use an advisory lock here; the pattern in this repo is the conditional update and it survives a
worker being killed.

### 1.3 Why RabbitMQ, and not Redis/Celery or SQS

The request named Redis/Celery or SQS. Both are declined, and the reasoning is worth stating because
it will be asked again:

- **This deployment already runs RabbitMQ**, with three durable queues, per-queue prefetch, and a
  consumer-channel-per-queue discipline that exists for a reason documented at
  `packages/queue/src/index.ts:14-20`. A second broker would be a second thing to run on the VPS, a
  second thing to monitor, a second thing to lose messages in, and a second reconnect bug to write.
- **Celery is Python.** The worker is a NestJS application context (`worker/src/main.ts:46`). There
  is no Python runtime in the worker image and no reason to add one.
- **SQS is AWS.** Object storage here is MinIO on a Hostinger VPS, not S3 proper. Taking an SQS
  dependency would put a hard AWS coupling into a stack that currently has none, for a queue whose
  job is to say "wake up".
- **The durability argument does not apply**, because the queue is not where durability lives.
  `export_jobs` is. A broker restart that drops an in-flight message costs a job some latency until
  the sweep in SS6.3 notices, and nothing else. That is the same trade every other lane here makes.

**Add a fourth queue**, `aura.export`, beside the three in `packages/queue/src/index.ts:22-43`:

```ts
export const EXPORT_QUEUE = "aura.export";
export async function publishExport(message: ExportMessage): Promise<void>;
export async function consumeExport(handler): Promise<void>;  // EXPORT_PREFETCH, default 2
```

`ExportMessage` is `{ jobId: string; orgId: string }` - not the whole job. Everything else is read
from the row, so a message that is redelivered after the job changed does the current thing rather
than a stale one.

**Prefetch defaults to 2, not 8.** The other lanes are provider-latency-bound and parallelise
freely; this lane is database- and disk-bound, and eight concurrent full-table scans against a
database that is already ~125ms away (see `DB_LATENCY_MIGRATION.md`) is how an export makes the
console slow for everybody. SS6.7 covers the fairness rule that sits on top.

---

## 2. Data model - migration 0148

Numbering: **0148**, not 0147. The first draft of this doc said 0147; by the time E0 was built,
`0147_call_issue_escalation.sql` (doc 36) already held that number in the working tree, untracked
alongside `0146_lead_call_inheritance.sql`. That is the ordinary state of this tree - two or three
unmerged migrations in flight - so **list the directory before naming a migration file**, and
**check what production is actually on** as well: local and production migration names have diverged
before, and the ledger is not trustworthy on its own.

### 2.1 `export_jobs`

```sql
CREATE TABLE IF NOT EXISTS export_jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- SS1.1. 'view' = one dataset + the caller's filters; 'section' = one nav
  -- section's preset list, unfiltered; 'bulk' = the whole tenant.
  scope              text NOT NULL CHECK (scope IN ('view', 'section', 'bulk')),
  -- Which section, when scope='section'. NULL otherwise. Stored so the exports
  -- centre and the owner alert can say "CRM" rather than list nine datasets.
  section            text,
  CONSTRAINT export_jobs_section_scope
    CHECK ((scope = 'section') = (section IS NOT NULL)),
  format             text NOT NULL CHECK (format IN ('csv', 'xlsx', 'json', 'ndjson')),
  -- The datasets this job covers, resolved at enqueue against the registry (SS3).
  -- For 'section' and 'bulk' this is the list AFTER the SS4.1 gates removed what
  -- the requester may not have - so the row records what was actually exported,
  -- not what was asked for.
  datasets           text[] NOT NULL CHECK (cardinality(datasets) > 0),
  -- The filters, as the API validated them. Replayed by the worker, never trusted raw.
  filters            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Requested columns per dataset, already intersected with what the requester may see.
  columns            jsonb NOT NULL DEFAULT '{}'::jsonb,

  status             text NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued','running','packaging','ready','failed',
                                         'expired','cancelled')),
  rows_total         bigint,          -- NULL until counted; NULL renders as indeterminate
  rows_written       bigint NOT NULL DEFAULT 0,
  bytes_written      bigint NOT NULL DEFAULT 0,
  current_dataset    text,

  -- WHOSE export this is. Every gate in SS4 is re-evaluated against this identity
  -- in the worker; it is not a display field.
  requested_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  requested_by_auth_id text,          -- Supabase subject, for audit parity with doc 27 SS5.2
  -- The scope the requester had AT ENQUEUE, frozen. See SS4.2 for why it is frozen
  -- AND re-checked rather than either one alone.
  scope_snapshot     jsonb NOT NULL,

  storage_key        text,            -- S3 key. NEVER a URL. See SS7.2.
  content_type       text,
  file_name          text,
  expires_at         timestamptz,
  downloaded_count   int NOT NULL DEFAULT 0,
  last_downloaded_at timestamptz,

  -- SS4.5. Stamped when the owner alert has been written, so a retried or
  -- resumed job cannot notify the owners twice. NOT a boolean: the timestamp is
  -- what makes "did the alert actually go out, and when" answerable later.
  owners_notified_at timestamptz,

  error              text,
  retry_count        int NOT NULL DEFAULT 0,
  started_at         timestamptz,
  finished_at        timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS export_jobs_org       ON export_jobs (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS export_jobs_user      ON export_jobs (org_id, requested_by_user_id, created_at DESC);
-- The sweep's two queries: stale in-flight jobs, and artifacts due for deletion.
CREATE INDEX IF NOT EXISTS export_jobs_inflight  ON export_jobs (status, started_at)
  WHERE status IN ('queued', 'running', 'packaging');
CREATE INDEX IF NOT EXISTS export_jobs_expiring  ON export_jobs (expires_at)
  WHERE status = 'ready';
```

`ON DELETE CASCADE` on `requested_by_user_id` rather than `SET NULL`: an export belongs to the person
who asked for it, and a job whose owner is gone is a file nobody may download. Deleting the row is
the fail-closed direction, and the purge sweep cleans the artifact behind it.

### 2.2 `export_job_files`

A bulk export is many files in one ZIP. One row per member file, so the manifest and the UI can both
be built from the database rather than by opening the archive.

```sql
CREATE TABLE IF NOT EXISTS export_job_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  job_id       uuid NOT NULL REFERENCES export_jobs(id) ON DELETE CASCADE,
  dataset      text NOT NULL,
  file_name    text NOT NULL,
  row_count    bigint NOT NULL DEFAULT 0,
  bytes        bigint NOT NULL DEFAULT 0,
  -- Columns the dataset's own gate removed, so the manifest can say so out loud (SS5.4).
  redacted_columns text[] NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS export_job_files_job ON export_job_files (job_id, dataset);
```

### 2.3 RLS and grants - the order matters

Copy the block from `0062_import_jobs.sql:24-42` verbatim in shape, for both tables:

```sql
ALTER TABLE export_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE export_jobs FORCE  ROW LEVEL SECURITY;
DO $$ BEGIN
  CREATE POLICY org_isolation ON export_jobs
    USING (org_id = current_setting('app.org_id', true)::uuid)
    WITH CHECK (org_id = current_setting('app.org_id', true)::uuid);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- REVOKE FIRST, THEN GRANT. A migration that only GRANTs narrows nothing:
-- whatever the web-facing roles already had, they keep.
REVOKE ALL ON export_jobs FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON export_jobs FROM %I', api_role);
    END IF;
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON export_jobs TO aura_app;
```

The REVOKE-before-GRANT ordering is not stylistic. A GRANT-only migration has shipped here before
and left a web-facing role holding INSERT on a table it was supposed to have lost.

**`verify-rls` will block the deploy** if these tables are added without a tenant policy, and that is
correct - do not add them to the non-tenant allowlist. They are tenant tables.

### 2.4 The notification kinds - both halves each, or it throws at runtime

Three new kinds, and they are deliberately three rather than one, because the notification centre
routes on kind and a person's delivery preferences are set per kind (migration 0109):

| Kind | Audience | Fires |
|---|---|---|
| `export_ready` | the requester | their own job reached `ready` |
| `export_failed` | the requester | their own job reached `failed`, finally |
| `export_created` | **the org's owners** | any export was started in this org (SS4.5) |

`export_created` is the owner alert, and it is a separate kind precisely so an owner can put it in
their digest without also silencing the `export_ready` for exports they ran themselves.

Each of them needs **two** edits that live in different files and have silently drifted before:

1. The DB CHECK. `notifications_kind_check` is dropped and recreated in full each time - see
   `db/migrations/0143_attendance_absence_alerts.sql:99-123` for the exact `DO $do$` block that finds
   the existing constraint by name and replaces it. Copy that block; do not write a bare
   `ALTER TABLE ... ADD CONSTRAINT`.
2. The zod enum in `shared/notifications.ts`.

Miss (1) and every insert raises `23514` at runtime, from a worker, where nobody sees it. Miss (2)
and the API refuses to write a kind the database would have accepted. Both halves have drifted here
before and broke lead routing; add a test asserting the two lists are equal.

`report_ready` already exists in the CHECK and is *not* the right kind to reuse - it means a scheduled
report snapshot, and the notification centre routes on kind.

### 2.5 Retention and the purge

Default retention **7 days**, as a platform constant in `shared/exports.ts` beside
`RECYCLE_BIN_RETENTION_DAYS`, not an org setting. `expires_at` is stamped when the job reaches
`ready`.

A new sweep `worker/pipeline/export-purge.ts`, started from `worker/src/main.ts` next to
`startRecycleBinPurge()` (`worker/src/main.ts:230`):

1. `SELECT id, org_id, storage_key FROM export_jobs WHERE status='ready' AND expires_at < now()`,
   cross-tenant on the admin pool, batched.
2. Delete the S3 object.
3. `UPDATE ... SET status='expired', storage_key=NULL`.

**Delete the object before clearing the key**, not after. The other order leaks an orphan on every
crash in between, and an orphan in object storage is invisible - nothing ever lists it again.

Follow `recycle-bin-purge.ts`'s shape: set-based, cross-tenant, no per-org loop. The one difference is
step 2, which is a per-object S3 call and cannot be set-based.

---

## 3. The dataset catalogue

### 3.1 One registry, in `shared/`

Every exportable dataset is declared once, in `shared/export-datasets.ts`, and both the API and the
worker read it. The registry entry is what makes a dataset exist; there is no way to export a table
that is not in it.

```ts
export interface ExportDataset {
  key: ExportDatasetKey;            // 'leads', 'calls', 'contacts', ...
  label: string;
  section: ExportSection;           // which rail section owns it (SS3.4)
  module: OrgModule;                // gates on organizations.enabled_modules (0072)
  feature?: FeatureKey;             // optional, the 0093 visibility axis
  object: PermissionObjectType | null;  // grid object; null = not grid-governed (SS3.2)
  permission: PermissionAction;     // always 'export' - present so it cannot be assumed
  scopeColumn: string | null;       // the column crmScope/ownerScope narrows on
  sensitivity: 'normal' | 'call_content' | 'financial';
  columns: ExportColumn[];          // name, type, and whether it needs a further grant
  defaultOrder: string;             // keyset order, must be unique-suffixed (SS3.3)
}
```

The `module` field is what stops the mistake `CrmPermissionsGuard` documents at length: it used to
hard-code `'crm'`, and `lead` is core Aura, so a hard-coded module would have taken the lead board
away from every recording-only tenant. `PERMISSION_OBJECT_MODULE` (`shared/permissions.ts:98`) is the
same idea; the registry's `module` should be *derived from* it where `object` is non-null, and only
stated explicitly where `object` is null.

### 3.2 The catalogue

| Dataset | Module | Grid object | Sensitivity | Notes |
|---|---|---|---|---|
| `leads` | `aura` | `lead` | normal | board filter; `board_id` NULL = Main |
| `lead_stage_transitions` | `aura` | `lead` | normal | the ledger; joins to lead |
| `calls` | `call_intel` | none | **call_content** | metadata only without `recordings:export` (SS4.3) |
| `call_transcripts` | `call_intel` | none | **call_content** | requires `recordings:export` AND the call-access gate |
| `contacts` | `crm` | `contact` | normal | |
| `accounts` | `crm` | `account` | normal | |
| `deals` | `crm` | `deal` | normal | |
| `tasks` | `crm` | `task` | normal | multi-assignee: one row per assignee, stated in the manifest |
| `conversations` | `crm` | `conversation` | normal | private threads excluded (SS4.3) |
| `products` | `crm` | `product` | normal | |
| `quotations` | `crm` | `quotation` | financial | |
| `invoices` | `crm` | `invoice` | financial | |
| `attendance` | `attendance` | none | normal | owner/manager personas only |
| `members` | `aura` | none | normal | no auth identifiers, ever |
| `audit_log` | `aura` | none | normal | owner-only; included in the bulk export |

Datasets with `object: null` are **not** ungated - they are gated by persona and module instead,
because the grid has no object for them. `call` is deliberately absent from `PermissionObjectType`
and the reason is in `shared/permissions.ts`: reading a call already has three gates, and a fourth
axis is how "why can Priya not hear this call" acquires four answers and no authoritative one.
Do not add one here. Use the three that exist.

### 3.3 How a dataset declares its query

Each dataset supplies a builder that returns parameterised SQL. Two rules:

1. **Keyset pagination, never `OFFSET`.** `ORDER BY created_at DESC, id DESC` with a
   `(created_at, id) < ($cursor_at, $cursor_id)` predicate. `OFFSET` on a table with a million rows
   re-scans the whole prefix on every page, and at ~125ms per round trip the job will not finish.
   The order must end in a unique column, or pages silently drop and duplicate rows.
2. **The scope predicate is appended by the engine, not by the dataset.** The dataset declares
   WHICH scope applies; the engine builds the predicate. A dataset that could write its own scope
   predicate is a dataset that can forget to.
3. **The SELECT list is written by hand, and pinned by a test.** The registry names the columns of
   the FILE; `worker/pipeline/export-queries.ts` names the columns of the DATABASE, and the two are
   not the same thing. Every output is ALIASED to the registry's name and
   `export-queries.test.ts` asserts the two lists are equal.

**Built 2026-09-30 (E1), and the plan was wrong about two things.**

- **`scopeColumn` was the wrong model and is now two fields.** The registry declares
  `ownerScope: OwnerScopedObject | null` (the persona axis) and `crmScopeColumn: string | null` (the
  grid axis). A single column name could not express the real rule: a lead scopes on
  `assigned_telecaller_id` OR `telecaller_id` where the assignment is null, and flattening that to
  one column would have given every telecaller an empty export of the leads they created themselves.
- **`leads` has no `owner_user_id` at all**, so its `crmScopeColumn` is null and the persona is the
  only axis that narrows it. `leads.controller.ts:283` says so outright. The first draft would have
  emitted a predicate against a column that does not exist.

**And the first draft of the catalogue invented columns.** `leads.phone`, `contacts.phone`,
`calls.counterparty_number` - none exist. The schema stores a per-org HMAC plus a prefix and the last
three digits and nothing else (0001, 0006), so **no export can contain a full phone number**, and a
test now asserts the registry never claims one. Likewise there is no `call_analyses` table: the AI
read lives in `transcripts.intelligence` as jsonb, read with `->> 'summary'` exactly as
`owner-calls.controller.ts:126` already reads it.

### 3.4 Sections

"Export everything in this section" needs a definition of section that the person recognises, and the
one they already use is the console rail. `OWNER_NAV_SECTIONS` (`web/lib/nav.ts:795`) is the
vocabulary; the registry's `section` field takes one of its keys, and the preset list for a section is
simply every dataset that names it.

| Section (`NavSection`) | Datasets |
|---|---|
| `tasks` | `tasks` |
| `leads` | `leads`, `lead_stage_transitions` |
| `customers` | `contacts`, `accounts` |
| `sales` | `deals`, `quotations`, `invoices`, `products` |
| `conversations` | `calls`, `call_transcripts`, `conversations` |
| `reports` | `attendance` |
| `settings` | `members`, `audit_log` |
| `account` | - (the exports centre lives here; it exports nothing of its own) |

The mapping is taken from `OWNER_SECTION_OF` (`web/lib/nav.ts:909`), which already files each page
into a section - `/owner/calls` is `conversations`, `/owner/invoices` is `sales`. **Derive the export
section from the page's section rather than restating it**, or the Export button on a page and the
section export that is supposed to contain it will disagree the first time a page moves between
sections, which has happened twice.

Two consequences worth stating:

- **`section` is a preset, not a permission.** Every dataset in the list still goes through all five
  gates in SS4.1 independently. A telecaller exporting the Sales section gets deals they own and no
  invoices at all, if that is what their grid row says - and the manifest names the omission.
- **The registry lives in `shared/`; `nav.ts` lives in `apps/web`.** The worker cannot import the
  latter. So `shared/export-datasets.ts` holds the `section` value as a plain string union, and a test
  in `apps/web` asserts every section key in the registry exists in `OWNER_NAV_SECTIONS` and that
  every section with pages has at least one dataset or is explicitly listed as exporting nothing. That
  test is the only thing standing between this table and silent drift.

---

## 4. RBAC

This is the section to get right. Everything else is plumbing.

### 4.1 Five gates, all of them, every time

For each dataset in a job, in order:

1. **Tenant.** `TenantGuard` pins `req.tenantOrgId`; every query runs inside `withOrg`, so RLS is
   the floor. The worker has no request, so it must enter the org context explicitly -
   `withOrgContext(orgId, ...)`, the same call `report-schedules.ts` makes.
2. **Module.** `orgHasModule(client, dataset.module)` (`api/common/org-modules.ts:22`). Off means the
   dataset is not offered and, if named directly, denied - identically to a missing grant.
3. **Grid.** `@RequireCrmPermission(dataset.object, 'export')` for grid-governed datasets. This is the
   `export` column at `/owner/staff` finally doing something across the product.
4. **Row scope.** `crmScope` INTERSECT `ownerScope`. Both are computed today
   (`api/common/crm-scope.ts`, `api/common/owner-scope.ts`) and the rule stated at
   `api/common/auth-principal.ts:74-86` is **intersection, never union** - a persona can narrow a grid
   grant and can never widen it. An export that resolves `owned` gets `WHERE owner_id = $me`.
5. **Sensitivity.** SS4.3.

A dataset that fails any gate is **omitted from a `section` or `bulk` export, and 403s from a `view`
extract.** The difference is deliberate: naming one dataset you may not have is an error; a section or
bulk export means "everything I may see here", and silently including less is the correct behaviour.
The manifest names what was omitted and why, so the omission is visible rather than mysterious.

A section export where **every** dataset is gated out does not produce an empty ZIP - it fails at
enqueue with a 403 naming the section. An empty archive is indistinguishable from a broken export.

### 4.2 Re-materialising the requester in the worker

**The trap.** `report-schedules.ts` renders **unscoped**, and its header says so plainly: a scheduled
run has no HTTP request and therefore no `req.crmScope`, so every widget renders across the whole
tenant. That was an acceptable trade there because creating a schedule is owner-only, and an owner
forwarding a spreadsheet is the same act.

**It is not acceptable here, and copying that pattern is the single worst bug this feature can
ship.** A telecaller's export must contain a telecaller's rows. So:

- At enqueue, the API writes `scope_snapshot` - the resolved `{crmScope, ownerScope, permissions,
  modules}` - into the job row.
- In the worker, before the first row is read, **re-resolve those same values from the database** for
  `requested_by_user_id`, using the same helpers the guards use.

**Built 2026-09-30 (E1): "the same helpers" is now structural rather than aspirational.** The
predicate builders (`ownerScopeFilter` and its three renderings) moved from
`api/common/owner-scope.ts` into `@aura/shared/owner-scope`, and the API file re-exports them, so
every existing call site is unchanged and `owner-scope.spec.ts` still pins the column each object
scopes on. The worker imports the same function.

The alternative was the worker re-implementing the predicate, which this codebase has paid for twice
already (`report-schedules.ts` duplicates a render loop, `crm-objects.ts` a projection - both headers
say so). A duplicated scope predicate is worse than either: the copy that drifts does not throw and
does not render wrong, it returns more rows than the person may see, in a file, silently. What stayed
in the API is the `@OwnerScope()` decorator, which needs Nest.
- If the re-resolved scope is **narrower** than the snapshot, use the narrower one. If it is wider,
  still use the snapshot.

Why both. The snapshot alone would let a job queued before a demotion run with the old, wider grant -
somebody revokes access at 10:00 and a 10:05 file still carries everything. Re-resolution alone would
let a job widen after a *promotion*, producing a file the person could not have asked for at the time
they asked. The intersection is the only direction that is never surprising, and it is the same
"narrow, never widen" rule the persona intersection already follows.

### 4.3 `recordings:export`, private threads, and the call-access gate

Three narrower gates stack on top of the five:

- **`recordings:export`** (`api/common/auth-principal.ts:107`, enforced by `PermissionsGuard`). Without
  it, the `calls` dataset exports **metadata only** - direction, timestamps, duration, disposition,
  the linked lead - and the transcript, summary, recording URL and extracted-fact columns are dropped.
  `call_transcripts` is not offered at all. The dropped columns are listed in
  `export_job_files.redacted_columns` and printed in the manifest.
- **The call-access gate (migration 0122).** Where a tenant has operator call access switched off, an
  operator cannot read call content interactively and must not be able to read it through an export.
  `CallAccessGuard` fails closed without an attributable operator; the export path must reach the same
  verdict.
- **Private threads.** `api/common/private-threads.ts` keeps each person's linked personal WhatsApp
  chats visible only to them (migration 0125). The `conversations` dataset must apply
  `visibleThread`. A bulk export run by an owner **does not** widen this - the chats are private to
  the person, and "I am the owner" was never a reason they were visible.

### 4.4 The section and bulk exports

A `section` export needs **no persona beyond what its datasets already require**. That is the point of
it: a salesperson exporting the Sales section is exporting their own pipeline, and making it
owner-only would turn a convenience into a permission request. The five gates in SS4.1 run per
dataset and are sufficient.

A `bulk` export carries extra conditions:

1. **Owner persona only**, and additionally `audit_log` and `members` require the org-admin role.
2. **Per-tenant only.** There is no cross-tenant export, no `@CrossTenant()` route, and no operator
   surface that produces one. A platform operator who needs a tenant's data asks the tenant.
3. **Rate-limited to one bulk export per org per 24h**, enforced at enqueue. A bulk export is a full
   read of the tenant; letting it be triggered in a loop is a self-inflicted outage.
   A `section` export gets the softer limit instead: one per section per person per hour.
4. **Always audited** (SS4.8), and the audit row is written **before** the job is enqueued, not after
   it succeeds. An attempt that fails is still an attempt worth having a record of.

Owner alerting used to be listed here as a bulk-only condition. It is not - see SS4.5.

### 4.5 The owner alert

**Every export in the org notifies the org's owners**, whatever its scope and whoever ran it. The
reasoning is that the interesting question is not "how much data left" but "data left, and who took
it" - a telecaller exporting the full contact list to CSV the week before they resign is a `view`
extract, and it is exactly the event an owner wants to know about. Scoping the alert to bulk exports
would have alerted on the one case nobody needs telling about, because the owner runs those
themselves.

**Fired at creation, not completion.** The alert is a governance signal, and the act worth recording
is the request. A job that then fails, is cancelled or expires unread is still a person who asked for
the data; an alert that only fires on success would miss it. The requester's own `export_ready` still
fires on completion, because that one is about a file being available.

**Who gets it:**

| Recipient | Gets `export_created` |
|---|---|
| Every membership with the owner persona | yes |
| The requester, when they are themselves an owner | **no** - no self-alert |
| Other owners, when an owner ran it | yes |
| Operators | no (SS4.6) |

Suppressing the self-alert matters more than it sounds: without it, an owner who exports four reports
in a morning has four notifications about themselves, learns the kind is noise, and mutes it - taking
the alert about everybody else with it.

**Delivery, so it stays signal.** Migration 0109 already lets each person route a kind to their daily
digest instead of instant, and that mechanism carries the whole design here:

| Job | Default delivery |
|---|---|
| `bulk` | instant |
| `section` | instant |
| `view` of a `call_content` or `financial` dataset | instant |
| `view` of a `normal` dataset | **digest** |

So the routine case - somebody exporting a filtered lead list - lands as one line in the owner's daily
roll-up, and the cases that deserve interrupting somebody do interrupt them. An owner can override
either direction in their notification preferences; the table is the default, not a rule.

**Content.** Who, what scope, which section or dataset, how many rows the estimate said, and the
format. The alert **never** links to the artifact and the owner **cannot** download another person's
export from it - `linkPath` goes to `/owner/account/data?job=<id>`, which shows them the job's
metadata. The download route's ownership check (SS7.2) is unchanged by this. An alert that handed an
owner the file would make every alert a second copy of the data.

**Written once.** `owners_notified_at` is stamped in the same transaction as the notification rows. A
sweep-driven retry (SS6.3) re-runs the job; it must not re-alert.

**This stays inside the no-automated-sending rule.** These are `notifications` rows, which cannot
reach a person who is not signed in to the console. Nothing is emailed, and the alert is explicitly
not a channel for getting an export off the platform.

### 4.6 Operators

Platform operators (`operator-only.guard.ts`) may **see** a tenant's export history - status, who,
when, how many rows - and may **not** download the artifact and may **not** create a job. Reading the
job list is operational; reading the file is reading the tenant's data. The download route checks
`principal.operatorEmail === null` explicitly rather than inferring it from role.

### 4.7 API keys

`req.apiKey` has no person, no membership, and therefore no grid grant or persona - the reasoning is
at `api/common/auth-principal.ts:96-104`. Exports for API keys need dedicated
`exports:read`/`exports:create` scopes, and a key-created job resolves scope from the key's scopes, not
from any user. **Ship this second.** The first release refuses API-key callers outright; that is the
fail-closed direction and it is easy to relax later.

### 4.8 Audit

One row per job at enqueue and one per download, via `auditActor(req)`
(`api/common/audit-actor.ts:33`):

| Action | Payload |
|---|---|
| `export.created` | scope, datasets, format, filters, resolved row scope |
| `export.downloaded` | job id, byte count, requester |
| `export.failed` | job id, error class (not the raw error) |
| `export.purged` | job id (written by the sweep, actor = system) |

---

## 5. Serialization

### 5.1 CSV

Use `toCsv`/`csvCell` from `api/modules/reports/csv.ts:12` - which re-exports `shared/csv.ts` -
so the browser-side import template and every server-side export quote, escape and
formula-neutralise identically. Do not write a second encoder in the worker; that file's header
explains why a second copy is a bug waiting to happen.

Two additions the streaming path needs:

- A row-at-a-time writer (`csvRow(columns, row)`) so the worker never builds the whole document.
- `CSV_BOM` prepended by default. Excel on Windows reads a BOM-less UTF-8 CSV as the system codepage
  and mangles every Devanagari or accented name in it.

### 5.2 XLSX

`exceljs`, in **streaming workbook writer** mode (`stream.xlsx.WorkbookWriter`), writing to a temp
file on disk, not to a buffer. The non-streaming API builds the whole workbook in memory and will OOM
the worker on a large tenant.

Constraints to enforce, not discover:
- **1,048,576 rows per sheet.** Past that, roll to `leads (2)`, `leads (3)`, and say so in the
  manifest. A silently truncated spreadsheet is worse than a second sheet.
- **32,767 characters per cell.** Transcripts exceed this. Truncate with a visible `...[truncated]`
  marker and point at the JSON export for the full value.
- Long digit strings (phone numbers, invoice numbers) are written as **text**, with the column
  formatted as text. Excel turns `919876543210` into scientific notation otherwise, and the person
  who opens it has no way to know.
- Dates are written as real dates in the org's reporting timezone (SS5.4), not as strings.

`exceljs` is a new dependency. Add it to `apps/worker` only. **Do not run `pnpm --filter worker add
exceljs` and walk away** - a filtered add here has orphaned `next` in other workspace projects
before; run `pnpm install --frozen-lockfile` after, and check the other apps still build.

### 5.3 JSON and NDJSON

- **`ndjson` is the default for JSON exports** and the only one offered above ~100k rows: one object
  per line, written incrementally, readable by anything, and valid as far as it got without needing a
  closing bracket.
- **`json`** produces `{"dataset": "...", "exported_at": "...", "rows": [...]}` - a real array, for
  small extracts a person will open by hand.
- `null` stays `null`. Numbers stay numbers. `bigint` counts serialise as strings, matching what the
  rest of the codebase already does with its `::text` casts on byte counts.

### 5.4 Projection, redaction, timezone, currency

- **Columns** come from the registry, intersected with what the requester may see, intersected with
  what they asked for. Never `SELECT *`; a column added by a later migration must not appear in an
  export because nobody updated a list.
- **Timezone.** Timestamps render in the org's reporting timezone, which `withOrgContext` already sets
  per org. The manifest states the zone. A CSV of timestamps with no stated zone is a support ticket.
- **Currency.** The org's currency (from `/owner/account/time`), with the ISO code in the column
  header (`amount_INR`), because a spreadsheet has nowhere else to put it.
- **Redaction is recorded.** Anything dropped by SS4.3 goes into
  `export_job_files.redacted_columns` and into the manifest, so the file says what is not in it.

### 5.5 Limits

| Limit | Value | Why |
|---|---|---|
| Rows per dataset | 5,000,000 | past this, ask for a filter |
| Uncompressed bytes per job | 2 GiB | the disk budget on the worker |
| Datasets per `view` job | 1 | that is what a view extract means |
| Concurrent jobs per org | 2 | SS6.7 |
| `section` jobs per person per section | 1 / hour | SS4.4 |
| `bulk` jobs per org | 1 / 24h | SS4.4 |
| Job wall-clock | 60 min | past this it is stalled, not slow |

Hitting a limit **fails the job with a specific message** naming the limit and suggesting a narrower
filter. It does not truncate silently.

**The row cap applies per dataset, not per job**, and that is what makes a section export tractable: a
`conversations` section export of a tenant with four million calls fails on the `calls` dataset alone
and says so, rather than producing a 2 GiB archive in which one member file is quietly short. A
per-job row cap would have hidden which dataset was the problem.

---

## 6. Execution

### 6.1 The API's half

`POST /v1/exports` validates, gates, resolves scope, writes, alerts, publishes.

```
1. zod-validate the body (SS9)
2. resolve the dataset list:
     scope='view'    -> the one dataset named
     scope='section' -> the section's preset list (SS3.4)
     scope='bulk'    -> every dataset in the registry
3. for each dataset: module + feature + grid + sensitivity gates (SS4.1)
     'view'                -> a failure is a 403
     'section' / 'bulk'    -> a failure drops the dataset from the list
     nothing survives      -> 403 naming the section
4. resolve crmScope INTERSECT ownerScope -> scope_snapshot
5. BEGIN
     INSERT INTO export_jobs (... status 'queued', datasets = the SURVIVING list ...)
     INSERT the export_created notifications for the owners (SS4.5)
     UPDATE export_jobs SET owners_notified_at = now()
   COMMIT
6. publishExport({ jobId, orgId })   -- after the commit
7. auditActor -> export.created
8. 202 Accepted, { jobId, status: 'queued', datasets, omitted }
```

**The owner alert is written in the same transaction as the job**, which is what makes "every export
alerts the owners" true rather than nearly true. A notification written after the commit is a
notification that a crash between the two skips, and the export still runs - the one combination that
turns the alert into something an owner cannot rely on. Being inside the transaction is also why it
is stamped at creation rather than completion (SS4.5): there is no later moment that is equally
guaranteed to happen.

**`omitted` comes back in the 202.** The caller asked for a section and got fewer datasets than the
section holds; saying so in the response is what lets the drawer show it before the person goes
looking for a file that was never going to be there.

**Publish after commit.** A message published inside the transaction can be consumed before the row is
visible, and the worker then finds nothing and nacks. If publishing fails, the row still exists and
the sweep in SS6.3 picks it up - which is the whole point of the row being the record.

**The PATCH trap.** If a job-settings PATCH is ever added, remember that `Input.partial()` keeps
`.default()` in zod, so a PATCH silently overwrites fields the caller never sent. There is already one
live instance of that bug in outreach cadences. Build the patch schema explicitly.

### 6.2 The worker's half

`worker/pipeline/export.ts`, consumed from `worker/src/main.ts` beside the other three lanes:

```
claim:     UPDATE export_jobs SET status='running', started_at=now()
            WHERE id=$1 AND status='queued' RETURNING *      -- 0 rows => someone else has it
re-scope:  re-resolve grants for requested_by_user_id, intersect with scope_snapshot (SS4.2)
count:     SELECT count(*) per dataset -> rows_total         -- best effort, skipped above a threshold
stream:    per dataset, keyset pages of 1000 rows
             -> serialize into a temp file
             -> every 5000 rows: UPDATE rows_written, bytes_written, current_dataset
             -> announce('export', 'update', jobId)
package:   status='packaging'; zip if >1 file; upload to S3; write export_job_files rows
finish:    status='ready', storage_key, expires_at=now()+7d, finished_at
notify:    insert 'export_ready' FOR THE REQUESTER ONLY; announce('export', 'update', jobId)
cleanup:   delete the temp file in a finally block
```

**The worker does not write the owner alert.** That happened at enqueue (SS6.1), and `owners_notified_at`
is already stamped. A retry, a resume or a redelivered message must not produce a second round of
owner notifications for the same job - the alert is about the request, and the request happened once.

**Progress writes are throttled** to every 5,000 rows or 2 seconds, whichever is later. A write per row
would be a round trip per row, and at ~125ms each the progress bar would cost more than the export.

`announce()` (`worker/pipeline/realtime.ts:20`) is best-effort by construction and never throws - a
progress signal must not be able to fail a job.

### 6.3 The durable sweep

`startExportSweep()`, every 60s, mirroring `startStalledCallSweeper()`:

- `queued` with `created_at < now() - 5 min` -> republish the message (lost message).
- `running`/`packaging` with `started_at < now() - 60 min` -> `failed`, error
  `"stalled: worker did not finish"`.
- `failed` with `retry_count < 3` and a **retryable** error class -> back to `queued` with backoff.

Non-retryable: a permission denial, a limit breach, a missing dataset. Retrying those just burns the
database three more times to reach the same answer.

### 6.4 Memory budget

The worker holds: one page of rows (1,000), one write buffer, and a file handle. Nothing else. No
`rows.push(...)` accumulating a result set, no `JSON.stringify(everything)`, no `Buffer.concat`. If you
can write a test that asserts peak RSS stays flat across 100k rows, write it - this is the class of bug
that only shows up on the largest tenant, in production, at 2am.

### 6.5 Cancellation

`DELETE /v1/exports/:id` sets `status='cancelled'` from `queued` or `running` only. The worker checks
the status **between pages** (one cheap indexed read per page, not per row) and aborts on a
non-`running` status, deleting its temp file. A `ready` job's DELETE means "delete the artifact now",
which runs the SS2.5 purge steps immediately.

### 6.6 Failure

`consumeOn` already nacks without requeue (`packages/queue/src/index.ts:113-120`), and the TODO for a
dead-letter queue is still open there. Do not rely on the broker for retries: record the failure on the
row and let the sweep decide. Store an **error class** plus a human message, never a raw stack - the
message is rendered in the console, and a stack trace in a tenant's UI leaks file paths.

### 6.7 Fairness

`EXPORT_PREFETCH=2` limits one worker, not one tenant. Add a per-org check at claim time: if the org
already has 2 jobs in `running`/`packaging`, **nack-and-requeue with a delay** rather than running a
third. Otherwise one tenant running twelve bulk exports starves every other tenant's extract, and the
only symptom anybody else sees is "export is slow today".

---

## 7. Delivery

### 7.1 Where the artifact lives

`exports/<org_id>/<job_id>/<file_name>` in the existing bucket (`S3_BUCKET`, default
`aura-recordings`). The `org_id` in the prefix is not access control - RLS and the download route are -
but it makes an orphan auditable and a per-tenant purge possible.

### 7.2 The download route, and why it is a 302

```
GET /v1/exports/:id/download
  -> guards: tenant, principal, job.requested_by_user_id === principal.userId
             (or org-admin, for a bulk export the org is entitled to see)
  -> operator: refused (SS4.6)
  -> status must be 'ready'; 'expired' returns 410 Gone with a re-run affordance
  -> presignedGetUrl(storage_key, 300, content_type)
  -> 302 redirect, Cache-Control: no-store
  -> audit export.downloaded; increment downloaded_count
```

**The job row stores the key, never a URL.** Three reasons, all of which have bitten this kind of
feature elsewhere:

1. A stored presigned URL is a **bearer token in a database column**. Anyone who can read the row - a
   support screen, a log line, a CSV of the jobs table - can download the file.
2. It cannot be revoked. Deleting the job row does not un-sign a URL already minted.
3. Expiry becomes wrong. A URL signed at creation expires on the creation clock, so a job that finished
   20 minutes later hands out a link already half dead.

Signing at download time gives a **5-minute** window, re-authorises on every click, and lets the route
refuse after the job expires or the person loses access.

Sign with the **public** client (`api/s3/s3.service.ts:40-46`) - the browser has to be able to reach the
address. Set `ResponseContentDisposition` to `attachment; filename="..."` through `safeFilename`, so the
name cannot inject header content.

### 7.3 Expiry, as the user sees it

- Job cards show "Available until 7 Oct, 14:32" from `expires_at`, in the org's timezone.
- An expired job stays in the list with its row counts, greyed, with a **Run again** button that
  re-enqueues the same parameters. The history is worth more than the file.

### 7.4 Storage quota

The storage sweep counts recordings only - `STORAGE_SWEEP_SQL`
(`worker/pipeline/storage-usage.ts:96`) sums a recordings table. Export artifacts are invisible to it
today.

Recommendation: add `export_bytes` to `org_storage_usage` as a **separate column**, summed from
`export_jobs.bytes_written WHERE status='ready'`, shown separately on the storage screen, and
**excluded from the quota that triggers the `storage_quota` notification** for the first release.
Rationale: 7-day retention bounds it, and a tenant hitting their quota because they exported their own
data - and then being unable to export it - is a trap worth not building. Revisit after a month of
real numbers.

---

## 8. Frontend

**Built 2026-09-30 (E2 UI).** The drawer is `web/components/export-drawer.tsx`, opened by
`export-button.tsx` from `PageHeader`'s `actions` slot so a SERVER page keeps Export without becoming
a client component. The centre is `web/app/(owner)/owner/account/data/`. Three things the console's own
rules decided for us:

- **Expiry renders through `<LocalTime>`, not `toLocaleString()`.** `console-time.test.ts` catches a
  bare locale format in the owner console, and it caught this one: a date formatted in the machine's
  zone means two colleagues read different days off the same row, with a hydration mismatch in
  between.
- **A failed export is `StatusChip tone="danger"`, which is ORANGE.** Red means MISSED and only
  missed; `danger` was re-pointed at the error orange for exactly this kind of use.
- **`ProgressBar` takes a real percentage and has no indeterminate mode**, so a job whose count was
  skipped gets a pulsing track instead of a made-up number. A bar that jumps to 100 and sits there is
  worse than admitting we do not know.

The account menu gained a "Your data" row for everyone, not just owners: the page shows a person their
OWN exports and only an owner the whole workspace's, so gating the entry would hide a telecaller's own
downloads from them. `account-menu.test.ts` pins the menu's rows, so adding it is a two-file change.

### 8.1 Where it lives

- **`view`:** an `Export` action in the toolbar of each list page that has one - `/owner/leads`,
  `/owner/calls`, `/owner/crm/contacts`, `/owner/invoices`, `/owner/attendance`.
- **`section`:** the same drawer, reached two ways - a second option inside it ("Everything in
  Sales"), and an `Export section` item on the section's own landing page. Both post the same body
  with `scope: 'section'`; there is no separate screen.
- **`bulk` + history:** a new `/owner/account/data` page under the Account section, alongside Storage.
  The rail already has that section; this is a tab, not a ninth entry.

Deliberately **not** a top-level "Exports" rail entry. The rail is seven sections and adding an eighth
for a thing people use monthly would cost every other section a slot in the eye's first pass. Export
belongs where the data is, plus one page in Account for history.

### 8.2 The export drawer

Opened from the toolbar. Pre-filled from **what is on screen** - the active filters, the date range
from the shared period picker, the visible columns. That is the whole UX argument: the person has
already expressed what they want by filtering, and asking them to express it again in a modal is where
exports get abandoned.

The scope selector is the first control, and **the filtered view is the default**. Someone who has
just filtered a board to 40 rows and hits Export means those 40.

```
+-- Export ------------------------------------------------+
|  What      (o) This view          ~12,400 rows           |
|                Board: Main - Stage: Qualified            |
|                1 Sep - 30 Sep 2026      [Edit filters]   |
|            ( ) Everything in Leads     ~48,900 rows      |
|                Leads, Stage history - no filters         |
|                                                          |
|  Format    (o) CSV   ( ) Excel (.xlsx)   ( ) JSON        |
|  Columns   [x] All visible   [ ] Choose...               |
|                                                          |
|  i  Transcripts and recordings are not included -        |
|     your role does not have recording export.            |
|  i  Your workspace owners are told when an export runs.  |
|                                                          |
|              [ Cancel ]            [ Start export ]      |
+----------------------------------------------------------+
```

Three things this layout is doing on purpose:

- **The section option names its datasets** ("Leads, Stage history"), because "everything in Leads" is
  otherwise a promise nobody can check. If a dataset was gated out, it is not listed - the person sees
  what they will get, not what the section theoretically holds.
- **Both options carry a row estimate**, so the difference between 12,400 and 48,900 is visible before
  the choice rather than after the wait. Estimates come from the same count the worker will run, capped
  and approximate above a threshold; render `~` and never a false precision.
- **The owner-alert notice is shown to everyone, including owners.** People should know the alert
  exists before they run the export, not discover it when someone asks them about it. A surveillance
  measure people are not told about is a worse version of one they are.

The redaction notice is **shown before the job runs**, not discovered in the file. Someone who exports
12,000 calls and then finds the transcript column empty has wasted their time and ours.

A `className` passed to a kit component loses to that component's own base class - Tailwind resolves
the tie by stylesheet order, not argument order. Use the kit's variants for this drawer rather than
overriding.

### 8.3 Progress

Two mechanisms, deliberately:

1. **Realtime.** A new `export` topic in `KNOWN_TOPICS` (`shared/realtime.ts`); the worker announces on
   every throttled progress write. The console's existing `useServerState` re-reads through the normal
   authorised path, so no row data travels on the bus - only "something changed".
2. **A poll fallback.** Every 5s while a job is in flight and the page is visible. **Not optional.**
   Locally, realtime requires RabbitMQ to be running or nothing updates at all, and in production a
   broker restart drops signals in flight by design. A progress bar that can silently stop is worse
   than one that ticks a little late.

States: `queued` -> indeterminate bar, "Waiting to start". `running` with `rows_total` -> determinate
`rows_written / rows_total`. `running` without a count -> indeterminate with a live row count.
`packaging` -> indeterminate, "Preparing your file".

### 8.4 The exports centre

A table at `/owner/account/data`: what, who, when, rows, size, status, expiry, and a Download or Run
again button. Owners see the org's jobs; everyone else sees their own. This is also where a bulk export
is started, behind a confirm that names what is about to be included.

The "what" column reads `This view - Leads`, `Everything in Sales`, or `Whole workspace`, so the three
scopes are distinguishable at a glance. **For an owner this table is the standing answer to the
question the alert raises** - the alert says an export happened, and this is where they see what it
was, how big, and whether it was downloaded. Make `?job=<id>` from a notification scroll to and
highlight that row; an owner who clicks an alert and lands on an unsorted table of forty jobs has been
given a search task instead of an answer.

An owner reading this table still cannot download somebody else's artifact (SS7.2). The row shows
metadata; the Download button renders only on their own jobs.

Give it a dedicated skeleton measured against the real table geometry, matching the per-screen loaders
the console already has - a generic spinner here reads as broken.

### 8.5 Notifications and the toast

**To the requester:**

- A **toast with a Download button** if the person is still on the page when the job finishes. Most
  `view` extracts finish in seconds and never need anything else.
- A **notification** (`export_ready`) for anything they walked away from, with `linkPath`
  `/owner/account/data?job=<id>`.

**To the owners** (SS4.5), at creation:

```
Priya Sharma started an export
Everything in Customers - 2 datasets, ~18,200 rows - CSV
Today, 14:06                                 [ View exports ]
```

Named person, scope, size, format, time. No download affordance and no link to the file. The text says
"started", not "downloaded" - conflating the two would have the alert claim something it does not
know.

For an owner whose preferences digest this kind, the same content arrives as one line in their daily
roll-up, grouped by person. Two exports by the same person on the same day are two lines, not a
summary - "Priya ran 2 exports" is exactly the compression that makes the alert useless.

**`linkPath` must not carry `/admin`.** The console is served under that basePath in production and
`next/link` adds it; a stored path that already says `/admin/...` is prefixed twice and 404s. This is
invisible in local dev, which runs with no basePath, and it has shipped before. The `stored-links` spec
(`api/common/stored-links.spec.ts`) will catch it - do not add an ALLOWED entry to get around it.

Nothing is emailed and nothing goes out over WhatsApp. A notification "cannot reach a person who is not
signed in to the console", which is the property that keeps this inside the rule that nothing automated
sends. A download link in an email is an unauthenticated artifact sitting in an inbox, and that is not
a thing this platform does.

### 8.6 Failure states

| Status | What the person sees |
|---|---|
| `failed`, retryable | "Export failed - retrying automatically (2 of 3)" |
| `failed`, final | The message, and **Run again**. Never a stack trace. |
| `failed`, limit | "This export is too large. Narrow the date range and try again." |
| `cancelled` | Row stays, greyed, **Run again** |
| `expired` | "Expired 3 days ago", **Run again** |

Red in this console means MISSED, not error - failed export states use the orange error treatment, not
the red one.

---

## 9. API surface

| Method | Route | Guard stack | Returns |
|---|---|---|---|
| `GET` | `/v1/exports/datasets` | tenant, principal | datasets and sections this caller may export, with column lists and row estimates |
| `POST` | `/v1/exports` | tenant, principal, per-dataset gates | `202 { jobId, status, datasets, omitted }` |
| `GET` | `/v1/exports` | tenant, principal | this caller's jobs; org-wide for owners |
| `GET` | `/v1/exports/:id` | tenant, principal, ownership | one job, with its per-file rows |
| `GET` | `/v1/exports/:id/download` | tenant, principal, ownership, not-operator | `302` |
| `DELETE` | `/v1/exports/:id` | tenant, principal, ownership | cancel, or delete the artifact |

`GET /v1/exports/datasets` is what the drawer reads. It must be computed from the same registry and the
same gates the POST enforces - a dataset offered here and refused there is a bug report.

**Built 2026-09-30 (E2 backend). Four mistakes worth writing down, because every one of them was
invisible to typecheck and to the unit suite:**

1. **`@Controller("v1/exports")` doubles the prefix.** `main.ts` calls `setGlobalPrefix("v1")`, so the
   routes mounted at `/v1/v1/exports`. Every other controller here names the resource only
   (`@Controller("exports")`).
2. **A parameter renumbering left `$4` in the SQL with three params bound** - Postgres answered
   `42P18 could not determine data type of parameter $3` and the route 500'd. Assembled SQL again.
3. **A bare admin key has `principal.userId === "admin-key"`**, which is not a uuid, so
   `m.user_id = $1` raised `22P02` and the gate 500'd instead of denying. Now it denies, which is what
   `CrmPermissionsGuard` already decided for the same case: omitting `x-caller-user-id` must not grant
   more than asserting an unresolvable one.
4. **`API_BASE` in the integration harness already ends in `/v1`**, so test paths must not repeat it.

**And a fixture lesson.** `seedTenants` inserts the organization row directly, so a fixture tenant has
NO `roles` and NO `role_permissions` - and because the gate reads the grant from the database, every
grid-governed dataset is denied. That is correct for an unconfigured tenant and useless as a fixture,
so the test seeds the grid the way `seedCrmDefaults` (admin.controller.ts:63) does. A real tenant gets
those rows at provisioning; one created by hand does not.

The POST body carries `scope` and, for a section, `section`:

```ts
{ scope: 'view',    dataset: 'leads', filters: {...}, columns: [...], format: 'csv' }
{ scope: 'section', section: 'sales',                 columns: null,  format: 'xlsx' }
{ scope: 'bulk',                                      columns: null,  format: 'csv' }
```

`filters` and `dataset` are rejected outright on a `section` or `bulk` body rather than ignored. A
caller who sends filters with a section export believes they will be applied, and silently dropping
them produces a file that is correct by the schema and wrong by the request.

---

## 10. Testing

**Unit**
- `csvRow` matches `toCsv` for the same input, including formula neutralisation.
- Keyset pagination over a seeded 10k-row table returns every row exactly once, with a duplicated
  `created_at` in the middle. This is the test that catches a non-unique sort order.
- XLSX sheet roll at the row limit; cell truncation at 32,767.
- A pure function for the scope intersection - snapshot x re-resolved, all nine combinations of
  `all`/`owned`/`none` - in the style of `quotaAlertDecision`.
- The owner-alert recipient rule (SS4.5) as a pure function: owners minus the requester, and the
  instant-vs-digest decision per scope and sensitivity.

**Section presets**
- Every section key in the registry exists in `OWNER_NAV_SECTIONS`, and every rail section with pages
  either owns at least one dataset or is explicitly listed as exporting nothing (SS3.4). This is the
  test that catches a page moving between sections.
- A `section` export whose datasets are all gated out returns 403, not an empty ZIP.
- A `section` or `bulk` body carrying `filters` or `dataset` is rejected.

**Owner alert**
- One export -> one `export_created` per owner, none to the requester when the requester is an owner.
- A job retried by the sweep does not write a second round: assert `owners_notified_at` is unchanged
  and the notification count is stable.
- A crash between the job INSERT and the notification INSERT leaves neither (same transaction).

**Guard**
- Every route appears in `guard-mounting.spec.ts` with its full stack. A route that 400s on a malformed
  body before the guard runs proves nothing; assert the **403**.
- `permissions-inventory.spec.ts` must list the new routes.

**Tenant isolation**
- Add export cases to the isolation suite. That suite is opt-in and rots unseen, so: run it in CI for
  this change, and make each case a genuine cross-tenant read attempt with a valid body. A case that
  400s or 403s before reaching the handler looks like coverage and is not.

**Integration** (needs Docker, which is usually off on the dev machine)
- Enqueue -> consume -> ready -> download, against MinIO.
- A killed worker mid-job -> the sweep fails it -> the retry succeeds.
- Two workers racing one job -> exactly one runs it.

**SQL verification scripts**
- One that asserts every `ExportDatasetKey` maps to a real table and real columns. Typecheck cannot see
  inside a template literal, and this is the check that catches a renamed column before production does.

---

## 11. Rollout

| Phase | Contents | Ships when |
|---|---|---|
| **E0** DONE | Migration 0148, `shared/export-datasets.ts` (with sections), `EXPORT_QUEUE`, the three notification kinds (all three places) | built 2026-09-30, local |
| **E1** DONE | Worker consumer + sweep, CSV only, `scope: 'view'`, three datasets; scope predicates moved to `@aura/shared` | built 2026-09-30, local; NOT run against a database |
| **E2** DONE | API routes + owner alert (43 integration cases), the export drawer, the exports centre at `/owner/account/data` with live progress, and Export on `/owner/leads` | built 2026-09-30; api 975, web 1091, integration 43 |
| **E3** | XLSX + JSON/NDJSON; the rest of the catalogue; the ZIP writer | E2 stable one week |
| **E4** | `scope: 'section'` across all sections, the section presets test, the hourly limiter | E3 stable |
| **E5** | The exports centre, `scope: 'bulk'`, the 24h limiter | E4 stable |
| **E6** | Purge sweep in production, `export_bytes` on the storage screen | E5 deployed |
| **E7** | API-key scopes (SS4.7) | on request |

Two ordering decisions worth defending:

- **The owner alert ships in E2, with the first export anybody can run.** It is a governance control,
  and a governance control added in a later phase means every export between the two phases happened
  unobserved. There is no version of this feature that should reach a tenant without it.
- **Sections (E4) come before bulk (E5)**, which reverses the obvious order. A section export exercises
  the ZIP writer, the per-dataset gating, the omission manifest and the multi-dataset progress bar at a
  size that is recoverable when it is wrong. Bulk is the same machinery with no ceiling; it is the
  wrong place to find out that the manifest was never being written.

E1 is deliberately behind no UI. A worker lane that can be exercised by an admin-key POST before any
tenant can reach it is how the throughput and memory characteristics get measured honestly.

---

## 12. Risks and open questions

| # | Risk | Mitigation |
|---|---|---|
| R1 | A worker export saturates the database and the console goes slow | prefetch 2, per-org cap of 2, keyset pages of 1000; a read replica later if it is still a problem |
| R2 | `report-schedules`' unscoped-render pattern is copied into the export worker | SS4.2, plus a test asserting a telecaller's job produces only their rows |
| R3 | The notification kind is added in one place only | SS2.4, plus a test asserting the CHECK and the zod enum are equal |
| R4 | `exceljs` added with a filtered `pnpm add` breaks other workspace apps | `pnpm install --frozen-lockfile` after, and build every app |
| R5 | Export artifacts fill the VPS disk | 7-day retention, purge sweep, per-job 2 GiB cap, `export_bytes` visible |
| R6 | A presigned URL leaks through a log or a support screen | store the key, sign at download, 5-minute expiry (SS7.2) |
| R7 | Production migration numbering diverges from the local tree | check what production is on before naming 0148 |
| R8 | The Next build's EPERM symlink crash on Windows hides a real failure | it is a known local-only crash, not a code bug; verify on the VPS |
| R9 | Owners mute `export_created` because it fires too often, taking the alert they wanted with it | no self-alert, digest by default for routine `view` extracts, instant only for section/bulk/sensitive (SS4.5) |
| R10 | A section preset silently loses a dataset when a page moves between rail sections | the section test in SS10; derive from `OWNER_SECTION_OF` rather than restating it |
| R11 | Section exports make full-table reads routine rather than exceptional | the hourly per-section limiter, the per-dataset row cap, and the per-org concurrency cap of 2 |

**Open questions for the user:**

1. **Retention: 7 days, or 30?** 7 is chosen here because the file is reproducible and the disk is a
   VPS. 30 makes "I exported that last month" work.
2. **Should a bulk export include call transcripts** for an owner who holds `recordings:export`? It is
   the single largest thing in the tenant and the most sensitive. Default assumed here: yes for owners
   with the grant, and the manifest says so.
3. **Is the bulk export a DPDP/GDPR "right of access" artifact** - complete and self-describing for a
   regulator - or an operational convenience? That changes the manifest's requirements, not the
   engine's.
4. **Attachments.** Exporting rows is specified. Exporting the *files* attached to them (recordings,
   quotation PDFs) is an order of magnitude more data and is assumed out of scope; say if not.
5. **Does the owner alert cover a `view` extract of ten rows?** It does here, digested rather than
   instant (SS4.5). The alternative is a row-count floor below which nothing is reported - simpler for
   owners, and it creates a size under which data can leave unobserved. Assumed: no floor.
6. **Who counts as "the owner" for the alert** - every membership with the owner persona, or only the
   org-admin role? Assumed: every owner persona, since that is who the console already treats as
   accountable. On a large team that could be several people getting the same alert.

---

## 13. Deploy notes

1. `0148` runs before the worker and API images deploy - the worker will insert notifications with the
   new kinds on its first tick, and the API writes `export_created` on the first export anybody runs.
2. `verify-rls` runs in the deploy path and will refuse the deploy if either table lacks a tenant
   policy. That is working as intended; fix the migration, not the check.
3. `EXPORT_PREFETCH` defaults to 2 and needs no env change to deploy. Set it explicitly in
   `docker-compose.prod.yml` anyway, so the number sits visibly next to the other three.
4. Nothing in this feature is gated behind an env flag. It is gated behind the **`export` grid
   action**, which is off for any role that has not been granted it - so deploying it gives nobody
   anything until an owner turns it on. That is the right default, and it is why there is no
   `EXPORTS_ENABLED`. The same grid action governs all three scopes: an owner granting `export` on
   `deal` is granting it in the Sales section export too, and the staff screen's help text should say
   so rather than leaving them to find out.
5. The repo is public. Scan the commit patch before pushing: this change touches S3 configuration and
   migration files, which is exactly the neighbourhood a credential gets committed from.
