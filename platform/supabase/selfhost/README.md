# Self-hosted Supabase

Running Supabase on the Aura VPS instead of Supabase Cloud.

## What Supabase actually does for this platform

Two things, and it is worth being precise about it, because the migration is
much smaller than "move off Supabase" sounds:

1. **Postgres.** `DATABASE_URL`, `APP_DATABASE_URL`, `FUNNEL_DATABASE_URL`.
2. **Auth (GoTrue).** The console signs in against it, and `apps/api` provisions
   owner logins through `/auth/v1/admin/users` with the service-role key.

Everything else in the Supabase product is unused. `supabase/config.toml`
disables the Data API, Realtime and Storage; `0007_supabase_hardening.sql`
revokes the `anon`/`authenticated` grants outright; recordings live in the
platform's own MinIO. The full upstream stack runs here anyway — that was the
deployment decision — but nothing outside Postgres and GoTrue is on any request
path Aura serves.

**Auth and the application database are not coupled in SQL.** Nothing joins
`auth.users`; the only link is `users.sso_subject`, which holds the Supabase user
UUID as text. That single fact is what makes the auth migration tractable:
preserve the UUIDs and everything downstream keeps working.

## Layout

Two compose projects on one shared Docker network:

```
project `aura`                          project `aura-supabase`
(docker-compose.prod.yml)               (this directory)

  caddy ──────────────────────────────►  api-gw (Envoy)   :8000
  api ──┐                                  ├─ auth (GoTrue)
  worker ├──────────────────────────────►  ├─ rest, realtime, storage,
  web ──┤     supabase-db:5432             │  imgproxy, meta, functions,
  marketing ─┘                             │  studio
  redis, rabbitmq, minio                   └─ db ──── supavisor
                          network: aura_default (external to this project)
```

**Why two projects and not one overlay.** `./deploy.sh` runs `up -d --build`, and
an unscoped run has already taken this platform down once (2026-08-10 — see the
header of `docker-compose.prod.yml`). Folding Postgres into that project puts the
database inside the blast radius of every deploy. Here, no invocation of
`deploy.sh` can recreate the database container.

The cost of that choice: `deploy.sh` does not start this stack, does not check
its ports, and will happily deploy the app while the database is down. That is
the intended trade — the app failing loudly beats the database being restarted
quietly.

## Files

| Path | |
|---|---|
| `upstream/` | Vendored, unmodified upstream stack. See `UPSTREAM.md`. |
| `docker-compose.aura.yml` | Every Aura-specific change. Read this one. |
| `.env.selfhost.example` | Template; `.env.selfhost` is gitignored. |
| `bin/generate-keys.js` | Every secret the stack needs. |
| `bin/export-from-cloud.sh` | Read-only capture from Supabase Cloud. |
| `bin/import-to-selfhost.sh` | Build the schema, load the data. |
| `bin/compare-schemas.sh` | Pre-flight column drift check. |
| `bin/verify-selfhost.sh` | Proves the dangerous things are closed. |
| `bin/backup.sh` / `bin/restore-test.sh` | What replaced managed backups. |

Requires **Docker Compose ≥ 2.24** (`ports: !override`). Check with
`docker compose version`.

---

## 1. First start

```bash
cd /opt/aura/platform/supabase/selfhost

cp .env.selfhost.example .env.selfhost
node bin/generate-keys.js --write .env.selfhost
chmod 600 .env.selfhost
```

Then edit the three URLs in `.env.selfhost` — `SUPABASE_PUBLIC_URL`,
`API_EXTERNAL_URL`, `SITE_URL` — to your real domains, and check
`ss -ltnp` for a native Postgres already holding 5432.

DNS and TLS for the new subdomain, before first start:

```bash
# A record: supabase.sirahagents.com -> this box
sudo certbot --nginx -d supabase.sirahagents.com     # nginx layout only
```

The vhost is already written — `docker/nginx-aura.conf` (host nginx) and
`docker/Caddyfile` (container Caddy) both have a block for it.

```bash
docker compose --env-file .env.selfhost \
  -f upstream/docker-compose.yml -f docker-compose.aura.yml up -d

bash bin/verify-selfhost.sh
```

`verify-selfhost.sh` must pass before anything else happens. Its first check is
whether the port overrides took, and the failure it catches is Postgres bound to
`0.0.0.0`.

---

## 2. The cutover

`DB_LATENCY_MIGRATION.md` is the background: production runs in Mumbai, the cloud
database is in AWS Seoul, and every query pays ~125ms for the distance. This is
the infrastructure half of that document.

### Rehearse it first — twice over

The rehearsal is not optional and it is not just prudence: it is the only thing
that produces a *tested restore*, which `DB_LATENCY_MIGRATION.md` makes a
precondition of starting. Production keeps running on Supabase Cloud throughout.

**First, add `SUPABASE_DOMAIN=…` to `platform/.env.production`.** The rehearsal
runs the migrate job through `docker-compose.prod.yml`, and compose interpolates
that file before it considers profiles — so without this variable *every* compose
command against it fails, including ones that have nothing to do with Caddy.
Setting it early is harmless: it only takes effect when Caddy next starts.

```bash
export CLOUD_URL='<DATABASE_URL from .env.production, still pointing at Supabase>'
export TARGET_DATABASE_URL='postgresql://postgres:<POSTGRES_PASSWORD>@supabase-db:5432/postgres'
export TARGET_APP_DATABASE_URL='postgresql://aura_app:<APP_DB_PASSWORD>@supabase-db:5432/postgres'
export APP_DB_PASSWORD='<APP_DB_PASSWORD>'

bash bin/export-from-cloud.sh "$CLOUD_URL" ./dump   # read-only
bash bin/import-to-selfhost.sh ./dump
bash bin/compare-schemas.sh ./dump
```

`compare-schemas.sh` is the one that earns its keep on this project. Migration
numbers here have genuinely drifted between branches — production once had
0051/0052 hand-applied while 0034–0050 did not exist on the box — so
`schema_migrations` cannot be trusted blind. A column that exists in the cloud
and not here will abort the data load; better to learn that now than at 01:00.

Then the marketing role, and prove the backups work:

```bash
bash /opt/aura/platform/scripts/apply-marketing-schema.sh /opt/aura/platform/.env.production
bash bin/backup.sh
bash bin/restore-test.sh        # restores into a throwaway container
```

**Do not continue until `restore-test.sh` has passed at least once.**

### The window

Keep it short. The rollback below is only clean while nothing has been written to
the new database that the old one lacks.

```bash
cd /opt/aura/platform

# 1. Stop writes. Leave `web` up so the console shows its "API offline" state
#    rather than a blank page.
docker compose --env-file .env.production -f docker-compose.prod.yml \
  -f docker-compose.nginx.yml stop api worker

# 2. Tag the running images so a rollback is a retag, not a rebuild.
docker tag aura-node:latest rollback-api:pre-supabase-selfhost
docker tag aura-web:latest  rollback-web:pre-supabase-selfhost

# 3. Final export and import, into a database dropped and rebuilt from the
#    rehearsal. (Recreate it: the rehearsal left rows in it.)
cd supabase/selfhost
bash bin/export-from-cloud.sh "$CLOUD_URL" ./dump-final
bash bin/import-to-selfhost.sh ./dump-final
```

Now repoint `platform/.env.production`. Six values, and the four in bold are the
ones people forget:

| Variable | New value |
|---|---|
| `DATABASE_URL` | `postgresql://postgres:…@supabase-db:5432/postgres` |
| `APP_DATABASE_URL` | `postgresql://aura_app:…@supabase-db:5432/postgres` |
| `FUNNEL_DATABASE_URL` | `postgresql://aura_marketing:…@supabase-db:5432/postgres` |
| **`DB_SSL`** | **`0`** — without it the marketing site cannot reach the database |
| **`SUPABASE_DOMAIN`** | **the new subdomain** — Caddy refuses to start without it |
| **`NEXT_PUBLIC_SUPABASE_URL`** | **the new public URL** |
| **`NEXT_PUBLIC_SUPABASE_ANON_KEY`** | **`ANON_KEY` from `.env.selfhost`** |
| `SUPABASE_URL` | `http://supabase-gateway:8000` (internal; no public hop) |
| `SUPABASE_SERVICE_ROLE_KEY` | `SERVICE_ROLE_KEY` from `.env.selfhost` |

Then deploy — **`web` must be rebuilt, not restarted**:

```bash
cd /opt/aura/platform
./deploy.sh api worker web
```

`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` are **build args**
in `docker/web.Dockerfile`. A deploy that only restarts `web` leaves the old
project's URL and key compiled into the browser bundle: every container reports
healthy, the API is fine, and sign-in fails. `deploy.sh` builds, so this is
handled — but it is the single most common way this cutover appears to work and
then does not.

### Verify from outside, not from `docker ps`

```bash
bash supabase/selfhost/bin/verify-selfhost.sh

curl -s -o /dev/null -w "%{http_code} %{time_starttransfer}\n" \
  https://aura.sirahagents.com/v1/health
```

Expect **~110–115ms**, down from ~235ms. That number is the entire point of the
migration; if it has not moved, the API is still talking to Seoul and something
did not take.

Then sign in and load the owner dashboard. **Everyone is signed out once** — the
new stack signs tokens with a different `JWT_SECRET`, so existing sessions are
void. Nobody needs a password reset: `encrypted_password` is a portable bcrypt
hash and came across with the users.

### Rollback

Put the old `DATABASE_URL`, `APP_DATABASE_URL`, `FUNNEL_DATABASE_URL`,
`NEXT_PUBLIC_SUPABASE_*` and `SUPABASE_*` back, drop `DB_SSL=0`, and
`./deploy.sh api worker web`. The Supabase Cloud project is untouched and still
running.

This works only while nothing has been written to the new database that the old
one lacks — so keep the window short, and **do not delete the cloud project until
a full business cycle has passed.**

---

## 3. Backups

This is what moving off managed Postgres actually cost. Nothing backs the
database up unless `bin/backup.sh` runs.

```cron
15 2 * * * cd /opt/aura/platform/supabase/selfhost && bash bin/backup.sh >> /var/log/aura-backup.log 2>&1
```

On-box to MinIO (14 days), off-box encrypted to whatever `OFFSITE_*` points at
(90 days). Set these in the cron environment or a sourced file:

```bash
OFFSITE_ENDPOINT=https://s3.example.com
OFFSITE_BUCKET=aura-db-backups
OFFSITE_ACCESS_KEY=...
OFFSITE_SECRET_KEY=...
OFFSITE_PASSPHRASE=...     # store with JWT_SECRET and CRM_SECRET_KEY
```

The offsite copy is gpg-encrypted before it leaves the box; the on-box copy is
not, because it sits on the same disk as the live database and the same MinIO
that already holds every call recording — encrypting it would protect the data
only from someone who already has root.

**Losing `OFFSITE_PASSPHRASE` makes every offsite backup unreadable.** It belongs
wherever `JWT_SECRET` and `CRM_SECRET_KEY` are kept.

Run `bin/restore-test.sh` on a schedule too. A backup nobody has restored is a
belief, not a backup.

---

## 4. Day-to-day

**psql.** `docker exec -it supabase-db psql -U postgres`. From your laptop,
tunnel: `ssh -L 5432:127.0.0.1:5432 root@<vps>` — the pooler is published on
loopback only.

**Studio.** `https://supabase.example.com/`, basic auth from `DASHBOARD_USERNAME`
/ `DASHBOARD_PASSWORD`. That basic auth is the only thing between the internet
and a SQL console over every tenant's data.

**Logs.** `docker logs supabase-auth`, `supabase-db`, `supabase-envoy`.

**Restarting the stack does not restart Aura**, and vice versa. They are separate
projects on purpose.

**`docker compose down` on the `aura` project will fail** while this stack is
running, because it tries to remove `aura_default` and the Supabase containers
are still attached (`error while removing network: has active endpoints`). That
is the safety property working — the app cannot pull the network out from under
the database — but the message does not say so. Stop this stack first, or use
`stop` rather than `down`.

**Start order after a reboot.** `aura` first (it owns the network), then
`aura-supabase`. With `restart: unless-stopped` on both, Docker handles this on
its own; it only matters when bringing the stack up by hand after a `down`.

---

## 5. Traps

**`verify-rls.js` and the hostname `db`.** The script's `assertDisposable()`
treats `db` and `postgres` as throwaway databases and runs a destructive
cross-tenant write suite against them. While production was Supabase Cloud, being
remote was the only thing stopping it. So the database is published to Aura as
`supabase-db`, *and* the script now refuses outright under `NODE_ENV=production` —
because Compose adds the service name `db` as a network alias regardless of what
we ask for, so the hostname alone cannot be trusted.

**0007 will not re-run after a schema restore.** `pg_dump` carries
`schema_migrations` across, so `migrate.js` skips
`0007_supabase_hardening.sql` — the migration that revokes `anon`/`authenticated`
access to schema `public`. A fresh Supabase database grants those roles
privileges on every table `postgres` creates, by default, and the anon key is
published in the browser bundle. That is why `import-to-selfhost.sh` builds the
schema from migrations against an *empty* `schema_migrations` and copies only
rows — and then re-applies 0007 explicitly anyway. `verify-selfhost.sh` checks
both the HTTP surface and `information_schema.role_table_grants`.

**`DB_SSL=0` is required.** `ssl.js` infers TLS from the hostname and
`supabase-db` is not in its local set. The marketing container makes it
non-optional: `docker-compose.prod.yml` pins it to `DB_SSL: ${DB_SSL:-1}`, so
leaving it unset turns TLS *on* for that container alone and the funnel silently
cannot reach its database.

**Upstream publishes Postgres on `0.0.0.0`.** `docker-compose.aura.yml` undoes
that with `ports: !override`, which needs Compose ≥ 2.24 and silently does
nothing if a service is renamed upstream. `verify-selfhost.sh` check 1 exists for
exactly this.

**`getClaims()` now falls back to `getUser()`.** The self-hosted stack signs
HS256 with a shared secret rather than publishing an ES256 JWKS, so
`apps/web/lib/supabase/server.ts` takes its documented fallback path: one round
trip to the auth server per request instead of local verification. That was worth
~125ms against Seoul; against a container on the same box it is ~1ms. The
security property is unchanged — it is still verification, not `getSession()`.
Configuring `GOTRUE_JWT_KEYS` with an asymmetric key would restore local
verification if that ~1ms ever matters.

**`pg_trgm` finally installs.** `0042_fuzzy_dedupe.sql` wraps `CREATE EXTENSION`
in an exception handler because nobody knew whether Supabase Cloud would permit
it; self-hosted, the migration role is a real superuser, so the extension and its
trigram indexes are created and fuzzy duplicate matching starts working. Expect
`merge.controller.ts` to begin reporting it as available.
