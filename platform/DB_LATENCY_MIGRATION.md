# Getting the database off the far side of the Indian Ocean

**Status:** planned. The code-side round-trip reductions are done and deployable
independently; this document is the infrastructure half.

## The measurement this is based on

Production runs on a Hostinger VPS in **Mumbai** (`data_center_id: 23`, `mum2`).
The database is a Supabase project in **AWS Seoul** (`aws-1-ap-northeast-2`).

Measured from outside, 2026-09-01:

| Endpoint | What it does | TTFB |
|---|---|---|
| `GET /v1/definitely-not-real` | 404, touches no database | **~110ms** |
| `GET /v1/health` | exactly one `SELECT 1` | **~235ms** |

The ~110ms is the client's own network to Mumbai and cancels out. **The ~125ms
delta is the cost of a single database round trip**, and it is paid by every
query the platform makes. Mumbai to Seoul is ~5,500km; ~125ms is simply what
that distance costs.

Nothing about this is a slow query. The database is idle. It is 5,500km away.

## Why the fix is not "move the Supabase project"

Supabase cannot change a project's region in place - it means a new project plus
a data migration. The tempting version of that (new project in `ap-south-1`,
restore into it) drags the **auth** system along with it, and that is the
expensive part:

- `auth.users` has to migrate, or every customer loses their login.
- A new project has new JWT signing keys, so **every active session is
  invalidated** and everyone must sign in again.
- `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are **build
  args** in `docker-compose.prod.yml`, not runtime env - changing them requires
  a full image **rebuild**, not a restart. A deploy that only restarts will
  appear to work and then fail at the first sign-in.

And it buys less than it looks like it does, because of the next section.

## Auth is already fixed, and it changes the plan

The console used to call `supabase.auth.getUser()` **twice per navigation** -
once in the middleware, once again in the owner layout - each one a network
round trip to the auth server in Seoul.

Both now call `getClaims()`, which verifies the ES256 signature locally against
the project's published JWKS using WebCrypto. The project already serves an
asymmetric key at `/auth/v1/.well-known/jwks.json`, so this is **zero network
calls per request** after the first key fetch.

**So Supabase Auth being in Seoul now costs approximately nothing.** The only
thing still paying the 125ms toll is the Postgres data.

That separates the two concerns, and makes the cheaper option the better one.

## Recommended: move the DATA to Mumbai, leave AUTH where it is

Run Postgres on the Mumbai VPS; keep the Supabase project alive purely as the
identity provider.

**What this gets:**

- Round trips go from ~125ms to ~0.2ms over the compose network.
- **No auth migration.** No session invalidation, no re-login, no key rotation.
- **No image rebuild.** `NEXT_PUBLIC_SUPABASE_*` never change, so the build args
  stay put; only `DATABASE_URL` / `APP_DATABASE_URL` move, and those are runtime
  env read by the API and worker.
- The handsets are untouched. They POST to `aura.sirahagents.com/v1`, which does
  not move - no re-enrollment, and nothing in the field can be re-pointed
  remotely anyway.

**What this costs:** backups and HA become ours. That is a real trade and should
be answered before the cutover, not after - see step 1.

The VPS has 4 vCPU / 16GB / 200GB, and `docker-compose.yml` already defines a
`postgres:16-alpine` service for local development, so the shape is familiar.

### Cutover sequence

1. **Answer the backup question first.** `pg_dump` on a cron to object storage
   (MinIO is already running on the box) plus a documented restore test. Do not
   start the cutover until a restore has actually been performed once.
2. **Stand Postgres up alongside the running system**, on the compose network,
   not exposed publicly. Match the roles the app expects: `aura_app` is the
   non-superuser runtime role RLS depends on - a superuser connection silently
   bypasses every policy, which is the expensive version of this mistake.
3. **Dump and restore into it while production still runs against Seoul.**
   `pg_dump --no-owner --no-acl` of the application schema. This is a rehearsal;
   the real dump happens in the window.
4. **Verify the restore before trusting it**, with the checks this repo already
   has rather than by eyeballing row counts:
   - `verify-rls.js --structural-only` - every `org_id` table must have FORCE
     RLS and a real policy. 82 tables at last count.
   - `pnpm tenancy:check`
   - Compare `schema_migrations` against `packages/db/migrations/*.sql`. Note
     that this table cannot be trusted blind on this project - migration numbers
     have drifted because two branches allocated them independently.
5. **Take the window.** Stop `api` and `worker` (leave `web` up so the console
   shows its "API offline" state rather than a blank page), take the final dump,
   restore, repoint `DATABASE_URL` and `APP_DATABASE_URL`, restart.
6. **Verify from outside, not from `docker ps`.** A healthy container that never
   took traffic is exactly the failure this step exists to catch:

   ```
   curl -s -o /dev/null -w "%{http_code} %{time_starttransfer}\n" https://aura.sirahagents.com/v1/health
   ```

   Expect **~110-115ms** rather than ~235ms. That single number is the whole
   point of the migration - if it has not moved, the API is still talking to
   Seoul and something did not take.

### Rollback

`DATABASE_URL` still points at a live, untouched Seoul project for as long as
you leave it running. Rollback is putting the two env vars back and restarting -
provided **nothing has written to the new database that the old one lacks**.
That window is the real risk, so keep it short and keep writes off during it.
Do not delete the Supabase database until a full business cycle has passed.

## The alternative, if managed Postgres is non-negotiable

New Supabase project in `ap-south-1` (Mumbai), migrate data **and** auth. Round
trips land at ~1-5ms rather than ~0.2ms - functionally the same win.

Accept, in exchange for keeping managed backups:

- every user is signed out at cutover,
- the web image must be **rebuilt**, not restarted, because the anon key and
  project URL are build args,
- `auth.users` migration has to be right the first time.

## What is already done, and what it is worth

These landed on the code side and are independent of the migration - they reduce
the *number* of round trips, so they pay off whether or not the database moves,
and they are what makes the app feel fast rather than merely faster once it has.

| Change | Round trips saved | Where |
|---|---|---|
| `getClaims()` instead of `getUser()` in the middleware | 1/navigation | `apps/web/lib/supabase/middleware.ts` |
| `getClaims()` instead of `getUser()` in the layout | 1/navigation | `apps/web/lib/supabase/server.ts` |
| `BEGIN` + `set_config` batched into one statement | 1/tenant request | `packages/db/src/index.ts` |
| `/v1/auth/context` two queries collapsed to one CTE | 1/navigation | `apps/api/src/modules/auth/auth.service.ts` |
| Dashboard's 8 aggregates batched into one exchange | 7/dashboard load | `apps/api/src/modules/owner/owner.controller.ts` |
| Legacy dashboard's 7 aggregates batched | 6/dashboard load | same |

Dashboard load: **15 round trips down to 4**. At Seoul's 125ms that is ~2.1s to
~500ms. At Mumbai's ~0.2ms it is the difference between "fast" and instant.

### The one assumption not verified locally

The batching changes send multi-statement simple queries. Every equivalence and
RLS-isolation check passed against a real Postgres 16, but production reaches
Postgres through **Supavisor in session mode** (port 5432), which was not in the
test path. Session mode assigns a dedicated backend connection and proxies the
protocol, so this is expected to be transparent - but it is an expectation, not
a measurement.

Make it the first check after the API deploy, before moving on:

```
curl -s -o /dev/null -w "%{http_code} %{time_starttransfer}\n" \
  "https://aura.sirahagents.com/v1/health"
```

then sign in and load the owner dashboard. If the dashboard renders its KPI row
and telecaller table, the batching works through the pooler. If it renders "Data
unavailable", roll the API back to the pre-deploy tag and say so - that is the
one failure mode this change can produce, and it is immediately visible.

### Still on the table

- **Connection pool ceilings.** `DB_POOL_MAX` defaults to 10 and
  `DB_ADMIN_POOL_MAX` to **3** (`packages/db/src/index.ts`). The admin pool
  serves `/v1/auth/context`, which runs on every navigation. The batching above
  cut hold times roughly 4x so this is far less urgent than it was, but 3 is low.
- **Streaming the owner layout.** `getOwner()` currently blocks the entire
  layout before anything paints; only three files in the console use `Suspense`.
  The shell could paint instantly with data streaming in behind it.
- **Read caching.** Every server fetch is `cache: "no-store"` and there is no
  `unstable_cache` anywhere in the web tier. Redis is running in production and
  is currently used only for throttling. Slow-moving reads (org, stages,
  branding, nav entitlements) are the candidates.
