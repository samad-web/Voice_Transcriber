# 08 — Road to 10/10

**Written 2026-08-06**, from a code audit of `platform/` and `CallRecorderApp/` at branch
`crm-connectors-and-console-auth`.

This plan supersedes `06_HARDENING_PLAN.md` as the live tracking document. Everything in 06 that
is still real is carried here with its original section number in brackets, so the two can be
read together — but 06's two deliberate exclusions (**automated testing/CI** and **the Android
app**) are *included* here, because they are now the largest remaining gaps and the platform has
live customers.

It also positions `ceo-dashboard-build-prompt-v2.md` — that spec is good and is kept, but it is
**Stage 5**, not Stage 0. Building two XL modules on the current foundation would make the
product broader and the business more fragile at the same time.

---

## 0. What "10/10" means

A number with no rubric is a mood. These are the six dimensions from the audit, with a testable
definition of done for each. **The plan is finished when every "10/10" cell is true, provable,
and does not depend on any one person being awake.**

| Dimension | Today | 10/10 means | Stage |
|---|---|---|---|
| **Architecture & design** | 8 | Same design, plus: one identity system, no root credential, no default tenant, provider failover, no hand-copied tenancy patterns. | 2, 3 |
| **Security & auth** | 3 | The API proves identity itself. No credential grants cross-tenant access implicitly. Every role check is server-enforced. Every cross-tenant read is audited. A pentest finds nothing above Medium. | 0, 2 |
| **Engineering discipline** | 2 | Every push runs typecheck + lint + unit + integration + RLS/tenancy invariants in CI. >70% coverage on `packages/shared`, `packages/db`, worker pipeline, and every API guard. No merge to `main` without green. | 1 |
| **Operations & reliability** | 3 | Staging exists and is on the deploy path. Recordings replicated off-box with a **tested** restore. p95 latency, queue depth, pipeline failure rate and LLM spend all alerted. 99.5% monthly uptime measured, not asserted. Any secret recoverable from a vault. | 1, 3, 6 |
| **Feature completeness** | 7 | Every tenant is provisioned complete and cannot be live-but-inert. Owner console answers the four questions in the v2 spec. Erasure is complete across CRM and per-subject. | 4, 5 |
| **Business readiness** | 2 | A customer can be quoted, provisioned, metered, invoiced, limited, and offboarded without you touching a terminal. DPA + privacy policy + consent evidence exist. 10+ paying tenants. | 4, 6 |

### The three rules this plan runs on

1. **No new customer-facing module ships before Stage 4 completes.** The v2 owner-console spec is
   the reward for a solid foundation, not a substitute for one.
2. **Every stage ends with a written exit check that someone else could run.** If it can't be
   verified by a second person, it isn't done.
3. **Nothing is "verified" by having been manually curled once.** From Stage 1 onward, verified
   means a test in CI.

---

## Stage 0 — Emergency (this week, ~2 days)

Nothing here is a feature. All of it is "the platform is currently exposed or one disk failure
from unrecoverable." Do it before writing another line of product code.

### 0.1 Close the operator-console hole 🔴 **highest priority in this document**

**The problem.** [`apps/web/lib/owner-context.ts`](../platform/apps/web/lib/owner-context.ts)
`isOperator()` returns `true` for any signed-in user holding **zero memberships** when
`PLATFORM_OPERATOR_EMAILS` is unset — and it is unset in production. `NEXT_PUBLIC_SUPABASE_ANON_KEY`
ships in the browser bundle, and Supabase enables `/auth/v1/signup` by default. So the full chain
is: stranger self-signs-up against the public anon key → signs in at the console → middleware
passes → `(platform)` layout finds no membership → `isOperator()` true → **every tenant's calls,
transcripts and recording audio.**

**Do all four, in this order:**

1. Supabase dashboard → Authentication → Providers → Email → **disable signups**. Also confirm no
   other provider (Google, magic link) is enabled.
2. Invert the default in `isOperator()`: an **empty** `PLATFORM_OPERATOR_EMAILS` must mean *nobody
   is an operator*, not *everybody*. Fail closed.
3. Set `PLATFORM_OPERATOR_EMAILS=support@sirahdigital.in` in `.env.production` and redeploy.
4. Query `auth.users` on Supabase and confirm the only rows are accounts you created. If there are
   others, treat as an incident: rotate, audit `audit_log`, and check MinIO access logs.

**Exit check.** A freshly created Supabase account, signed in, sees the "No console access" card
and nothing else. Verified by actually creating one and then deleting it.

### 0.2 Kill the `dev-admin-key` fallback 🔴

[`admin-key.guard.ts:36`](../platform/apps/api/src/common/admin-key.guard.ts) and
[`server-api.ts:9`](../platform/apps/web/lib/server-api.ts) both do
`process.env.ADMIN_API_KEY ?? "dev-admin-key"`. A single missing env var in production — a typo, a
compose file run without `--env-file`, a new container — turns a hardcoded string into a working
root credential for the open internet.

* Add a `config/assert-env.ts` that runs first in `main.ts` and in the web's `instrumentation.ts`.
  In `NODE_ENV=production` it **throws** if `ADMIN_API_KEY`, `JWT_SECRET`, `CRM_SECRET_KEY`,
  `APP_DATABASE_URL` or `SUPABASE_URL` are unset or equal to a known dev default. A crashed
  container is a far better outcome than an open one.
* Keep the dev default *only* when `NODE_ENV !== "production"`.

### 0.3 Rotate the exposed secrets

The Supabase DB password and `service_role` key were pasted into a chat transcript on 2026-07-22
and have not been rotated. `ADMIN_API_KEY` should be assumed stale for the same reason.

* Rotate the Supabase DB password → re-run `bootstrap-role.js` **and** update `APP_DATABASE_URL`
  in the same change (they are one atomic operation; see `DEPLOYMENT.md` §8).
* Rotate the `service_role` key. Nothing in this stack uses it except owner provisioning — verify
  `apps/api/src/modules/owner/` picks up the new value.
* Switch the Supabase **Data API off entirely** — there is no PostgREST client here, so it is pure
  attack surface.
* Rotate `ADMIN_API_KEY`; update the VPS `.env.production` and every provisioning script.

### 0.4 Back up the recordings, and prove the restore

`miniodata` is one volume, on one disk, on one VPS, holding **every recording every customer has
ever made**. Postgres is covered by Supabase. This is not.

* Create a Backblaze B2 bucket (~$0.006/GB/month — this is a rounding error at your volume).
* Nightly systemd timer on the VPS running `mc mirror --overwrite --remove` from MinIO to B2.
* Enable object versioning on the B2 bucket so a bad mirror can't propagate a deletion.
* **Restore one recording from B2 to a scratch path and play it.** Write the exact commands into
  `DEPLOYMENT.md` §8. An untested backup is a hypothesis, not a backup.

### 0.5 Get eyes on production

You discovered that Gemini credits were exhausted — and that live transcription had been failing
for an unknown period — by reading worker logs by hand. That is the failure this fixes.

* **Sentry** (free tier) in `apps/api`, `apps/worker` and `apps/web`. 30 minutes of work.
* **UptimeRobot** (free) on `GET /v1/health` and on the web `/login`.
* One worker cron that posts a daily summary to email/Telegram: calls ingested, calls COMPLETE,
  calls `FAILED_*` with `next_attempt_at IS NULL`, CRM deliveries pending, devices silent >24h.
  Crude, ten lines, and it would have caught the Gemini outage on day one.

### 0.6 Secure the secrets that cannot be regenerated

`CRM_SECRET_KEY` seals every stored CRM credential and is **unrecoverable**. The Android release
keystore (`CallRecorderApp/aura-release.jks`) is described in project notes as *this machine only* —
losing it means you can never ship an app update again, for any device, ever.

Both into a password manager (1Password/Bitwarden) today, plus an encrypted offline copy. Record
the recovery path in `DEPLOYMENT.md`.

### 0.7 Basic HTTP hardening

[`main.ts`](../platform/apps/api/src/main.ts) is 15 lines with no protections at all.

```ts
app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
```
plus `@nestjs/throttler`: 5/min on `/v1/auth/login`, 10/min on `/v1/devices/enroll`, 100/min
default. Tighten CORS to an explicit origin list rather than a single `WEB_ORIGIN`.

### 0.8 Make Fortune Innovatives produce something

It has been live since 2026-07-27 with no extraction agent and no CRM connector, so its calls
transcribe into a void — half your customer base receiving zero value. Give it an agent and a
connector, or record explicitly that it is transcription-only. §4.2 makes this structurally
impossible to repeat.

**Stage 0 exit check:** a written incident-readiness note answering — can a stranger reach customer
data? (no, proven) · can we lose recordings? (no, restore tested) · will we know within an hour if
the pipeline stops? (yes, alert fired in a drill) · can we ship an Android update if this laptop
dies? (yes, keystore in vault).

### Run log — 2026-08-06

Full report: [`12_STAGE0_EXECUTION_REPORT.md`](12_STAGE0_EXECUTION_REPORT.md). Tree typechecks
clean (8/8 projects), `pnpm -r test` green (196 passed / 4 skipped). **Not deployable without the
env changes in §3 of that report** — two changes fail closed on variables absent from
`platform/.env.production`.

| Item | State | Note |
|---|---|---|
| 0.1 Close the operator-console hole | 🟡 **partial** | Step 2 done — `isOperator()` fails closed, plus new gates on `(admin)` (had no layout at all) and `(platform)`. Steps 1, 3, 4 outstanding: **Supabase email signups are still enabled**, `PLATFORM_OPERATOR_EMAILS` is still unset in production (deploying the code without it locks the operator out), `auth.users` not yet audited. |
| 0.2 Kill the `dev-admin-key` fallback | 🟡 **partial** | API done: `resolveAdminKey()` returns `null` in production + `config/assert-env.ts` throws at boot. Web done via `instrumentation.ts` (also asserts `AUTH_ENABLED`). **Not** done: the literal still sits at `apps/web/lib/server-api.ts:10`, and `JWT_SECRET ?? "dev-jwt-secret-change-me"` remains at 4 sites (`device-auth.guard.ts:33`, `device-nonce.ts:5`, `devices.controller.ts:193`, `erasure.controller.ts:97`). |
| 0.3 Rotate the exposed secrets | ⬜ **untouched** | Ops. Also: `SUPABASE_SERVICE_ROLE_KEY` is absent from `.env.production`, so owner sign-in provisioning is broken in production **today**. Set it as part of the `service_role` rotation. |
| 0.4 Back up the recordings, prove the restore | ⬜ **untouched** | The only Stage 0 item whose downside is permanent. |
| 0.5 Get eyes on production | ⬜ **untouched** | Note `apps/web/instrumentation.ts` now exists — the right place for the Next Sentry SDK. |
| 0.6 Secure the unregenerable secrets | ⬜ **untouched** | `CRM_SECRET_KEY` must be **generated** first (§3 of the report) and vaulted the same hour. |
| 0.7 Basic HTTP hardening | 🟢 **done** | `helmet()`, 1 MB JSON body limit, `trust proxy 1`, CORS as a comma-separated allowlist (`config/cors.ts`), `@nestjs/throttler` 100/min default + 5/min login + 10/min device register. Two deviations recorded in the report §5.3. **`ValidationPipe` deliberately not added** — `class-validator` is not a dependency and 19 controller modules validate with zod, so it would be inert. Strike it from this item. |
| 0.8 Make Fortune Innovatives produce something | ⬜ **untouched** | |

---

## Stage 1 — Make change safe (weeks 2–5, ~3 weeks)

**This is the stage that changes the trajectory.** Right now, 8,000 lines of TypeScript and 5,000
of Kotlin have zero automated verification. Every refactor in Stages 2–5 is a coin flip until this
lands, and Stage 2 in particular rewrites the authentication layer of a system with live customers.

Doing Stage 2 before Stage 1 is the single most expensive sequencing mistake available here.

### 1.1 Tooling floor

* **ESLint** (`typescript-eslint` + `eslint-plugin-import`) and **Prettier**, one config at the
  monorepo root, `pnpm lint` / `pnpm format:check`.
  * Configure Prettier with `endOfLine: "lf"` and add a `.gitattributes` with `* text=auto eol=lf`.
    The repo currently has **mixed CRLF/LF line endings** (analytics/calls/crm/tenancy controllers
    are CRLF, most others LF), which has already cost a debugging cycle when a codemod regex
    anchored on `";\n` silently skipped every CRLF file.
* **Vitest** as the test runner for `packages/*` and `apps/worker`; **Jest** (NestJS default) for
  `apps/api` so `@nestjs/testing` works without friction.
* A `test` script in every package, and `pnpm -r test` at the root.

### 1.2 Unit tests — target the pure logic first

Highest value per hour, because it is pure, deterministic and load-bearing:

| Target | Why it matters |
|---|---|
| `packages/shared/src/leads.ts` `qualifyLead` | Decides whether a call becomes a lead. Silent wrongness here loses revenue invisibly. |
| `packages/shared/src/roles.ts` `resolveOwnerRole` | New, uncommitted, and about to become an authorization input. |
| Agent schema compiler (`@aura/shared`) | Compiles tenant config into a provider `responseSchema`. Malformed output breaks extraction for a whole tenant. |
| `retryBackoffSeconds` in `apps/worker/src/pipeline/pipeline.ts` | 30s→2m→8m→32m→cap. Off-by-one here means either hammering a dead provider or never retrying. |
| `packages/db/src/secrets.ts` seal/unseal | AES-256-GCM round-trip, plus the "unset key ⇒ plaintext + warn" branch. |
| OEM filename parser (`OemRecordingIngestor`, Kotlin) | Three OEM formats already, each learned from a production break. Regression-prone by nature. |
| `packages/llm` response parsing | Provider JSON → typed facts, including the malformed-response path. |

### 1.3 Integration tests — the pipeline and the guards

Spin real Postgres + RabbitMQ + MinIO via **Testcontainers** (or a dedicated
`docker-compose.test.yml`), run migrations, seed, and exercise:

* **The full pipeline**, with `ASR_STUB=1 ANALYZE_STUB=1`: create call → presigned upload →
  UPLOADED → transcode → asr → analyze → lead projection → CRM dispatch → COMPLETE.
* **Failure and retry**: force an S3 `NoSuchKey`, assert `FAILED_ASR` + `next_attempt_at` set,
  assert the sweeper claims it, assert the backoff escalates, assert it retires at
  `PIPELINE_MAX_ATTEMPTS` with `next_attempt_at` NULL.
* **`TRANSCRIPTION_OFF`**: assert zero rows in `transcripts`, `ai_outputs`, `leads` and
  `crm_sync_log`, but the call listed and `/audio` still 200.
* **Every guard**, as a table-driven suite — this is the regression net for all of Stage 2:
  `AdminKeyGuard`, `TenantGuard`, `PermissionsGuard`, `OwnerRoleGuard`, `DeviceAuthGuard`.
  Each with: valid, absent, malformed, wrong-tenant, and expired credentials.
* **Cross-tenant isolation**, asserted directly: tenant A's session/key must receive 404 or empty
  for every one of tenant B's calls, leads, agents, devices, workspaces and audio URLs. Loop it
  over the whole route table, not a sample.

The six scratchpad e2e suites (`test-pipeline`, `test-agents`, `test-compliance`,
`test-device-auth`, `test-endpoints`, `test-management`) already encode most of this knowledge.
**Move them into `platform/tests/` and make them run in CI** — they are currently outside the repo
and therefore not durable, not versioned, and not run unless remembered.

### 1.4 CI — GitHub Actions

`.github/workflows/ci.yml`, on every push and PR, Node 22 (matching `docker/node.Dockerfile`):

```
lint → typecheck → unit → integration (services: postgres, rabbitmq, minio)
     → pnpm tenancy:check
     → pnpm --filter @aura/db verify:rls
     → docker build (node + web images)
```

`pnpm tenancy:check` **exists and is still not wired into any build** — that has been true since
2026-07-29. Wire it now; it is a two-line change that enforces a real invariant.

Add a second workflow that builds the Android debug APK and runs its unit tests, so the Kotlin side
stops being verified only by a human installing an APK.

Branch protection on `main`: no merge without green.

### 1.5 Extend the RLS invariant check [06 §1.9]

`packages/db/verify-rls.js` checks **six known tables**. There are 25+ with `org_id`. A new table
added without a policy passes today.

Rewrite it to enumerate `information_schema.columns` for every table carrying `org_id` and fail if
any lacks `FORCE ROW LEVEL SECURITY` or an `org_isolation` policy. Run it in the `migrate`
container after every migration, so **a bad migration fails the deploy instead of leaking
silently**, and in CI against the ephemeral Postgres.

### 1.6 Staging [06 §4.3]

Migrations 0011–0014 went straight to production Supabase. That has worked four times, which is
exactly how much evidence you have.

* A second Supabase project (`aura-staging`).
* A second compose stack on the same VPS, distinct compose project name, distinct domain
  (`staging.aura.sirahagents.com`), its own MinIO volume.
* Deploy path becomes **staging → verify → production**, and that becomes the documented default
  in `DEPLOYMENT.md`.
* A seed script that populates staging with synthetic tenants and calls. **Never copy production
  audio into staging** — that would put real customer voice recordings in a lower-trust
  environment and undo the compliance story.

**Stage 1 exit check:** a deliberately introduced bug in `qualifyLead`, in a guard, and in a
migration each fail CI *before* a human notices. Prove it by actually injecting all three — the
same technique already used to prove `check-tenancy.js` was non-vacuous.

### Run log — 2026-08-06

Full report: [`12_STAGE0_EXECUTION_REPORT.md`](12_STAGE0_EXECUTION_REPORT.md).

| Item | State | Note |
|---|---|---|
| 1.1 Tooling floor | 🟢 **done** | ESLint flat config + Prettier (`endOfLine: "lf"`) at `platform/`, `/.gitattributes` with `* text=auto eol=lf`, Vitest + `test`/`test:watch` in `packages/{shared,db,llm}` and `apps/worker`, `pnpm -r test` at the root. **Jest for `apps/api` not set up** — zero API tests exist, which is why 1.3's guard suite has no home yet. Lint baseline: 32 problems (7 errors, 25 auto-fixable warnings), all 7 errors in files nobody touched this run; `prettier --check` reports 97 files. Both CI steps are `continue-on-error` pending a cleanup pass. **`.gitattributes` will renormalise any CRLF file staged alongside it — land it as its own commit on a quiet tree.** |
| 1.2 Unit tests — pure logic | 🟡 **partial** | 200 cases, 196 green. Covered: `qualifyLead` (+ `isFilled`, `parseLeadRules`, `parseLeadStages`, `entryStage`, `statusForStage`, `mergeFacts`), `resolveOwnerRole`, `validateExtraction`/`compileToJsonSchema`, `retryBackoffSeconds`, `reasonOf`, `leadTitle`, `mapFields`/`mapPayload`/`confidenceScore`, `secrets.ts` seal/unseal incl. the unset-key branch, `packages/llm` response parsing + retry. **Not covered:** the Kotlin `OemRecordingIngestor` parser (Android A1). Four tests are `.skip`ped **as bug reports**, each paired with a passing test pinning today's wrong behaviour — CRM `confidenceScore` reports 1.0 on zero filled facts; an enum field with no options can never validate; `Date.parse` accepts `"5000"` as a datetime; `resolveOwnerRole` escalates case variants to `owner`. Details in report §5.1. |
| 1.3 Integration tests | ⬜ **untouched** | The guard suite and the cross-tenant route loop do not exist. **This is the hard gate on Stage 2** — 2.4 rewrites auth on a system with live customers. |
| 1.4 CI — GitHub Actions | 🟡 **partial** | `.github/workflows/ci.yml`: `static` (lint, format, typecheck, `pnpm tenancy:check` — now wired into a build for the first time since 2026-07-29), `unit`, `db` (migrations + `verify:rls` against an ephemeral `postgres:16-alpine`, zero `secrets.*` references), `build` (both images). **Missing:** the `integration` job and its rabbitmq/minio services, the Android debug-APK workflow, and branch protection on `main`. |
| 1.5 Extend the RLS invariant check | 🟡 **partial** | `verify-rls.js` rewritten: derives every `org_id` table from `information_schema.columns` and fails **by name** on any lacking FORCE RLS or a policy; asserts `WITH CHECK` and not just `USING`; handles `organizations`/`org_self` as its named special case; two-entry reviewed allowlist (`users`, `schema_migrations`); asserts `usage_events` UPDATE/DELETE denial and that the live CHECKs contain `TRANSCRIPTION_OFF` and `'dead'`. Added `assertDisposable()` — the script previously ran `DELETE FROM organizations WHERE name LIKE 'rls-test-%'` against whatever `DATABASE_URL` was exported. **The "run it in the migrate container" half is structurally blocked**: production is Supabase, so the guard refuses, and the only override re-enables the destructive path against live data. Needs a read-only `verify:rls:structural` split — see report §5.2. |
| 1.6 Staging | ⬜ **untouched** | |

**Note on 1.2's source of truth:** `packages/shared/src/enums.ts` is out of sync with two live CHECK
constraints (`CallStatus` missing `TRANSCRIPTION_OFF`, `CrmSyncStatus` missing `'dead'`). Fixtures
were sourced from the constraints, not from that file, and `verify-rls.js` now fails CI on the drift
— but **the file itself is still wrong** and is the one anyone will reach for next. Fix before 2.1.

### Run log — 2026-08-06 (run 2)

Full report: [`14_STAGE1_EXECUTION_REPORT.md`](14_STAGE1_EXECUTION_REPORT.md). Re-verified for that
report: `pnpm -r typecheck` 8/8, `pnpm -r test` **308 passed / 4 skipped / 0 failed**,
`pnpm tenancy:check` OK, `pnpm lint` 33 problems (7 errors, 26 warnings). No reviewer returned a
verdict on any of the four partitions — treat every "done" below as *passing its own tests*, not as
*reviewed*.

| Item | State | Note |
|---|---|---|
| 1.1 Tooling floor | 🟢 **done** | Jest + `ts-jest` + `@types/jest` + `@nestjs/testing` and `apps/api/jest.config.js` now exist, closing run 1's last 1.1 gap — **added by the integration pass, not by the partition that wrote the specs against them.** Also added: `apps/{api,worker}/tsconfig.build.json` excluding `*.spec.ts`/`*.test.ts`, which stops 24 test artifacts shipping inside the production image (they would fail a `--prod` install at require time). |
| 1.2 Unit tests — pure logic | 🟢 **done** | **All four `.skip`ped bug reports fixed and un-skipped.** `confidenceScore` now uses `isFilled` (a zero-fact call no longer reaches a customer's CRM at confidence 1.0); an optionless enum is rejected at save time (a tenant's lead board no longer goes silently dry); `isIsoDateTime` replaces bare `Date.parse` (no more year-5000 quotation dates); `resolveOwnerRole` trims and lower-cases. `enums.ts` fixed: `CallStatus` += `TRANSCRIPTION_OFF`, `CrmSyncStatus` += `'dead'`, asserted against the migration files by `enums.test.ts` — the "Note on 1.2's source of truth" above is now closed. Still not covered: the Kotlin `OemRecordingIngestor` (Android A1). **Caveat:** `StoredExtractionSchema`, written so the new enum rule would not fire on agent versions saved before it, is exported and wired into neither read path — see report 14 §7 N1 before deploying `packages/shared`. |
| 1.3 Integration tests | 🟡 **partial** | **Guard suite: 4 of 5 guards, 98 cases** (`AdminKeyGuard` 26, `TenantGuard` + `@OrgId()` 13, `PermissionsGuard` 12, `OwnerRoleGuard` 12, plus a self-tested shared harness). 4 new `.skip`s, each a Stage-2.5 bug report paired with a test pinning today's behaviour. **`DeviceAuthGuard` has no spec at all** — six routes including the whole device ingest path. **Nothing asserts which guards are mounted on which route**, because every case builds a synthetic `ExecutionContext`: unmounting a guard from a controller ships green. `docker-compose.test.yml`, `tests/setup/env.ts` and `tests/setup/migrate.ts` landed and were **executed for the first time** (18/18 green: the safety guards genuinely refuse production and the dev stack, 19 migrations apply and are idempotent, every `org_id` table has FORCE RLS + a policy, both live CHECKs match the zod enums). But `tests/setup/processes.ts` does not exist, **no API or worker process is spawned by anything**, and the pipeline suite, the `TRANSCRIPTION_OFF` suite, the retry/retirement suite and the cross-tenant isolation loop have zero coverage. **Still the hard gate on 2.4.** |
| 1.4 CI — GitHub Actions | 🟡 **partial** | Unchanged. No `integration` job (correctly — there is nothing to run), no Android workflow, no branch protection. `docker-compose.test.yml`'s header claims an `integration` job that does not exist; delete the claim or add the job. Also: no top-level `permissions:` block, so `GITHUB_TOKEN` takes the repo default. |
| 1.5 Extend the RLS invariant check | 🟡 **partial** | No code change. Now *provable on a laptop*: `tests/setup.test.ts` asserts the same invariant against a real ephemeral schema, so the structural half no longer depends on pointing the destructive script at something. The `verify:rls:structural` split for the migrate container is still unowned. |
| 1.6 Staging | ⬜ **untouched** | Migration 0019 will be the fifth to reach production having been applied nowhere else first. |
| **Migration 0019** | 🟢 **landed** | `0019_hot_path_indexes.sql`, five indexes, mirrored byte-identically to `supabase/migrations/`. **`CREATE INDEX CONCURRENTLY` is impossible under `migrate.js`** — it wraps every file in `BEGIN`/`COMMIT` and `CONCURRENTLY` raises SQLSTATE 25001 inside one, so the file would neither apply nor be recorded; `supabase db push` wraps the same way. Plain `CREATE INDEX` + `SET LOCAL lock_timeout='5s'` + `IF NOT EXISTS` throughout. Safe at current size (~150 calls) and **not** safe by the time `calls` is in the millions. Apply through `--profile setup run --rm migrate`, never `psql -f` (`SET LOCAL` outside a transaction is a no-op). Note the plan's own §2.3 "migration 0019" must renumber to 0020. |
| **Defence-in-depth `org_id` predicates** | 🟢 **landed** | `PATCH`/`DELETE /v1/members/:userId` and both deletes in `DELETE /v1/owners/:userId`. Report 12 §4.3's claim that the members PATCH was a *reachable* cross-tenant write **does not hold** — RLS on the `NOBYPASSRLS` `aura_app` role already narrowed it; the real finding was that one `adminPool()` slip would have made it true silently. Report 12 is uncorrected on disk. |
| **0.2 web-tier `dev-admin-key` literal** | 🟢 **landed** | `apps/web/lib/server-api.ts` now mirrors the API's `resolveAdminKey()` — empty string under `NODE_ENV=production`, which no configured key can equal. This was the one Stage 0 §0.2 item report 12 recorded as **not landed**. |
| **Deploy-doc corrections** | 🟢 **landed** | `DEPLOYMENT.md` + `.env.production.example`: `PLATFORM_OPERATOR_EMAILS` rewritten to "blank means **nobody**", `CRM_SECRET_KEY` marked REQUIRED with the crash-loop consequence, the four fatal boot variables named, §7's known-gaps list rewritten against current code, and the `CONCURRENTLY` prohibition recorded at the runner. **Nothing in `Build docs/` was corrected.** |

**Still blocking deploy, unchanged by this run:** `CRM_SECRET_KEY` (API crash-loops without it),
`PLATFORM_OPERATOR_EMAILS` (console lockout), `SUPABASE_SERVICE_ROLE_KEY` (owner provisioning
already broken in production), and disabling Supabase email signups. See report 12 §3.

**Stage 2 gate:** 2.1 and 2.2 may begin. **2.4 may not** — it changes which credential every request
carries, and its three failure modes (a route quietly unguarded, a route resolving the wrong tenant,
a device route nobody modelled) are all invisible to the suite that exists. Prerequisites, in order:
the `DeviceAuthGuard` spec, `tests/setup/processes.ts` + one end-to-end pipeline test, the
cross-tenant isolation loop over report 13's 75-route table, and route-level guard-mounting
assertions. **Stage 1's exit check has not been attempted and would fail two of its three injections
today.**

### Run log — 2026-08-07 (run 3, closeout)

Full report: [`15_STAGE1_CLOSEOUT.md`](15_STAGE1_CLOSEOUT.md). Two developers (the deploy-blocking
build regression · triage of the four failing isolation cases), one adversarial security audit of
the regression net, one integration pass that executed every gate. Measured for that report:
`pnpm -r typecheck` **8/8**, `pnpm -r test` **377 passed / 7 skipped / 0 failed**,
`pnpm tenancy:check` OK, `pnpm test:integration:only` **141 passed / 0 failed of 141**,
`NEXT_SKIP_STANDALONE=1 pnpm -r build` **exit 0, 8/8**.

| Item | State | Note |
|---|---|---|
| 1.1 Tooling floor | 🟢 **done** | Unchanged. Plus `apps/web` gains a `lint` script (`eslint . --max-warnings=0`) so that app has a hard gate invocable on its own. |
| 1.2 Unit tests — pure logic | 🟢 **done** | Unchanged at 377/7/0. **N1 still open** — `StoredExtractionSchema` is wired into neither read path; do the count or the one-line swap before `packages/shared` ships. Kotlin `OemRecordingIngestor` (Android A1) still uncovered. |
| 1.3 Integration tests | 🟢 **done for the API tier** | **The isolation loop exists, executes, and is green: 57 routes, 54 asserting both directions, 3 excluded with printed reasons, 0 single-direction, 141 cases.** `tests/setup/processes.ts` spawns the API; `DeviceAuthGuard` now has a spec (D1–D10, with D10's correct behaviour skipped as a bug report); `guard-mounting.spec.ts` reflects Nest's own `__guards__` metadata and asserts guard *indices*, so unmounting a guard no longer ships green. Four failing cases triaged to root cause and fixed — two source defects, two wrong expectations (§3 of report 15). **Scope caveat that decides the Stage 2 gate: the loop covers the API only.** `apps/web` is never started by any harness and has zero test files; the pipeline/`TRANSCRIPTION_OFF`/retry-retirement suites still do not exist; all 141 cases authenticate via the admin key, which leaves `PermissionsGuard` and `OwnerRoleGuard` inert for the whole run and gives the session credential — the one 2.4 adopts — 5 route shapes of 57. |
| 1.4 CI — GitHub Actions | 🟡 **partial** | **No change, and it now costs more.** Still four jobs (`static`, `unit`, `db`, `build`); `grep -c integration ci.yml` returns 0, so the 141-case net blocks no merge. `next build` no longer lints (`eslint: { ignoreDuringBuilds: true }`) while the Lint step is still `continue-on-error: true`, so a new `apps/web` ESLint error is caught by **nothing**. Repo-wide lint is 0 errors / 55 warnings, so the flag can simply be deleted. No Android workflow, no branch protection, no top-level `permissions:` block. |
| 1.5 Extend the RLS invariant check | 🟡 **partial** | Unchanged. The `verify:rls:structural` split for the migrate container is still unowned. |
| 1.6 Staging | ⬜ **untouched** | Unchanged. Migration 0019 will still be the fifth to reach production having been applied nowhere else. |
| **Deploy-blocking build regression** | 🟢 **fixed** | `pnpm --filter @aura/web build` exits 0. The seven ESLint errors are gone — five promise defects fixed at source (two were real: a rejected clipboard write left a one-shot secret marked COPIED; a rejected poll froze the call drawer), two unregistered-rule disables removed since the plugins do not exist in the workspace. Lint is deliberately no longer a build gate. Survived two prior runs because both integration passes skipped `next build` under the `.env.local` rule — **and that rule's premise is wrong: a Next build here does reach live production over the network.** `pnpm -r build` still exits 1 on Windows during the standalone trace copy (`EPERM … symlink`), pre-existing, environmental, after compile and typecheck succeed; CI's `build` job is the only real confirmation. |
| **#66 erasure receipt** | 🟢 **fixed** | **The platform minted an HMAC-signed, hashed `COMPLETED` erasure receipt for a call in another tenant.** RLS meant nothing was purged, but a signed, unretractable attestation of erasure was issued for a resource the caller does not own — on the feature customers are told to rely on for GDPR/DPDP — and written to the append-only ledger as `erasure.complete`. Now 404s before any DELETE and before anything is signed. **Erasure is no longer idempotent** — release-note it. |
| **#28 reprocess-backlog** | 🟢 **fixed** | One audit `INSERT` reused `$1` for a uuid and a text column; Postgres aborted the statement and rolled back the shared transaction, so the endpoint had been 500ing on every request that matched a call. It now works in production for the first time — and it really does re-run ASR/analyze and fire CRM dispatch. |
| **#40 retry-dead** | 🟢 **test corrected** | Asserted 200; there is no `@HttpCode` anywhere in `apps/api/src`, so every POST answers 201. The route was correct. Its adjacent real defect — an unconditional `crm.retry_dead` audit row for a nonexistent integration — is open. |
| **Security audit of the net** | 🔴 **`NET_HAS_HOLES`** | Isolation suite and guard specs both assessed **honest** — no vacuous tests, correct table names, self-tested harness. Three critical findings, all outside the API tier: `apps/web` has zero tests and is never started by any harness; **the 36 `(platform)` Server Actions accept a caller-supplied `orgId` with the root admin key and no identity check — a live cross-tenant read path in production today**; and the isolation suite is not in CI. Report 15 §4 reproduces every `brokenImplementations` and `coverageGaps` entry verbatim. |

**Still blocking deploy, unchanged by all three runs:** `CRM_SECRET_KEY` (API crash-loops without
it), `PLATFORM_OPERATOR_EMAILS` (console lockout, now that `isOperator()` fails closed),
`SUPABASE_SERVICE_ROLE_KEY` (owner provisioning already broken in production today), and disabling
Supabase email signups. See report 12 §3.

**Stage 1 is NOT complete.** 1.3 landed the piece that mattered most and 1.2/1.1 are done, but 1.4
is unchanged and now carries a new gap, 1.5 is half done, and 1.6 is untouched. **Stage 1's exit
check has still not been attempted**, and it would fail: the isolation loop — the third of the net
that would catch a tenancy bug — is not wired into CI at all.

**Stage 2 gate: 2.1 and 2.2 may begin. 2.4 may NOT.** The reason has changed since run 2. It is no
longer that the net does not exist — it exists, it is honest, and it is green. It is that the net
tests whether the API scopes a request correctly, while 2.4 changes *who decides which tenant to ask
for*, in a tier with zero tests that no harness even starts — and that tier is reading across
tenants in production right now. Prerequisites, in order and roughly one focused week: fix the 36
`(platform)` Server Actions (2–3 days, and this is a production incident, not Stage 2 prep); give
`apps/web` a test runner and its first tests (1 day); wire the isolation suite into CI and drop the
Lint `continue-on-error` (0.5 day); parameterise the isolation loop over the session credential
(1 day); add expired/revoked/multi-membership session fixtures (0.5 day); bring the 12 out-of-loop
device and unguarded routes in (1 day). Then re-run the exit check. Then reassess 2.4.

### Run log — 2026-08-07 (run 4, Server Action lockdown)

Full report: [`17_SERVER_ACTION_LOCKDOWN.md`](17_SERVER_ACTION_LOCKDOWN.md). Two developers (the
guard and the eight action files · the web tier's first test harness), two adversarial reviews, one
integration pass. Measured for that report: **36 of 36** exported `(platform)` Server Actions now
open with `await requireOperator()` as their first statement, `pnpm -r typecheck` **8/8**,
`pnpm -r test` **544 passed / 7 skipped / 0 failed** (was 377/7/0), `pnpm tenancy:check` OK,
`NEXT_SKIP_STANDALONE=1` web build **19/19 pages**, `pnpm install --frozen-lockfile` up to date.

| Item | State | Note |
|---|---|---|
| 1.1 Tooling floor | 🟢 **done** | Plus `apps/web` finally gains a test runner — `vitest.config.ts` + `test`/`test:watch` + `vitest@^3.2.0`, shaped like `packages/shared` so root `pnpm -r test` needs no other wiring. The lockfile was regenerated in the same run, so `docker/web.Dockerfile:16`'s `--frozen-lockfile` still passes. |
| 1.2 Unit tests — pure logic | 🟢 **done** | Unchanged. **N1 still open.** |
| 1.3 Integration tests | 🟢 **done for the API tier** | Unchanged for the API. The web tier is no longer at zero — see the two rows below — but no harness starts it, and no integration-shaped test invokes a real Server Action end to end. |
| 1.4 CI — GitHub Actions | 🟡 **partial** | **No change, and it now costs more again.** Still four jobs; `grep -c integration ci.yml` is still 0, so the 141-case isolation net and the 167 new web tests block no merge. Lint step still `continue-on-error: true` while `next build` no longer lints. No Android workflow, no branch protection, no top-level `permissions:` block. |
| 1.5 Extend the RLS invariant check | 🟡 **partial** | Unchanged. `verify:rls:structural` split still unowned. |
| 1.6 Staging | ⬜ **untouched** | Unchanged. |
| **The 36 `(platform)` Server Actions** | 🟢 **fixed** | New `apps/web/lib/operator-guard.ts` — `requireOperator(): Promise<Principal>` composing the same `getPrincipal()`/`isOperator()` the layout uses, plus a detail-free `NotAuthorizedError`. It **throws rather than redirects** (an action invoked outside a navigation has nowhere to redirect to), and each action catches it and returns `{ error: "Not authorized" }`, byte-identical across all three refusals so it is not a tenant-enumeration oracle. Verified 36/36 by three independent counts, a brace-balancing first-statement parser, an exhaustive export-shape sweep (no `export default`, no arrow form, no clause or star export), and three runtime probes that invoked every real export under three hostile identities **with a positive control**. **No reviewer found a bypass.** No signature or return shape changed; an operator naming any `orgId` is still intended. |
| **`apps/web`'s first tests** | 🟢 **landed** | **167 tests, 4 files, from zero.** `isOperator()`/`getPrincipal()` (26 — incl. five spellings of an empty allowlist and all three API-failure shapes); `resolveAdminKey()` (13 — the API twin's nine-row table reproduced row for row so the mirrored credential cannot drift); `requireOperator()` (11 — mocking only `getSessionUser` and `fetch`, so the real composition runs); and a **guard-mounting check** (117) that discovers action files on disk and asserts per action that the guard is present, precedes the network call, and is the literal first statement. Proven non-vacuous by mutation, not inspection: reverting the fail-closed `isOperator()` line produces 3 named failures, deleting one action's guard produces 3 more. A reviewer found and fixed a real hole in the mounting check itself (`export { fooAction }` and `export * from` were invisible to its fail-closed parser case) and added the first-statement assertion, because the ordering case asserted nothing for the 8 `crm` actions that delegate to a local helper — report 17 §4 reproduces the finding verbatim. |
| **The render path** | 🔴 **open** | **The same defect one layer over, unchanged by this run.** `grep -rl "getPrincipal\|isOperator\|requireOperator" "app/(platform)" --include=page.tsx` returns **0 of 12 files**. `instances/[id]/page.tsx` takes the org from the URL segment and issues nine `apiGetAs(..., orgId)` calls on the root admin key; the other eleven honour `?org=` via `lib/tenant-scope.ts`, which validates the id only against the cross-tenant tenant list. A layout is not an authorization boundary. `(admin)/admin/page.tsx` is identical. **~1 day, same shape as the fix just landed, and it is a live cross-tenant read path today.** |

**Still blocking deploy, unchanged by all four runs:** `CRM_SECRET_KEY` (API crash-loops without it),
`PLATFORM_OPERATOR_EMAILS` (console lockout — **and now every one of the 36 actions refuses you too**,
since `requireOperator()` composes the same check), `SUPABASE_SERVICE_ROLE_KEY` (owner provisioning
already broken in production), and disabling Supabase email signups — **that last one is what turns
this vulnerability from "a customer owner could" into "anyone could."** See report 12 §3, restated in
report 17 §6. **This fix must ship in the same deploy as those env changes, not after them.**

**Stage 2 gate: 2.1 and 2.2 may begin. 2.4 still may NOT.** Report 15's six prerequisites: items 1
and 2 are now **done** and item 2's deploy consequence is closed. Items 3–6 are untouched, and item 3
— wiring the net into CI — is now the highest-leverage gap, because 544 tests that block no merge are
544 tests someone has to remember. This run did not so much advance Stage 2 readiness as remove a
production incident from the critical path, which was report 15's own recommendation. Next, in order:
extend the guard to the twelve render-path pages (1 day); promote the mounting check to
`platform/scripts/` and commit the reviewers' probe (0.5 day); wire the `integration` job and drop the
Lint `continue-on-error` (0.5 day); parameterise the isolation loop over `asSession()` (1 day);
session-lifecycle fixtures (0.5 day); the 12 out-of-loop routes (1 day). Then the exit check. Then
reassess 2.4.

---

## Stage 2 — The tenancy and identity spine (weeks 6–11, ~5 weeks)

Carried almost wholesale from `06_HARDENING_PLAN.md` Phase 1, which is well-analysed and correct.
§1.1 (`TenantGuard` + `@OrgId()` + `@CrossTenant()`) is **already done**. What follows is the rest,
plus one item the audit added.

The through-line: **today the API trusts the web tier absolutely.** The web tier holds a root key,
asserts which tenant it wants, and — since the owner-roles work — asserts *who the user is* and
*what role they hold*, as plain headers. That is a sound boundary only while the console is the
only client and the key never leaks. It is not a boundary you can sell, audit, or extend to a
mobile owner app.

### 2.1 Verify the Supabase JWT at the API [06 §1.2]

New `apps/api/src/modules/auth/supabase-jwt.ts`: verify `Authorization: Bearer <supabase-jwt>`
against the project JWKS (RS256), cache keys with a long TTL and a stale-if-error fallback, refresh
on unknown `kid`, validate `iss`/`aud`/`exp`. Resolve `sub` → `users.sso_subject` → `memberships`.

Rename `AdminKeyGuard` → `PlatformAuthGuard` with three branches (Supabase JWT, legacy `aus_`
session, admin key) that all produce the same `Principal`.

*Risk:* a JWKS outage or clock-skew bug locks everyone out. Mitigated by the cache, the
stale-if-error fallback, and the break-glass credential in §2.3.

### 2.2 Principal model v2 [06 §1.3]

`Principal.orgId: string` + `role: string` makes a user with two memberships structurally
unrepresentable — which is why `owner-context.ts` currently does
`memberships.find(active) ?? memberships[0]` and silently discards the rest.

```ts
interface Principal {
  kind: "user" | "device" | "service" | "break_glass";
  userId: string;
  subject?: string;
  memberships: Membership[];
  isPlatformAdmin: boolean;
  activeOrgId: string | null;
  permissions: Permission[];   // resolved FOR activeOrgId
}
```

Permissions must resolve **per org**: the same person can be `org_admin` on one tenant and
`viewer` on another, and `recordings:listen` has to follow that. Type-driven; the compiler finds
every call site.

### 2.3 Scoped service credentials — migration `0019` [06 §1.5, renumbered]

Replace the single `ADMIN_API_KEY` with named, scoped, revocable, attributable credentials.

```sql
CREATE TABLE service_credentials (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid REFERENCES organizations(id) ON DELETE CASCADE,  -- NULL = platform scope
  name         text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  scopes       text[] NOT NULL DEFAULT '{}',
  created_by   uuid REFERENCES users(id),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

Keys are `aur_sk_<32 bytes base64url>`, stored as SHA-256, shown once — the same pattern the
existing `api_keys` table already uses. Scopes start concrete: `tenants:provision`, `tenants:read`,
`devices:enroll`, `calls:read`, `crm:write`, enforced by a `@RequireScope()` decorator alongside
`@RequirePermission`.

**`ADMIN_API_KEY` is demoted, not deleted:** it survives as a `break_glass` principal that can reach
exactly two routes — `POST /v1/admin/tenants` and `POST /v1/admin/service-credentials`. That keeps
first-boot provisioning possible on an empty database and keeps a recovery path if §2.1 misfires,
while removing its ability to read any tenant's data. Every break-glass use writes an audit row and
fires an alert.

### 2.4 The web tier stops holding a root key [06 §1.4] — *highest risk item in the plan*

Server components and server actions forward the signed-in user's Supabase JWT instead of sending
`x-admin-key` + a self-chosen `x-org-id`.

* `apps/web/lib/server-api.ts` rewritten around `apiAs(path, { orgId })`.
  `adminHeaders`, `apiGet`, `orgHeaders` and `crossTenantHeaders` are deleted.
* Migrate **route group by route group** behind `API_AUTH_MODE=jwt|admin_key`: `(owner)` first
  (smallest surface, real customers), then `(platform)`, then `(admin)`. Roll back by flipping the
  flag. Keep the admin-key branch until every group has run on `jwt` in production for a week.
* Server actions move with their route group. `calls/actions.ts` was the load-bearing tenant bug
  once already — give it its own verification pass.

This is what Stage 1's guard suite exists to protect. Do not attempt it without CI green.

### 2.5 Make owner roles a real boundary — *added by this audit*

The in-flight owner-roles work is currently **advisory, not enforced**, in two ways:

1. [`admin-key.guard.ts:58-68`](../platform/apps/api/src/common/admin-key.guard.ts) trusts
   `x-caller-user-id` and `x-caller-owner-role` as **client-asserted headers**.
2. [`owner-role.guard.ts:41`](../platform/apps/api/src/common/owner-role.guard.ts) *passes
   unchecked* when `viaAdminKey && ownerRole == null` — so any admin-key holder bypasses every
   role check by simply omitting a header.

The compatibility reasoning is sound for a transition, but it must be a transition with an end. Once
§2.4 lands, the persona comes from the **verified JWT's membership row**, both headers are deleted,
and the `viaAdminKey && ownerRole == null` escape hatch is removed. Until then, the v2 spec's §9
claim that owner roles are "enforced server-side on every API endpoint" is not yet true — say so in
the doc so nobody builds on the assumption.

Add to the Stage 1 guard suite: a Telecaller principal must receive 403 on manager-only routes,
another telecaller's leads, and every operator route.

### 2.6 Delete `DEV_ORG_ID` and `DEV_WORKSPACE_ID` [06 §1.6]

They are the mechanism by which a page renders the wrong customer's data and returns HTTP 200. This
codebase has been burned at least four times: the `/compliance` page editing the dev org's policy
for every customer; `calls/actions.ts` 404-ing the drawer for every non-dev tenant; the
`.env.local` trap pointing a local dev server at production data; and the Fortune Innovatives
lookups that rendered a loading skeleton with a 200.

* `resolveTenantScope()` → `resolveOperatorScope()`. Tenant list from `GET /v1/tenants`, filtered by
  the principal's grants. Default = last-viewed org from a **signed, httpOnly cookie** validated
  against that list; else first **by name** (the current `created_at DESC` default moves every time
  a customer is onboarded).
* Delete the unauthenticated `AUTH_ENABLED=false` branch in `owner-context.ts`. Local dev instead
  gets a **seeded Supabase-equivalent dev user with a real membership** (extend
  `packages/db/seed.js`), so local development exercises the production code path. That is the
  entire point of removing it.
* Remove the variable from `.env.example`, `.env.production.example`,
  `apps/web/.env.development.local` and `DEPLOYMENT.md` §7.2.

### 2.7 Multi-membership + real tenant switcher [06 §1.7]

`getPrincipal()` returns `memberships[]` and an `activeOrgId` from the signed cookie, validated
against the list. `<TenantSwitcher>` renders in `(owner)` when `memberships.length > 1`.
`PLATFORM_OPERATOR_EMAILS` stops being load-bearing — platform staff are identified by a
`platform_admin` membership; the env var survives only as a bootstrap override.

### 2.8 Audit every cross-tenant access [06 §1.8]

When a `platform_admin` reads or writes another tenant's data, write an `audit_log` row **in that
tenant's org**. `TenantGuard` is the natural choke point — it already knows when it is pinning an
org the principal has no membership for. Record actor, route, method, org, and target id. Batch
writes so a list endpoint doesn't double its query count. Surface it on `/instances/[id]` beside the
existing per-customer ledger, labelled as platform access.

This is the access a customer most wants accounted for, and the one a DPA will require.

### 2.9 Stop swallowing every error — *added by this audit*

`apiGetAs` returns `null` on any non-2xx **and** on any thrown error
([`server-api.ts:87-91`](../platform/apps/web/lib/server-api.ts)) — 35 such catches across the web
app. A 403, a 500, an expired session and a genuinely empty result are indistinguishable, to the
user and to you. This is the mechanism behind the "renders only the loading skeleton with an HTTP
200" bug class.

Return a discriminated result — `{ ok: true, data } | { ok: false, kind: "auth" | "forbidden" |
"notfound" | "server" | "network", status }` — and render four distinct states: signed-out, no
access, genuinely empty, and broken (with a Sentry-linked error id). The v2 spec's constraint #6
("`apiGetAs` returns null on failure — every panel renders an API-offline card, never throws")
should be **amended** to "never throws, but must distinguish *why*."

**Stage 2 exit check:** the API rejects a request carrying only an admin key on any tenant-data
route. A Telecaller JWT gets 403 on manager routes, proven in CI. Grepping the web tier for
`x-admin-key` returns two hits, both in the break-glass provisioning path. `DEV_ORG_ID` returns zero
hits repo-wide.

---

## Stage 3 — Pipeline & reliability (weeks 12–16, ~4 weeks)

`06_HARDENING_PLAN.md` Phase 2 and 4, carried forward with the audit's additions.

### 3.1 `ProviderRouter` + BYO tenant keys [06 §2.3] — migration `0020`

Provider selection is a hardcoded `STUB → Gemini` if/else in
[`asr.ts`](../platform/apps/worker/src/pipeline/asr.ts) and
[`packages/llm/src/index.ts`](../platform/packages/llm/src/index.ts). One provider ran out of
credit and the entire platform stopped transcribing, with the reason visible only in worker logs.
That is a design consequence, not bad luck.

`packages/llm/src/router.ts`: `resolve(org, agent, task) → [primary, fallback]`, per-provider
timeout, retry and circuit breaker. **Fail over on 5xx, timeout and quota errors only — never on a
content refusal**, which is a legitimate answer and must not be re-rolled against a second
provider. Record the provider and model actually used on every output; the columns already exist.

Same change: `org_provider_credentials` (migration `0020`), sealed with the existing
`CRM_SECRET_KEY` envelope in `packages/db/src/secrets.ts`. Resolution order: **tenant key →
platform key → deny.** API returns prefix + last 4 only. This is also what makes per-tenant cost
attribution meaningful — and what lets a large customer bring their own quota instead of competing
for yours.

Note `0015_sarvam_asr_job.sql` / `0016_instance_asr_settings.sql` already added a second ASR
provider by hand; the router should absorb that logic rather than sit beside it.

### 3.2 Cost tracking [06 §2.4]

`ai_outputs.cost_usd` **exists as a column and is never written** — the insert at
`pipeline.ts:328` passes tokens but not cost. Add `packages/llm/src/pricing.ts` (per-model price
table, versioned by effective date), compute at write time, emit an `llm_cost_usd` usage event
alongside the token events. Without this, Stage 4's billing has nothing to meter and §3.3 has
nothing to limit.

### 3.3 Backpressure [06 §2.5]

Two per-org ceilings, both currently absent:

* An analyze-concurrency semaphore in **Redis** — which is already in the compose stack and
  entirely unused.
* An **hourly LLM spend ceiling**, alert at 80%, hard stop at 100%, reading §3.2's cost events.

Without these, one tenant uploading a backlog exhausts a shared provider quota for every other
tenant — which is precisely how the Gemini outage happened and precisely how it recurs.

### 3.4 Dead-letter queue and replay [06 §2.2]

[`packages/queue/src/index.ts:50`](../platform/packages/queue/src/index.ts) `nack`s with
`requeue=false` on an unexpected error, so a message failing *outside* the call state machine
vanishes silently. The retry sweeper covers calls that reached a `FAILED_*` state; it does not
cover a message that failed before the state machine took ownership.

Declare `pipeline.dlq` with a dead-letter exchange on the main queue, record payload + reason, and
add one-click replay to the `(admin)` health panel — which already renders per-stage in-flight and
failed counts and is the obvious home for it.

### 3.5 Real transcode [06 §2.1]

[`pipeline.ts:522`](../platform/apps/worker/src/pipeline/pipeline.ts) is a pass-through with a
TODO. It works only because the client happens to record 16 kHz mono AAC — a coincidence that
already broke once when Xiaomi's OEM recordings arrived as `.mp3`, and will break again on the next
OEM format.

Add ffmpeg to `docker/node.Dockerfile`, normalise to 16 kHz mono Opus, and make this stage the
place where the device envelope is decrypted. **The Android side already encrypts at rest with
`FileCrypto` and the server never decrypts — so encryption-at-rest is currently unused end to end.**
Store the normalised object alongside the original and point ASR at it, so a provider swap never
re-reads a device-specific container.

### 3.6 `Idempotency-Key` [06 §2.6] — migration `0021`

[`calls.controller.ts:109`](../platform/apps/api/src/modules/calls/calls.controller.ts) carries the
TODO. The device retries `POST /v1/calls` on any network failure, so duplicate call rows are a live
possibility today — and every duplicate is a duplicate LLM bill and a possible duplicate lead.

`idempotency_keys (org_id, key, request_hash, response_body, created_at)`, 24h TTL reaped by the
existing reaper, an interceptor on every POST. Return the stored response on a repeat; 409 when the
same key arrives with a different body.

### 3.7 Single-use device nonces [06 §2.7]

[`device-nonce.ts:9`](../platform/apps/api/src/common/device-nonce.ts) — nonces are time-windowed
but replayable within the window. Move to Redis with a TTL matching the window and an atomic
`SET NX`. Small change, closes a real replay hole in device authentication.

### 3.8 Worker tenancy: one helper, fair scheduling [06 §1.10]

Four sweepers now hand-implement "sweep cross-tenant on the admin pool, then re-enter each org's
RLS context" — `retry.ts`, `reaper.ts`, `outbox.ts`, and the lead projection. All four are correct;
the fifth will be where it is copied wrongly. None is **fair**: a tenant with 10,000 pending rows
starves everyone else on the same tick, because sweeps order by due time across all orgs.

`apps/worker/src/pipeline/tenants.ts` exporting `forEachTenant(fn, { concurrency, perOrgLimit })`,
round-robin, at most `perOrgLimit` rows per org per tick. Refactor all four onto it.

*These loops are destructive — the reaper deletes on retention.* Verify against a database copy,
and confirm the three idle-loop preconditions from `run-prod-local.sh` before running against
production data.

### 3.9 Observability, properly [06 §4.1]

Building on Stage 0.5's crude alerts:

1. **OpenTelemetry traces** spanning device upload → S3 → every pipeline stage, keyed by `call_id`.
   NestJS and `pg` have auto-instrumentation; the worker needs manual spans per stage.
2. **Golden signals per stage**: queue depth, latency p50/p95, failure rate, DLQ size.
3. **Business alerts**, in this order — the first one is the metric that says whether the product
   works at all:
   * **recording success rate per device model** ← build this one first
   * devices silent > 24h
   * uploads pending > 6h
   * LLM spend rate and provider error rate
   * CRM sync failure rate

Grafana + Prometheus + Loki on the same VPS is sufficient at this scale. Do not reach for a hosted
APM yet.

### 3.10 Storage durability, completed [06 §4.2]

Stage 0.4 did the emergency mirror. Now: object versioning, a lifecycle rule per tenant matching
their `retention_days` (so the reaper is not the only thing enforcing retention), and a **documented,
tested restore drill** run quarterly.

**Stage 3 exit check:** kill the primary LLM provider's key in staging — transcription continues on
the fallback and an alert fires. Post the same call twice with one `Idempotency-Key` — one row.
Upload an `.mp3`, a `.wav` and an `.m4a` — all three reach COMPLETE.

---

## Stage 4 — Business machinery (weeks 17–21, ~4 weeks)

Without this stage there is no business, only a system. Today a customer can upload unlimited calls
and burn unlimited provider credit for free, and there is no way to invoice them.

### 4.1 Billing [06 §3.1] — migration `0022`

[`billing.controller.ts:64`](../platform/apps/api/src/modules/billing/billing.controller.ts)
returns a hardcoded `{ invoices: [] }`. The `usage_events` ledger behind it is real and durable —
the hard part is done.

* `plans` (name, price, included calls/minutes/tokens, overage rates, limits) and `invoices`
  (org, period, line items, subtotal, tax, total, status).
* A monthly rollup job in the worker that closes a period into an invoice row from the ledger.
* **GST handling is not optional for Indian B2B** — invoices need GSTIN, HSN/SAC code, place of
  supply, and a compliant invoice number series. Get this right at schema time; retrofitting tax
  onto issued invoices is miserable.
* Stripe/Razorpay collection stays **out of scope** — the deliverable is a *correct invoice*.
  Payment collection is a separate decision, and for Indian SMB B2B a UPI/bank transfer against a
  PDF invoice is often what customers actually want.

### 4.2 Limit enforcement + tenant lifecycle [06 §3.2, §1.9]

`limits: { callsPerMonth: 50000, tokensPerMonth: null }` is a **literal in the usage response** and
nothing enforces it. Move limits onto the plan, check them in the call-admission path, notify at
80%, reject at 100% with a Problem+JSON error the device can distinguish from a transport failure.
That is the difference between metering and billing.

Same change — make a tenant impossible to provision incomplete:

* `POST /v1/admin/tenants` takes a **template**: retention days, consent policy, lead stages,
  transcription toggle, a starter extraction agent, a CRM connector stub. Ship `sales-india` and
  `transcription-only` in `packages/shared/src/tenant-templates.ts`.
* The response includes a **readiness report** — agent present, CRM present, ≥1 enrollment key, ≥1
  owner login — and `/instances/[id]` renders it as a checklist. *A tenant that cannot produce a
  lead should say so on its own page.* This is the structural fix for Fortune Innovatives.
* **Suspension means one thing everywhere**: `organizations.status = 'suspended'` already refuses
  ingest; extend it to render the console read-only and pause CRM dispatch.

### 4.3 Compliance you can actually show a customer

You have consent policy, retention, cascading erasure with signed receipts, and an audit ledger.
That is genuinely more than most competitors at this stage. What is missing is the paperwork and
the evidence trail that make it defensible under India's DPDP Act 2023, where you are a **Data
Processor handling voice recordings of third parties who never consented to you**.

* **DPA template** (you ↔ customer), **privacy policy**, **sub-processor list** (Supabase Seoul,
  Google Gemini, Sarvam, Backblaze, Hostinger). Note the data-residency point: Supabase is in
  `ap-northeast-2` (Seoul) while every customer is in India — a customer with any compliance
  function will ask, and `organizations.region` **exists as a column that nothing writes**.
* **Consent evidence**: today `consent_status` is derived from a flag the device asserts. Record
  *what* was played, *when*, and the device config version that decided it, so a receipt is
  evidence rather than a configuration echo.
* **Erasure completeness** [06 §3.6] — two real gaps: CRM-pushed copies are logged but not deleted
  (add best-effort provider deletes, and record per-integration success/failure on the receipt — *a
  receipt that overstates what was deleted is worse than one that admits a gap*); and erasure is
  per-call, with no per-subject fan-out. A data subject asking to be forgotten needs every call
  matching their `contact_number_hash` across the org, plus their lead row. Both columns already
  exist — it is a query change.
* A one-page **"How consent works in Aura"** explainer for the sales conversation.

### 4.4 Self-serve onboarding

Right now onboarding a customer requires you at a terminal. Target: a customer signs a quote and
gets provisioned, enrolled and producing leads without a single manual step.

* Provisioning wizard on `/instances/new` driving §4.2's templates end to end.
* Enrollment-key QR + a printable one-page handset setup guide per OEM (Samsung / Xiaomi / Realme /
  Oppo / Vivo), derived from `05_FLEET_ONBOARDING.md`.
* An in-console **device health page for the owner** — "3 of 5 handsets recorded today" — so the
  customer notices a silent phone before you do.

**Stage 4 exit check:** provision a tenant, enroll a handset, produce a lead, generate a
month-end invoice, and hit a plan limit — all through the UI, with no terminal.

---

## Stage 5 — Product depth (weeks 22–34, ~12 weeks)

Now build `ceo-dashboard-build-prompt-v2.md`. The spec is strong and its non-negotiable constraints
are correct (with the two amendments noted below). What changes is **order and gating**, because a
9-month build is worth nothing if the foundation moves under it.

### The amendments to the v2 spec

* **Constraint #6** — see §2.9. "Returns null on failure" becomes "returns a typed result and
  renders four distinct states."
* **§9 owner roles** — see §2.5. The claim that roles are enforced server-side is not yet true; it
  becomes true at Stage 2.4. Do not build Telecaller-scoped data access on top of it before then.
* **§A.6 identity prerequisite** — the spec says "verify a stable telecaller identity exists before
  building." It now does: migration `0017_telecallers.sql` landed. Verify the device→user→call join
  is complete before Module A, not after.

### Order

| Order | Module | Why here | Size |
|---|---|---|---|
| 1 | **A — Telecaller performance & coaching** (`/owner/team`) | This is the module Aura is *uniquely* positioned to build, because the input is call **content**, not CRM activity logs. It is also the one that answers a question an owner will pay money for today: "which of my reps is bad, and specifically why." Ship it first and it can be sold before the rest exists. | L |
| 2 | **B — Lead workspace upgrades** | Saved views, configurable pipeline, bulk actions, column chooser. Directly reduces the daily friction of the customers you already have. Note §B.2 (stages become tenant config) is the one backend change with real blast radius — keep it behind a per-tenant flag with the current enum as the seeded default, exactly as the spec says. | M |
| 3 | **C — Business health review** | Only worth building once ≥5 tenants have asked for different metrics. §C.2's custom metric builder is **the primary injection surface in the entire product** — metric definitions are structured JSON validated by `zod`, compiled to parameterized SQL against a whitelisted column set, and raw SQL is never accepted from a client. Write that test suite before the feature. | XL |
| 4 | **D — Automations** | Highest cost, least validated demand, and it introduces tenant-authored control flow into your worker. §D.1's "engine first, canvas second" is right. Do not start until three customers have asked for it **by name**. If the flow canvas would blow the bundle budget, ship the vertical step-list builder — same engine, no React Flow. | XL |

**Also from the spec, and worth pulling early:** §D.4's *setup completion rail* and *unfinished
business panel*. They are small, they run on data that already exists, and they make the product
feel alive from day one of a new tenant. Consider shipping them alongside Module A rather than with
Module D.

### Performance, from the spec's own budget

§C.5 is right and applies from Module A onward: dashboard queries hit **pre-aggregated rollups**
(`mv_agent_daily`, `mv_lead_daily`, `mv_calls_hourly`, refreshed by a worker cron, RLS applied),
never raw call scans. Budgets: dashboard first paint < 1.5s, widget refresh < 500ms, board
interaction < 100ms. Because pages are RSC, **a slow widget blocks the page** — stream with
`<Suspense>` and per-widget skeletons.

---

## Stage 6 — Scale & durability (ongoing, from week 22)

Runs in parallel with Stage 5; none of it is a prerequisite for it.

* **Load testing.** k6 against staging: 100 concurrent uploads, 10k calls/day, 25k leads and 100k
  calls in a single tenant (the v2 spec's realistic target). Find the first bottleneck before a
  customer does.
* **Database.** Partition `calls`, `transcripts` and `ai_outputs` by month once any tenant passes
  ~100k calls. Review indexes against actual `pg_stat_statements` from production, not from
  intuition.
* **Multi-worker.** The pipeline is already queue-driven and the sweepers already claim rows with
  conditional `UPDATE`s, so horizontal worker scaling should be near-free — verify it under load
  rather than assuming.
* **Disaster recovery drill.** Once a quarter: restore Postgres from a Supabase backup and MinIO
  from B2 into a scratch stack, boot it, and confirm a call plays. Time it, and write the number
  down. That number is your RTO.
* **Uptime measurement.** 99.5% monthly, measured by the external check, published to customers.
* **Security review.** After Stage 2 completes, one external pentest. Target: nothing above Medium.

---

## Android track (parallel, ~4 weeks total)

`06_HARDENING_PLAN.md` excluded Android entirely. It cannot stay excluded: it is the component with
the most device-specific fragility, the least ability to hotfix, **zero tests across 44 files and
5,062 lines**, and it is the sole source of every byte of data the platform processes.

| # | Work | Why |
|---|---|---|
| A1 | Unit tests for `OemRecordingIngestor` filename parsing, `CallLogReader.nearest`, the dedupe/purge logic, and `FileCrypto` round-trip. Run in CI (Stage 1.4). | Three OEM formats so far, **each one learned from a production break**. This is the single most regression-prone code in the repo. |
| A2 | **Crash + event reporting** (Sentry or Firebase Crashlytics). | Today a crash on a customer's handset is invisible unless they mention it. `HealthWorker`/`EventLog` telemetry exists — surface it in the operator console. |
| A3 | **Per-device recording success rate**, reported to the platform and shown on the instance page. | The most important business metric in the product, and it does not exist. A silent handset currently looks identical to a quiet telecaller. |
| A4 | **Self-diagnostic screen** in the app: OEM folder found? files present? permissions granted? last successful upload? battery optimisation exempted? | Turns "it's not working" support calls into a screenshot. Battery optimisation killing WorkManager is the classic silent failure on Xiaomi and Oppo. |
| A5 | `targetSdk` 34 → 35/36, and a written OEM compatibility matrix (tested model × OS version × folder path × outcome). | Android 15/16 handsets are shipping now. The matrix is also a sales asset and a purchasing rule. |
| A6 | Keystore + `keystore.properties` into the vault; signed-release build reproducible from a second machine. | Covered in Stage 0.6, verified here. |

**The strategic risk to state plainly:** the entire data supply depends on OEM dialers writing
recordings to public storage. Google Dialer devices are permanently excluded (confirmed on
hardware). Any OEM can move or remove that folder in an OS update — Xiaomi already did, and it
broke ingestion. Mitigations: the compatibility matrix as a hard purchasing rule for customer
fleets, A3's per-model success monitoring as the early-warning system, and a standing evaluation of
one alternative capture path so a single OEM change is not an extinction event.

---

## Migration numbering

`packages/db/migrations` is at **0018**. `06_HARDENING_PLAN.md` reserved 0015–0019 for work that has
since been claimed by `0015_sarvam_asr_job`, `0016_instance_asr_settings`, `0017_telecallers` and
`0018_owner_roles`. Renumbered here — **use these, and correct 06 so the collision cannot bite:**

| # | Contents | Stage |
|---|---|---|
| `0019` | `service_credentials` | 2.3 |
| `0020` | `org_provider_credentials` (BYO LLM keys) | 3.1 |
| `0021` | `idempotency_keys` | 3.6 |
| `0022` | `plans`, `invoices` | 4.1 |
| `0023` | CRM OAuth refresh columns | blocked |
| `0024+` | Stage 5 tables (see v2 spec §10) | 5 |

`ai_outputs.cost_usd` and `organizations.region` already exist — they need **writers**, not
migrations.

Remember `pnpm db:supabase:sync` after adding any migration: `supabase/migrations/` is generated,
and `packages/db/migrations` stays canonical.

---

## Blocked on external credentials

Each is isolated so nothing else waits on it.

| Item | Needs | Note |
|---|---|---|
| Play Integrity [06 §3.3] | Google Cloud project | The device sends the literal string `"android-stub"`; the server verifies nothing. Enrollment currently proves possession of a one-time key and nothing about the app. Treat a failed verdict as a warning first, a hard block once the fleet is known-clean. |
| FCM push [06 §3.4] | Firebase project + service account | Logout/wipe currently propagate on the ~1h config poll. For "stop recording on that handset **now**", an hour is the wrong number. The device already handles the refresh — this is a delivery channel, not a feature. |
| CRM OAuth refresh [06 §3.7] | OAuth apps at Salesforce, Zoho, monday, Dynamics 365 | Those four authenticate with pasted access tokens that expire in **hours**. Pilot-only until this lands. The other eleven providers use long-lived credentials and are fine. |
| Off-box backup target | Backblaze B2 bucket | Stage 0.4 — do not wait on anything for this one. |
| Staging Supabase project | Second Supabase project | Stage 1.6. |

---

## Timeline and effort

Solo developer with AI assistance, realistic rather than optimistic.

| Stage | Weeks | Cumulative | Gate |
|---|---|---|---|
| 0 — Emergency | 0.5 | **wk 1** | Nothing else starts first. |
| 1 — Make change safe | 3 | wk 5 | **Hard gate on Stage 2.** |
| 2 — Tenancy & identity spine | 5 | wk 11 | Hard gate on Stage 5. |
| 3 — Pipeline & reliability | 4 | wk 16 | 3.2 before 3.3; 3.1 before 3.2. |
| 4 — Business machinery | 4 | wk 21 | Hard gate on Stage 5. |
| 5 — Product depth | 12 | wk 34 | Module order A→B→C→D, each gated on demand. |
| 6 — Scale & durability | ongoing | — | Parallel from wk 22. |
| Android | 4 | parallel | A1 belongs inside Stage 1. |

**~8 months to a defensible 10/10.** Roughly 5 months of that is foundation, which will feel slow
and is not. The alternative — building Stage 5 first — produces a more impressive demo and a
business that cannot survive its first outage, its first security question from a real buyer, or
its first month of trying to invoice anyone.

---

## Scorecard tracking

Update this table at every stage boundary. It is the plan's only success metric.

| Dimension | Start | After 1 | After 2 | After 3 | After 4 | After 5 | Target |
|---|---|---|---|---|---|---|---|
| Architecture & design | 8 | 8 | 9 | 10 | 10 | 10 | **10** |
| Security & auth | 3 | 5 | 9 | 9 | 10 | 10 | **10** |
| Engineering discipline | 2 | 8 | 9 | 9 | 10 | 10 | **10** |
| Operations & reliability | 3 | 6 | 6 | 9 | 9 | 10 | **10** |
| Feature completeness | 7 | 7 | 7 | 8 | 9 | 10 | **10** |
| Business readiness | 2 | 2 | 3 | 3 | 8 | 10 | **10** |

---

## What this plan deliberately does not do

* **No Kubernetes, no service mesh, no multi-region.** The single-VPS + Supabase shape is right for
  this load and nothing here outgrows it.
* **No payment collection.** Stage 4 produces a correct invoice. Taking money is a separate,
  smaller decision.
* **No microservices split.** The pnpm monorepo with three apps is the correct granularity.
* **No new datastore.** Postgres + materialized views cover every analytics need in the v2 spec.
* **No sandboxed code node in automations.** Tenant code execution with no sandbox is out of scope,
  exactly as the v2 spec says.
* **No rewrite of anything.** Every item is additive or a scoped refactor of a named file. The
  architecture is good; it is the layers around it that need work.

---

## The strategic point, stated once

The moat is not the Kanban board, the widget canvas, or the automation engine — every CRM has
those, built by larger teams. The moat is that **Aura extracts structured, CRM-ready facts from
Tamil/English sales calls that nobody else is transcribing.**

Everything that strengthens that compounds: transcript accuracy, extraction quality, capture
reliability, and provable lineage from lead back to the exact moment in the call. Everything else
is table stakes you will lose on against a funded competitor.

So the honest business plan alongside the technical one: **finish Stages 0–4, then sell to ten more
SMBs in Tamil Nadu with the same shape as RD Interlock Brick** — brick, interiors, real estate,
building materials — before building Stage 5's XL modules for a customer you have not met. Ten
paying customers on a boring, reliable v1 beats one customer on a spectacular v3.
