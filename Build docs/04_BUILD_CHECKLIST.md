# Build Checklist — AI Call Intelligence Platform

Companion to `01_GAP_ANALYSIS.md`, `02_BACKEND_DESIGN.md`, `03_PRD_v2.md`.

**Confirmed stack decisions:**
- Backend: **NestJS** (modular monolith + worker pool, TypeScript end-to-end)
- Frontend: **Next.js** (App Router, single app; platform-admin console as a protected route group)
- Visual design: **`ui-design/` prototype ("Aura Platform")** is the source of truth — neo-brutalist monochrome, Tailwind v4, no component library
- Device activation: recording is **disabled until enrolled** — admin generates an instance ID + one-time admin key in the web app; the Android app has an admin-only screen where they are entered

Effort/risk figures per workstream are carried from `01_GAP_ANALYSIS.md` §5 (engineer-weeks, small team).

---

## 0. Pre-build gates *(2 wk, Low risk — do first; blocks sales commitments, not engineering start)*

- [ ] Decide **first market** → fixes the consent regime (India DPDP / EU GDPR / US two-party states) and Phase-1 consent scope (PRD §10.1)
- [ ] Procure initial handset test pool and define the **certified-device matrix** process (probe test call at enrollment → `FULL_DUPLEX / NEAR_END_ONLY / SPEAKER_REQUIRED / UNSUPPORTED`)
- [ ] Decide **VoIP metadata** ships in Phase 1 or is parked (PRD §10.5)
- [ ] Decide **original-audio retention** default after transcription (PRD §10.4)
- [ ] Decide **BYO LLM keys**: default vs. premium; enterprise default = BYO recommended (PRD §10.3)
- [ ] Rewrite product guardrails doc: the "nothing leaves the device" non-negotiables are inverted by this pivot (gap F2)
- [ ] Legal review engaged: DPA template, sub-processor list, announcement-tone requirements (gap F3)
- [ ] Sales/marketing sign-off on the PRD §2 capability statement (no VoIP audio, no dual-channel, MDM-only distribution)

---

## 1. Foundations & repo setup

- [x] Monorepo: `apps/web` (Next.js), `apps/api` (NestJS API), `apps/worker` (NestJS worker pool), `packages/shared` (zod schemas + types shared API↔web↔worker), `packages/ui` (extracted Aura UI kit) — *scaffolded in `platform/`, all builds green*
- [x] Local dev stack via docker-compose: Postgres, Redis, RabbitMQ, MinIO — *verified running; Postgres on host port 5433 (a native install owns 5432)*
- [ ] Terraform/IaC skeleton: managed Postgres (PITR), managed Redis, queue, S3 (SSE-KMS + versioning + Object Lock), ECS/GKE with separate API and worker pools, secret store
- [ ] `organizations.region` column + region-aware bucket naming from day one (data residency reserved)
- [ ] CI: typecheck, lint, tests, migration check, Android build job
- [ ] Environments: dev / staging / prod with separate KMS keys and secrets

---

## 2. Backend platform — Phase 1

### 2.1 Tenancy & data model *(6 wk with auth/RBAC, Med risk)*

- [x] Postgres schema per `02_BACKEND_DESIGN.md` §4: `organizations, workspaces, users, memberships, instances, devices, device_health, calls, recordings, transcripts, ai_outputs, agents, crm_integrations, crm_sync_log, usage_events, audit_log` + `enrollment_tokens` for the activation gate — *`platform/packages/db/migrations/0001_init.sql`*
- [x] Every tenant table: `org_id` + **Row-Level Security** policy (ENABLE + FORCE, default-deny when unset); app connects as non-superuser `aura_app`; `withOrgContext()` sets `app.org_id` transaction-locally — *NestJS interceptor wiring still pending*
- [x] RLS enforcement test: cross-tenant read/write attempts fail at the DB layer — *`packages/db/verify-rls.js`, 6/6 pass*
- [x] `call_facts(call_id, field_key, value_text, value_num, value_bool)` projection table
- [x] `remote_number_hash` + `remote_number_last3` columns — *HMAC-at-write application logic still pending*
- [x] Agents **versioned and immutable** — PK `(id, version)`; `ai_outputs` carry `agent_version` — *app-layer "edit = new version" enforcement still pending*
- [ ] Migration tooling + seed script; partition plan documented — *runner (`migrate.js`) + idempotent seed (`seed.js`, v4-shaped fixed dev IDs) done; partition doc pending*

### 2.2 Identity, auth, RBAC

- [x] Human auth: real session layer — `POST /v1/auth/login` (scrypt credential check → `sessions` table bearer token, 7-day TTL), `/auth/me`, `/auth/logout`; the guard accepts admin-key OR session and pins the org from the session so a session can't cross tenants; web login page wired — *identity source is dev credentials; **OIDC + MFA is the swap-in at `/auth/login`** (needs an external IdP)*
- [x] RBAC roles `platform_admin, org_admin, workspace_admin, workspace_member, viewer` + separately-grantable `recordings:listen`/`recordings:export`, enforced by `@RequirePermission` + `PermissionsGuard` — **e2e-proven: a viewer session gets 403 on audio playback, org_admin/admin-key succeed** — *decorator applied to audio playback; rolling it onto export/other routes is mechanical*
- [x] Platform API keys: `POST/GET/DELETE /v1/apikeys` — `cik_live_<random>`, SHA-256 hash + 12-char prefix stored, key shown once, revocable (`api_keys` table, RLS) — *e2e-tested; last-used tracking + scopes pending; kept separate from tenant LLM keys*
- [x] Device enrollment flow (§3.2): `POST /v1/instances` creates the instance + **one-time admin key** (hash-only storage, TTL, max-uses, returned exactly once) — *e2e-tested; web copy-once + QR display done*
- [x] `POST /v1/devices/register`: validates instance ID + admin key (TTL + use-count + race-guarded), stores device public key, returns `device_id` + refresh token — *e2e-tested; **Play Integrity verification still a stub***
- [x] `POST /v1/devices/challenge` + `/authenticate`: nonce-signature challenge, P-256 ECDSA verified against the enrolled public key → 15-min access JWT (`sub, org_id, instance_id, scope, cfg_ver`) — *e2e-tested with a real keypair; nonce is stateless HMAC, single-use-via-Redis pending*
- [x] **Activation gating (server side):** device `status` gates everything — non-active devices are denied new tokens, `GET /v1/devices/me/config` returns `recordingEnabled=false` after logout/wipe, and `POST /v1/devices/{id}/logout|wipe` flip it (audit-logged) — *e2e-tested 10/10; FCM push still pending*
- [ ] Idempotency-Key support on all POST endpoints

### 2.3 Ingest & processing pipeline *(6 wk, Med risk)*

- [x] `POST /v1/calls` → creates call row (`AWAITING_AUDIO`), checks device/org status + consent policy **before** returning presigned S3 multipart URLs (5 MB parts, direct-to-MinIO) — *e2e-tested; per-org limits/quota checks pending*
- [x] `POST /v1/calls/{id}/complete` → S3 size + sha256 consistency check → `UPLOADED` → RabbitMQ wake-up — *e2e-tested incl. double-complete rejection*
- [x] Stage state machine in Postgres with optimistic status checks; queue is wake-up only; idempotent replay verified; terminal `COMPLETE` / `FAILED_{STAGE}` — *DLQ + admin replay pending*
- [ ] **transcode** worker: ffmpeg → 16 kHz mono Opus, decrypt device envelope — *stage exists as pass-through (client already records 16 kHz mono); ffmpeg + envelope decrypt pending*
- [x] **asr** worker: pluggable provider (`ASR_STUB` > **Groq Whisper `whisper-large-v3`** > Gemini). **Real Groq run e2e-tested through the whole pipeline** (transcript engine `groq/whisper-large-v3`); transcript + usage event stored — *Groq/Whisper gives segments but no speaker labels (diarized:false); Gemini is the later swap*
- [ ] **analyze** worker: resolve agent version → render prompt → LLM structured-output mode → validate → one repair attempt with validation errors → on second failure store raw + `validation_status=failed` (never drop)
- [ ] Every `ai_outputs` row records agent version, model, provider, tokens in/out, cost
- [x] **crm-dispatch** worker: generic webhook connector POSTs call summary + facts to the tenant URL, logs to `crm_sync_log`, never blocks completion — *e2e-tested; HubSpot OAuth connector + field mapping + backoff retries pending*
- [ ] DLQ per stage + one-click replay from admin UI
- [ ] Backpressure: per-org analyze concurrency (Redis semaphore) + per-org hourly LLM spend ceiling with 80% alert

### 2.4 Dynamic extraction schema *(part of agent engine: 7 wk, **High risk** — ruthless scoping)*

- [x] Field definition format: scalar types, enum, array-of-scalar, datetime — hard-constrained (`ExtractionSchema` zod in `@aura/shared`)
- [x] Compiler: one definition → (a) LLM structured output (**Groq JSON mode** now, Gemini `responseSchema` later), (b) `validateExtraction()` runtime validator with repair-once, (c) `call_facts` projection rows — *real Groq extraction e2e-tested (correctly pulled budget/intent/follow-up from a sample transcript); (d) UI filter/table columns pending*
- [x] Agent config bundle: system prompt + fields + labels, **versioned-immutable** (create=v1, edit=new version, explicit activate; enforced in API) — *scoring weights + CRM mapping pending*
- [x] `POST /v1/agents/{id}/test`: runs any version against a stored call via the SAME analyze core as the pipeline, non-persisting — *diff-vs-active view pending*

### 2.5 Model provider layer

- [ ] `ProviderRouter`: resolve(org, agent, task) → [primary, fallback]; timeout, retry, circuit breaker per provider; normalize across OpenAI / Gemini / Anthropic / self-hosted
- [ ] Credential resolution: tenant BYO key → platform key → deny; BYO keys **envelope-encrypted** (per-org DEK wrapped by KMS CMK), decrypt in memory only, API shows prefix + last 4 only
- [ ] Failover on 5xx/timeout only, never on content refusals; model recorded per output
- [ ] **Zero-retention provider tiers only** for voice-transcript processing
- [ ] Usage events emitted per call: tokens, cost, latency, provider, model

### 2.6 Compliance services *(5 wk, **High risk** — on the critical path)*

- [x] Consent policy stored per org + returned in device config; `consent_status` recorded per call from `consentPlayed`; `on_consent_failure` per tenant; policy change bumps every instance `config_version` — *e2e-tested; jurisdiction resolution + device TTS playback pending*
- [x] Retention reaper: interval job, per-org `retention_days`, sweeps S3 + call rows + transcripts/outputs/facts, audit-logged — *`worker/src/pipeline/reaper.ts`; search-index sweep pending (no OpenSearch yet)*
- [x] Erasure service: `POST /v1/erasure-requests` cascades S3 object → transcript → ai_outputs → call_facts → crm_sync_log → recording → call, then HMAC-**signed completion receipt** in the audit log — *e2e-tested; per-subject phone-hash fan-out + CRM copy deletion pending*
- [x] Audit log: append-only (UPDATE/DELETE revoked from app role), every enrollment/policy/agent/erasure/CRM/wipe action recorded; `GET /v1/org/audit` listing — *per-tenant export pending*
- [ ] DPA template + sub-processor disclosure published

### 2.7 Metering, limits, search

- [x] Postgres `usage_events` durable ledger written by the pipeline (asr_seconds, llm_tokens_in/out); `GET /v1/usage` aggregates calls/minutes/tokens/devices vs limits — *e2e-tested; Redis fast-path counters + hourly reconcile deferred (Postgres-only for now)*
- [x] Metrics surfaced: calls, minutes, AI tokens in/out, devices, API keys — *storage-GB-months, API-request count, seats, CRM syncs pending*
- [ ] Soft/hard limit enforcement at admission (80/100% notify, hard reject) — *limits are reported by `/v1/usage`; enforcement-at-admission still pending*
- [x] Transcript search: Postgres `tsvector` GIN + `ts_headline` snippets (`GET /v1/search`) — *e2e-tested; `SearchProvider` port abstraction + structured `call_facts` filters pending*
- [ ] API surface per §9: versioned `/v1`, cursor pagination, Problem+JSON errors; device + platform endpoint sets

---

## 3. Android client — Phase 1

### 3.1 Activation & admin screen *(part of enrollment/auth: 4 wk, Med risk)*

- [x] **Admin-only screen** (`ui/AdminActivationActivity.kt`): hidden entry via toolbar long-press in `ui/MainActivity.kt`; enter server URL + instance ID + admin key → enroll — *e2e-buildable APK; QR-scan entry pending*
- [x] Enter **instance ID + admin key** → `ActivationManager.enroll` runs register → challenge → authenticate → config → stores activation state (`platform/ActivationStore.kt`)
- [x] App-wide activation gate: `service/PhoneStateReceiver.kt` and `service/RecordingService.kt` **refuse to start capture unless `isRecordingAllowed`** (activated AND server `recordingEnabled`)
- [ ] Un-activated UI state on the main screen (banner/no controls) — *status shown in the admin screen; main-screen banner pending*
- [x] Deactivation path: `ActivationManager.refreshConfig` closes the gate on 401 (revoked/wiped); manual "Deactivate" clears enrollment + wipes Keystore key
- [ ] Enrollment probe test call → report capture capability class to server (certified-device matrix input) — *pending*

### 3.2 Identity & network *(enrollment/auth cont.)*

- [x] Add `INTERNET` permission; `PlatformApi` HttpURLConnection JSON client — *OkHttp + **certificate pinning** pending (comes with the upload subsystem)*
- [x] P-256 keypair in Android Keystore (`platform/DeviceIdentity.kt`), private key never leaves hardware; SPKI PEM to server, ECDSA-SHA256 nonce signing — *StrongBox attestation pending*
- [ ] Play Integrity token at registration — *stub sent ("android-stub")*
- [x] Token store + nonce-signature refresh + 401 handling → gate closes — *refresh token persisted; access JWT fetched per config refresh (not yet cached with expiry)*

### 3.3 Capture changes *(1 wk, Low risk — quick, large cost saving)*

- [x] Retune `capture/AudioCapturer.kt` to **16 kHz mono** (from 44.1 kHz) — *done; APK rebuilt*
- [ ] Per-recording telemetry: which audio source won the probe (`audio_source_used`)
- [ ] Keep: OFFHOOK-only start (never record unanswered), probe-order fallback, silence-discard rule (digital silence → delete file, log, report capture failure — never upload an empty artifact), persistent non-dismissible notification (non-negotiable)
- [x] Consent announcement **tone** playback at capture start (`ToneGenerator`, `CaptureSettings.announceRecording` flag), reported as `consentPlayed` on upload — *TTS + server-policy-driven enforcement of `on_consent_failure` pending*
- [ ] VoIP **metadata-only** events from `service/CallAccessibilityService.kt` (app, direction, callee, duration — no audio, no ASR)

### 3.4 Upload subsystem *(5 wk, Med risk — largest single client gap)*

- [x] Room migration v3→v4 on `storage/RecordingEntity.kt`: added `uploadState`, `remoteCallId`, `attemptCount`, `lastError`, `sha256`, `bytesUploaded` with `MIGRATION_3_4` wired in — *`capturedAt`/`deviceLocalId` not added (existing `startedAt` covers timing); APK builds*
- [x] WorkManager `UploadWorker` + `UploadScheduler.enqueue` called from `RecordingService` right after the durable DB write — *unique OneTimeWork with APPEND_OR_REPLACE; periodic sweep for stragglers still pending*
- [ ] Constraints from server config — *`NetworkType.CONNECTED` for now; wifi-only/battery/storage from server config pending*
- [x] Resumable multipart to presigned S3 URLs (5 MB chunks), direct to S3 — never through the API (`upload/UploadApi.kt`)
- [ ] Exponential backoff with jitter, ~6 h cap — *bounded `runAttemptCount < 5` retry for now; jitter/6h cap + health-alert-on-permanent-fail pending*
- [x] Queue survives app kill / network loss (WorkManager-persisted; re-checks the gate) — *reboot-resume relies on WorkManager defaults, not explicitly verified*
- [x] Local file deleted only after server-confirmed `/complete` success — *configurable local-retention window pending*
- [x] No strict upload ordering — uploads independent (per-recording loop)

### 3.5 Security, config, telemetry, remote control *(5 wk, Med risk)*

- [x] AES-256-GCM at rest (`platform/FileCrypto.kt`, Keystore key, random IV per file): recording encrypted to `.m4a.enc` on capture, decrypted to a temp only for upload — *StrongBox attestation + per-device envelope-wrap pending*
- [x] `allowBackup=false` (already set in the manifest)
- [x] Remote config sync: `ConfigRefreshWorker` (~1h) re-fetches `/devices/me/config` so remote logout/wipe/policy reach the device; `cfg_ver` carried — *capture-policy fields (beyond `recordingEnabled`) not yet in the server config doc*
- [x] Device health telemetry `POST /v1/devices/me/health` **+ Android `HealthWorker`** (~6h, real battery/storage/pending-uploads) — *e2e-tested server side; APK builds with the reporter*
- [x] Batched call-detection telemetry `POST /v1/devices/me/events` **+ Android `EventLog`** (PII-free `call_offhook` events, drained by HealthWorker) — *e2e-tested server side*
- [ ] FCM **push** channel for instant logout/wipe — *currently propagated by the ~1h config-refresh poll instead of push; delete-local-on-wipe done via the gate*
- [ ] Distribution: signed APK via MDM (Intune / Android Enterprise) runbook — **no Play Store** (policy violation stands)

---

## 4. Next.js web app — Phase 1 *(10 wk, Med risk)*

### 4.1 Scaffold & design system

- [ ] Next.js App Router + TypeScript + **Tailwind v4**; fonts: Space Grotesk (display), Inter (body), JetBrains Mono (labels)
- [ ] Port the **Aura design language** from `ui-design/`: `#F9F9F9` canvas, white cards, black 2–4px borders, `rounded-none`, offset hard shadows `shadow-[4px_4px_0px_0px_rgba(0,0,0,1)]`; red = destructive/error only, green = terminal logs only
- [ ] Extract shared UI kit into `packages/ui` from the prototype's hand-styled patterns: Card, BrutalButton, StatusChip, ConsolePanel (black bg, mono log stream), SlideOverDrawer, Modal, DataTable, KPI StatCard, ProgressBar, Toast — **no shadcn/ui or other component library**
- [ ] lucide-react icons, motion/AnimatePresence transitions, recharts styled monochrome (black/neutral series, black tooltip)
- [ ] Sidebar layout + giant uppercase display page titles + mono-label top bar, responsive per the prototype's mobile menu
- [ ] Auth: OIDC session, role-aware navigation; `(platform)` customer route group + `(admin)` protected platform-admin route group

### 4.2 Port the five prototype screens (mock data → real API)

- [x] **Platform Hub** (`DashboardTab`): KPI cards (capture success, recorded minutes, fleet health, LLM tokens) + 7-day ingest bar chart wired to `GET /v1/analytics/overview` — *lead-intent pie + per-OEM bars pending*
- [x] **Call Log Explorer** (`CallExplorerTab`): table + clickable slide-over drawer (transcript bubbles, AI output + `call_facts`, pipeline/CRM chips, **Reprocess** + audited **Get-audio-link** buttons) wired to `GET /v1/calls/:id`, `/audio`, `/reprocess` — *column filters + inline waveform playback pending*
- [x] **AI Agent Studio** (`AgentBuilderTab`): agent list + versions, prompt editor, dynamic field builder, live compiled JSON Schema pane, **sandbox test against a stored call** (`POST /v1/agents/{id}/test`, output in a console box), activate/version flow — *version-diff view pending*
- [x] **Instances** (was `DevicesTab` "Fleet & MDM"): customer list (`GET /v1/admin/tenants`) → per-customer detail with enrollment keys + that customer's devices and **remote logout / wipe** actions (real endpoints, confirm-gated). `/devices` now redirects to `/instances` — *health gauges + remote config-push editor pending*
- [x] ~~**Compliance & Audit** (`ComplianceTab`)~~ — **section removed 2026-07-21; folded into the instance detail page.** Consent + retention editor (PATCH `/v1/org/policy`), immutable audit ledger and the **cascading erasure tool with signed-receipt display** now live per customer at `/instances/[id]`, so they act on that tenant's org instead of always the dev org. `/compliance` redirects to `/instances`; all API endpoints unchanged — *ledger search/filter pending*

### 4.3 Screens the prototype lacks (same design language)

- [x] Login page wired to real `/v1/auth/login` (session token + role shown) — *OIDC/SSO + MFA enrollment is the identity-source swap*
- [x] **Instance & activation management**: an *instance* = one customer company = one **organization** (the RLS tenant boundary). `POST /v1/admin/tenants` provisions org + default workspace + instance + first key atomically; `/instances/new` collects company name, consent policy and retention. Detail page issues further keys (`POST /v1/instances/:id/keys`) and lists key status (active/expired/exhausted) — key display stays copy-once + QR with the same `v:1` payload the handset scans. Cross-tenant isolation verified: dev org gets 404 on another customer's instance and sees none of its devices/calls — *key revoke UI still pending*
- [x] Workspace / user / membership management (org admin) — `/team` page + `GET/POST /v1/workspaces`, `GET/POST/PATCH/DELETE /v1/members` (role + `recordings:listen`/`export` permission chips) — *e2e-tested*
- [x] Transcript full-text search **endpoint** `GET /v1/search` (Postgres `tsvector` + `ts_headline` snippets) — *e2e-tested; dedicated search page UI pending*
- [x] CRM integration setup `/crm`: generic webhook connect + field-map editor (`PATCH /v1/crm/integrations/:id`) — *HubSpot OAuth button present but disabled (needs credentials); sync-log view pending*
- [x] Usage & limits view `/usage` (StatCards + limit progress bars) + billing invoices placeholder fed by metering
- [x] `(admin)` platform-admin console: tenant list with call/device counts + global pipeline-health placeholder — *model routing, cost dashboards, DLQ replay pending; RBAC gating pending OIDC*
- [x] Notes on calls: `GET/POST /v1/calls/:id/notes` (`call_notes` table) + notes section in the call drawer — *e2e-tested*

---

## 5. Phase 2 — Depth

- [ ] Salesforce connector *(3 wk)* — only with committed revenue
- [ ] Zoho connector *(3 wk)* — same rule
- [ ] Sentiment + talk-ratio analytics on transcripts
- [ ] Agent version diffing UI + A/B testing across versions
- [ ] Advanced dashboards (coaching views, team comparisons)
- [ ] SSO (enterprise IdPs) + SCIM provisioning
- [ ] Data residency: activate multi-region S3/Postgres using the `organizations.region` seam
- [ ] Public API + docs portal (OpenAPI from the NestJS surface)

## 6. Phase 3 — Scale

- [ ] Self-serve signup + billing (Stripe on top of the day-one metering ledger)
- [ ] Dynamics connector
- [ ] OpenSearch behind the existing `SearchProvider` port, fed from a `transcripts` outbox
- [ ] Streaming / real-time transcription
- [ ] Coaching & QA scorecards
- [ ] On-device ASR fallback for low-connectivity fleets (the `transcription/Transcriber.kt` seam becomes the fallback path)

---

## 7. Cross-cutting *(observability/deploy: 4 wk, Low risk; compliance/legal tracked in §2.6)*

- [ ] OpenTelemetry traces spanning device upload → S3 → every pipeline stage, keyed by `call_id`
- [ ] Golden signals per stage: queue depth, latency p50/p95, failure rate, DLQ size
- [ ] Business alerts: **recording success rate per device model** (the metric that decides if the product is real — instrument first), devices silent >24 h, uploads pending >6 h, LLM spend rate, CRM sync failure rate
- [ ] NFR targets wired into monitoring: 99.5% API uptime (upload endpoint prioritized), transcript ≤10 min p95 for ≤30-min calls, no acknowledged recording ever lost
- [ ] Threat model + annual pen test scheduled
- [ ] Marketing/legal language check: "encrypted on device, in transit, and at rest; decrypted only within the processing pipeline" — **never "E2E"**
- [ ] MDM onboarding runbooks (Intune, Android Enterprise) + pre-sales device certification flow
- [ ] Success-metric instrumentation per PRD §8: capture rate ≥95%, upload ≤6 h ≥99%, WER ≤15%, extraction accuracy ≥85%, CRM sync ≥98%, healthy devices ≥95%, AI cost/call, signup→first call <1 day
