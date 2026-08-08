# 14 — Stage 1 execution report (run 2)

**Run date 2026-08-06, evening.** Branch `crm-connectors-and-console-auth`, uncommitted in the
working tree. Four developers on disjoint partitions (A: API guard suite · B: integration harness +
isolation loop · C: correctness fixes in `shared`/`worker` · D: migration 0019 + API/web fixes +
doc corrections), one integration pass, one analyst pre-pass
([`13_ROUTE_AND_GUARD_INVENTORY.md`](13_ROUTE_AND_GUARD_INVENTORY.md)).

---

**The tree is green and the numbers moved, but the thing Stage 1.3 exists to produce did not ship.**
Re-run for this report, not taken on report: `pnpm -r typecheck` passes 8/8; `pnpm -r test` is
**308 passed / 4 skipped / 0 failed** (109 shared + 46 llm + 38 worker + 21 db under vitest, 94+4
under jest in `apps/api`), up from 196/4/0; `pnpm tenancy:check` passes; `pnpm lint` is 33 problems
(7 errors, 26 warnings) against a 32-problem baseline, +1 warning, no new errors.

**The integration harness was executed — once, by the integration pass, and it does not test the
pipeline.** `platform/tests/` contains `setup/env.ts`, `setup/migrate.ts` and one file the
integrator wrote, `setup.test.ts`. Those 18 assertions ran green against the ephemeral
`docker-compose.test.yml` stack and they prove real things: the safety file genuinely refuses a
non-loopback host and each of ports 5432/5433/5672/9000/4000 by name, `childEnv()` blanks every
provider key, all 19 migrations apply to a clean Postgres 16 and are idempotent, every `org_id`
table comes out with FORCE RLS and a policy, and both live CHECK constraints match the zod enums.
That is the harness testing itself. **The §1.3 suite — upload → ASR → extraction → lead projection →
CRM dispatch, cross-tenant isolation, retry and retirement — does not exist in any form. No API or
worker process is ever spawned by anything in this repo.** `tests/setup/processes.ts`, which
`docker-compose.test.yml`'s own header describes as the thing that spawns them, was never written.

**The guard suite is real but partial: four of five guards, at unit level, with fake execution
contexts.** 98 cases across `AdminKeyGuard`, `TenantGuard`, `PermissionsGuard` and `OwnerRoleGuard`.
`DeviceAuthGuard` has **no spec file** — the shared harness references `device-auth.guard.spec.ts`
by name and that file does not exist. And because every case builds a synthetic
`ExecutionContext`, **nothing asserts which guards are mounted on which route.** Deleting
`@UseGuards(AdminKeyGuard, TenantGuard)` from a controller leaves the whole suite green.

**No reviewer returned a verdict.** All four partitions came back `VERDICT: undefined`; no reviewer
set `testsAreHonest` either way. What stands in place of four independent reviews is the integration
pass (which found and fixed a wrong test and a missing runner) and my own re-run of everything
above. Treat every "landed" below as *landed and compiling and passing its own tests*, not as
*reviewed*.

**One change made this run is a live-data risk nobody flagged.** See §7, finding N1:
`StoredExtractionSchema` was written specifically so the new save-time enum rule would not fire on
agent versions saved before it existed — and then was not wired into either read path. Do not deploy
`packages/shared` without doing the count in N1 first.

---

## 1. What shipped

| Change | Plan ref | File(s) | Status |
|---|---|---|---|
| Guard suite: `AdminKeyGuard` (26 cases incl. production-hardening branch) | 1.3 | `apps/api/src/common/admin-key.guard.spec.ts` (new) | **landed** |
| Guard suite: `TenantGuard` + `@OrgId()` (13 cases) | 1.3 | `apps/api/src/common/tenant.guard.spec.ts` (new) | **landed-with-fixes** — one case asserted a falsehood about zod's `.uuid()`; integration rewrote it, see §3 |
| Guard suite: `PermissionsGuard` + `principalHasPermission` (12 cases) | 1.3 | `apps/api/src/common/permissions.guard.spec.ts` (new) | **landed** |
| Guard suite: `OwnerRoleGuard` (12 cases, 2 skipped) | 1.3 | `apps/api/src/common/owner-role.guard.spec.ts` (new) | **landed** |
| Shared guard harness + its own self-tests | 1.3 | `apps/api/src/common/guard-harness.spec.ts` (new) | **landed-with-fixes** — fixture comment carried the same zod falsehood |
| Guard suite: `DeviceAuthGuard` (analyst supplied cases D1–D10) | 1.3 | — | **not landed** — no spec file; the harness references one by name |
| Route-level assertions (which guards are mounted where) | 1.3 | — | **not landed** — see §3 |
| Jest + `@nestjs/testing` for `apps/api` | 1.1 | `apps/api/package.json`, `apps/api/jest.config.js` (new) | **landed-with-fixes** — **added by the integration pass, not by the partition that wrote 1,347 lines of specs against it.** Before that, `apps/api` typecheck was red and `pnpm -r test` skipped all five files silently via `--if-present` |
| Ephemeral test stack (pg 55432 / rabbit 55672 / minio 59000) | 1.3 | `platform/docker-compose.test.yml` (new) | **landed** |
| Harness: safety guards + `childEnv()` | 1.3 | `platform/tests/setup/env.ts` (new) | **landed** |
| Harness: schema reset + migration runner | 1.3 | `platform/tests/setup/migrate.ts` (new) | **landed** |
| Harness: process spawner for API + worker | 1.3 | `tests/setup/processes.ts` | **not landed** — nothing starts an API or a worker |
| Runner wiring so the harness can execute at all | 1.3 | `platform/vitest.integration.config.ts` (new), root `package.json` (`test:integration{,:up,:down}`), root `vitest`/`pg` devDeps | **landed** — **added by the integration pass** |
| Harness self-test, 18 cases, executed green | 1.3 | `platform/tests/setup.test.ts` (new) | **landed** — **written by the integration pass** |
| Full pipeline suite (`ASR_STUB=1 ANALYZE_STUB=1`, create → upload → COMPLETE) | 1.3 | — | **not landed** |
| Failure/retry suite (S3 `NoSuchKey` → `FAILED_ASR` → backoff → retire) | 1.3 | — | **not landed** |
| `TRANSCRIPTION_OFF` suite (zero rows in 4 tables, call still listed, `/audio` 200) | 1.3 | — | **not landed** |
| Cross-tenant isolation loop over the whole route table | 1.3 | — | **not landed** |
| CI `integration` job + rabbitmq/minio services | 1.4 | `.github/workflows/ci.yml` | **not landed** — correctly, there is nothing to run |
| `CallStatus` += `TRANSCRIPTION_OFF`; `CrmSyncStatus` += `'dead'` | §4.3 (rpt 12) | `packages/shared/src/enums.ts` | **landed** |
| `confidenceScore` uses `isFilled` | §5.1 (rpt 12) | `apps/worker/src/pipeline/crm-dispatch.ts` | **landed** |
| `upsertLead` incoming-fact filter uses `isFilled` | §5.1 (adjacent) | `apps/worker/src/pipeline/leads.ts` | **landed** |
| Optionless enum rejected at save time | §5.1 (rpt 12) | `packages/shared/src/extraction.ts` (`superRefine`) | **landed** |
| `StoredExtractionSchema` — read-path degradation for pre-existing rows | §5.1 (implied) | `packages/shared/src/extraction.ts` | **landed but DEAD — not wired into either read path.** See §7 N1 |
| ISO-8601 datetime check replaces bare `Date.parse` | §5.1 (rpt 12) | `packages/shared/src/extraction.ts` (`isIsoDateTime`) | **landed** |
| `resolveOwnerRole` trims + lower-cases | §5.1 (rpt 12) | `packages/shared/src/roles.ts` | **landed-with-caveat** — closes the resolver, not the HTTP path (§7 N5) |
| Migration 0019 — five hot-path indexes | §4.3 (rpt 12) | `packages/db/migrations/0019_hot_path_indexes.sql` (new) | **landed** |
| 0019 mirrored to Supabase | — | `supabase/migrations/20260101000019_hot_path_indexes.sql` (new) | **landed** — byte-identical, verified |
| `org_id` predicate on `PATCH`/`DELETE /v1/members/:userId` | §4.3 (rpt 12) | `apps/api/src/modules/tenancy/members.controller.ts` | **landed** — defence in depth; the reported bug did not actually exist (§7 N6) |
| `org_id` predicate on `DELETE /v1/owners/:userId` (memberships + sessions) | — | `apps/api/src/modules/owner/owners.controller.ts` | **landed** |
| `owner_role` written on owner provisioning | — | `apps/api/src/modules/owner/owners.controller.ts` | **landed** |
| Web-tier `dev-admin-key` literal removed | 0.2 | `apps/web/lib/server-api.ts` (`resolveAdminKey()`) | **landed** — was **not landed** in run 1 (rpt 12 §2.2) |
| `PLATFORM_OPERATOR_EMAILS` semantics corrected in the repo docs | 0.1 step 3 | `platform/DEPLOYMENT.md`, `platform/.env.production.example` | **landed** |
| `CREATE INDEX CONCURRENTLY` prohibition documented at the runner | 1.4/§5 | `platform/DEPLOYMENT.md` | **landed** |
| Corrections to `11_DATA_INVENTORY.md` / `12_STAGE0_EXECUTION_REPORT.md` | — | — | **not landed** — neither file was opened this run (mtimes 16:46 and 17:33 vs a 20:11 start). Report 12 §4.3 still asserts a cross-tenant write that does not exist (§7 N6) |
| Test artifacts excluded from `dist/` (prod image would fail on `--prod` install) | §5.6 (rpt 12) | `apps/api/tsconfig.build.json`, `apps/worker/tsconfig.build.json` (new) | **landed** — **added by the integration pass** |
| `JWT_SECRET ?? "dev-jwt-secret-change-me"` removed at 4 sites | 0.2 | — | **not landed** (unchanged from run 1) |
| Kotlin unit tests (`OemRecordingIngestor` etc.) | 1.2, A1 | — | **not landed** |
| Staging project + second compose stack | 1.6 | — | **not landed** |

Four of the six items the integration pass fixed were work the owning partition should have done.
That is the honest reading of the "landed-with-fixes" and bolded rows above.

---

## 2. Where Stage 1 now stands against the plan

| Item | Run 1 | Run 2 | Note |
|---|---|---|---|
| 1.1 Tooling floor | 🟢 | 🟢 | Jest for `apps/api` now exists — the last gap is closed |
| 1.2 Unit tests | 🟡 | 🟢 | All four `.skip`ped bug reports are fixed and un-skipped; 308 cases |
| 1.3 Integration tests | ⬜ | 🟡 | Harness executes; **no pipeline suite, no isolation loop, 4/5 guards, no route-level assertions** |
| 1.4 CI | 🟡 | 🟡 | Unchanged. No `integration` job, no Android workflow, no branch protection |
| 1.5 RLS invariant | 🟡 | 🟡 | Unchanged in code. Now *provable on a laptop* — `setup.test.ts` asserts the invariant against a real ephemeral schema |
| 1.6 Staging | ⬜ | ⬜ | Untouched |

**Stage 1 exit check — "a deliberately introduced bug in `qualifyLead`, in a guard, and in a
migration each fail CI before a human notices" — has not been attempted, and two thirds of it would
fail today.** A bug in `qualifyLead` fails CI (55 cases). A bug in a guard's *logic* fails CI. A
guard *unmounted from a controller* does not. A bad migration fails the `db` job only if it fails to
apply or breaks RLS — an index on the wrong column, or a CHECK that drifts from the enums in a
direction `verify-rls.js` does not assert, passes.

---

## 3. The guard suite and the isolation loop

### What is now protected by a test

Sourced from the analyst's decision tables (13 §2), so the case ids below are traceable back to
that document.

**`AdminKeyGuard`** — `resolveAdminKey()` in all four states (configured / trimmed-empty /
unset-in-production → `null` / unset-elsewhere → dev literal); the dev literal is *rejected* under
`NODE_ENV=production` (A-hardening); an empty `x-admin-key` never matches an unset key (A14);
repeated headers take the first value (A15); a well-formed org id that names no tenant 404s (A3); a
malformed one is let through unchecked (A4, today's behaviour, pinned); the session path resolves
from `Bearer aus_` including the prefix in the hash (A10), 401s an unknown token (A11), a
non-`aus_` bearer without touching the database (A12), and no credential at all (A13); a *wrong*
admin key still falls through to the session path (A9); **and a session's org pins over any
`x-org-id` the caller sends** — the single most load-bearing assertion in the file for Stage 2.

**`TenantGuard`** — `@CrossTenant()` at class level, at handler level overriding a scoped
controller, on a route with no principal at all, and a scoped sibling on the same controller (T1);
401 on a missing principal, which is a *guard-order* bug and is caught loudly (T2); the principal's
org is pinned (T3); 400 when the admin-key principal named no org (T4); 400 on the malformed id A4
let through (T5); a session principal cannot be moved by a header (T6). Plus `@OrgId()` throwing 500
on a cross-tenant route and on the empty string.

**`PermissionsGuard`** — the two-permission registry is asserted exhaustively; `viaAdminKey` and
`platform_admin` short-circuit *regardless of the boolean flags* (P3/P4); membership flags are read
for a session principal; a viewer without the grant 403s (P6); an `org_admin` whose grant was
revoked 403s (P8) — role does not imply the grant; handler metadata beats controller metadata.

**`OwnerRoleGuard`** — inert on a route declaring no roles (O1, which is `GET /v1/owner/overview`
and is a finding, not a feature); 403 with no principal (O3); the admin-key fail-open (O4); the
`resolveOwnerRole(null) → owner` fail-open (O5); telecaller denied on owner-or-manager (O6); manager
allowed (O7); manager denied on owner-only with the requirement named (O8); the case-variant
escalation (O9); and enforcement for a session principal that *does* carry a persona.

**The harness itself is tested** — that header names are lower-cased the way Node's parser does,
that real decorator metadata resolves through a real `Reflector`, that handler metadata overrides
class metadata, and that `expectHttpError` fails when the guard did not throw. That last one is the
only thing standing between this suite and the classic vacuous-guard-test failure.

**The integration harness** proves `env.ts` rejects production and the dev stack, that migrations
apply and are idempotent, that every `org_id` table has FORCE RLS and a policy, and that
`calls_status_check` / `crm_sync_log_status_check` match the zod enums **against a real schema
rather than against themselves**.

### What is still protected only by hope

Read this list before starting 2.4. Every line is a property Stage 2 will move.

1. **`DeviceAuthGuard` has no tests at all.** Six routes hang off it, including `POST /v1/calls`
   and `POST /v1/calls/:id/complete` — the entire device ingest path — and every one of them runs
   with *no* `AdminKeyGuard` and *no* `TenantGuard`. The analyst's D1–D10 cases are written and
   unimplemented. D9 (absent `org_id` → `withOrg(undefined, …)`) and D10 (a token naming another
   tenant is accepted and scoped to that tenant, with nothing re-read from the database) are
   unasserted behaviours on the ingest path of a live system.
2. **Nothing asserts guard *mounting*.** Every case constructs its own `ExecutionContext`. The
   75-route table, the standard `@UseGuards(AdminKeyGuard, TenantGuard)` stack on 57 routes, the six
   `@CrossTenant()` routes and the six routes with **no guard at all** are documented in report 13
   and asserted nowhere. A refactor that drops a guard from a controller ships green.
3. **There is no cross-tenant isolation loop.** §1.3's requirement — "tenant A's session/key must
   receive 404 or empty for every one of tenant B's calls, leads, agents, devices, workspaces and
   audio URLs, looped over the whole route table, not a sample" — has zero coverage. Tenant
   isolation on this platform is currently asserted by: RLS policies (structurally verified),
   `check-tenancy.js` (a static grep that no handler resolves its own org), and one guard unit test
   that a session's org pins over a header. Nothing exercises an actual request for another
   tenant's row.
4. **The pipeline has no end-to-end test.** `TRANSCRIPTION_OFF`, retry backoff escalation and
   retirement at `PIPELINE_MAX_ATTEMPTS` are covered only as pure functions.
5. **`apps/web` has no test script and zero tests.** `isOperator()`, the owner/operator split and
   `server-api.ts`'s tenant pinning — all modified across these two runs, all security-relevant —
   are verified by `tsc` alone. `pnpm -r --if-present test` runs 5 of 9 projects; `packages/queue`
   and `packages/ui` are the other two gaps.
6. **`platform/tests/` is not typechecked and not in CI.** It is not a workspace package, so
   `pnpm -r typecheck` skips it — including `env.ts`, the file that decides whether a destructive
   suite may reach production. `pnpm test:integration` is in no workflow.

### On test honesty

No reviewer set `testsAreHonest: false`, because no reviewer reported at all. Two honesty defects
were found by the integration pass rather than by review, and both are worth recording because they
are the failure mode this suite is supposed to prevent:

- `tenant.guard.spec.ts` T5 asserted that zod 4's `.uuid()` rejects a v1-shaped UUID. It does not —
  verified empirically against the installed zod 4.4.3, which accepts version nibbles 1–8 with
  variant 8/9/a/b plus the nil UUID. The guard was correct; the test was wrong and would have been
  "fixed" by someone changing the guard. Rewritten to assert the real boundary (version nibble 9,
  variant nibble c).
- `guard-harness.spec.ts` carried the same false premise in a fixture comment, which is how that
  error would have propagated into the next spec written against the harness. Corrected.

Four `.skip`s remain, all new, all in `apps/api`, all Stage-2.5 future-state tests paired with an
active test pinning today's behaviour: `admin-key.guard.spec.ts` "A4 (correct)" and "A5/A7
(correct)"; `owner-role.guard.spec.ts` "O4 (correct)" and "O9 (correct)". Each requires a source
change that has not landed. They are correctly skipped and each is a bug report, in the same style
as run 1's four.

---

## 4. The five correctness fixes

All four of run 1's `.skip`ped bug reports are **fixed and un-skipped**. `packages/shared` and
`apps/worker` now have no skipped tests: `roles.test.ts` 7 cases, `enums.test.ts` 9,
`extraction.test.ts` 38, `leads.test.ts` 55, `crm-dispatch.test.ts` 22, all green.

### 4.1 The CRM confidence score

`crm-dispatch.ts` counted a fact as filled with `v !== null && v !== ""`.

```diff
- const filled = Object.values(facts).filter((v) => v !== null && v !== "").length;
+ const filled = Object.values(facts).filter(isFilled).length;
```

**Customer-visible consequence, before:** a whitespace-only string and the literal `"[]"` — the two
things a model most often emits for "not mentioned", and how `call_facts` stores an empty
`string[]` — counted as answers. A call that `qualifyLead` scored as **zero** filled fields was
delivered into the customer's CRM at `confidenceScore` **1.0**, the maximum. That number is rendered
into a CRM field and used by sales teams to triage, so it overstated precisely the leads that
deserved least trust. One definition of "the call said something" now, shared with `qualifyLead`.
`crm-dispatch.test.ts:283` un-skipped.

The same local test existed in `upsertLead`'s incoming-fact filter and was swapped to `isFilled`
too — there, a whitespace fact could overwrite a real budget established by an earlier call through
the jsonb `||` merge.

### 4.2 The silently-dry pipeline

`extraction.ts` compiled `field.enumValues ?? []`, so an enum field with no options became
`{ enum: [] }`.

```
+ .superRefine((field, ctx) => {
+   if (field.type === "enum" && (field.enumValues?.length ?? 0) === 0) { … }
+ })
```

**Before:** no value can satisfy an empty enum, so **every** call for that agent validated as failed,
and default lead rules treat a failed validation as "not a lead". One un-filled dropdown in the agent
editor and the tenant's lead board went silently dry — no error, no failed call, nothing arriving.
Now rejected where the author can still act on it, with the field named.
`extraction.test.ts:175` un-skipped.

**This fix is the one that needs a pre-deploy check** — the read-path half was written and not
wired. See §7 N1.

### 4.3 The year-5000 date

The datetime validator was `Number.isNaN(Date.parse(value))`, despite an error message promising ISO.

```diff
- if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
+ if (!isIsoDateTime(value)) {
```

**Before:** `Date.parse("5000")` succeeds. A model answering `quotation_date` with the *quantity*
validated cleanly and landed in the customer's CRM as **the year 5000**. The new check asserts the
shape first (date, optional time, optional fractional seconds, optional offset, space-or-`T`
separator per RFC 3339 §5.6) and uses `Date.parse` only to confirm the components are a real date, so
`2026-13-01` is rejected. Deliberately permissive about what models legitimately emit; a bare number
is not one of those things. `extraction.test.ts:331` un-skipped.

### 4.4 The role escalation

`resolveOwnerRole` now trims and lower-cases before parsing.

**Before:** `resolveOwnerRole("Telecaller")` → `"owner"` — a case variant of the *most restricted*
persona resolving to the *least* restricted. The `null` fail-open is deliberate and documented and
was left alone. `roles.test.ts:76` un-skipped.

**This does not close the HTTP-reachable path, and the report-11/12 framing of this bug was
incomplete.** `admin-key.guard.ts:95` parses `x-caller-owner-role` with a raw `OwnerRole.safeParse`,
so `Telecaller` still becomes `null` there — and `null` then takes `OwnerRoleGuard`'s admin-key
fail-open, which allows. Same escalation, different mechanism, still open. Two entry points, one
fixed. Pinned by the active O9 test with its skipped correct-behaviour sibling. See §7 N5.

### 4.5 The enum drift

```diff
  "COMPLETE",
+ "TRANSCRIPTION_OFF",
  "FAILED_TRANSCODE",
…
- export const CrmSyncStatus = z.enum(["pending", "synced", "failed"]);
+ export const CrmSyncStatus = z.enum(["pending", "synced", "failed", "dead"]);
```

**Before:** `enums.ts` described a state machine the worker does not have. `TRANSCRIPTION_OFF` is
written at `pipeline.ts:516`; `'dead'` is the *normal* terminal state of an exhausted CRM delivery,
written at `outbox.ts:92` and `:111`. Both feed `Call` in `entities.ts`. Latent, because nothing
parses a live row through `Call` — but it is the file every fixture author reaches for, and a fixture
built from it produces a test that passes while the code is wrong. The analyst checked the reverse
direction across all 11 exported unions plus every inline controller enum and found **no** value the
database would reject, so the fix is purely additive and cannot break a caller. Order matches
`0014:29-32` so the two read side by side in a diff, and `enums.test.ts` now asserts the unions
against the migration files themselves.

`UploadState` has no database counterpart at all — it is the Android client's local upload-queue
state. Leave it; a reviewer will otherwise try to reconcile it with `calls.status`.

---

## 5. Migration 0019

`packages/db/migrations/0019_hot_path_indexes.sql`, mirrored byte-identically to
`supabase/migrations/20260101000019_hot_path_indexes.sql` (verified with `diff`).

```sql
SET LOCAL lock_timeout = '5s';

CREATE INDEX IF NOT EXISTS transcripts_call        ON transcripts (call_id);
CREATE INDEX IF NOT EXISTS recordings_call         ON recordings  (call_id);
CREATE INDEX IF NOT EXISTS ai_outputs_call_created ON ai_outputs  (call_id, created_at DESC);
CREATE INDEX IF NOT EXISTS calls_org_started       ON calls       (org_id, started_at DESC);
CREATE INDEX IF NOT EXISTS calls_stuck_uploads     ON calls       (updated_at) WHERE status = 'UPLOADED';
```

**`CREATE INDEX CONCURRENTLY` is not compatible with this runner, and this was a blocker the
analyst caught before Dev D wrote a file that could not apply.** `packages/db/migrate.js:37-41`
wraps every migration in `BEGIN` / file / `INSERT INTO schema_migrations` / `COMMIT`. `CONCURRENTLY`
raises SQLSTATE 25001 inside a transaction block; the file would roll back, `migrate.js:44` would set
`exitCode=1` and break the loop, and 0019 would neither apply nor be recorded — with the operator
reading a transaction-block error rather than an index problem. `supabase db push` wraps a file the
same way, so the CLI is not an escape hatch. Making `CONCURRENTLY` available means teaching the
runner to run a nominated file outside a transaction, which changes its failure semantics (a
half-applied file stops being impossible). Not done, correctly.

**Safe to run against live Supabase today. Yes — with the caveats below.**

- Plain `CREATE INDEX` takes a SHARE lock: concurrent `SELECT`s are unaffected, concurrent
  `INSERT`/`UPDATE`/`DELETE` wait. Because all five run in the runner's single transaction, each
  lock is held until the final `COMMIT`, not released after its own statement — so the write stall
  spans `calls`, `recordings`, `transcripts` and `ai_outputs` simultaneously for the duration of the
  file.
- At current size (~150 calls platform-wide) every build is sub-millisecond and the whole file is a
  blip. **This is true now and will not stay true.** The file's own header says to re-read it before
  adding a sixth index; take that literally.
- `SET LOCAL lock_timeout = '5s'` is the right guard and only works inside a transaction. It is
  correct under `migrate.js` and under `supabase db push`. **If anyone runs this file through
  `psql -f` without `BEGIN`, `SET LOCAL` emits a warning and does nothing** — and a pending SHARE
  lock queues *ahead* of every writer that arrives after it, so one idle-in-transaction session
  turns this into a table-wide write stall for as long as that session lives. Do not apply it that
  way.
- Every statement is `IF NOT EXISTS`, so the remedy for a lock timeout is to re-run the migration
  once the blocker is gone. Never repair a partial apply — a partial apply is impossible here.
- Nothing changes a row, a column, a constraint or a plan's *correctness*. Rollback is
  `DROP INDEX` on five names; no data can be lost by applying it.

**Recommended apply procedure**

1. Apply it in the same deploy as §6's environment fixes, not separately — the API cannot start
   without `CRM_SECRET_KEY` regardless.
2. Before applying, check for long-lived transactions on the Supabase side:
   `SELECT pid, state, xact_start FROM pg_stat_activity WHERE state <> 'idle' AND xact_start < now() - interval '30s';`
   Terminate or wait out anything `idle in transaction`.
3. Apply through the normal path — `docker compose --profile setup run --rm migrate`, which runs
   `migrate.js` and then `bootstrap-role.js`. Do not hand-run the SQL.
4. On a lock-timeout failure the whole file rolls back and nothing is recorded. Re-run it.
5. Afterwards, confirm the two that matter most actually get used:
   `EXPLAIN` the Call Explorer list (expect `calls_org_started`, index scan, no sort) and
   `requeueStuckUploads`'s predicate (expect `calls_stuck_uploads`, not a seq scan).

**One thing 0019 deliberately does not do:** `transcripts_call` is not UNIQUE, even though
`persistTranscript` is DELETE-then-INSERT and one row per call is the intent. A unique index fails
the migration outright against any pre-existing duplicate, and whether production holds one cannot be
established without querying production. Uniqueness is a separate change that starts with a count.

---

## 6. ⚠️ Still blocking deploy

**Nothing this run changed any of it.** Restating report 12 §3 in short; that section remains the
authority.

| Blocker | Effect if deployed as-is | Fix |
|---|---|---|
| **`CRM_SECRET_KEY` absent from `platform/.env.production`** | `assertRequiredEnv()` throws at the first line of `bootstrap()`; `docker/node.Dockerfile` bakes `NODE_ENV=production`. **API crash-loops. Total outage, console and device ingest.** | `openssl rand -hex 32`, append to `.env.production` |
| **`PLATFORM_OPERATOR_EMAILS` absent** | `isOperator()` now fails closed. Every account, including yours, gets "No console access" at `/dashboard`, `/instances`, `/admin`. **Must ship in the same deploy as the code, not after.** | `PLATFORM_OPERATOR_EMAILS=support@sirahdigital.in`; runtime var, needs `up -d`, not a rebuild |
| **`SUPABASE_SERVICE_ROLE_KEY` absent** | Advisory in code (warn, not throw) but already broken in production: creating an owner sign-in throws `"Supabase Auth is not configured on the API"` today. `docker-compose.prod.yml` passes it nowhere | Rotate the `service_role` key first, then write the new value once |
| **Supabase: email signups still enabled** | The other half of the operator-console hole. The code stops a stranger becoming an operator; only the dashboard setting stops them getting an account. Also audit `auth.users` for rows you did not create | Authentication → Providers → Email → disable signups; confirm no other provider |

**Doc corrections Dev D did land** — both in the repo, both of them the wording that would otherwise
walk an operator straight back into the lockout:

- `platform/DEPLOYMENT.md` — `PLATFORM_OPERATOR_EMAILS` rewritten from "optionally restrict… blank
  means any signed-in non-owner does" to **blank means nobody**, with the reason (the anon key ships
  in the browser bundle, Supabase enables signup by default) and the ordering rule (same deploy as
  the code). Also: `CRM_SECRET_KEY` added to the secrets-to-generate list as `rand -hex 32`; a
  "The API refuses to start" paragraph naming all four fatal variables; §7's known-gaps list
  rewritten against the code as it now stands, with `JWT_SECRET`'s four remaining dev-fallback sites
  promoted to item 2 and the advisory nature of owner-role enforcement stated plainly; and the
  `migrate.js` description corrected to say each file is wrapped in its own `BEGIN`/`COMMIT`
  **"which is why no migration may use `CREATE INDEX CONCURRENTLY`"**.
- `platform/.env.production.example` — the same two blocks, plus `CRM_SECRET_KEY` marked REQUIRED
  with the crash-loop consequence named.

**Doc corrections Dev D did not land:** nothing in `Build docs/`. `11_DATA_INVENTORY.md` and
`12_STAGE0_EXECUTION_REPORT.md` were not opened this run. Report 12 §4.3's cross-tenant-write claim
is still wrong on disk — see N6.

---

## 7. New findings

Not in reports 11 or 12. N1 is this run's own regression risk and is the one to act on first.

**N1 — `StoredExtractionSchema` is dead code, and the strict enum rule now fires on the read path.
🔴 Check before deploying `packages/shared`.**
Dev C wrote `StoredExtractionSchema` precisely so a *stored* agent version with an optionless enum —
legal when it was saved, and agent versions are immutable — would degrade that field to an
unconstrained string instead of throwing. It is exported and **used nowhere**. Both read sites still
call the strict schema: `apps/worker/src/pipeline/pipeline.ts:354` and
`apps/api/src/modules/agents/agents.controller.ts:206`, both `ExtractionSchema.parse(agent.field_schema)`.
Consequences if any live agent version holds an optionless enum: the worker's parse now throws inside
the try that ends at `pipeline.ts:422` → `fail("ANALYZE")` → `FAILED_ANALYZE`, retried five times,
then retired with `next_attempt_at` NULL, i.e. **every call for that tenant stops at analyze instead
of completing with an empty extraction**; and the agent preview endpoint 500s on a zod throw rather
than 400ing. Before this run the same config produced `validation_status='failed'`, no lead, and a
COMPLETE call. Do one of two things before deploy: (a) count the affected rows —
`SELECT id, version FROM agents WHERE jsonb_path_exists(field_schema, '$.fields[*] ? (@.type == "enum" && (!exists(@.enumValues) || @.enumValues.size() == 0))');` — and if zero, ship as-is with the
gap recorded; or (b) swap both read sites to `StoredExtractionSchema`, which is the one-line change
the schema was written for. (b) is correct either way.

**N2 — `POST /v1/auth/logout` has no guard of any kind and runs a `DELETE` on the RLS-bypassing
admin pool.** `auth.controller.ts:87`, no `@UseGuards`, only the 100/min default bucket; the handler
reaches `auth.service.ts:160`, `DELETE FROM sessions`, on `adminPool()` — and `sessions` *does* carry
RLS, which the admin pool bypasses. It deletes by token hash, so it is not currently an arbitrary
delete, but it is an unauthenticated write against the privileged pool. Unchanged this run.

**N3 — `GET /v1/owner/overview` mounts `OwnerRoleGuard` and declares no `@RequireOwnerRole`, so the
guard is inert.** `OwnerController` gained the guard at class level; only
`PATCH /v1/owner/telecallers/:deviceId` declares roles. A telecaller persona reads the whole-org
dashboard. Pinned by the active O1 test, which asserts today's inertness. Unchanged this run.

**N4 — `DeviceAuthGuard` never validates `org_id` or `instance_id`.** `device-auth.guard.ts:40-41`
copies both off the JWT payload verbatim. An absent `org_id` reaches `withOrg(undefined, …)` (D9);
an `org_id` naming another tenant is accepted and the request is scoped to *that* tenant (D10), with
nothing re-read from the database. Device status is checked only inside each handler
(`calls.controller.ts:139`, `devices.controller.ts:232`), so a token minted before a logout or wipe
stays valid for its full 15 minutes and is refused by the handler, not the guard. **No test covers
any of this**, because the `DeviceAuthGuard` spec was not written.

**N5 — the case-variant escalation has two entry points and one was fixed.** Detailed in §4.4.
`admin-key.guard.ts:95` still uses the raw parse, so `x-caller-owner-role: Telecaller` → `null` →
`OwnerRoleGuard`'s admin-key fail-open → allowed. Fixing `roles.ts` alone does not close the
HTTP-reachable path; report 12 §5.1's "fix: lower-case and trim in the resolver" was necessary and
not sufficient. Also note the O9 spec's comment referring to "the skipped `roles.test.ts:76` case" is
now stale — that case is un-skipped and passing.

**N6 — report 12 §4.3's cross-tenant-write finding does not hold, and it is still on disk.** The
`UPDATE memberships … WHERE user_id = $1` at `members.controller.ts:127` runs inside `withOrg` →
`getPool()` → the `aura_app` role, created `NOBYPASSRLS` at `0001_init.sql:11-12`, against a table
carrying FORCE RLS with both `USING` and `WITH CHECK` on `org_id`. RLS narrows it to the current org;
an operator editing one tenant's member was **not** updating every org. The real, weaker finding is
zero defence in depth: the statement had no org predicate of its own, so one `adminPool()` import
slip creates exactly the described bug silently and with a 200. Dev D added `AND org_id = $5` on
that PATCH, on the sibling DELETE, and on both deletes in `DELETE /v1/owners/:userId` — the right
change for the right reason. **Correct report 12 §4.3 when someone next touches it.**

**N7 — the full list of `adminPool()` (RLS bypassed) sites with no `@CrossTenant()`.** From report
13, verified: `auth.service.ts:48` (login — structural, `users` has no `org_id`);
`auth.service.ts:160` (logout — N2); `devices.controller.ts:59` (register — structural, pre-enrollment);
`devices.controller.ts:164` (authenticate — structural but unthrottled, N8);
`owners.controller.ts:270` and `:280` (**intentional and correct** — "does this human hold a
membership in any *other* org" is genuinely cross-tenant; **do not add `@CrossTenant()`**, it would
unset `tenantOrgId` and break the `@OrgId()` calls in the same handler — add a comment);
`org-registry.service.ts:37` (guard-internal existence check, read-only).

**N8 — `POST /v1/devices/challenge` + `/authenticate` are an anonymous amplifier, confirmed against
the route table.** Both `@SkipThrottle()`. `/challenge` mints a valid HMAC nonce with no auth and no
DB. `/authenticate` runs a `devices JOIN instances` query on `adminPool()` at `:164` **before any
signature check**, plus an ECDSA verify per request. Unlimited anonymous admin-pool queries and CPU
from one source IP. Report 12 §5.3 called this; the route inventory confirms it and adds that the
query precedes the signature check. Pick a generous limit rather than none.

**N9 — `recordings:listen` is not enforced for any console user, and `recordings:export` is enforced
nowhere at all.** `GET /v1/calls/:id/audio` is the only route on the platform with a
`@RequirePermission`, and `PermissionsGuard` short-circuits on `viaAdminKey` — which every console
request is, because `server-api.ts` sends the admin key. The permission is real only for a
`Bearer aus_` session. `recordings:export` is declared in `PERMISSIONS` and required by no route:
dead metadata. Pinned by the active P3 test.

**N10 — no route on the platform writes `owner_role` to anything but `'owner'`.** 20 legal
`role` × `owner_role` combinations exist; only 5 are producible over HTTP, and
`POST /v1/owners` hardcodes `'owner'` (`owners.controller.ts:154`). The manager and telecaller halves
of the persona matrix are therefore exercised **only** by the caller-supplied `x-caller-owner-role`
header — the untrusted input. Any Stage 2.5 design that assumes personas come from the database
needs to create them there first.

**N11 — the outbox table is still named `crm_sync_log`.** Migration 0008 repurposed it in place and
never renamed it. A test written against `crm_dispatch_outbox` matches nothing and passes vacuously.
Caught while writing `setup.test.ts`; noted inline there.

**N12 — `docker-compose.test.yml`'s header claims a CI `integration` job that does not exist.**
`ci.yml` has exactly four jobs: static, unit, db, build. Either the job or the comment has to go, and
that call belongs with whoever finishes the suite. Adding a job for a suite with no pipeline tests
would be a green check that proves nothing — worse than the absent job.

**N13 — `.github/workflows/ci.yml` has no top-level `permissions:` block**, so `GITHUB_TOKEN` falls
back to the repository default, often read/write. The workflow needs no write scope anywhere. Minor
hardening gap. (Everything else about the workflow verified: valid YAML, only `db` declares
`services:`, its `DATABASE_URL`/`APP_DATABASE_URL` are job-scope `127.0.0.1` literals, zero
`secrets.*` references.)

**N14 — `eslint.config.mjs` enables two rules from plugins it never loads** (`jsx-a11y/media-has-caption`,
`@next/next/no-img-element`), which is why 2 of the 7 lint errors are "Definition for rule was not
found" and are unfixable from the files they point at. The error count can never reach zero until the
config is corrected. CI runs lint with `continue-on-error`, so nothing is gated.

---

## 8. Next

### Is Stage 2 safe to begin?

**Partly, and not the part that matters most. 2.1 and 2.2 may start now. 2.4 must not.**

The plan's own words: "Doing Stage 2 before Stage 1 is the single most expensive sequencing mistake
available here," and 2.4 — the web tier stops holding a root key — is flagged as the highest-risk
item in the document. The regression net that was supposed to make 2.4 survivable is the guard suite
*plus* the cross-tenant isolation loop. We have four fifths of the first and none of the second.

Concretely, 2.4 changes which credential each request carries and therefore which guard branch every
route takes. The failure modes it introduces are: a route that quietly stops being guarded, a route
that starts resolving the wrong tenant, and a device route that was never in the console's path at
all. **All three are invisible to the suite that exists**, because every case builds its own
`ExecutionContext` and no case asserts what is mounted where or issues a request for another
tenant's row.

- **2.1 Verify the Supabase JWT at the API — safe to start.** `AdminKeyGuard`'s session path has 8
  cases including the org-pinning assertion, and the skipped A5/A7 pair already encodes the intended
  end state. This is the branch that makes `resolveOwnerRole`'s fail-open reachable from a JWT
  claim, which is exactly why 4.4 was worth doing first.
- **2.2 Principal model v2 — safe to start.** `Principal` is a compile-time-only union today
  (`auth-principal.ts:8`); `AuthService.login:74` and `principalFromToken:151` assign `row.role`
  straight out of Postgres with no parse, safe only because a CHECK makes a bad row impossible. The
  guard suite pins every consumer of the current shape.
- **2.3 Scoped service credentials — renumber it.** The plan calls it migration `0019`; `0019` is
  now the index migration. It becomes `0020`, and everything downstream shifts one.
- **2.4 The web tier stops holding a root key — blocked.** Prerequisites, in order.
- **2.5 Owner roles as a real boundary — blocked on N5 and N3**, and note N10: the personas it is
  meant to enforce cannot currently be created in the database by any route.

### The honest next slice, in order

1. **`DeviceAuthGuard` spec** — the analyst's D1–D10 are written and the harness already exports
   `DEV_JWT_SECRET` and the deliberately-malformed `INSTANCE_A` for it. Half a day. This is the
   ingest path for every handset in production and it is the only guard with zero coverage.
2. **`tests/setup/processes.ts` + one end-to-end pipeline test** — `docker-compose.test.yml`,
   `env.ts` and `migrate.ts` all exist and are proven to work; what is missing is the thing that
   spawns `apps/api` and `apps/worker` from `dist/` against them. Until this lands, "integration
   tests" on this repo means "the harness tests the harness".
3. **The cross-tenant isolation loop**, driven off report 13's 75-route table rather than a
   hand-picked sample. This is the single highest-value test on the roadmap and the actual gate on
   2.4.
4. **Route-level guard-mounting assertions** — a small suite that walks the Nest route table and
   asserts each route's guard set matches report 13. Cheap, and it is what turns the existing 98
   unit cases into a real regression net.
5. **Then the CI `integration` job**, once there is something in it, and delete the false claim in
   `docker-compose.test.yml`'s header either way (N12).
6. **N1's count or one-line fix**, before `packages/shared` goes anywhere near production.
7. **1.6 staging**, which is still untouched and is what stops migration 0019 from being the fifth
   migration to reach production without ever having been applied anywhere else.

Stage 1's exit check — inject a bug into `qualifyLead`, a guard, and a migration, and watch CI catch
all three — should be run the day items 1–4 land. It has not been attempted, and today it would
fail on two of the three.

---

## 9. Verification log for this report

Everything below was executed by me for this document; nothing is taken on report.

| Command | Result |
|---|---|
| `pnpm -r typecheck` | 8/8 Done |
| `pnpm -r test` | 308 passed, 4 skipped, 0 failed (5 jest suites + 9 vitest files) |
| `pnpm tenancy:check` | `tenancy check OK — no handler resolves its own org` |
| `pnpm lint` | 33 problems (7 errors, 26 warnings); 26 auto-fixable `import/order` |
| `node --check packages/db/migrate.js` | OK (syntax only — never executed) |
| `diff` of 0019 canonical vs Supabase mirror | identical |
| `grep` for `.skip` across all spec/test files | 4, all in `apps/api`, all Stage-2.5 future-state |
| `git status` + per-file mtimes | used to attribute this run's changes; `Build docs/08`, `/11`, `/12` untouched since 17:34 |

`pnpm test:integration` was **not** re-run for this report — it requires bringing a docker stack up,
which this role does not do. Its 18/18 result is the integration pass's, recorded as theirs.

No database connection was opened, no env file was read, no docker command was run, and nothing was
committed.
