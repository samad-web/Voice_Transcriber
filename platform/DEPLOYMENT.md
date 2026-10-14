# Deployment runbook

Target: **one VPS running Docker Compose, with a self-hosted Supabase as the
database.** Nothing here needs a CI system or a Kubernetes cluster.

```
                ┌──────────────────────────── your VPS ────────────────────────────┐
  phones  ────► │  Caddy :443  ──/v1/*──►  api    ───┐                              │
  browser ────► │              ──else───►  web      │                               │
                │                          worker ◄─┴─ rabbitmq, redis              │
  phones  ────► │  Caddy :443 (storage.…) ►  minio  (call audio)                    │
                │                                                                   │
                │  ── compose project `aura`  ───────────────────────────────────    │
                │  ── compose project `aura-supabase` ───────────────────────────    │
  browser ────► │  Caddy :443 (supabase.…) ►  api-gw ──► auth, rest, studio, …      │
                │                             supabase-db  (Postgres)               │
                └───────────────────────────────────────────────────────────────────┘
```

The database is **two compose projects away from `deploy.sh`** on purpose — see
`supabase/selfhost/README.md`. That directory is the runbook for everything
Supabase-shaped: first start, the cutover from Supabase Cloud, and backups.

* `docker-compose.prod.yml` — the stack. Caddy is the only container that binds a host port.
* `docker/node.Dockerfile` — one image for **api**, **worker**, and the one-shot **migrate** job.
* `docker/web.Dockerfile` — the Next.js console (standalone output).
* `.env.production.example` — every variable, with the reasoning next to it.

---

## 1. Prerequisites

* A VPS with a public IPv4, Docker Engine + **Compose v2.24 or newer** (the self-hosted
  Supabase overlay uses `ports: !override`; older Compose silently ignores it and leaves
  Postgres published on `0.0.0.0`). 2 vCPU / 4 GB was comfortable with a managed database;
  running Postgres and the full Supabase stack here too wants **4 vCPU / 16 GB**.
* Three DNS records pointing at it — **all must resolve before the first start**, or Caddy's
  ACME challenge fails and you burn Let's Encrypt rate limits:
  * `app.example.com` → console + API
  * `storage.example.com` → MinIO (device uploads)
  * `supabase.example.com` → the self-hosted Supabase gateway (console sign-in)
* Ports 80 and 443 open. Nothing else needs to be reachable from the internet — in
  particular Postgres is published on loopback only, and `verify-selfhost.sh` checks it.
* A Gemini API key (see §6).

---

## 2. Supabase (self-hosted)

The schema is plain Postgres with our own RLS. Of the whole Supabase product this platform
uses exactly two things — **Postgres** and **Auth** — and nothing else is on any request path:
`supabase/config.toml` disables the Data API, Realtime and Storage,
`0007_supabase_hardening.sql` revokes the `anon`/`authenticated` grants, and recordings live in
MinIO. Tenant isolation comes from `current_setting('app.org_id')` policies enforced against
the non-superuser `aura_app` role.

**The setup and cutover runbook is `supabase/selfhost/README.md`.** In short:

```bash
cd supabase/selfhost
cp .env.selfhost.example .env.selfhost
node bin/generate-keys.js --write .env.selfhost      # every secret the stack needs
# edit SUPABASE_PUBLIC_URL / API_EXTERNAL_URL / SITE_URL to your domains
docker compose --env-file .env.selfhost \
  -f upstream/docker-compose.yml -f docker-compose.aura.yml up -d
bash bin/verify-selfhost.sh                          # must pass before going further
```

Then in `.env.production`:

* `DATABASE_URL` — `postgres` on `supabase-db:5432`. Owner connection: migrations and the few
  pre-tenant admin flows. Unlike Supabase Cloud's restricted `postgres`, this one is a real
  superuser — which is why `0042` can finally install `pg_trgm`.
* `APP_DATABASE_URL` — the `aura_app` user. Everything tenant-scoped.
* `APP_DB_PASSWORD` — matching the one inside `APP_DATABASE_URL`.
* `DB_SSL=0` — **required**, see below.
* `SUPABASE_DOMAIN`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` — from `.env.selfhost`.

Things that bite once, all specific to this arrangement:

* **`DB_SSL=0` is not optional.** `packages/db/ssl.js` infers TLS from the hostname, and
  `supabase-db` is deliberately not in its local-host set. Worse, the marketing container is
  pinned to `DB_SSL: ${DB_SSL:-1}`, so leaving it unset turns TLS *on* for that container
  alone and the funnel cannot reach its database while everything else looks healthy.
* **The username is the plain role name.** On Supabase Cloud the pooler required
  `aura_app.<project-ref>`; that was a pooler convention, not a Postgres one. Keep the suffix
  and the login fails.
* **`NEXT_PUBLIC_SUPABASE_*` are build args.** Changing them needs `./deploy.sh web` (a
  rebuild), not a restart — see §7. This is the most common way a cutover appears to work and
  then fails at the first sign-in.
* **The database service is reachable as `db` too, and must not be used that way.** Compose
  adds the service name as a network alias whatever we ask for; `verify-rls.js` treats `db` as
  a disposable database. Use `supabase-db`. (`verify-rls.js` now also refuses under
  `NODE_ENV=production` unless the database is empty — see below.)

Apply the schema:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml \
  --profile setup run --rm migrate
```

That runs `packages/db/migrate.js` (every `packages/db/migrations/*.sql` not yet in
`schema_migrations`, in filename order, each wrapped in its own `BEGIN`/`COMMIT` — which is why no
migration may use `CREATE INDEX CONCURRENTLY`), then `packages/db/bootstrap-role.js`, which
replaces the dev password baked
into `0001_init.sql` with `APP_DB_PASSWORD` and refuses to continue if the role can bypass RLS,
then `packages/db/verify-rls.js --structural-only` (08 §1.5) — read-only, so it runs against
Supabase directly rather than refusing like the full check below does: every `org_id` table gets
enumerated from the catalog and the run fails, by table name, on any missing FORCE RLS or a real
`org_isolation` policy. A migration that adds a tenant table and forgets its policy fails **this**
deploy, not a future incident.

Then prove isolation actually *behaves* correctly against the real database — the part the
structural check above cannot see, because right policies can still not bind:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml \
  --profile setup run --rm -e RLS_TEST_ALLOW_PRODUCTION=1 \
  migrate node packages/db/verify-rls.js
```

Six assertions; all must say PASS. If `no org context sees zero workspaces` fails, `APP_DATABASE_URL`
is pointing at an over-privileged role — stop and fix it before any customer data lands.

**This is a one-time, pre-onboarding step and the script enforces that.** It writes: two
`rls-test-*` organizations, created and deleted at both ends of the run, and the delete cascades
across every tenant table. So under `NODE_ENV=production` (which `docker/node.Dockerfile` bakes
into this image) it refuses without `RLS_TEST_ALLOW_PRODUCTION=1`, and it refuses *even with*
that flag once the database holds a single non-test organization. The flag states intent; the
row count is what actually decides.

Once customers exist, run these checks against a restored copy instead —
`supabase/selfhost/bin/restore-test.sh` stands one up in a throwaway container.

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

### 2c. Owner logins (per-instance customer access)

Each customer gets their own sign-in, created from the operator console at
**Instances → \<customer\> → Owner Logins**. An owner sees `/owner` only — their dashboard, lead
board and lead list, scoped to their org — and is redirected away from every operator page.

That provisioning calls Supabase's admin API, which the anon key cannot reach, so the **API**
(not the web app) needs the service-role key in `.env.production`:

```
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service_role secret>   # Project Settings → API
```

The service-role key bypasses RLS completely. Keep it server-side: never in a `NEXT_PUBLIC_*`
variable, never in the web image. With it blank the console still lists owners but cannot create
them, and says so.

**`PLATFORM_OPERATOR_EMAILS` is REQUIRED in production.** It is the allowlist of who may reach the
operator console, and it fails **closed**:

```
PLATFORM_OPERATOR_EMAILS=support@sirahdigital.in
```

Comma-separated; the parser trims and lower-cases, so spaces and case do not matter.

**Blank means NOBODY** — `/dashboard`, `/instances` and `/admin` render the "No console access"
card for *every* account, including yours. This inverted in Stage 0 (`isOperator()`,
`apps/web/lib/owner-context.ts`). It used to mean "any signed-in non-owner is an operator", which
was the hole: the anon key ships in the browser bundle and Supabase enables `/auth/v1/signup` by
default, so a stranger could self-sign-up and read every tenant. Do not deploy the console without
this variable set, and set it in the **same** deploy as the code — not after.

An owner (anyone with a membership) always lands on `/owner` and is unaffected either way;
`(owner)/layout.tsx` gates on membership, not on this list. Being listed here *wins over* holding a
membership — a listed email stays an operator even after you provision yourself an owner login on a
test tenant, which is what stops that from locking you out of the operator console.

Consumed by the **web** service via `env_file`. It is a runtime variable, so changing it needs
`up -d`, not a rebuild. When it is blank the web tier logs
`[auth] PLATFORM_OPERATOR_EMAILS is unset …` at startup and again from `instrumentation.ts`,
because the symptom — a correct login seeing a refusal card — does not name its own cause.

How the binding works: the console resolves the signed-in Supabase user through
`GET /v1/auth/context`, which matches `users.sso_subject` and returns their org. The org a page
renders is therefore derived on the server from a verified session — never from a URL or header.

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

`ADMIN_API_KEY`, `JWT_SECRET`, `APP_DB_PASSWORD`, `RABBITMQ_PASSWORD`, `S3_SECRET_ACCESS_KEY`, and
`CRM_SECRET_KEY` — the last one as `openssl rand -hex 32`, because it is an AES-256 key rather than
a password.

**The API refuses to start** if `ADMIN_API_KEY`, `JWT_SECRET`, `CRM_SECRET_KEY` or
`APP_DATABASE_URL` is unset or still holds a published example value: `assertRequiredEnv()`
(`apps/api/src/config/assert-env.ts`) is the first statement of `bootstrap()` and throws, so the
container restart-loops instead of serving behind a key anyone can read from this repository. It
reports *every* offender in one error — one pass over `.env.production`, not four deploys. The web
tier does the same for `ADMIN_API_KEY` and the two `NEXT_PUBLIC_SUPABASE_*` values
(`apps/web/instrumentation.ts`). A crash loop at this point is the assertion working.

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
web image. The console's per-tenant pages (dashboard, calls, agents, search, usage,
client-config, crm) still resolve their org from those variables rather than from the signed-in
session; only `/instances` is genuinely multi-tenant. See §7.

Finally, give the customer their own login: **Instances → \<customer\> → Owner Logins → Create
owner login** (§2c). The password is shown once. They sign in at the same `/login` and land on
`/owner`, which is scoped to their org by the session — no `DEV_ORG_ID` involved.

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

## 5b. Publishing a build to the fleet (Build docs/49 P3)

**Uploading is not publishing, and this is where six weeks of work went missing.** On 2026-10-14
the newest PUBLISHED release was 1.1.4 / code 8 from 2026-09-18, while `CallRecorderApp/dist/`
held a signed `Aura-1.2.1-11.apk` built on 2026-10-12. Four features - missed-call capture
(0133/0134), phone alerts (0150), live pairing (0124) and the whole client half of attendance -
were built, server-deployed, and on zero phones. The update channel had never been offered the
build, so no handset could get it.

`scripts/alerts.js` now fires `fleet_behind` when a built APK is unpublished or when devices are
two or more builds behind. That closes the *noticing*. The sequence below is the *doing*.

```bash
# 1. UPLOAD. No --publish. Nothing is offered to any phone by this step.
docker cp CallRecorderApp/dist/Aura-1.2.1-11.apk aura-api-1:/tmp/
docker exec aura-api-1 node scripts/publish-app-release.js /tmp/Aura-1.2.1-11.apk   --notes "Missed-call capture, phone alerts, live pairing, attendance"

# 2. CONFIRM what is staged against what is live.
docker exec aura-api-1 node scripts/publish-app-release.js --list

# 3. INSTALL IT ON ONE HANDSET BY HAND and use it. This is the only safety there is.
#    Verify, concretely: a missed call appears as a NO_AUDIO row within minutes; a new
#    lead raises a lock-screen alert; the QR pairing dialog flips to Connected by itself.

# 4. ONLY THEN. This is the rollout.
docker exec aura-api-1 node scripts/publish-app-release.js --promote 11
```

Three traps, two of them now enforced by the script rather than remembered:

1. **`--promote` IS the rollout.** Android 12+ installs it unattended, between calls, within about
   six hours. There is no staged rollout and no canary — the flag flips and the fleet moves. Step 3
   is not optional.
2. **Rollback is asymmetric.** `--unpublish` stops the spread; it does not undo an install, because
   Android will not downgrade. Recovering a bad build needs a **new, higher** `versionCode`
   carrying the old code.
3. **Never publish 1.2.0 / code 10** (`phone-alerts-0150`). The script now refuses it by name, and
   refuses to promote any code older than the one already live — which would otherwise offer the
   fleet an update every installer must reject, leaving a permanent un-satisfiable update prompt.

**Still outstanding, and not a code problem:** distribution is sideload, so Play Protect warns on
every install and the test Honor handset is still unpaired. The cheapest real fix is a Play
**internal testing track** — about a day plus $25, kills the warning for up to 100 testers, and
removes the ugliest moment in onboarding. Closed testing needs a data-safety form whose honest
answer is "yes, we record calls"; a production listing draws policy review on call recording and
should be budgeted for a rejection and a resubmit.

---

## 6. ASR / analyze provider

Precedence is `ASR_STUB`/`ANALYZE_STUB` → **Sarvam** → **Gemini**, and since migration 0202 that
sentence is true for the first time. It used to describe the intent while the code chose on KEY
PRESENCE alone: `sarvamAsrConfigured()` answered "is a key set", so a Sarvam account with no credit
kept every call for 62 days while a funded Gemini key sat configured and idle. Precedence now runs
over provider HEALTH — a vendor that refuses us is parked in `asr_provider_health` and skipped
exactly as if its key were unset. See `apps/worker/src/pipeline/asr-route.ts`.

```bash
ASR_PROVIDER_ORDER=gemini,sarvam     # optional: make Gemini primary without a code change
ASR_PREFLIGHT_INTERVAL_MS=86400000   # full credit pre-flight, daily
ASR_PARKED_PROBE_INTERVAL_MS=900000  # re-probe a PARKED vendor every 15 min, so a top-up
                                     # is honoured in minutes rather than after the cooldown
```

The worker's boot banner now reports which providers are **usable**, not which are configured —
`asr[sarvam UNUSABLE (provider_out_of_credit) | gemini:gemini-3.5-flash inline]`. A line reading
`← NOTHING WILL TRANSCRIBE` means every configured vendor is parked.

Set `SARVAM_API_KEY` and both
stages route there; leave it unset and both fall back to Gemini. `ANALYZE_PROVIDER`
(`auto`|`gemini`|`sarvam`) decouples the two, so analyze can sit on Gemini while ASR stays on
Sarvam — useful because they have very different failure modes.

**Sarvam (Saaras v3)** is the default for Indic call audio: measurably better on Tamil, and the
only option that gives real acoustic diarization. It runs on the **batch** API, because
diarization and audio over 30s are batch-only. That makes ASR asynchronous — `processCall` submits
the job, records `calls.asr_job_id` and stops at `TRANSCRIBING`; `startAsrPoller` finishes the
call when the job lands. **Requires migration 0015.** Per-instance language/mode/vocabulary
requires **0016**.

Set the instance's `asr_mode` to `codemix` for any customer whose calls mix English into an Indic
language: the default `transcribe` mode transliterates English, turning "RD Interlock" into
"ஆர்டி இன்டர்லாக்" — unusable as a CRM value.

**sarvam-105b** (the only chat model left; 30b is deprecated) is a *reasoning* model. Reasoning
bills as output and counts against `max_tokens`, and on the **starter** tier the ceiling is 4096 —
enough that roughly one request in five overruns it and returns nothing. `SARVAM_LABEL_CHUNK`,
`SARVAM_REASONING_EFFORT` and `SARVAM_MAX_ATTEMPTS` exist purely to survive that; raise the first
and drop the last after a plan upgrade.

**Gemini** transcribes and diarizes in one call, inline, with no migration requirement. Never
point `GEMINI_*_MODEL` at a `-latest` alias or at `gemini-2.5-flash`: the alias moves underneath a
running deployment, and 2.5-flash is retired for new users and answers `404`.

Either way, analyze *labels* ASR's segments (role + intent) rather than re-splitting the text — it
never overwrites what ASR produced.

`ASR_STUB` / `ANALYZE_STUB` must be `0`. They emit clearly-fake transcripts, which is useful in
tests and disastrous in production.

---

## 6b. Device push (FCM)

Push is what makes remote **logout**, **wipe** and **ping** reach a handset in seconds. Without it
none of those break — they fall back to the handset's ~1h `ConfigRefreshWorker` poll — but "I
wiped that phone" then means "within the hour", which is not what the console's wording implies.

**Requires migration 0098** (`devices.fcm_token`). It is the newest migration in the repo, so it
is the one most likely to be missing on a stack that was deployed before it landed; without the
column the app's token registration 500s and the handset stays unreachable by push.

Two things must line up, and they are easy to get half-right:

1. **The server needs an Admin SDK credential.** Firebase Console → Project Settings → Service
   Accounts → Generate New Private Key, then base64 it into `FIREBASE_SERVICE_ACCOUNT_B64` in
   `.env.production` (see `.env.production.example` for the exact commands). It must be for the
   **same** Firebase project as the Android app's `google-services.json` — `auratel-9ddbd`. A key
   from another project initialises perfectly and then fails every single send.

   Base64, not a path: the `api` container has no volume mount, so `FIREBASE_SERVICE_ACCOUNT_PATH`
   set here names a file that does not exist inside the container. That form is for local dev only.

2. **The handsets need to be on a build that registers a token** — `versionCode` 6 / `1.1.2` or
   newer. Earlier APKs have no FCM at all, so their `devices.fcm_token` stays null forever and
   `ping` returns `{"pinged": false}` for them. See §5.

Neither half announces itself when it is missing: devices keep recording and uploading normally,
and a console operator sees no error. Check explicitly, after every deploy that touches this:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml logs api | grep -i "FCM push"
# "FCM push enabled (project auratel-9ddbd)"  -> credential loaded, right project
# "No Firebase credential ..."                -> step 1 not done; push disabled
```

Then prove the round trip against one real handset — `POST /v1/devices/:id/ping` is there for
exactly this and changes no device state:

```bash
curl -X POST https://<api-host>/v1/devices/<device-uuid>/ping -H "x-admin-key: <key>"
# {"pinged": true}  -> credential, token and delivery all working
# {"pinged": false} -> no stored token (old APK, or step 2), or no credential (step 1)
```

`FIREBASE_SERVICE_ACCOUNT_B64` is a secret on the level of `JWT_SECRET`. It is read once at boot,
and it arrives via `env_file` — which compose resolves when it *creates* a container. So picking up
a new value needs `up -d` (which recreates `api` because its config changed), **not** `restart`,
which hands the existing container back its existing environment and will have you re-checking a
correct `.env.production` wondering why the log line has not changed. No `--build`: the image is
unaffected.

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d api
```

---

## 7. Known gaps — read before onboarding a real customer

These are honest limitations of the current build, not deployment steps. Stage 0 closed several
that used to be listed here; what remains is stated against the code as it stands today.

**Closed by Stage 0 — do not re-derive them from an older copy of this file.** The `dev-admin-key`
fallback is gone from the API (`resolveAdminKey()` returns `null` under `NODE_ENV=production`, so a
missing variable denies rather than accepting a published string) and from the web tier
(`lib/server-api.ts`, same rule). `assertRequiredEnv()` and `instrumentation.ts` refuse to boot in
production on a missing or example credential. `isOperator()` now denies by default (§2c). `main.ts`
has `helmet()`, a 1 MB JSON body limit, `trust proxy 1`, a comma-separated CORS allowlist and a
global throttler (100/min default; 5/min on `POST /v1/auth/login`, 10/min on
`POST /v1/devices/register`). `verify-rls.js` derives its table set from `information_schema` and
fails by name on any `org_id` table lacking FORCE RLS or a `WITH CHECK` policy, so a future
migration cannot add an unprotected tenant table quietly.

1. **`ADMIN_API_KEY` is effectively a root credential.** It authenticates every `/v1/admin/*`
   call and crosses tenant boundaries. Keep the key on the server only, never in a browser or a
   phone. Supabase Auth (§2b) plus `PLATFORM_OPERATOR_EMAILS` (§2c) gate who can open the console,
   but the console's own server components still read the API with this key — a signed-in operator
   is implicitly an admin, and the API itself does not yet verify the Supabase session. Per-role
   API authorisation is still unbuilt.

   This matters most for **owner logins** (§2c): an owner's tenant scoping is enforced in the web
   tier, where the org is resolved from a verified session and never from the request, and the
   admin key stays server-side so a browser cannot call the API directly. It is a sound boundary
   as long as the console is the only client. Anything that hands an owner a token for the API
   itself needs the guard to verify the Supabase JWT and pin the org from `users.sso_subject`
   first — `AdminKeyGuard` already does exactly this for its own session tokens, so it is a
   branch to add, not a redesign.

   **CORRECTION, 2026-10-14.** This item used to end with a paragraph claiming owner-role
   enforcement is *advisory* — that "anyone holding the admin key satisfies every
   `@RequireOwnerRole` by sending no header at all". **That hole is closed and the claim was
   stale.** `OwnerRoleGuard` (`common/owner-role.guard.ts`) derives the persona from `memberships`
   via `AuthService.ownerRoleFor`, and `admin-key.guard.ts` keeps parsing `x-caller-owner-role`
   only for introspection — nothing authorizes against it. Stage 2.5 fixed it; this file did not
   catch up.

   The correction matters beyond the one paragraph: **a security document that overstates its
   holes gets discounted wholesale, including on the items where it is right.** Everything left in
   this section was re-read against the code on 2026-10-14.

   **What P5-A changed.** The API now verifies a Supabase JWT itself
   (`common/supabase-jwt.ts`), as a THIRD principal source beside the admin key and the API's own
   `aus_` sessions. On that path the org is resolved `claims.sub` → `users.sso_subject` →
   `memberships` and **`x-org-id` is demoted from an assertion to a selector among the caller's own
   workspaces** — a token for org A cannot reach org B even while sending `x-org-id: B`. Set
   `SUPABASE_JWT_SECRET` (HS256, what self-hosted GoTrue signs with) or leave the Supabase URL set
   and it will use the published JWKS. Unset both and the branch is skipped entirely, so nothing
   changes.

   The admin-key path is **untouched**, deliberately: the console can be moved off the root key one
   route at a time (P5-B) rather than in one change that has to be right everywhere at once. Until
   that happens the sentence at the top of this item still holds — the admin key is a root
   credential, and the new path reduces what *needs* one rather than what one can do.

   **Cross-tenant access is now recorded.** `CrossTenantAuditInterceptor` writes an `audit_log` row
   when a platform operator touches a tenant, or on any mutation through the admin key, deduplicated
   to one row per (actor, org, route) per hour. Before this, "did anyone read that customer's calls,
   and who" had no answer at all. A tenant member's own GET is not logged — it is not cross-tenant,
   and logging it would bury the rows that are.
2. **~~`JWT_SECRET` has a published dev fallback~~ — CLOSED 2026-10-14 (P6a).** All four sites
   (`common/device-auth.guard.ts`, `common/device-nonce.ts`,
   `modules/devices/devices.controller.ts`, `modules/tenancy/erasure.controller.ts`) now read
   `jwtSecret()` from `config/secrets.ts`, which **throws** when the variable is unset or holds a
   published default — in every environment, not only production. A `??` that substitutes a
   known-public value fails *open*; this fails closed. `secrets.spec.ts` also pins its
   rejected-value list as a superset of `assert-env.ts`'s, because two separate lists are exactly
   the shape that drifts silently.

   **And the device token's claims are validated** (P6b). `DeviceAuthGuard` used to copy `org_id`
   and `instance_id` straight off the payload with no parsing, so a token carrying neither produced
   `req.device.orgId === undefined` and the handlers passed that into `withOrg(undefined)` — a
   tenant context set from nothing. Every claim the handlers go on to trust is now uuid-checked.

   **What the guard still does not do, and why.** It does not read the device row. The tenant
   boundary on this path is enforced by RLS one layer down: every device handler opens
   `withOrg(req.device.orgId)` and then reads its own device row by id, so a token naming the
   *wrong* tenant enters that tenant's context and finds no row — 409 from ingest, 401 from config.
   A forged token cannot reach another tenant's data by naming it; it reaches a context where it
   owns nothing. Revocation is likewise the handler's job and is already built
   (`POST /devices/:id/logout`, `/wipe`, `/owner/devices/:id/revoke` all set a non-`active`
   status, and the handlers refuse those), and tokens already expire in 15 minutes. The residual
   exposure is that an already-issued token stays cryptographically valid for the rest of those 15
   minutes while being able to do nothing — which is the right trade against a database round trip
   on the hottest `@SkipThrottle()`d route on the platform. `device-auth.guard.spec.ts` pins that
   reasoning so it is not rediscovered as a bug.
3. **The operator console is single-tenant apart from `/instances`.** Its per-tenant pages read
   `DEV_ORG_ID`, so operating a second customer from them means changing that variable and
   rebuilding the web image. The **owner** console (`/owner`, §2c) is not affected — it resolves
   its org from the signed-in session, so every customer's owner sees their own instance without
   any per-tenant configuration.
4. **`NEXT_PUBLIC_API_URL` is baked at image build time.** Changing the domain requires
   `up -d --build`, not a restart. `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   follow the same rule (§2b), which is why an image built without `--env-file` ships sign-in
   disabled no matter what the runtime environment says.
5. **MinIO is a single container on a single disk.** Volume `miniodata` holds every recording;
   back it up (see §8). No replication, no lifecycle rules.
6. **Both-ends call capture is device-dependent.** On the tested phone `VOICE_CALL` is blocked,
   so the rep must tap Speaker manually or the transcript will contain only their side.
   Text-based diarization will still invent a "Customer" speaker — `diarized=true` is not
   evidence both sides were recorded.
7. **Transcription is post-call**, not streaming.
8. **Play Integrity and FCM push** are stubs; they need external credentials.
9. **CRM connectors authenticate with API keys and pasted tokens, not OAuth.** Every provider in
   the catalogue works this way today. For HubSpot (private app token), Pipedrive, GoHighLevel,
   Freshsales, Close, Attio, Keap, Zendesk Sell, Kylas, LeadSquared and Bitrix24 that is the
   vendor's normal long-lived credential and nothing expires. For **Salesforce, Zoho, monday and
   Dynamics 365 the pasted access token expires** — hours in Zoho's and Salesforce's case — and
   deliveries start failing with 401 until someone rotates it on the integration card. Treat
   those four as usable for pilots, not unattended production, until the OAuth refresh flow
   lands. The schema already carries everything that flow needs: a refreshed access token is
   just a new bearer secret.
10. **`CRM_SECRET_KEY` is unrecoverable.** It seals every stored CRM credential with AES-256-GCM.
    Lose it and each connected CRM must be re-authenticated by hand — back it up wherever you
    keep `JWT_SECRET`. It is now a **fatal** boot check in the API (§3), so "unset" is a crash
    loop rather than silent plaintext storage; the worker still only warns. Rows written before
    the key existed stay plaintext and keep working — `decryptSecret()` returns an unprefixed
    value unchanged — so setting a fresh key is safe and does not strand existing credentials.
11. **Automated coverage stops at unit tests.** `pnpm -r test` covers `packages/{shared,db,llm}`
    and `apps/worker`; there is no test runner in `apps/api` and no integration job in CI, so the
    guard stack, tenant isolation over HTTP and the device-auth path are verified by review and by
    `verify-rls.js` against a scratch database, not by a test. Treat a green CI as "nothing
    obviously regressed", not as "isolation still holds".

---

## 8. Operations

```bash
# logs
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f api worker

# update after a code change
git pull && docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build

# apply a new migration
docker compose --env-file .env.production -f docker-compose.prod.yml --profile setup run --rm migrate

# is device push actually live? (silent when it is not — see §6b)
docker compose --env-file .env.production -f docker-compose.prod.yml logs api | grep -i "FCM push"
```

**Backups.** Two things hold state, and **nothing backs up either of them for you.** That is
the bill for leaving managed Postgres: Supabase's automatic backups used to cover the database,
and self-hosting cancelled them.

* Postgres — `supabase/selfhost/bin/backup.sh`, on a cron. On-box to MinIO plus an encrypted
  offsite copy; `bin/restore-test.sh` restores into a throwaway container and checks the row
  counts and RLS survived. **A backup nobody has restored is a belief, not a backup** — run
  the restore test before you need it, and on a schedule after.

  ```cron
  15 2 * * * cd /opt/aura/platform/supabase/selfhost && bash bin/backup.sh >> /var/log/aura-backup.log 2>&1
  ```

* Recordings — the `miniodata` volume. Nothing backs it up for you either:

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

---

## 9. Account menu, storage meter and setup guide (Build docs/27)

Migrations **0126–0129**, applied with the normal `--migrate` step. Before applying them to
production:

* **0128 builds an index on `recordings`** (`recordings_org_uploaded`) with a plain
  `CREATE INDEX` inside the migration transaction. That holds a lock that blocks handset upload
  *completion* while it builds. Count the rows first, read-only, through the live container:

  ```bash
  ssh root@<vps> "docker exec -i aura-api-1 node -" <<'JS'
  const { Client } = require("/app/packages/db/node_modules/pg");
  const ssl = require("/app/packages/db/ssl.js");
  (async () => {
    const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: ssl.sslFor(process.env.DATABASE_URL) });
    await c.connect(); await c.query("BEGIN TRANSACTION READ ONLY");
    console.log((await c.query("SELECT count(*) FROM recordings")).rows[0]); await c.query("ROLLBACK"); await c.end();
  })();
  JS
  ```

  Under ~1M rows it builds in seconds. Above that, build it by hand first with
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS recordings_org_uploaded ON recordings (org_id) INCLUDE (bytes, uploaded_at) WHERE uploaded_at IS NOT NULL;`
  and the migration's `IF NOT EXISTS` becomes a no-op.
* **0129 shows the setup guide to existing tenants.** `guide_completed_at` / `guide_dismissed_at`
  start NULL, so every existing owner and manager sees "Finish your setup - X of N" in the sidebar
  after the deploy (doc 27 Q7). An owner can hide it. The required-steps *banner* stays off for
  them (`setup_completed_at` is untouched).

**New settings** (both in `.env.example` / `.env.production.example`):

| Variable | Read by | Default | What |
|---|---|---|---|
| `STORAGE_USAGE_INTERVAL_MS` | worker | `3600000` | How often each workspace's stored recordings are measured. The console only ever reads the snapshot. |
| `NEXT_PUBLIC_SUPPORT_CONTACT` | web, at runtime | blank | An email or `https://` URL linked from Plan & usage's "contact your account manager". Read at runtime through `env_file` - a restart applies it, no rebuild. |

**Abandoned multipart uploads (doc 27 §6.5, finding 2).** A handset retry starts a fresh multipart
upload, and FAILED_UPLOAD calls are abandoned. MinIO already cleans these up on its own: its
`api stale_uploads_expiry` defaults to **24h**, swept every `stale_uploads_cleanup_interval`
(**6h**). Check that nobody has changed them (read-only):

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm --entrypoint /bin/sh minio-init \
  -c 'mc alias set local http://minio:9000 "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null && mc admin config get local api | tr " " "\n" | grep stale_uploads'
```

Doc 27 also proposed an `AbortIncompleteMultipartUpload` lifecycle rule after 7 days. With the
24h default in place it is redundant, and it is a **production bucket-policy change, so it is not
applied by `deploy.sh`** - only apply it with an explicit go-ahead, e.g. if the check above shows the
expiry was raised or disabled:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml run --rm --entrypoint /bin/sh minio-init \
  -c 'mc alias set local http://minio:9000 "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" >/dev/null &&
      echo "{\"Rules\":[{\"ID\":\"abort-incomplete-multipart\",\"Status\":\"Enabled\",\"Filter\":{\"Prefix\":\"\"},\"AbortIncompleteMultipartUpload\":{\"DaysAfterInitiation\":7}}]}" |
      mc ilm import "local/$S3_BUCKET"'
```

**What only a real Supabase can prove** (local dev has no Supabase, so no login exists there).
Each touches production auth - use a dedicated test account, never a client's, and only with a
go-ahead:

1. **Log out from all devices**: sign in as the test account in two browsers; log out everywhere
   in A; B's next navigation must land on `/login`, and B's open `/events` stream must close within
   5 minutes (it re-checks its session every 5 minutes).
2. **Password change**: the old password fails, the new one works, and a second browser is signed
   out when "Sign out of my other devices" was ticked.
3. **Login activity**: a sign-in appears with *your* public IP, not the proxy's. The web tier takes
   the right-most `X-Forwarded-For` hop, which host nginx appends (`$proxy_add_x_forwarded_for`).

---

## 10. Observability and alerting (Build docs/49 P2)

**Read this first: for 62 days the entire observability stack was `GET /health`, and it was green
the whole time while 96% of the product's core function failed.** A health check that cannot see
the business failing is not monitoring; it is reassurance. Everything in this section exists
because of that, and the ordering below is "what would have caught it", not "what is easiest".

### 10.1 Error tracking

`SENTRY_DSN` (or `GLITCHTIP_DSN`) in `.env.production` turns it on for all four apps. Unset is a
warning line at boot and a no-op — observability that can take the product down is worse than none.

```bash
# any Sentry-compatible ingest, incl. a self-hosted GlitchTip on the box
SENTRY_DSN=https://<public-key>@errors.example.com/<project-id>
SENTRY_ENVIRONMENT=production
BUILD_SHA=$(git rev-parse HEAD)      # so an event names the commit it came from
```

`packages/shared/src/observability.ts` does **not** use the Sentry SDK, and the reason is the one
non-negotiable constraint on this product. The SDK's model is capture-then-redact: it instruments
HTTP and attaches request bodies, headers, cookies and breadcrumbs, leaving you to strip what you
do not want. That is a denylist, and a denylist over a payload of customer call content is wrong
the first time somebody adds a field. Here an event is **constructed** from four things — an error
type, a scrubbed message, stack frames, and five allowlisted tags — so there is no field a
transcript, a phone number or a presigned recording URL can travel in. `observability.test.ts`
asserts that against the serialised wire body, not against an object.

What is tagged: `service`, `environment`, `org_id`, `call_id`, `where`. Ids only — an `org_id` that
is not shaped like an id is dropped rather than sent, because a tenant NAME passed where an id was
expected is the likeliest way identity leaks and both are strings.

### 10.2 The alerts — `scripts/alerts.js`

Twelve checks, on **business ratios** rather than process liveness, because technical monitoring
would not have caught the incident that prompted them: no exception was thrown, every container was
healthy, and the queue was empty because work was completing.

```cron
*/5 * * * *  cd /opt/aura/platform && node scripts/alerts.js       >> /var/log/aura-alerts.log 2>&1
0   9 * * *  cd /opt/aura/platform && node scripts/alerts.js --digest >> /var/log/aura-alerts.log 2>&1
```

```bash
ALERT_WEBHOOK_URL=https://...        # Slack / Discord / Chat / Mattermost / n8n, same body shape
ALERT_TIMEZONE=Asia/Kolkata          # decides what "a business hour" means
BACKUP_DIR=/opt/aura/platform/supabase/selfhost/backups
RABBITMQ_MANAGEMENT_URL=http://localhost:15672   # optional; queue depth is skipped without it
ALERT_REMIND_AFTER_MS=21600000       # 6h between reminders for a still-firing alert
```

| Check | Fires when | Why that threshold |
|---|---|---|
| `asr_success` | <80% of audio-bearing calls complete in 1h, ≥20 calls | P1's exact signature. Would have fired 2026-08-13. `NO_AUDIO` excluded — those never had audio. |
| `provider_parked` | any vendor parked in `asr_provider_health` | Names the vendor, so the alert is actionable rather than worrying |
| `queue_depth` | >500 ready messages | The worker is dead or losing |
| `stuck_transcribing` | any call >2h in TRANSCRIBING | The poller died; invisible to both retry sweeps |
| `zero_ingest` | 0 calls in a business hour with active devices | FCM, pairing, or the APK |
| `device_silence` | any active device unseen >48h | A sleeping phone records nothing |
| `backup_age` | newest dump >36h old, or <1MB | A script that exits 0 having written nothing looks like success |
| `disk_space` | >80% on `/` | MinIO grows monotonically |
| `fleet_behind` | a built APK is unpublished, or devices ≥2 builds behind | This was invisible for four weeks (P3) |
| `worker_heartbeat` | no beat for 10 minutes | The one signal with no false negative |
| `platform_incidents` | any live `source='system'` ticket | One line carries the occurrence count |
| `storage_runway` | <60 days of free space at the measured rate | A projection is a number you can put in a calendar |
| `monitor_broken` | any check throws | A monitor that silently stops covering something is this document's whole lesson applied to itself |

**The daily digest is not a courtesy.** Silence from a monitor is ambiguous — fixed, or dead? — and
an alarm nobody has ever seen fire is an alarm nobody trusts. The 09:00 line is the daily proof that
the thing runs at all.

Useful by hand:

```bash
node scripts/alerts.js --list            # what is firing, and whether it ever reached anybody
node scripts/alerts.js --dry-run         # check without notifying
node scripts/alerts.js --test smoke      # prove the webhook works, end to end
```

`--list` marks a firing alert `[NEVER DELIVERED]` when `last_notified_at` is NULL. That is the
misconfigured-webhook case, and it is the one failure a monitoring system cannot report any other
way.

### 10.3 From outside the box

`.github/workflows/uptime.yml`, every 15 minutes, with `UPTIME_WEBHOOK` as a repo secret and
`UPTIME_CONSOLE_URL` / `UPTIME_API_HEALTH_URL` as repo variables. **If the VPS is down the on-box
cron is down too**, so this is the only check that can report a total outage — and it is the only
one that must not live on the box. It hits unauthenticated health paths only, so no credential sits
in a public repository's CI.

It proves "the process is answering", not "the product is working". §10.2 is the second question,
and the two are complementary: `GET /health` answering 200 is exactly what was true for 62 days.

### 10.4 Verifying it, which is the part people skip

Break things on purpose, in staging:

```bash
# 1. the vendor refuses us  → asr_success + provider_parked + platform_incidents
docker exec aura-test-api env SARVAM_API_KEY=invalid ...   # or park it by hand:
psql -c "UPDATE asr_provider_health SET parked_until = now() + interval '1 hour',
         last_reason = 'provider_out_of_credit' WHERE provider = 'sarvam'"

# 2. the worker dies        → worker_heartbeat, within 10 minutes
docker compose stop worker

# 3. the backup stops       → backup_age, within 36 hours (or touch an old file to test now)

# 4. delivery works at all  → the one test that proves the pipe
node scripts/alerts.js --test smoke
gh workflow run uptime.yml -f force_failure=true
```

**An alert nobody has ever seen fire has not been tested.** Each of the four above should land in
the channel; `--list` should then show the condition clearing and a `RESOLVED` line should be posted
exactly once.

---

## 11. Backups, and the restore that proves them (Build docs/49 P4)

### 11.1 The state this section exists to change

As measured on 2026-10-14: the nightly database backup was running and succeeding, and
`OFFSITE_ENDPOINT`, `OFFSITE_BUCKET` and `OFFSITE_PASSPHRASE` were all **unset**. The off-box copy
was built, reviewed, committed — and never configured. So one VPS held the only Postgres, every
recording in MinIO, and every backup of both. Recordings had no backup at all.

That is the largest single-point-of-loss in the system, and the first part of the fix is filling in
four environment variables.

### 11.2 Turn the off-box copy on

In `supabase/selfhost/.env.selfhost`:

```bash
OFFSITE_ENDPOINT=https://s3.<region>.<provider>.com
OFFSITE_BUCKET=aura-db-backups
OFFSITE_ACCESS_KEY=...
OFFSITE_SECRET_KEY=...
OFFSITE_PASSPHRASE=...            # the dump is AES256-encrypted before it leaves
OFFSITE_RETAIN_DAYS=90

# recordings (bin/backup-recordings.sh) — a mirror, not a tar
RECORDINGS_OFFSITE_BUCKET=aura-recordings-backup
RECORDINGS_OFFSITE_SSE=1          # you are asserting the bucket is private and encrypted at rest
```

**Pick a target that is not this VPS and not this provider.** Provider-correlated failure — a
billing dispute, an account suspension, a regional outage — is the scenario that matters; a second
bucket at the same provider does not survive it.

**Write `OFFSITE_PASSPHRASE` down wherever `JWT_SECRET` and `CRM_SECRET_KEY` live.** An encrypted
backup whose passphrase died with the server is a tidy way to lose the data twice.

```cron
15 2 * * *  cd /opt/aura/platform/supabase/selfhost && bash bin/backup.sh            >> /var/log/aura-backup.log 2>&1
45 2 * * *  cd /opt/aura/platform/supabase/selfhost && bash bin/backup-recordings.sh >> /var/log/aura-backup.log 2>&1
```

Recordings run **after** the database, in their own script, deliberately: the dump is tens of MB
and finishes in seconds, the recordings are 61 GB and growing. Folding them together would mean a
`set -e` on one object transfer abandoning the backup of the thing you cannot rebuild.

### 11.3 Rehearse the restore — this is the part that converts belief into fact

```bash
bash bin/restore-test.sh              # the ON-BOX copy: proves pg_dump works
bash bin/restore-test.sh --offsite    # the OFF-BOX copy: proves you survive losing the machine
```

Only the second one proves anything about disaster recovery. It pulls the encrypted copy, decrypts
it with `OFFSITE_PASSPHRASE` — which is itself a test nobody else runs — and restores into a
throwaway Postgres on `--network none` that is removed on every exit path.

It checks five things, and the last two were added because they are the ones people skip:

1. `pg_restore` reports no unexpected errors (`pg_net` and `supabase_vault` are expected to fail —
   they are Supabase-only extensions and plain Postgres cannot provide them);
2. row counts match the manifest taken at backup time (orgs, calls, `auth.users`, migrations);
3. every `org_id` table still has FORCE RLS — a restore can return the rows and lose the tenant
   boundary, and row counts alone would pass;
4. **`max(name)` from `schema_migrations`** — not the count. The count can be right while the
   database is the wrong one: a dump taken mid-deploy, or from the *other* Supabase stack on this
   box (`supabase-db` belongs to an unrelated product; Aura's is `aura-supabase-db`);
5. **one sealed credential actually decrypts** with the current `CRM_SECRET_KEY`. Every CRM API
   key, OAuth client secret and messaging token is AES-256-GCM sealed under that key, which lives in
   `.env.production` and *not* in the dump. A restored database full of credentials nobody can
   decrypt is a restored database you cannot operate — and you find out weeks later, as
   unexplained 401s from a customer's CRM.

Export `CRM_SECRET_KEY` before running it, or check 5 reports that it could not be proved.

### 11.4 The record

**A backup nobody has restored is a belief, not a backup.** Write the date here each time, so the
claim in the Terms of Service §4.1 has evidence behind it:

| Date | Source | Hardware | Result |
|---|---|---|---|
| _not yet_ | — | — | **No restore has ever been performed.** `bin/restore-test.sh` has existed, unrun, since the Supabase cutover. |

The target to beat: a restore from off-box media, on a machine that is not this VPS, with nothing
carried over but the dump and the passphrase.

### 11.5 What is still a known loss

- **RPO is up to 24 hours** (nightly at 02:15) and **RTO is hours to days** (a hand-rebuilt VPS).
  Both are now stated in the Terms of Service §4.1 rather than left to a customer's assumption.
- **The recordings mirror has no history.** It is the current state, which is correct for immutable
  objects, and it means a local deletion bug would propagate on the next run — `--remove` stays off
  precisely so it does not.
- **The mirror never deletes.** When the retention job removes audio past a tenant's window, the
  offsite copy keeps it until the target's own lifecycle rule expires it. Set that rule to match the
  longest retention tier sold, or the bill grows for data a customer was told was deleted.

---

## 12. Release discipline and staging (Build docs/49 P7)

### 12.1 What was wrong, and why it is a defect *generator*

Measured 2026-10-14: production ran commit `eded853` on branch
`crm-connectors-and-console-auth` — a feature branch from an old phase that became the release line
by accident — while `main` sat **29 commits behind, 0 ahead**, eight branches were live, and two
migrations in the tree (`0199`, `0200`) were not applied. "What is in production" was answerable
only by SSH, which is precisely how drift survives.

There was also **no environment between a laptop and four paying customers**, so production has
been the first real execution of every migration this project has written. That is not carelessness;
it is what a manual multi-branch deploy with no staging produces on a long enough timeline.

### 12.2 Deploy, with the guards

`./deploy.sh` now refuses four things it used to allow:

| Refuses | Because |
|---|---|
| a dirty working tree | the image is built from the **tree**, not the commit. A parallel session fixed a file between `git add` and `git commit`, the stale copy shipped, and the production worker crash-looped. |
| a tree out of sync with origin | so "what is in production" is answerable from the remote, not only from the box |
| a pending migration without `--migrate` | `0199`/`0149`: code in front of its own schema 500s one route while everything else reports healthy. The tree is compared against `schema_migrations`; it is detected, not remembered. |
| a deploy it cannot verify afterwards | "compose exited 0" is not a deploy |

`--force` exists and prints a warning. Use it when you mean it.

After the restart it asserts, and exits non-zero on any of them:

- the running `api` and `worker` containers report the `BUILD_SHA` this script just built — a
  container that was *not recreated* keeps the old value, which is the case worth catching;
- the API health path answers on the loopback port nginx proxies to;
- `max(schema_migrations)` matches the newest migration in the tree;
- and one business number — whether any ASR provider is parked. `/health` was green for the 62 days
  the product transcribed 4% of its calls, so a deploy reporting only "the process is up" reports
  exactly what it reported throughout that outage.

**One deploy branch.** Pick it and delete the rest once merged. The convention this runbook assumes
is: **`main` is what deploys**, everything merges there, and `deploy.sh` enforces sync with its
upstream. If the long-lived feature branch is kept as the release line instead, rename it `release`
so the name says what it is — the current state, where prod tracks a branch named after a finished
phase, is the problem rather than a detail of it.

### 12.3 Picking a migration number

```bash
node scripts/check-migrations.js --next
```

In CI as well, so a duplicate or a new gap fails a push rather than a deploy. The eight intentional
holes and the one duplicated number (0083) are documented in `platform/README.md` — including why
renumbering 0083 is the *risky* fix, not the safe one.

### 12.4 Staging

```bash
cp .env.production .env.staging     # then change every domain, port and credential
docker compose -f docker-compose.staging.yml --env-file .env.staging up -d --build
docker compose -f docker-compose.staging.yml --env-file .env.staging \
  --profile setup run --rm migrate          # migrate + verify-rls, in one command
```

A second compose project on the same box: its own Postgres, RabbitMQ, MinIO and volumes, ports on
`127.0.0.1:19xxx`, and a different image tag (`aura-staging-node:latest`) so a staging build cannot
replace the image production restarts into. Production's database is a *separate compose project*
that this file never references, so a mis-set `DATABASE_URL` cannot reach it.

**The worker here sends nothing.** `ASR_STUB`, `ANALYZE_STUB`, `CRM_DISPATCH_ENABLED=false`,
`OUTBOUND_MESSAGING_ENABLED=false`, `FCM_ENABLED=false`, and both provider keys blank — set in the
compose file rather than in a runbook step somebody has to remember. Staging holds a restore of
production, so it holds real customers' numbers and real CRM credentials; the worst bug available
here is messaging a real customer from a test environment.

**Restore production into it — which is also P4's restore rehearsal.** One piece of work, two
problems:

```bash
# in supabase/selfhost/
bash bin/restore-test.sh --offsite        # proves the backup; leaves nothing behind
# then, for a staging database shaped like production's:
docker exec -i aura-staging-postgres-1 pg_restore -U aura -d callintel --no-owner --no-acl \
  < /path/to/db-<stamp>.dump
```

Then run the migration you are about to deploy, against that. **That is the whole point of this
environment**: a migration whose first real execution is in production is a migration nobody has
tested, and three separate migrations in this project have proved it.

### 12.5 What staging deliberately is not

Not a load test, not TLS, not real FCM, not a real Razorpay webhook, and not a performance
reference — one box, shared CPU, stubbed providers. It answers exactly one question well: *does
this change apply, in order, to data shaped like production's?* Claiming more for it would be the
same mistake as a health check that cannot see the business failing.
