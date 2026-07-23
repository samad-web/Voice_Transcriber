# Deployment runbook

Target: **one VPS running Docker Compose, with Supabase as the database.**
Nothing here needs a CI system or a Kubernetes cluster.

```
                    ┌──────────────────────── your VPS ────────────────────────┐
  phones  ──────►   │  Caddy :443  ──/v1/*──►  api    ───┐                      │
  browser ──────►   │              ──else───►  web      │                      │
                    │                          worker ◄─┴─ rabbitmq, redis     │
  phones  ──────►   │  Caddy :443 (storage.…) ►  minio  (call audio)           │
                    └────────────────────────────┬─────────────────────────────┘
                                                 │ TLS
                                          Supabase Postgres
```

* `docker-compose.prod.yml` — the stack. Caddy is the only container that binds a host port.
* `docker/node.Dockerfile` — one image for **api**, **worker**, and the one-shot **migrate** job.
* `docker/web.Dockerfile` — the Next.js console (standalone output).
* `.env.production.example` — every variable, with the reasoning next to it.

---

## 1. Prerequisites

* A VPS with a public IPv4 (2 vCPU / 4 GB is comfortable), Docker Engine + Compose v2.
* Two DNS records pointing at it — **both must resolve before the first start**, or Caddy's
  ACME challenge fails and you burn Let's Encrypt rate limits:
  * `app.example.com` → console + API
  * `storage.example.com` → MinIO (device uploads)
* Ports 80 and 443 open. Nothing else needs to be reachable from the internet.
* A Supabase project (free tier is enough to start).
* A Gemini API key (see §6).

---

## 2. Supabase

The schema is plain Postgres with our own RLS; Supabase Auth, PostgREST, Realtime and
Storage are **not used**. Tenant isolation comes from `current_setting('app.org_id')`
policies enforced against the non-superuser `aura_app` role.

1. Create the project. Note the region — put the VPS in the same one, every query pays that
   round-trip.
2. **Project Settings → Database** gives two things you need: the connection string and the
   `postgres` password.
3. In `.env.production` set:
   * `DATABASE_URL` — the `postgres` user. Owner connection: migrations and the few
     pre-tenant admin flows.
   * `APP_DATABASE_URL` — the `aura_app` user. Everything tenant-scoped. Over the pooler the
     username is `aura_app.<project-ref>`.
   * `APP_DB_PASSWORD` — a fresh secret, ≥24 chars, matching the one inside `APP_DATABASE_URL`.
4. **Project Settings → API → Exposed schemas**: remove `public`. `0007_supabase_hardening.sql`
   already revokes `anon`/`authenticated` access, but switching the Data API off entirely means
   a future migration can't accidentally re-grant it.

Three things bite everyone once, all confirmed against this project:

* **`db.<ref>.supabase.co` does not resolve** on IPv4-only networks — new projects reach the
  direct connection over IPv6 only. Use the pooler host from the dashboard.
* **The pooler's region prefix is not always `aws-0`.** Guessing gives
  `tenant/user postgres.<ref> not found`, which reads like a credentials failure but is a
  wrong-host failure. Copy the host from the dashboard.
* **Percent-encode the password in the URL.** A password containing `@`, `/`, `:` or `#`
  silently breaks host parsing — a password like `p@ssw0rd#1` must be written `p%40ssw0rd%231`.
  Over the pooler the username is `<role>.<project-ref>`, so the runtime user is
  `aura_app.<project-ref>`, not `aura_app`.

Apply the schema:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml \
  --profile setup run --rm migrate
```

That runs `packages/db/migrate.js` (all seven migrations, in order, each in its own
transaction) and then `packages/db/bootstrap-role.js`, which replaces the dev password baked
into `0001_init.sql` with `APP_DB_PASSWORD` and refuses to continue if the role can bypass RLS.

Then prove isolation actually holds against the real database:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml \
  --profile setup run --rm migrate node packages/db/verify-rls.js
```

Six assertions; all must say PASS. If `no org context sees zero workspaces` fails, `APP_DATABASE_URL`
is pointing at an over-privileged role — stop and fix it before any customer data lands.

The script writes: it creates two `rls-test-*` organizations and deletes them again at both ends
of the run. Harmless, but run it *before* onboarding, not as a routine health check.

<details>
<summary>Using the Supabase CLI instead</summary>

`supabase/migrations/` is generated from `packages/db/migrations/` — same SQL, renamed to the
CLI's timestamp convention:

```bash
pnpm db:supabase:sync          # regenerate after adding a migration
pnpm db:supabase:check         # CI guard: fails if stale
supabase link --project-ref <ref> && supabase db push
```

`packages/db/migrations/` stays canonical; never hand-edit `supabase/`. You still need to run
`bootstrap-role.js` afterwards.
</details>

### 2b. Console sign-in (Supabase Auth)

The web console signs operators in with Supabase Auth — the same project that hosts the
database, using its GoTrue auth server rather than the `users` table. In the dashboard:

| Where | Setting |
| --- | --- |
| Authentication → Providers → Email | **Enabled** |
| Authentication → Providers → Email | **Allow new users to sign up: OFF** |
| Authentication → URL Configuration | Site URL = `https://<APP_DOMAIN>` |
| Authentication → Users → Add user | Create the operator account, e.g. `support@sirahdigital.in` |

Signup is deliberately closed: the console has no registration form, but leaving the provider's
signup endpoint open would let anyone with the (public) anon key create an account, and **any
authenticated Supabase user can reach the console**. Create operator accounts from the
dashboard.

Then copy Project Settings → API into `.env.production`:

```
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon public key>
```

Both are `NEXT_PUBLIC_*`, so they are baked into the image at build time — same rebuild rule as
`NEXT_PUBLIC_API_URL` (§7.3). Leaving either blank ships a console with **no sign-in gate at
all**: `/login` reports that auth is unconfigured and every page stays reachable. That fallback
exists so local dev works without a project; it must never be how production is deployed.

---

## 3. Deploy the stack

```bash
git clone <repo> && cd platform          # or rsync the directory up
cp .env.production.example .env.production
chmod 600 .env.production
$EDITOR .env.production                  # fill in every "replace-with-…"

docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
docker compose --env-file .env.production -f docker-compose.prod.yml ps
```

`--env-file` is not optional: `env_file:` only populates containers, while `${VAR}`
substitution inside the compose file reads `--env-file`. Without it the stack refuses to
start with `APP_DOMAIN is required`.

Secrets to generate (never reuse the examples):

```bash
openssl rand -base64 36 | tr -d '/+=' | head -c 40    # per secret
```

`ADMIN_API_KEY`, `JWT_SECRET`, `APP_DB_PASSWORD`, `RABBITMQ_PASSWORD`, `S3_SECRET_ACCESS_KEY`.

### Smoke test

```bash
curl https://app.example.com/v1/health            # {"status":"ok","service":"aura-api"}
curl -I https://app.example.com/login             # 200, valid certificate
curl -sI https://storage.example.com/aura-recordings | head -1   # 403 from MinIO = reachable, not public
```

### Co-hosting behind an existing nginx

The stack above assumes Caddy owns `:80`/`:443`. If the box already runs nginx for
another site, Caddy cannot bind those ports — `up` fails with *port is already
allocated*, and stopping nginx takes the other site down. Use the overlay instead:

```bash
docker compose --env-file .env.production \
  -f docker-compose.prod.yml -f docker-compose.nginx.yml up -d --build
```

`docker-compose.nginx.yml` parks Caddy behind an unused profile and publishes
web/api/minio on **loopback only** (`127.0.0.1:18080/18081/18082`), so the host's
nginx stays the single edge and the containers are unreachable from the internet
except through it. Check the ports are free first — `ss -ltnp | grep -E '1808[012]'`
— and change them in the overlay if not.

Then install the vhosts and let certbot add TLS:

```bash
sudo cp docker/nginx-aura.conf /etc/nginx/sites-available/aura
sudo ln -s /etc/nginx/sites-available/aura /etc/nginx/sites-enabled/aura
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d $APP_DOMAIN -d $STORAGE_DOMAIN
```

`nginx-aura.conf` ships HTTP-only by design — certbot rewrites those blocks in
place to add `listen 443 ssl`, the certificate paths and the `:80` redirect.
Shipping 443 blocks first would reference cert files that don't exist yet and
nginx would refuse to start.

Two settings in it are load-bearing rather than boilerplate:

* `proxy_set_header Host $host` on the storage vhost. SigV4 signs the Host
  header; nginx's default (`$proxy_host`) rewrites it and **every** device upload
  fails with `SignatureDoesNotMatch`.
* `client_max_body_size 0` on the storage vhost. nginx defaults to 1 MB, which
  rejects every multi-MB recording part with a 413.

---

## 4. First customer

Provisioning is one API call — org, workspace, instance and the first enrollment key,
atomically:

```bash
curl -X POST https://app.example.com/v1/admin/tenants \
  -H "x-admin-key: $ADMIN_API_KEY" -H 'content-type: application/json' \
  -d '{"name":"RD Interlock Brick","workspaceName":"Sales","retentionDays":365}'
```

The response contains `adminKey` **once** — it is stored only as a hash. That value plus the
instance id is what the activation QR encodes.

Then set `DEV_ORG_ID` / `DEV_WORKSPACE_ID` in `.env.production` to that org and rebuild the
web image. The console's per-tenant pages (dashboard, calls, agents, search, usage, team,
api-keys, crm) still resolve their org from those variables rather than from the signed-in
session; only `/instances` is genuinely multi-tenant. See §7.

---

## 5. Android release APK

The app is sideloaded (it needs `MANAGE_EXTERNAL_STORAGE` and an accessibility service, both
Play-restricted), so "release" means a signed APK you distribute yourself.

**Create a keystore once.** Losing it means no existing install can ever be upgraded — back it
up somewhere other than this machine:

```bash
keytool -genkeypair -v -keystore CallRecorderApp/release.keystore \
  -alias aura -keyalg RSA -keysize 4096 -validity 10000
```

**Point the build at it** — `CallRecorderApp/keystore.properties` (gitignored):

```properties
storeFile=release.keystore
storePassword=…
keyAlias=aura
keyPassword=…
```

or the equivalent `ANDROID_KEYSTORE_FILE` / `ANDROID_KEYSTORE_PASSWORD` / `ANDROID_KEY_ALIAS` /
`ANDROID_KEY_PASSWORD` environment variables on a build server. If neither is present,
`assembleRelease` fails with a message saying so rather than emitting an unsigned APK.

**Build:**

```bash
cd CallRecorderApp
"$USERPROFILE/.gradle/wrapper/dists/gradle-8.14.3-bin/*/gradle-8.14.3/bin/gradle.bat" assembleRelease
# → app/build/outputs/apk/release/app-release.apk
```

(There is no `gradlew` wrapper in the repo; that cached Gradle is the one that works.)

What changed for release:

* `versionCode 2` / `versionName 1.0.0` — **bump `versionCode` on every build that leaves this
  machine**, Android refuses to install a lower one.
* Signed with your keystore (v1 + v2). A device holding the old debug-signed build must
  **uninstall it first** — Android will not replace a differently-signed APK, and uninstalling
  clears its enrollment, so re-scan the QR after installing.
* `isMinifyEnabled` + `isShrinkResources` — R8 is on. Room classes are kept via
  `proguard-rules.pro`; **install the release APK on a real phone and complete one call
  end-to-end before distributing it**, because R8 problems only appear at runtime.
* Cleartext HTTP is now refused (`res/xml/network_security_config.xml`). The debug build keeps
  a permissive override in `src/debug/`, so emulator + LAN development is unaffected. This means
  the server URL in the QR **must be `https://`**.
* The `ngrok-skip-browser-warning` header is now sent only to `*.ngrok*` hosts.

**Enroll a phone:** console → Instances → the customer → enrollment key → QR. In the app,
long-press the toolbar title → Admin → scan. Then grant: microphone, phone state, call log,
contacts, notifications, all-files access, battery-optimisation exemption, and the accessibility
service.

---

## 6. ASR / analyze provider

**Gemini** is the only provider, in both `apps/worker/src/pipeline/asr.ts` and
`packages/llm/src/index.ts`. Precedence is `ASR_STUB`/`ANALYZE_STUB` → **Gemini**; set
`GEMINI_API_KEY` and both stages route there.

ASR transcribes and diarizes in one call, so its segments carry speaker labels and timestamps.
Analyze then *labels* those segments (role + intent) rather than re-splitting the text — it never
overwrites what ASR produced.

`ASR_STUB` / `ANALYZE_STUB` must be `0`. They emit clearly-fake transcripts, which is useful in
tests and disastrous in production.

---

## 7. Known gaps — read before onboarding a real customer

These are honest limitations of the current build, not deployment steps:

1. **`ADMIN_API_KEY` is effectively a root credential.** It authenticates every `/v1/admin/*`
   call and crosses tenant boundaries. Keep the key on the server only, never in a browser or a
   phone. Supabase Auth (§2b) gates who can open the console, but the console's own server
   components still read the API with this key — a signed-in operator is implicitly an admin,
   and the API itself does not yet verify the Supabase session. Per-role API authorisation is
   still unbuilt.
2. **The console is single-tenant apart from `/instances`.** Per-tenant pages read `DEV_ORG_ID`.
   Operating a second customer today means changing that variable and rebuilding the web image.
3. **`NEXT_PUBLIC_API_URL` is baked at image build time.** Changing the domain requires
   `up -d --build`, not a restart.
4. **MinIO is a single container on a single disk.** Volume `miniodata` holds every recording;
   back it up (see §8). No replication, no lifecycle rules.
5. **Both-ends call capture is device-dependent.** On the tested phone `VOICE_CALL` is blocked,
   so the rep must tap Speaker manually or the transcript will contain only their side.
   Text-based diarization will still invent a "Customer" speaker — `diarized=true` is not
   evidence both sides were recorded.
6. **Transcription is post-call**, not streaming.
7. **Play Integrity, FCM push and HubSpot OAuth** are stubs; they need external credentials.

---

## 8. Operations

```bash
# logs
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f api worker

# update after a code change
git pull && docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build

# apply a new migration
docker compose --env-file .env.production -f docker-compose.prod.yml --profile setup run --rm migrate
```

**Backups.** Two things hold state, and Supabase only covers one of them:

* Postgres — Supabase's own backups (Settings → Database → Backups). Verify the schedule
  matches the retention you promised the customer.
* Recordings — the `miniodata` volume. Nothing backs it up for you:

  ```bash
  docker run --rm -v aura_miniodata:/data -v "$PWD:/backup" alpine \
    tar czf /backup/minio-$(date +%F).tar.gz -C /data .
  ```

* Caddy certificates live in the `caddy_data` volume. Deleting it re-issues from Let's Encrypt,
  which is rate-limited — keep it.

**Rotating secrets.** `JWT_SECRET` invalidates every device token (phones re-enroll silently on
next refresh). `ADMIN_API_KEY` breaks any provisioning script that hardcodes it.
`APP_DB_PASSWORD` needs `bootstrap-role.js` re-run *and* `APP_DATABASE_URL` updated in the same
change, or the API loses its database.
