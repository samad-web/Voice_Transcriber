# 12 — Stage 0 / Stage 1 execution report

**Run date 2026-08-06.** Branch `crm-connectors-and-console-auth`, uncommitted in the working tree.
Four developers on disjoint file partitions, four independent reviews, one integration pass.

**The tree compiles.** `pnpm -r typecheck` passes across all 8 projects (shared, db, queue, ui, llm,
api, worker, web) — re-run and confirmed for this report, not taken on report. `pnpm -r test` is
green: **196 passed, 4 skipped, 0 failed** across 9 test files in 4 packages. `pnpm tenancy:check`
passes. `pnpm install --frozen-lockfile` is a no-op against the regenerated lockfile. Nothing in
this run leaves the repository in a non-building state.

**But it is not deployable as it stands.** Two changes fail closed on environment that is not
present in `platform/.env.production` today, and deploying without §3 of this document will (a)
crash-loop the API container and (b) lock the only operator out of the console. §3 is the section
that matters most. Read it before you `docker compose up`.

One thing was verified only by `tsc`: `apps/web`'s `next build` was never executed, because it loads
`apps/web/.env.local`, which points at live production Supabase. The CI `build` job covers it with
placeholder build args and is the right place to prove it.

---

## 1. What shipped

| Change | Plan ref | File(s) | Status |
|---|---|---|---|
| `isOperator()` fails closed — empty allowlist means nobody | 0.1 step 2 | `apps/web/lib/owner-context.ts` | **landed** |
| `(admin)` route group gated on `isOperator` (had no layout at all) | 0.1 (implied) | `apps/web/app/(admin)/layout.tsx` (new) | **landed** |
| `(platform)` route group gated; shared refusal card | 0.1 (implied) | `apps/web/app/(platform)/layout.tsx`, `components/no-console-access.tsx` (new) | **landed** |
| Supabase dashboard → disable email signups | 0.1 step 1 | — | **not landed** (dashboard action, §6) |
| `PLATFORM_OPERATOR_EMAILS` set in production | 0.1 step 3 | `platform/.env.production` | **not landed** (§3) |
| `auth.users` audited for unexpected accounts | 0.1 step 4 | — | **not landed** (§6) |
| API `dev-admin-key` fallback removed under `NODE_ENV=production` | 0.2 | `apps/api/src/common/admin-key.guard.ts` (`resolveAdminKey()`) | **landed** |
| Boot-time env assertion, throws in production | 0.2 | `apps/api/src/config/assert-env.ts` (new), `apps/api/src/main.ts` | **landed** |
| Web-tier start-up assertion (`ADMIN_API_KEY` + `AUTH_ENABLED`) | 0.2 | `apps/web/instrumentation.ts` (new) | **landed-with-fixes** (reviewer added the `AUTH_ENABLED` half) |
| Web-tier `dev-admin-key` literal removed | 0.2 | `apps/web/lib/server-api.ts:10` | **not landed** — literal still present, see §2.2 |
| `JWT_SECRET ?? "dev-jwt-secret-change-me"` removed at 4 sites | 0.2 | `device-auth.guard.ts:33`, `device-nonce.ts:5`, `devices.controller.ts:193`, `erasure.controller.ts:97` | **not landed** — see §2.3 |
| Rotate Supabase DB password / `service_role` / `ADMIN_API_KEY`; Data API off | 0.3 | — | **not landed** (§6) |
| Backblaze B2 bucket, `mc mirror` timer, tested restore | 0.4 | — | **not landed** (§6) |
| Sentry, UptimeRobot, daily digest cron | 0.5 | — | **not landed** (§6) |
| `CRM_SECRET_KEY` + Android keystore into a vault | 0.6 | — | **not landed** (§6) |
| `helmet()` | 0.7 | `apps/api/src/main.ts` | **landed** |
| 1 MB JSON body limit | 0.7 | `apps/api/src/main.ts` | **landed** |
| `trust proxy 1` (prerequisite for per-IP limits) | 0.7 (added) | `apps/api/src/main.ts` | **landed** |
| CORS: `WEB_ORIGIN` parsed as a comma-separated allowlist | 0.7 | `apps/api/src/config/cors.ts` (new) | **landed** |
| `@nestjs/throttler` — 5/min login, 10/min device register, 100/min default | 0.7 | `app.module.ts`, `config/throttling.ts` (new), `auth.controller.ts`, `devices.controller.ts` | **landed** (exemptions differ from the plan — §5.3) |
| `ValidationPipe({ whitelist, transform })` | 0.7 | — | **not landed** — correctly so, see §5.4 |
| Fortune Innovatives given an agent + connector, or recorded transcription-only | 0.8 | — | **not landed** |
| ESLint flat config + Prettier + `.gitattributes` (`* text=auto eol=lf`) | 1.1 | `platform/eslint.config.mjs`, `.prettierrc.json`, `.prettierignore`, `/.gitattributes` (all new) | **landed** |
| Vitest in `packages/{shared,db,llm}` and `apps/worker`; `pnpm -r test` | 1.1 | 4 × `vitest.config.ts`, 4 × `package.json` | **landed** |
| Jest for `apps/api` so `@nestjs/testing` works | 1.1 | — | **not landed** — zero API tests exist |
| Unit tests: `qualifyLead`, `resolveOwnerRole`, schema compiler, `retryBackoffSeconds`, `secrets` seal/unseal, LLM response parsing | 1.2 | 9 × `*.test.ts` | **landed-with-fixes** (200 cases; reviewer fixed a mis-titled case that hid a real coverage gap) |
| Unit tests: Kotlin `OemRecordingIngestor` / `CallLogReader` / `FileCrypto` | 1.2, Android A1 | — | **not landed** |
| Integration tests (Testcontainers: pg + rabbit + minio), guard suite, cross-tenant loop | 1.3 | — | **not landed** |
| `.github/workflows/ci.yml` — static / unit / db / build | 1.4 | `.github/workflows/ci.yml` (new) | **landed-with-fixes** — no `integration` job (§5.5) |
| `pnpm tenancy:check` wired into a build | 1.4 | `ci.yml` `static` job | **landed** |
| Android debug-APK workflow | 1.4 | — | **not landed** |
| Branch protection on `main` | 1.4 | — | **not landed** (GitHub setting, §6) |
| `verify-rls.js` rewritten to derive the table set and fail on any gap | 1.5 | `packages/db/verify-rls.js` | **landed-with-fixes** — reviewer fixed a permanently-red assertion (§2.5) |
| `verify-rls.js` run in the `migrate` container after every migration | 1.5 | — | **not landed** — structurally blocked, see §5.2 |
| Staging Supabase project + second compose stack | 1.6 | — | **not landed** |
| Typed API results (`{ok:true,data} \| {ok:false,kind,status}`) | 2.9 (pulled early) | `apps/web/lib/api-result.ts` (new), `lib/server-api.ts` | **landed** (scaffolding only — call sites still `unwrap()` to `null`) |
| `pnpm-lock.yaml` regenerated for 9 new devDependencies + helmet + throttler | — | `platform/pnpm-lock.yaml` | **landed** (integration pass) |

---

## 2. The security fixes, in detail

### 2.1 The operator-console hole (§0.1) — closed in code, open in config

This was the highest-priority item in the plan and it is the one with the largest live blast radius.

**Before.** `isOperator()` ended with `if (OPERATOR_EMAILS.length === 0) return true;`. In
production `PLATFORM_OPERATOR_EMAILS` is unset (confirmed: `grep -c '^PLATFORM_OPERATOR_EMAILS='
platform/.env.production` → **0**). `NEXT_PUBLIC_SUPABASE_ANON_KEY` ships in the browser bundle and
Supabase enables `/auth/v1/signup` by default. Full chain: stranger self-signs-up → signs in →
middleware passes (it proves *a* session, not *whose*) → `(platform)/layout` finds no membership →
`isOperator()` returns true → every tenant's calls, transcripts and recording audio. `/admin` was
worse: that route group had **no layout at all**, so its only gate was the middleware.

**After.**
- `owner-context.ts:183` — `if (OPERATOR_EMAILS.length === 0) return false;`. Empty means nobody.
- `owner-context.ts:72-80` — a module-load `console.error` naming the variable, because the symptom
  (a correct login seeing "No console access") does not name its own cause.
- `app/(admin)/layout.tsx` — new; a customer owner is redirected to `/owner`, a signed-in
  non-operator gets the refusal card. `/admin` may never be laxer than `/dashboard`.
- `app/(platform)/layout.tsx` — same three decisions, same card.
- The one remaining open branch is `if (!AUTH_ENABLED) return true` (line 178), which requires
  `NEXT_PUBLIC_SUPABASE_URL`/`ANON_KEY` to be absent. `instrumentation.ts` now makes that state
  fatal in production, so it cannot be reached by a deployed console.

**How to confirm.** Create a throwaway Supabase account against the production project, sign in at
`https://aura.sirahagents.com`, and open `/dashboard`, `/instances` and `/admin` in turn. All three
must render the "No console access" card. Delete the account afterwards. This is the plan's own exit
check and it has not been run yet — it cannot be, until §3 step 4 sets the allowlist.

Grep-level check: `grep -n "OPERATOR_EMAILS.length === 0" platform/apps/web/lib/owner-context.ts`
must show `return false`.

### 2.2 The `dev-admin-key` root credential (§0.2)

`ADMIN_API_KEY` is the single credential protecting all 21 org-scoped tables plus `organizations`
and `users`, for every tenant — `AdminKeyGuard` mints a synthetic `platform_admin` with
`recordingsListen`/`recordingsExport` true and trusts the `x-org-id` header, validating only that
the org *exists*. It reaches 20 controllers, including the two `@CrossTenant()` surfaces that query
on `adminPool()` and bypass RLS entirely.

**Before.** `admin-key.guard.ts:36` — `process.env.ADMIN_API_KEY ?? "dev-admin-key"`. A string
published in this repository was a working root credential the moment one env var went missing.

**After.** `resolveAdminKey()` (`admin-key.guard.ts:28-33`) returns `null` under
`NODE_ENV=production` when the variable is unset. A `null` configured key can never match a
presented header, so the guard denies rather than accepting the literal — defence in depth behind
the boot assertion, so the hole cannot reappear via a code path that skips `bootstrap()`.

**How to confirm.**
```
grep -n -A6 "export function resolveAdminKey" platform/apps/api/src/common/admin-key.guard.ts
```
must show `if (env.NODE_ENV === "production") return null;`. Then, against a running production API:
`curl -s -o /dev/null -w '%{http_code}\n' -H 'x-admin-key: dev-admin-key' https://<api>/v1/admin/tenants`
must not be 200.

**Honest gap.** The plan named *two* sites. `apps/web/lib/server-api.ts:10` still reads
`process.env.ADMIN_API_KEY ?? "dev-admin-key"` and was not changed. It is covered indirectly —
`instrumentation.ts` throws before the first request when the variable is unset in production — but
that is a single chokepoint, which is exactly the argument the API side rejected for itself. Fix it
the same way `resolveAdminKey()` does, or delete the fallback outright; the web tier has no
equivalent to "make `pnpm dev` work with no setup" that a seeded `.env.development.local` cannot
also provide.

### 2.3 `JWT_SECRET` — Stage 0.2 half done

`process.env.JWT_SECRET ?? "dev-jwt-secret-change-me"` is still live at four sites, all inside the
API partition and all seen by the developer (`assert-env.ts`'s own header enumerates them):

| File | Use |
|---|---|
| `common/device-auth.guard.ts:33` | verifies the device access token |
| `common/device-nonce.ts:5` | HMACs the enrollment nonce |
| `modules/devices/devices.controller.ts:193` | **signs** the 15-minute device access token |
| `modules/tenancy/erasure.controller.ts:97` | signs the erasure receipt |

The literal is published in `platform/.env.example`. `device-auth.guard.ts:31-43` takes `org_id`,
`instance_id` and the device id straight off the JWT payload, so a forged token yields `POST /v1/calls`
ingest and transcript reads for any device in any tenant. `JWT_SECRET` **is** set in
`.env.production`, so this is not live exposure — but it is the same shape as the hole that was
closed, treated differently, and it was not listed as a follow-up.

**Fix:** a `jwtSecret()` helper mirroring `resolveAdminKey()`, used at all four sites. Behaviour is
byte-identical whenever `JWT_SECRET` is set. Left unapplied because it is five files in the live
device-auth hot path with zero test coverage — do it with the guard suite from §1.3, not before.

### 2.4 HTTP hardening (§0.7)

`main.ts` went from 15 lines with no protections to:

| Control | Detail |
|---|---|
| `helmet()` | default header set |
| body limit | `useBodyParser("json", { limit: "1mb" })` — Nest's default is 100 kB; the largest real body is the multipart part list on `POST /v1/calls/:id/complete` |
| `trust proxy 1` | **load-bearing.** Caddy is the only thing that can reach the process. Without this, `req.ip` is Caddy's container address for every external request, which collapses every per-IP limit into one shared bucket — the 5/min login limit would then let any stranger lock every customer out of signing in |
| CORS | `WEB_ORIGIN` parsed as a comma-separated allowlist (`config/cors.ts`). A single value behaves exactly as before, so no deployment change is required |
| throttling | global `ThrottlerGuard` via `APP_GUARD`; 100/min default, `@Throttle(5/min)` on `POST /v1/auth/login`, `@Throttle(10/min)` on `POST /v1/devices/register` |

The login limit is worth more than it looks: `AuthService.login` and `/v1/auth/context` both
sequentially scan `users` on `lower(email)` (the `UNIQUE(email)` btree cannot serve a `lower()`
predicate, and no expression index exists), and `/v1/auth/context` fires on **every** owner-console
page render. The limit protects an unindexed query, not just an endpoint.

**How to confirm.** `curl -I https://<api>/v1/health` shows helmet's headers
(`x-content-type-options`, `x-frame-options`, …). Six rapid `POST /v1/auth/login` with a wrong
password: the sixth returns 429. `curl -H 'Origin: https://evil.example' -I` on any route returns no
`access-control-allow-origin` for that origin.

### 2.5 The RLS invariant (§1.5)

**Before.** `verify-rls.js` proved isolation for **three** tables from a hand-kept list (the
report's claim of four credited its own new `telecallers` block to the baseline — see §5.6). All 21
`org_id` tables are correctly protected *today*, so this was latent, not an active breach. The real
defect: migration `0007`'s FORCE-RLS loop is derived from `pg_policies`, so a table added **without**
a policy is silently skipped rather than loudly broken — it ends up with `relrowsecurity=false` AND
`relforcerowsecurity=false` and looks like an ordinary non-tenant table. Migration `0019` could add
an `org_id` table with no policy and CI would stay green, at which point `aura_app` — the API's own
runtime role — reads and writes it cross-tenant with no database backstop.

**After.** The script now *derives* the table set from `information_schema.columns` and computes a
set difference against `pg_class` (`relforcerowsecurity`, the load-bearing flag — the migration owner
would bypass a merely-*enabled* policy) and `pg_policies`. Any table carrying `org_id` without FORCE
+ a policy fails the build **by name**. It also asserts each policy has a `WITH CHECK` and not only a
`USING` (a `USING`-only policy blocks cross-tenant reads and silently permits cross-tenant *writes*),
handles `organizations` as its named special case (`org_self`, keyed on `id`), and carries a
two-entry commented allowlist for `users` and `schema_migrations` so growing it requires a reviewed
edit. New behavioural assertions cover `usage_events` DELETE/UPDATE denial and the presence of
`TRANSCRIPTION_OFF` / `'dead'` in the live CHECK constraints, turning the `enums.ts` drift in §4.3
into a CI failure rather than a latent trap.

**Also added — the highest-value guard in the run.** `assertDisposable()` refuses to run unless the
target host is in `{localhost, 127.0.0.1, ::1, postgres, db}` or `RLS_TEST_ALLOW_REMOTE=1` is set
explicitly. The script seeds with `DELETE FROM organizations WHERE name LIKE 'rls-test-%'`, which
cascades to all 21 tenant tables. It was previously one exported `DATABASE_URL` away from running
destructive deletes against live customer data.

**How to confirm.** `node --check platform/packages/db/verify-rls.js` parses. Push the branch and
read the CI `db` job: it runs migrations against an ephemeral `postgres:16-alpine` on
`127.0.0.1:5432` (job-scoped literals, zero `secrets.*` references in the whole workflow) and must
be green. To prove it is non-vacuous, add a table with `org_id` and no policy to a scratch migration
and confirm the job goes red naming that table.

### 2.6 Typed API results (§2.9, pulled early)

`apiGetAs` returned `null` on any non-2xx **and** on any thrown error — 35 such catches across the
web app, making a 403, a 500, an expired session and a genuinely empty result indistinguishable.
That is the mechanism behind the "renders only the loading skeleton with HTTP 200" bug class.
`lib/api-result.ts` now defines `ApiResult<T>` and `classifyStatus()`, and `server-api.ts` produces
it. **This is scaffolding only** — call sites still funnel through `unwrap()` back to `null`, so no
page renders a distinct state yet. The type exists so Stage 2.9 is a migration rather than a
rewrite. Do not read it as delivered.

---

## 3. ⚠️ ACTION REQUIRED BEFORE DEPLOY

Two of this run's changes **fail closed**. That is the point of them, and it means the deploy will
break unless the environment catches up first. Do these in order. Steps 1–5 are on the VPS; step 6
is the Supabase dashboard.

All variable-presence facts below were checked by **name only** (`grep -c '^NAME='`) against
`platform/.env.production`. No value was read and no env file was executed.

### Step 1 — Verify what is missing (do this first, on the VPS)

```bash
cd /path/to/platform
for v in ADMIN_API_KEY JWT_SECRET CRM_SECRET_KEY APP_DATABASE_URL \
         SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY PLATFORM_OPERATOR_EMAILS \
         NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY; do
  printf '%-32s %s\n' "$v" "$(grep -c "^${v}=" .env.production)"
done
```

Expected result today, and what each zero means:

| Variable | Present? | Consequence if left as-is |
|---|---|---|
| `ADMIN_API_KEY` | ✅ 1 | — |
| `JWT_SECRET` | ✅ 1 | — |
| `APP_DATABASE_URL` | ✅ 1 | — |
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | ✅ 1 each | — |
| **`CRM_SECRET_KEY`** | ❌ 0 | **API crash-loops. Total outage.** |
| **`PLATFORM_OPERATOR_EMAILS`** | ❌ 0 | **You are locked out of the console.** |
| `SUPABASE_SERVICE_ROLE_KEY` | ❌ 0 | Owner sign-in provisioning is already broken today (§3.5) |
| `SUPABASE_URL` | ❌ 0 | Falls back to `NEXT_PUBLIC_SUPABASE_URL`; sets a boot warning only |

### Step 2 — `CRM_SECRET_KEY` — **blocks the deploy; without this the API does not start**

`assert-env.ts` treats `CRM_SECRET_KEY` as fatal in production, and `docker/node.Dockerfile:37`
bakes `ENV NODE_ENV=production` into the runtime image. The exact failure path:

```
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
  → api container starts, NODE_ENV=production, env_file: .env.production
  → main.ts:15 assertRequiredEnv()
  → assert-env.ts inspect() → "is not set (or is empty)" for CRM_SECRET_KEY
  → throw → `void bootstrap()` unhandled rejection → exit 1
  → restart: unless-stopped → permanent crash loop
```

The API, the server-rendered console (which fetches `http://api:4000`) and all device ingest go down
together. The compose healthcheck never passes.

**Fix — safe, and safe *because* the variable is currently unset:**

```bash
# 64 hex chars
openssl rand -hex 32
# append to platform/.env.production
CRM_SECRET_KEY=<the 64 hex chars>
```

Generating a **new** key is correct here, not dangerous. `warnIfSecretsUnencrypted()` already logs
`FATAL-ADJACENT` on every boot today, which confirms the variable has never been set — so every
stored CRM credential is currently **plaintext**, not sealed under some lost key.
`packages/db/src/secrets.ts` `decryptSecret()` returns unprefixed rows unchanged, so existing
plaintext credentials keep working and new writes get sealed under the new key. Once this is set,
**back it up before doing anything else** — see §6.6; it is unrecoverable and it seals every CRM
credential from that moment on.

Do not soften the assertion instead. That silently undoes the security control that was the entire
point of Stage 0.2.

### Step 3 — the other two REQUIRED vars

`assert-env.ts` reports *all* offenders in one error, so a restart loop needs one pass over the file,
not four deploys. `ADMIN_API_KEY`, `JWT_SECRET` and `APP_DATABASE_URL` are present and hold no
rejected literal, so `CRM_SECRET_KEY` is the single trigger — but the assertion also rejects:

- exact matches on `dev-admin-key`, `dev-jwt-secret-change-me`, `changeme`,
  `replace-with-a-long-random-key`, `replace-with-openssl-rand-hex-32`, and the local
  `postgresql://aura_app:aura_app_password@localhost:5433/callintel`
- `APP_DATABASE_URL` still containing the literal tokens `PROJECTREF` or `APP_DB_PASSWORD_VALUE`
- any value beginning `replace-with`, `your-`, `changeme`, `change-me`, `todo`

Secrets shorter than 24 characters **warn** and do not block — refusing to boot over a short-but-real
key would take the platform down to fix a weakness it is already living with, and you cannot rotate
a key while the API is in a crash loop.

### Step 4 — `PLATFORM_OPERATOR_EMAILS` — **blocks console access; without this you are locked out**

This is §0.1 step 3, and it must ship in the **same** deploy as the code, not after it. With the new
`isOperator()` deployed against the current file, `AUTH_ENABLED` is true and `OPERATOR_EMAILS` is
empty, so every account gets the "No console access" card at `/dashboard`, `/instances` and `/admin`.

```bash
# platform/.env.production
PLATFORM_OPERATOR_EMAILS=support@sirahdigital.in
```

Comma-separated, no spaces required (the parser trims and lower-cases). Consumed by the `web`
service via `env_file`. It is a **runtime** variable, so a rebuild is not required — but a
`docker compose up -d` is.

Customer `/owner` routes are unaffected: `(owner)/layout.tsx` gates on `getOwner()` membership, not
`isOperator`. Only the platform-operator console is at risk.

Two documents still describe the **old, inverted** semantics and will walk an operator straight back
into the lockout. Fix them in this same change:
- `platform/DEPLOYMENT.md:156-164` — "Optionally restrict… blank means any signed-in non-owner does"
- `platform/.env.production.example:155-158` — same wording

After 2026-08-06 the truth is: **blank means nobody.**

### Step 5 — `SUPABASE_SERVICE_ROLE_KEY` (advisory in code, broken in practice)

`assert-env.ts` only warns on this one, deliberately: an unset Supabase key *closes* a feature rather
than opening a door, and crashing a live API over a provisioning capability would be a self-inflicted
outage. But the finding underneath is real and pre-dates this run.

`supabase-admin.service.ts:19-24` reads `SUPABASE_URL ?? NEXT_PUBLIC_SUPABASE_URL` (so the URL
resolves) but `SUPABASE_SERVICE_ROLE_KEY` has **no fallback** and is absent from `.env.production`;
`docker-compose.prod.yml` passes it nowhere. So creating an owner sign-in from the console throws
`"Supabase Auth is not configured on the API"` in production **right now**. The new boot warning is
what will make that visible on the next restart.

Set it alongside the rotation in §6.2 — rotate the `service_role` key first, then write the new value
in once, rather than writing the stale one and rotating twice.

### Step 6 — Supabase dashboard (§0.1 step 1) — code cannot do this

Do this **before** or **with** the deploy, not after. It is the other half of the console hole: the
code change stops a self-signed-up stranger from becoming an operator; this stops them from getting
an account at all.

1. Authentication → Providers → **Email → disable signups.**
2. Confirm no other provider is enabled (Google, magic link, phone).
3. Authentication → Users → confirm every row is an account you created. If there are others,
   treat it as an incident: rotate per §6.2, audit `audit_log`, and check MinIO access logs.

### Deploy order, condensed

```
1.  Supabase dashboard: disable email signups; audit auth.users
2.  Edit platform/.env.production on the VPS:
      CRM_SECRET_KEY=<openssl rand -hex 32>          # or the API will not boot
      PLATFORM_OPERATOR_EMAILS=support@sirahdigital.in  # or you are locked out
      SUPABASE_SERVICE_ROLE_KEY=<rotated key>        # optional now, fixes owner provisioning
3.  Vault CRM_SECRET_KEY immediately (§6.6) — it is unrecoverable from this point
4.  Correct DEPLOYMENT.md §7 and .env.production.example (PLATFORM_OPERATOR_EMAILS semantics)
5.  Deploy. Watch `docker compose logs -f api` for the [env] block on first boot.
6.  Exit check: create a throwaway Supabase account, sign in, confirm /dashboard,
    /instances and /admin all render "No console access". Delete the account.
7.  Exit check: sign in as support@sirahdigital.in, confirm the console is reachable.
```

Note for whoever commits: `.gitattributes` is new and untracked. Landing it will silently
renormalise any of the 47 CRLF files that get staged alongside it, mixing whole-file line-ending
diffs into this commit. **Land `.gitattributes` on its own commit, on a quiet tree**, and run
`git add --renormalize .` as a separate commit after that.

---

## 4. Data findings

From a full read of migrations 0001–0018. `packages/db/migrations` and `platform/supabase/migrations`
are byte-identical — no drift. **24 tables** (23 application + `schema_migrations`), **21 carrying
`org_id`**.

### 4.1 The RLS coverage gap

All 21 `org_id` tables have FORCE RLS and an `org_isolation` policy **today**. This was a latent
gap, not an active breach — and §2.5 closes it. The exact 21: `agents`, `ai_outputs`, `api_keys`,
`audit_log`, `call_facts`, `call_notes`, `calls`, `crm_integrations`, `crm_sync_log`,
`device_health`, `devices`, `enrollment_tokens`, `instances`, `leads`, `memberships`, `recordings`,
`sessions`, `telecallers`, `transcripts`, `usage_events`, `workspaces`.

**`users` is the outlier and is not fixed.** It has no `org_id`, no RLS at all, and holds `email`,
`password_hash` and `sso_subject` for every tenant on the platform. `AuthService` runs entirely on
`adminPool()` — the RLS-bypassing owner connection — including `principalFromToken` and `logout`,
which operate on `sessions`, a table that *does* have RLS. The tenant boundary on the platform's
identity table is 100% application code. The new allowlist in `verify-rls.js` makes this visible in
CI output rather than silent, which is the most that could be done without a schema change.

### 4.2 Orphan columns — 26 of them, plus one fully orphan table

Ordered by consequence, not by table.

| Table.column | Kind | Consequence |
|---|---|---|
| **`device_health` (whole table, 11 cols)** | never read | **Orphan table.** One INSERT (`device-telemetry.controller.ts:49`), zero SELECTs anywhere. Every handset writes a health beacon on an interval and the platform never reads it. This is ~80% of the data Stage 5's feature 3.1 (Recording-Assurance-SLA) needs, already being collected and thrown away. `perms` and `failure_counts` are absent from even that one INSERT. |
| `instances.default_agent_id` | both | Never written either — one repo-wide occurrence, and it is a TODO comment. Routing is "the one `is_active` agent per workspace" (`pipeline.ts:341`), which caps a tenant at **one extraction shape**. Hard blocker for feature 1.1 (an objection agent cannot coexist with the lead agent). |
| `api_keys.key_hash` | never read | **The API-key feature is a facade.** Written at `apikeys.controller.ts:47`; nothing anywhere hashes an inbound key and looks it up. A customer can mint a `cik_live_` key in the console and it authenticates nothing. `last_used_at` is read and rendered but never written — always NULL, consistently. |
| `leads.telecaller_id` | never read | Written by the worker (`leads.ts:193`); `LEAD_COLUMNS` reads `telecaller_device_id` and joins `devices` instead. Index `leads_org_telecaller_id` is dead. Worse: the PATCH at `leads.controller.ts:262` reassigns `telecaller_device_id` without touching `telecaller_id`, so the two **diverge permanently** on first re-attribution — re-creating the exact handset-reassignment bug migration 0017 was written to fix. |
| `organizations.region` | written, read, **never used** | *This corrects the brief, which said it was never written.* It IS written (`admin.controller.ts:74`) and displayed in the console — but all four S3 clients hardcode `process.env.S3_REGION ?? 'ap-south-1'`. A tenant provisioned `eu-west-1` has its recordings in `ap-south-1` while the console says otherwise. That is a **false data-residency claim** in a product sold on data-protection terms — worse than an unwritten column. |
| `recordings.encrypted` | both | Defaults `true`, never checked. Encryption-at-rest is not implemented. The column asserts a security property that does not hold. |
| `ai_outputs.cost_usd` | both | Zero occurrences in TypeScript. Per-call LLM cost is unknowable, so unit economics cannot be measured per tenant or per agent. Blocks §3.2 and therefore §3.3 and §4.1. |
| `ai_outputs.schema_version` | both | An agent's `field_schema` can change under a stored output with no way to know which shape produced it — poisons any historical re-analysis. |
| `transcripts.confidence` | both | `AsrResult` has no confidence field. Blocks feature 5.2 (human-in-the-loop) and part of 5.1. |
| `usage_events.workspace_id` | both | Omitted by all three INSERT sites; no FK. Per-workspace metering impossible. `ref_id` is set to the call id and never selected — per-call cost attribution impossible even though the linkage is stored. |
| `usage_events` kind `asr_seconds` | never read | Written at `pipeline.ts:217`; the only consumer filters on `llm_tokens_in`/`llm_tokens_out`. **ASR seconds are metered and billed nowhere.** |
| `calls.source_id` | both | The OEM recording's own id is discarded at ingest, so a duplicate upload of the same recording cannot be detected. Relevant to §3.6. |
| `audit_log.ip` | both | Zero write sites across ~20 `INSERT INTO audit_log` statements. Every audit row has a NULL source address — a real problem for §4.3's evidence trail. |
| `devices.os_version`, `devices.app_version` | never written | Both read into the fleet list. An operator cannot tell which handsets are on an old build — the first question in any capture-failure triage. |
| `devices.refresh_token_hash` | never read | Written once at enrollment, never verified. The "long-lived refresh token" design in migration 0002's header does not exist in code. |
| `organizations.plan_id`, `.billing_customer_id`, `instances.limits`, `workspaces.settings`, `agents.scoring`, `agents.crm_mapping`, `calls.ended_at`, `recordings.codec`, `recordings.sample_rate` | both / never read | Dead surface. `plan_id`/`billing_customer_id` mean plan and billing linkage are not modelled anywhere — relevant to §4.1. |

### 4.3 Data-integrity defects

**`packages/shared/src/enums.ts` is out of sync with two live CHECK constraints — the single most
dangerous fact here.** `CallStatus` omits `TRANSCRIPTION_OFF` (added by 0014, written at
`pipeline.ts:511`); `CrmSyncStatus` omits `'dead'` (added by 0008, written routinely at
`outbox.ts:111`). Both feed `Call` in `entities.ts`. Latent today because nothing parses a live row
through `Call` — but it is exactly the file anyone writing fixtures or typed API results reaches
for, and fixtures built from it produce tests that pass while the code is wrong. `verify-rls.js` now
asserts both values are present in the live constraints, so the drift becomes a CI failure. **The
file itself is still wrong** and is out of every partition's scope — fix it before Stage 2.

**Transcode has no `try/catch` and two call states are unreachable.** `pipeline.ts:521-542` is a
pass-through; `fail()` is only ever called with `'ASR'` and `'ANALYZE'`, so `FAILED_TRANSCODE` and
`FAILED_CRM` are unreachable despite being in the CHECK constraint, offered as UI filters and listed
as stages. A throw in transcode — which the ffmpeg work in §3.5 *will* introduce — escapes
`processCall` entirely: no `error_message`, no attempt increment, no `next_attempt_at`. The call is
stranded in `TRANSCRIBING`/`TRANSCODING` where neither the retry sweep (`FAILED_%` only) nor the
stuck-upload sweep (`UPLOADED` only) will ever find it. **Silent permanent data loss.** Fix this
before §3.5, not with it.

**Cross-tenant write reachable from the operator console.** `members.controller.ts:127` —
`UPDATE memberships SET role = COALESCE($2, role), ... WHERE user_id = $1`, with no `org_id` and no
scope filter. An operator editing one tenant's team member updates **every** membership that user
holds, in every org. Migration 0018's header anticipates this risk and works around it for
`owner_role`; the `role` column itself is still exposed.

**Missing indexes on the pipeline hot path.** `transcripts` (GIN on `tsv` only), `recordings` and
`ai_outputs` (PK only) have **no index on `call_id` at all**, and each is read by `call_id` several
times per call — `transcripts` at five sites in `pipeline.ts` plus a LEFT JOIN in `crm-dispatch.ts`;
`ai_outputs` via a correlated subquery in both `leads.ts` and `crm-dispatch.ts`. Every one is a
sequential scan of the tenant's entire corpus, several times per call, and again on every CRM
delivery and every reaper/erasure sweep. It degrades superlinearly with tenant age: **the customers
who have been live longest get slowest.** Two more:
- `requeueStuckUploads` (`retry.ts:88`) full-scans the entire multi-tenant `calls` table on the
  admin pool **every 30 seconds, forever** — the only status index is `(org_id, status)`, which a
  cross-tenant query cannot use. Needs `calls(status, updated_at)`.
- The Call Explorer list (`calls.controller.ts:311`) orders by `c.started_at DESC` with no
  `workspace_id` predicate, so `calls_ws_started (org_id, workspace_id, started_at DESC)` cannot
  serve it. The single most-executed read in the console scans the tenant's whole calls table. The
  reaper has the same problem. Needs `calls(org_id, started_at DESC)`.

**A suspended tenant is still fully live.** `login()` checks `users.status` but never
`organizations.status`, and `owner-context.ts:125` falls back to `memberships[0]` when no active
membership exists. A user in a `suspended` or `churned` org can still mint a session token and read
every tenant-scoped endpoint. Separately `reaper.ts:23` selects only `status='active'` orgs, so a
suspended tenant's calls, transcripts and leads are **retained indefinitely past their own
`retention_days`** — a retention-policy violation on exactly the accounts most likely to be in a
dispute.

**Account takeover via email fallback.** `contextFor` matches `sso_subject` first but falls back to
`lower(email)`, ordered `(sso_subject = $1) DESC NULLS LAST`. A Supabase account whose email equals a
provisioned owner's resolves to that owner's membership **with a different subject**. `sso_subject`
is write-once and never rotated. Do not widen this; narrow it in §2.1.

**Personal data outlives instance deletion.** `instances.controller.ts:238` removes calls and
cascades devices but never touches `leads` — `telecaller_device_id` and `first_call_id`/`last_call_id`
go NULL and the lead survives holding `contact_name`, `contact_number_hash`, `summary` and `facts`.
`ErasureController` handles this correctly; the offboarding path does not. A GDPR Art.17 / DPDP gap
on the offboarding route specifically.

**Tenant deletion has never been exercised.** `calls.device_id` is the only FK in the schema with no
`ON DELETE` clause (defaults `NO ACTION`), and no `DELETE FROM organizations` or `DELETE FROM devices`
path exists anywhere. `instances.controller.ts:198` guards on a call count taken in a *separate*
statement from the delete, so a call landing in between turns offboarding into a 500.

**Zero defence in depth on several aggregate queries.** `leads.controller.ts:75`
(`SELECT lead_stages FROM organizations LIMIT 1`, no WHERE), `analytics.controller.ts:52`,
`billing.controller.ts:41,44`, `apikeys.controller.ts:66` are all correct **only** because RLS
narrows the result set. One `adminPool()` import slip returns an arbitrary tenant's data with HTTP
200 — the exact silent-wrong-customer failure mode this codebase has been burned by four times.

**`sessions` grows unbounded.** No sweep ever deletes rows past `expires_at`.

---

## 5. Known-broken / deliberately deferred

### 5.1 The four `.skip`ped tests — each is a bug report, not a gap

They are green-adjacent by design: each sits next to a passing test that pins *today's* wrong
behaviour, so the regression check and the record of current behaviour cannot drift apart. Un-skip
each one when its named fix lands.

| Test | File | The bug |
|---|---|---|
| "scores confidence using the platform-wide definition of a filled fact" | `apps/worker/src/pipeline/crm-dispatch.test.ts:283` | `confidenceScore` uses a local filled-ness check that disagrees with `isFilled` from `@aura/shared` on exactly the values the LLM produces most often for "not mentioned" (whitespace, `"[]"`). A call `qualifyLead` would score as **zero** filled fields is delivered to the customer's CRM with `confidenceScore` **1.0** — the maximum. That number is rendered into a CRM field and used by sales teams to triage, so it overstates precisely the leads that deserve least trust. Fix: one-line swap to `isFilled` in `crm-dispatch.ts`. |
| "rejects an enum field that declares no options" | `packages/shared/src/extraction.test.ts:175` | `extraction.ts:112` compiles `field.enumValues ?? []` — an empty enum no value can satisfy. **Every** call for that agent validates as failed, and with default lead rules a failed validation blocks lead creation. One un-filled dropdown in the agent editor silently stops a tenant's board receiving anything. Fix: reject at parse/save time. |
| "rejects a bare number string for a datetime field" | `packages/shared/src/extraction.test.ts:331` | The datetime check is `Date.parse`, not an ISO check, despite the error text promising one. `Date.parse("5000")` succeeds, so a model answering `quotation_date` with the *quantity* validates cleanly and lands in the customer's CRM as **the year 5000**. |
| "does not escalate a case variant of a restricted persona to owner" | `packages/shared/src/roles.test.ts:76` | `resolveOwnerRole("Telecaller")` → `"owner"`, the most permissive persona. The fail-open on `null` is deliberate and documented; the fail-open on a *case variant* is not. **Reachability is narrower than the developer claimed** — 0018's CHECK rejects case variants on INSERT/UPDATE, so no admin UI or CSV import can persist one. It is reachable only for a value that never round-trips through `memberships.owner_role` (a JWT claim or header read straight into the resolver) — which is exactly what Stage 2.1 introduces. Fix before then: lower-case and trim in the resolver. |

### 5.2 `verify-rls.js` cannot satisfy the second half of §1.5

§1.5 says "run it in the `migrate` container after every migration, so a bad migration fails the
deploy." Production is Supabase — a non-local host — so `assertDisposable()` refuses and exits 1,
failing the deploy for the wrong reason. The only way past is `RLS_TEST_ALLOW_REMOTE=1`, which
re-enables `DELETE FROM organizations WHERE name LIKE 'rls-test-%'` (cascading to all 21 tenant
tables) plus two INSERTs against live customer data. **Do not do that.**

The fix is a design change nobody owned this run: `structuralChecks()` is entirely read-only
(`information_schema.columns`, `pg_class`, `pg_policies`, `pg_constraint`) and is the half that
actually catches a bad migration. Split it behind a flag — `verify:rls:structural` — and run *that*
in the migrate container. The destructive behavioural half stays CI-only. Small change; it needs an
edit to `docker-compose.prod.yml` and `DEPLOYMENT.md`, both outside every partition this run.

### 5.3 Throttler exemptions deviate from the plan

`@SkipThrottle()` on `POST /v1/devices/challenge` and `POST /v1/devices/authenticate` removes the
100/min default from two **unauthenticated** endpoints. The stated justification (a NATed fleet would
be throttled) does not survive its own arithmetic: device tokens live 15 minutes, so N handsets
behind one IP generate N/7.5 req/min across the pair — reaching 100/min needs ~750 handsets on one
source IP. Meanwhile the pair is an anonymous amplifier: `/challenge` mints a valid HMAC nonce with
no auth, and `/authenticate` then runs a JOIN on `adminPool()` — the privileged, non-RLS pool —
*before* any signature check, plus an ECDSA verify per request. Unlimited anonymous admin-pool
queries from a single host.

There *is* a real reason to keep an exemption (a thundering herd of re-auths after an API restart),
which is why this is reported rather than reverted. Pick a generous limit rather than none.

Mirror-image note on `@Throttle(10/min)` for `POST /v1/devices/register`: the number is mandated
verbatim by §0.7, but under `trust proxy 1` it is per source IP, and enrolling a 20-handset fleet in
one sitting — the normal way a new tenant goes live — 429s from the eleventh phone onward. Visible
and retryable, but expect it during onboarding.

### 5.4 `ValidationPipe` was not added — correctly

§0.7 lists `app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))`. It is not
in `main.ts`. That is the right call and should be recorded as such rather than as a miss:
`ValidationPipe` acts on `class-validator` decorators, `class-transformer`/`class-validator` are not
dependencies of `apps/api`, and 19 controller modules validate with **zod** instead. Adding it would
be inert. Strike the line from the plan.

### 5.5 CI is missing the integration job

§1.4 specifies `lint → typecheck → unit → integration (services: postgres, rabbitmq, minio) →
tenancy:check → verify:rls → docker build`. The workflow has exactly four jobs — `static`, `unit`,
`db`, `build` — and the only `services:` block is `jobs.db.services.postgres`. There is no
integration job, no rabbitmq, no minio, and no Android workflow. §1.3's suites do not exist yet, so
an empty job would be scaffolding — but the gap was silently dropped rather than reported.

Branch protection on `main` is a GitHub setting and is not configured.

### 5.6 Smaller items left for a human

- **Server Actions are not gated.** §2's route-group layouts gate *rendering*, not Server Action
  invocation. The eight `"use server"` files under `app/(platform)/` contain zero identity checks —
  `createTenantAction` POSTs `/v1/admin/tenants` with the root key and returns a one-time enrollment
  key; `searchTranscriptsAction` takes an arbitrary `orgId` and searches **any** tenant's transcripts.
  An account that obtains a Next-Action id still reaches both while `/dashboard` shows it the
  refusal card. Materially narrower than before (action ids are no longer served in a payload it can
  render) and **not a regression** — everything was open before — but not closed. Fixing it means a
  guard in eight action files.
- **`OwnerRoleGuard` fails open** for admin-key callers with no asserted persona
  (`owner-role.guard.ts:41`). The web tier asserts one via `x-caller-owner-role`, so real console
  traffic is checked and nothing else is. This is §2.5's transition state and is correct *as a
  transition*; the v2 spec's §9 claim that owner roles are "enforced server-side on every API
  endpoint" is not yet true.
- **`pipeline.test.ts:74`** asserts `MAX_PIPELINE_ATTEMPTS === 5`, read from
  `process.env.PIPELINE_MAX_ATTEMPTS` at module load. Any shell or runner exporting that variable
  fails two tests with no defect present. Needs `vi.stubEnv` + a dynamic import.
- **Test files compile into `dist/`.** All four tsconfigs are `include: ["src"]` with no `exclude`,
  so `pnpm build` emits 18 test artifacts into `dist/` and they ship inside the production image.
  Harmless today (the builder stage installs devDependencies so `vitest` resolves), but a
  production-only install makes `tsc` fail with TS2307. The one-line `exclude` has a real cost — it
  drops the tests out of `tsc --noEmit`, removing type coverage from the only tests this repo has.
  Correct fix is a `tsconfig.test.json` per package.
- **Lint baseline: 32 problems — 7 errors, 25 warnings.** All 25 warnings are auto-fixable
  `import/order`. Of the 7 errors, 5 are genuine floating/misused promises and 2 are "Definition for
  rule not found" from inline disable comments for `@next/next` and `jsx-a11y`, which the new flat
  config does not register. **All 7 sit in files no developer touched this run** — pre-existing code
  surfaced by a first-ever lint. `prettier --check` reports 97 unformatted files. CI runs both steps
  with `continue-on-error: true` and a TODO to flip it after a cleanup pass; neither turns the
  pipeline red today.
- **`verify-rls.js`'s new header comment states a false fact about its own history** — it credits its
  own new `telecallers` assertions to the baseline (HEAD covers three tables, not four). Harmless to
  behaviour; correct the comment.

---

## 6. What Stage 0 still needs that code cannot do

None of this is blocked on anything. All of it is Stage 0, and Stage 0's exit check cannot be
answered without it.

**6.1 — Disable Supabase email signups, audit `auth.users`** (§0.1 steps 1 & 4). See §3 step 6. This
is half of the highest-priority item in the plan and the code change does not substitute for it.

**6.2 — Rotate the exposed secrets** (§0.3). The Supabase DB password and `service_role` key were
pasted into a chat transcript on 2026-07-22 and have not been rotated; assume `ADMIN_API_KEY` is
stale for the same reason.
- Rotate the DB password → re-run `bootstrap-role.js` **and** update `APP_DATABASE_URL` in the same
  change. They are one atomic operation (`DEPLOYMENT.md` §8).
- Rotate `service_role` → and set `SUPABASE_SERVICE_ROLE_KEY` while you are there (§3 step 5); owner
  provisioning is broken until you do.
- Rotate `ADMIN_API_KEY` → VPS `.env.production` **and** every provisioning script.
- **Switch the Supabase Data API off entirely.** There is no PostgREST client in this stack; it is
  pure attack surface, and it sits in front of a `users` table with no RLS (§4.1).

**6.3 — Off-box recording backup with a *tested* restore** (§0.4). `miniodata` is one volume, on one
disk, on one VPS, holding every recording every customer has ever made. Postgres is covered by
Supabase; this is not. Backblaze B2 bucket (~$0.006/GB/month), nightly systemd timer running
`mc mirror --overwrite --remove`, **object versioning on** so a bad mirror cannot propagate a
deletion. Then restore one recording to a scratch path and **play it**, and write the exact commands
into `DEPLOYMENT.md` §8. An untested backup is a hypothesis.

**6.4 — Sentry** (§0.5) in `apps/api`, `apps/worker`, `apps/web`. Three DSNs, ~30 minutes. Note
`instrumentation.ts` already exists in the web tier, which is where the Next SDK wants to
initialise — add it there rather than creating a second entry point.

**6.5 — UptimeRobot + the daily digest** (§0.5). External checks on `GET /v1/health` and the web
`/login`. Then one worker cron posting a daily summary: calls ingested, calls COMPLETE, calls
`FAILED_*` with `next_attempt_at IS NULL`, CRM deliveries pending, devices silent >24h. Ten lines,
and it would have caught the Gemini credit exhaustion on day one instead of by hand-reading worker
logs. Once §6.3's `device_health` writers exist you already have the data (§4.2) — today it is
written and discarded.

**6.6 — Vault the two unrecoverable secrets** (§0.6). Do `CRM_SECRET_KEY` the moment §3 step 2
generates it: from that point it seals every stored CRM credential and there is no recovery path.
`CallRecorderApp/aura-release.jks` is described in project notes as *this machine only* — losing it
means you can never ship an app update again, for any device, ever. Both into a password manager,
plus an encrypted offline copy, plus `keystore.properties`. Record the recovery path in
`DEPLOYMENT.md`, and verify it by building a signed release from a second machine (Android track A6).

**6.7 — Branch protection on `main`** (§1.4). No merge without green. The workflow exists now, so
this is a two-click setting and the enforcement half of everything Stage 1 built.

**6.8 — Fortune Innovatives** (§0.8). Live since 2026-07-27 with no extraction agent and no CRM
connector — its calls transcribe into a void. Half the customer base receiving zero value. Give it an
agent and a connector, or record explicitly on the instance page that it is transcription-only.
§4.2's readiness report is the structural fix; the customer needs the manual one this week.

**Stage 0 exit check, restated as four questions.** None can be answered yes today:
can a stranger reach customer data? *(code says no; not proven, and signups are still open)* · can we
lose recordings? *(yes — no off-box copy exists)* · will we know within an hour if the pipeline stops?
*(no)* · can we ship an Android update if this laptop dies? *(no)*.

---

## 7. Next

**Do not start Stage 2.** §1.3 does not exist, and Stage 2.4 — "the web tier stops holding a root
key" — is named in the plan as its highest-risk item, on a system with live customers. The guard
suite is the thing that makes it survivable.

Recommended order for the next slice:

1. **§3 of this document.** Not optional and not a slice — the branch is not deployable until it is
   done. Half a day including the exit checks.
2. **§0.4 — B2 bucket, mirror timer, tested restore.** The only item in Stage 0 where the downside is
   *permanent*. Everything else is exposure you can close after the fact; a dead disk is not. One
   day, no dependencies, nothing blocked on it.
3. **§0.5 — Sentry + UptimeRobot + the digest cron.** Half a day. Do it before §1.3 so the
   integration work has telemetry to check against, and so the next silent provider outage announces
   itself.
4. **§1.3 — integration tests, guard suite first.** This is the real next engineering slice, and the
   order inside it matters: build the **table-driven guard suite** (`AdminKeyGuard`, `TenantGuard`,
   `PermissionsGuard`, `OwnerRoleGuard`, `DeviceAuthGuard` × valid / absent / malformed /
   wrong-tenant / expired) and the **cross-tenant isolation loop over the whole route table** before
   the pipeline suite. Those two are the regression net for all of Stage 2; the pipeline suite is
   valuable but protects code that is not about to be rewritten. The six scratchpad e2e suites
   already encode most of the pipeline knowledge — move them into `platform/tests/` and wire them
   into the `integration` job that §5.5 says is missing. Budget ~1 week.

Three small things worth folding into (4) rather than scheduling separately, because each is a
one-liner guarding a real defect and each is currently pinned by a skipped test or an unowned file:
`packages/shared/src/enums.ts` (§4.3 — the fixture trap; `verify-rls.js` will now fail CI on it), the
`try/catch` around the transcode stage (§4.3 — silent permanent data loss, and §3.5 will trigger it),
and the missing `call_id` indexes on `transcripts`/`recordings`/`ai_outputs` (§4.3 — migration 0019,
before `service_credentials` claims that number).
