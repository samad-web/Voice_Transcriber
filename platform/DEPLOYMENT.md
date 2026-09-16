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
web image. The console's per-tenant pages (dashboard, calls, agents, search, usage, team,
api-keys, crm) still resolve their org from those variables rather than from the signed-in
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

## 6. ASR / analyze provider

Precedence is `ASR_STUB`/`ANALYZE_STUB` → **Sarvam** → **Gemini**. Set `SARVAM_API_KEY` and both
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

   The same premise is what makes owner-role enforcement **advisory**. The console tells the API
   who is asking via `x-caller-owner-role` / `x-caller-user-id`, and the API trusts those headers
   because only the console holds the admin key. Omitting `x-caller-owner-role` leaves the
   principal's persona `null`, which `OwnerRoleGuard` treats as "pass" — so anyone holding the
   admin key satisfies every `@RequireOwnerRole` by sending no header at all. That is one leaked
   env var away from mattering, which is why §1 above is the item and not this one.
2. **`JWT_SECRET` still has a published dev fallback in the API.** Four sites read
   `process.env.JWT_SECRET ?? "dev-jwt-secret-change-me"` (`common/device-auth.guard.ts`,
   `common/device-nonce.ts`, `modules/devices/devices.controller.ts`,
   `modules/tenancy/erasure.controller.ts`). It is **not** live exposure — `assertRequiredEnv()`
   rejects that literal and an unset variable in production, so the process cannot reach those
   lines carrying it — but the boot assertion is the only thing standing there, whereas
   `ADMIN_API_KEY` has two independent defences. `device-auth.guard.ts` reads `org_id`,
   `instance_id` and the device id straight off the JWT payload with no database re-check, so a
   forged token is call ingest and transcript reads for any device in any tenant.
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
