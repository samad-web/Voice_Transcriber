# Aura — Platform Architecture & Flow Map

_Last regenerated: 2026-09-15 · branch `crm-connectors-and-console-auth` · schema at migration `0119_review_queue_and_notification_delivery`_

This is the whole-system document: every runtime, every flow, and what is wired
to what. It supersedes `07_WEBAPP_OVERVIEW.md`, `02_BACKEND_DESIGN.md` and
`13_ROUTE_AND_GUARD_INVENTORY.md` for orientation — those stay authoritative for
their own detail. The design system has its own document,
[`22_DESIGN_SYSTEM.md`](22_DESIGN_SYSTEM.md) — this one names `@aura/ui` only
where it affects wiring.

The Android handset agent has its own document:
[`CallRecorderApp/ARCHITECTURE.md`](../CallRecorderApp/ARCHITECTURE.md). This one
covers it only where it touches the platform.

---

## 1. What the product is

A multi-tenant **AI call-intelligence platform with a CRM attached**. A
telecaller's Android handset records a call; the platform transcribes it, reads
it with an LLM, turns it into a lead, projects that lead onto a contact/deal
object model, and optionally pushes it out to whatever CRM the customer already
owns. Around that spine sit six other ways a lead can arrive, a marketing funnel
that books demos, a messaging inbox, a quote-to-invoice chain, and a report
builder.

### The three standing safety rules

These are load-bearing across the whole codebase. Several modules are
deliberately *less* capable than their competitor equivalents because of them,
and the module headers say so where that is true.

| # | Rule | Where it is structural, not conventional |
|---|---|---|
| 1 | **Contact-match before sync** — a synced email or calendar event reaches the CRM timeline only if its counterparty is *already* a contact | `email-sync.ts`, `calendar-sync.ts` |
| 2 | **Human-owns-it** — a value a person typed outranks anything a matcher or model produced | `conversations.service.ts:208`, `crm-objects.ts`, custom-field provenance (0045) |
| 3 | **Nothing automated sends** — no sweep, rule or schedule may dispatch an outbound message on its own | `outreach.ts` (promotes to `due`, never sends), `automation.ts` (no send action exists), `report-schedules.ts` (in-app notification only), asserted in `guard-mounting.spec.ts` |

---

## 2. System map

```
                        ┌──────────────────────────────────────────┐
   Telecaller handset   │  CallRecorderApp (Kotlin, Android)       │
   ───────────────────► │  detect → capture .m4a → Room → upload   │
                        └───────────────┬──────────────────────────┘
                                        │ device JWT (15 min)
                                        │ POST /v1/calls + presigned multipart
                                        ▼
 ┌────────────┐  admin key   ┌─────────────────────────┐  RabbitMQ  ┌──────────────────┐
 │ apps/web   │─────────────►│  apps/api  (NestJS)     │───wake────►│  apps/worker     │
 │ Next.js    │  x-org-id    │  modular monolith, /v1  │            │  1 consumer +    │
 │ 3 consoles │◄─────────────│  33 modules, 68 ctrls   │◄───────────│  ~25 sweeps      │
 └────────────┘   JSON       └───────┬─────────────────┘  same DB   └────────┬─────────┘
       ▲                             │                                      │
       │ Supabase Auth               │ aura_app pool (RLS, app.org_id)      │ + admin pool
       │ session                     ▼                                      ▼ (cross-tenant)
 ┌─────┴──────┐              ┌───────────────────────────────────────────────────────┐
 │  Owner /   │              │  Postgres  (Supabase in prod)                         │
 │  Operator  │              │  public schema = tenant data · marketing schema =     │
 └────────────┘              │  funnel · RLS default-deny on current_setting()       │
                             └───────────────────────────────────────────────────────┘
 ┌────────────┐                        ▲                    ▲                ▲
 │ apps/      │  aura_marketing role   │                    │                │
 │ marketing  │────────────────────────┘             ┌──────┴─────┐   ┌──────┴──────┐
 │ public site│  marketing schema ONLY               │ S3 / MinIO │   │ RabbitMQ    │
 └────────────┘                                      │ recordings │   │ wake-ups    │
                                                     └────────────┘   └─────────────┘

  Outbound / inbound edges:
   Gemini (ASR inline + analyze) · Sarvam (batch ASR) · 19 CRM providers ·
   Meta Lead Ads (webhook + MCP) · LinkedIn Lead Gen (poll) · Google / Microsoft /
   IMAP / CalDAV (mail + calendar) · WhatsApp providers incl. Wasi Hub · Razorpay ·
   Exotel-class telephony · Mailgun-class email relays
```

---

## 3. Runtime inventory

| Path | Runtime | Listens on | Credentials it holds |
|---|---|---|---|
| `platform/apps/api` | NestJS (Express), global prefix `/v1` | `API_PORT` (4000) | `ADMIN_API_KEY`, `JWT_SECRET`, DB `aura_app` + admin pools, S3, provider secrets |
| `platform/apps/worker` | NestJS **application context** — no HTTP server | — | Same DB pools, S3, `GEMINI_API_KEY` / Sarvam, provider secrets |
| `platform/apps/web` | Next.js App Router (standalone output) | 3000 | `ADMIN_API_KEY` (server-only), Supabase anon + service keys |
| `platform/apps/marketing` | Next.js App Router | 3000 (own container, own vhost) | `FUNNEL_DATABASE_URL` only (`aura_marketing` role) |
| `CallRecorderApp` | Android, single `:app` module, Kotlin | — | Device keypair + rotating refresh token |

### Shared packages

| Package | Owns |
|---|---|
| `@aura/shared` | Every zod schema and every **catalogue**: `crm-providers.ts` (19 CRMs), `connection-providers.ts` (Google/Microsoft/IMAP/CalDAV), `lead-intake.ts` (6 source kinds + provider specs), `org-modules.ts`, `permissions.ts`, `api-scopes.ts`, `report-builder.ts`, `automation.ts`, `outreach.ts`. Adding an integration is a row here, not a branch elsewhere. |
| `@aura/db` | `getPool()` (`aura_app`, RLS-bound), `getAdminPool()` (RLS-bypassing, sweeps only), `withOrgContext()`, secret encryption, SSRF guard for tenant-supplied URLs |
| `@aura/llm` | Gemini analyze + conversation intelligence + agent drafting, Sarvam batch ASR, provider retry |
| `@aura/queue` | RabbitMQ helper. **The queue is only a wake-up signal** — Postgres is the state machine |
| `@aura/ui` | Design system — v1 neo-brutalist primitives restyled onto v2 modern-minimal tokens; console pages themselves not yet migrated. See [`22_DESIGN_SYSTEM.md`](22_DESIGN_SYSTEM.md) |

---

## 4. Tenancy, identity and authorization

### The object hierarchy

```
organizations ──┬── workspaces ──┬── instances ── devices ── calls
                │                └── every CRM record is workspace-scoped
                ├── memberships ── users        (login ↔ org ↔ role)
                ├── enabled_modules[]           (0072: aura | crm | call_intel | wasi)
                ├── lead_stages                 (board columns are tenant DATA, not a migration)
                └── consent_policy · store_full_number · vocabulary
```

### Two isolation layers

1. **RLS in Postgres.** `withOrgContext(orgId, fn)` opens a transaction, runs
   `set_config('app.org_id', $1, true)`, and every tenant policy reads
   `current_setting('app.org_id')` with **default-deny when unset**. The runtime
   pool connects as the non-superuser `aura_app` role, so the application cannot
   bypass it.
2. **`TenantGuard` in the API.** Pins every request to exactly one org before a
   handler runs. The *only* way out is an explicit `@CrossTenant()`, reserved for
   operator surfaces with no single org (provisioning, fleet rollup, resolving a
   login's memberships) — those run on the admin pool.

### The guard stack, in mount order

| Guard | Authenticates | Notes |
|---|---|---|
| `AdminKeyGuard` | `x-admin-key` (platform root) **or** a Bearer session | Mints a synthetic `platform_admin` from the admin key. In production an unset key yields `null` and every admin-key request is rejected — no dev fallback. |
| `TenantGuard` | Pins `req.tenantOrgId` | Default-deny; `@CrossTenant()` is the single documented exit |
| `OrgRoleGuard` | `@RequireOrgRole("org_admin")` | Org *administration*: memberships, API keys, policy, device wipe, erasure |
| `OwnerRoleGuard` | `@RequireOwnerRole("owner" \| "manager" \| …)` | Derives the persona from `memberships` — it does **not** trust `x-caller-owner-role`; that bypass was closed in Stage 2.5 |
| `CrmPermissionsGuard` | `@RequireCrmPermission(object, action)` | Identity from the principal, **grant always read from `role_permissions` in the DB**, never from a header |
| `PermissionsGuard` | `@RequirePermission("recordings:listen" \| "recordings:export")` | Privacy grants on recordings |
| `DeviceAuthGuard` | 15-minute device access JWT | Handset routes only; all are `@SkipThrottle()` |
| `ApiKeyGuard` + `@RequireScope` | SHA-256 of a tenant API key | Public API + MCP server. Scope is mounted **per-handler, never per-controller**, so a new route cannot inherit an unexamined grant |
| `ThrottlerGuard` | *global* `APP_GUARD` | Rate-limited by default; every exemption is explicit and justified in-file |

**Unguarded by design** — asserted in `guard-mounting.spec.ts` so it can never
happen by accident: `/v1/auth/login`, `/v1/messaging/webhook/:token`,
`/v1/intake/*/:token`, `/v1/meta/webhook`, `/v1/webhooks/razorpay`. For the
`:token` routes the path segment **is** the credential — a platform-unique
CSPRNG value that both authenticates the caller and names the tenant. An unknown
token gets a bare 404: no echo, no tenant name, no hint a token exists.

### Module entitlements (0072)

`organizations.enabled_modules` gates whole areas. `crm` gates
`CrmPermissionsGuard` and hides ~12 nav destinations; `call_intel` decides
whether a tenant may read transcripts and the AI read of their own calls at all
— **off by default for every tenant**, because a verbatim transcript is the most
privacy-sensitive artifact the platform stores.

### The three consoles

| Route group | Who signs in | How the org is resolved |
|---|---|---|
| `app/(platform)` | Platform operator | Per-tenant pages resolve from `DEV_ORG_ID`; `/instances` is the multi-tenant view |
| `app/(owner)` | One customer's owner / manager / telecaller | `lib/owner-context.ts` maps the Supabase session → `users.sso_subject` → `memberships`. **No owner page takes an org id from the request.** |
| `app/(admin)` | Platform admin | Tenant provisioning, module toggles, erasure |

The admin key never reaches the browser: `lib/server-api.ts` carries
`import "server-only"`, so a Client Component importing it is a build error.

The owner sidebar (`lib/nav.ts`) groups its ~30 destinations into seven labelled
sections — Pipeline, Customers, Conversations, Sales, Insights, Lead connectors,
Workspace — rather than one flat column; the platform sidebar groups the same
way (Call intelligence, Growth, Clients, CRM setup, Access). Both read from one
href→section map, so "what is next to what" has a single answer instead of a
`section` field scattered across two dozen item literals.

`/owner/calls` (the client's own call log) and `/calls` (the operator's
cross-tenant explorer) are deliberately separate routes over the same `calls`
table, not one screen with a role switch: the operator view joins `instances`
and surfaces pipeline internals — attempt counts, `next_attempt_at`,
`error_message`, consent status — that are ours to act on and not a client's to
interpret. Both re-check the `call_intel` module per request rather than
trusting the nav, because a hidden link is not a closed door.

---

## 5. Flow — device enrollment and configuration

```
Operator console                Handset                        API
──────────────────              ────────                       ───
/instances/new
  └─ create instance ──► enrollment_token (one-time)
        │
        │  QR / typed
        ▼
                     QrScannerActivity
                     ActivationManager.enroll
                       ├─ DeviceIdentity.ensureKeyPair()  (device-local keypair)
                       └─ POST /v1/devices/register ─────────────► devices row + refresh token
                                                                   status='active'
                     every session:
                       POST /v1/devices/challenge  ───────────────► nonce
                       sign(nonce) with private key
                       POST /v1/devices/authenticate ─────────────► 15-min access JWT
                       GET  /v1/devices/me/config ────────────────► recordingEnabled, cfgVer,
                                                                     capture profiles, telecaller
                     ConfigRefreshWorker re-pulls config on a schedule
                     HealthWorker → POST /v1/devices/me/health   (fleet dashboard)
                                  → POST /v1/devices/me/events   (call detected, batched)
```

**Nothing captures until enrollment succeeds *and* the server config says
`recordingEnabled`.** Device wipe / logout is an `org_admin` action
(`OrgRoleGuard`) and flips `devices.status`, which the upload admission check
reads on the very next call.

### App self-update (0081)

The fleet's APK is sideloaded, so nothing could replace it before this shipped
— a fix meant physically collecting phones.

```
scripts/publish-app-release.js          → app_releases (platform-level, no org_id, no RLS)
                                            staged published=false until promoted
        │
        ▼
GET /v1/devices/me/update  (DeviceAuthGuard)
  ├─ compares the handset's reported versionCode to the newest PUBLISHED row
  └─ returns a presigned download URL, generated per request (bucket stays private)
        │
        ▼
Android: ~6h wifi-only worker → download → verify SHA-256
  ├─ Android 12+: AutoInstaller commits a session with USER_ACTION_NOT_REQUIRED
  │    - only when no call is ringing/active/recording and the app is not on screen,
  │      otherwise retries every 30 min
  │    - falls back to the notification if the system still wants a confirmation,
  │      or after a day of waiting
  ├─ Android 8-11: notification → tap runs a PackageInstaller session (system confirmation)
  └─ reports the installed version back via POST /v1/devices/me/health → devices.app_version
```

Unattended install needs the RUNNING build to hold
`UPDATE_PACKAGES_WITHOUT_USER_ACTION`, so the first hop onto a build that has it
(from 1.1.3 or older) is still a tap. Every hop after that is not. Since nobody
confirms an install any more, publishing a build installs it on the whole fleet:
try every build on one handset before `--publish`.

The route is advisory by construction: it cannot touch `recordingEnabled`, so a
bad release cannot take the fleet offline. `publish-app-release.js` refuses a
`versionCode` that is not strictly higher than the live one — a handset offered
an equal code would prompt forever and never satisfy the prompt.

---

## 6. Flow — call capture on the handset

Two independent detectors feed one recording service. Full detail lives in the
Android doc; the platform-relevant shape is:

```
PhoneStateReceiver (cellular)  ─┐
CallAccessibilityService (VoIP)─┼─► RecordingService ─► AudioCapturer ─► .m4a
OemRecordingIngestor           ─┘        (foreground)      (AAC 16 kHz)
  └─ adopts Samsung/MIUI dialer recordings instead of capturing,
     because the system dialer taps both call legs and an app cannot
                                             │
                                             ▼
                                    Room (RecordingEntity)
                                             │
                                    UploadScheduler → UploadWorker (WorkManager)
```

`OemRecordingIngestor` matters architecturally: on OEMs whose dialer records
both sides, the app reads those files rather than fighting the audio stack.
Everything downstream — upload, ASR, LLM — is identical either way.

---

## 7. Flow — the call pipeline (the spine)

### Upload admission and hand-off

```
POST /v1/calls                       (DeviceAuthGuard, @SkipThrottle)
  ├─ check device.status='active' AND org.status='active'      ← rejects BEFORE bytes move
  ├─ check org.consent_policy ≠ 'prohibited'
  ├─ derive number fragments: first 5 digits, last 3, SHA-256 hash
  │    full number retained ONLY if organizations.store_full_number (0011)
  ├─ INSERT calls (status='AWAITING_AUDIO', telecaller_id frozen at creation)
  ├─ INSERT recordings (s3_key = org/{orgId}/calls/{callId}.m4a)
  └─ return presigned multipart plan

   ...handset uploads parts directly to S3...

POST /v1/calls/:id/complete          (DeviceAuthGuard, @SkipThrottle)
  ├─ verify sha256 matches creation, verify S3 object size
  ├─ UPDATE calls SET status='UPLOADED'          ← the DB commit is the source of truth
  └─ publishPipeline({callId, orgId})            ← the queue is only a wake-up
```

Both routes are deliberately un-throttled: a tenant's whole fleet shares one
office NAT, and a phone flushing an offline backlog is exactly the burst a
per-IP limit punishes. Losing `/complete` after the bytes land would strand the
recording with no sweeper that recovers it.

### The state machine

`calls.status` is the pipeline. The queue can be purged, the worker can be
restarted, and nothing is lost.

```
AWAITING_AUDIO
     │ /complete
     ▼
  UPLOADED ──────────────────────────────► TRANSCRIPTION_OFF   (0014, tenant toggle)
     │ advance
     ▼
 TRANSCODING ──── ffmpeg → 16 kHz mono ────► FAILED_TRANSCODE
     │                                        also: duration < MIN_TRANSCRIBE_SECONDS (5s)
     │                                        short-circuits — ring-outs and misdials
     ▼                                        are a large share of telecalling volume
 TRANSCRIBING ─┬─ inline (Gemini)  ──────────► transcript + segments
               └─ batch (Sarvam)  ──────────► parks with a job id;
                                              asr-poll.ts drives it later (15s clock)
     │                                      └► FAILED_ASR
     ▼
  ANALYZING ──┬─ analyzeConversation → diarize, per-turn intent, call-level
              │    intent/sentiment/outcome, key points, action items → transcripts.intelligence
              ├─ analyzeTranscript → the AGENT's own extraction schema → ai_outputs, call_facts
              │    ABSENT_TOKENS scrub: "null"/"n/a"/"not_discussed" must look absent
              │    before they can reach a customer's CRM as a contact literally named "null"
              └─ upsertCallAnalytics → talk metrics, quality score, risk flags
     │                                      └► FAILED_ANALYZE
     ▼
   SYNCING ──┬─ upsertLead()          → leads          (dedup on contact_number_hash)
             ├─ projectLeadToCrm()    → contacts + deals
             ├─ detectCallProjects()  → project labels (0073, string match, not an LLM)
             └─ enqueueDispatch()     → crm_sync_log   (the outbox)
     │
     ▼
  COMPLETE
```

`FAILED_CRM` is deliberately unreachable: by the time the call reaches
`SYNCING`, the transcript, the facts and the lead all exist and are correct, so
a *delivery* outcome must not un-complete the call. A delivery failure lives in
the outbox, not on the call.

Every projection in `SYNCING` runs in its own non-blocking `try/catch` — a bad
alias in a project catalogue must not strand a call.

### What qualifies as a lead

The agent's `lead_rules` decide (`qualifyLead` in `@aura/shared`). The default —
"extraction validated and something came back filled" — rejects wrong numbers
and unanswered calls with **no tenant setup**. Board columns come from
`organizations.lead_stages`, so renaming or adding a stage is a row edit.

### The three stranding sweeps

A pipeline whose only recovery path is the queue loses work. There are three
independent ones, all reading their work from Postgres:

| Sweep | Clock | Catches |
|---|---|---|
| `startRetrySweeper` | 30 s | `FAILED_%` past its backoff, and `UPLOADED` calls whose queue message was lost (>10 min) |
| `startStalledCallSweeper` | 5 min | A worker killed mid-stage — status is neither `FAILED_%` nor `UPLOADED`, so neither sweep above would ever look again (>1 h) |
| `startAsrPoller` | 15 s | Calls parked in `TRANSCRIBING` by a batch ASR provider; no-op for inline providers |

Retry backoff is `30s → 2m → 8m → 32m`, capped at an hour, `PIPELINE_MAX_ATTEMPTS`
(5) attempts — roughly half an hour of trying, which covers a rate-limit, a
restart or a network blip.

---

## 8. Flow — lead intake: six front doors, one pipeline

Migration **0078** collapsed what were five divergent writers into one service.
The channel changes only the field map and which screens apply.

```
  web form ──┐
  email    ──┤  POST /v1/intake/{form|email|telephony}/:token   (no guard — token IS the credential)
  telephony──┤        │
  Meta ads ──┤   MetaWebhookController → LeadIntakeService
  API      ──┤   PublicApiController  ─┘
  LinkedIn ──┘   linkedin-sync.ts (worker, polled — LinkedIn has no lead webhook)
                        │
                        ▼
        resolve token → verify signature → screen payload → normalise →
        claim in lead_intake_events → write lead → record outcome
                        │
                        │  ONE transaction: the claim and the lead commit together,
                        │  so a failed write cannot leave a claim saying "handled"
                        ▼
                 leads  ──►  projectLeadToCrm()  ──►  contacts + deals
                 source_channel ∈ call | web_form | email | telephony |
                                  meta_ads | linkedin_ads | api | import | manual
```

Intake routes **always answer 2xx once the token is good**. Every provider
behind them retries on non-2xx, so an unparseable payload is a `202` carrying
the outcome — the reason lands on the source's page in the console where someone
can fix the mapping — not a `500` that has the provider replay the same bad body
for hours. A *paused* source resolves and records a rejection, deliberately, so
"we paused it and the leads stopped" is visible rather than deduced.

### The two writers, and what stops them drifting

Pushed channels write from the API (`LeadIntakeService`); pulled channels write
from the worker (`pipeline/lead-intake.ts`), because the API's Nest container is
not reachable from a sweep. Three things hold them together:

1. Both normalise through `@aura/shared`, so "what is this person's name" has one answer.
2. Both write the same column set with the same first-touch `COALESCE` rules, then both call `projectLeadToCrm`.
3. Both claim in `lead_intake_events` first, so a lead cannot be ingested twice regardless of door.

---

## 9. Flow — Meta Lead Ads (two paths, one destination)

```
  Meta ──webhook──► POST /v1/meta/webhook   (unauthenticated by necessity)
                      ├─ org resolved from the UNTRUSTED page_id, on the admin pool
                      ├─ signature verified with META_APP_SECRET (Meta signs with the
                      │    platform app secret, not a per-page one)
                      └─ LeadIntakeService  ──► leads + contacts + deals

  Meta MCP ──pull──► meta-mcp-sync.ts (worker, 10 min, off unless META_MCP_SYNC_ENABLED="true")
                      └─ tenant-supplied MCP server URL (SSRF-guarded) ──► leads
```

Historical note worth keeping: 0063 wrote **contacts/deals only**, and
`/owner/board` and `/owner/leads` read `leads` — so every Meta lead ever captured
was invisible on the two pages an owner actually works in, while handset leads
appeared fine. 0074's MCP pull was built around that; 0078 fixed the webhook
path itself. Both now land on the same board.

---

## 10. Flow — the marketing funnel and booking

`apps/marketing` is a separate Next.js app on a separate Postgres role. It holds
`USAGE` on the `marketing` schema and **nothing else in the database** — there is
no fallback to `DATABASE_URL` or `APP_DATABASE_URL`, deliberately, because a
public unauthenticated form must not hold credentials to live customer data.

```
/            landing
/capture     step 1 — name, phone, WhatsApp, email, consent  → captureContact()
/start       step 2 — business type, team size, budget, intent, CRM
                                                              → recordQualification()
                │
                ├─ meets funnel_criteria ──► /slots → booking → booking_slots
                │                              └─► Google Meet link, calendar event
                └─ fails criteria ──────────► rejection queued to marketing.funnel_followups
/continue/[token]   resume a half-finished form (signed token)
/reschedule/[token] move a booked slot
/booked, /consent, /privacy, /terms, /dpa, /security, /compatibility
```

Worker sweeps that serve this app:

| Sweep | Clock | Does |
|---|---|---|
| `startFollowUpDrain` | 60 s | Drains `marketing.funnel_followups` — rejections and follow-ups |
| `startBookingConfirmations` | 60 s | Queues the WhatsApp confirmation with the Meet link |
| `startCallReminders` | 5 min | Computes 24 h / 1 h / 5 min from each booking's own start time and queues three stamped rows, so the schedule survives a restart |
| `startBookingNotificationDrain` | 60 s | Sends those reminders, the attended/no-show message, the no-show drip. Keyed on the **booking**, so a reschedule gets a fresh set |
| `startFormNudges` | 5 min | Two nudges, ever, to people who gave details and never answered |
| `startFunnelReminderSweep` | 1 h | Nudges enquirers who went quiet — **opt-in**, `FUNNEL_REMINDERS_ENABLED=true` |
| `startFunnelRetentionSweep` | 24 h (first pass 60 s after boot) | Deletes enquiries when the published privacy policy says we have. **Not env-configurable** — the retention period is a public commitment |
| `startCalendarBusySync` | 10 min | Pulls Google the *other* way: an hour blocked by hand stops being offered |

The follow-up drain has a scar worth reading: it was imported and never called,
so every queued rejection sat untouched while the console truthfully reported
"queued" and the row's error column stayed empty. There was no failure anywhere
to notice.

---

## 11. Flow — outbound CRM dispatch

**A connector is data, not code.** `packages/shared/src/crm-providers.ts` holds
19 entries — HubSpot, Salesforce, Zoho, Pipedrive, GoHighLevel, Freshsales,
Close, Attio, monday, Dynamics 365, Keap, Zendesk Sell, Bitrix24, LeadSquared,
Kylas, plus Zapier/Make/n8n and a fully custom webhook. Each declares its auth
scheme, the per-tenant config that completes its URL, and one spec per writable
object (lead, contact, call activity) with an endpoint template, body shape,
response id path and a starting field map.

```
pipeline SYNCING
      │
      ▼
 enqueueDispatch()  ──► crm_sync_log   ← THE QUEUE IS THE TABLE
      │                 one row per (call, integration), with next_attempt_at
      │
      ├─ try once inline, so the happy path is instant
      │
      └─ startOutboxDrain (15 s) redelivers anything the inline attempt missed
              │
              ▼
        resolveCrmRequest() / renderBody()  ← the SAME @aura/shared functions
                                              the console's "test connection" uses,
                                              so a passing test is evidence about
                                              the real request
```

A worker restart, a broker purge or a redeploy loses nothing: anything still due
is picked up next drain. That is why this is not a RabbitMQ delayed-retry queue —
a lead that took a five-minute call to obtain must not be destroyed by an
infrastructure hiccup.

**To add a CRM:** append a `CrmProviderSpec`. No dispatcher change.
**To add an object to an existing CRM:** append a target to its `targets`.

### Integrity sweeps over the same data

| Sweep | Clock | Asks |
|---|---|---|
| `startCallCrmIntegritySweep` | 30 min | Does a call's own AI read (outcome, quality score) agree with the deal it produced? Writes `call_crm_integrity_flags` — a permanent triage queue, **on by default** |
| `startCrmReconcileSweep` | 30 min | Does a lead's dual-written deal/contact still agree with it? A migration burn-in instrument — **off unless `CRM_RECONCILE_ENABLED=true`** |

---

## 12. Flow — conversations and messaging

```
 Provider (Evolution / WATI-class / Wasi Hub)
      │
      ▼
 POST /v1/messaging/webhook/:token          (no guard — token IS the credential)
      ├─ resolve messaging_channels.webhook_token → org
      ├─ match sender to an existing contact
      │     └─ SAFETY RULE 2: a human-set contact outranks the matcher
      └─ append to conversations / messages  → /owner/inbox
 
 Outbound: POST /v1/conversations/:id/messages   (AdminKeyGuard + Tenant + CrmPermissions)
      └─ a signed-in human presses send. There is no automated sender anywhere.
```

`messaging_channels` (0056, extended for Wasi in 0061) is org *configuration*, so
it sits on `AdminKeyGuard + TenantGuard` rather than `CrmPermissionsGuard` — the
same treatment pipelines, custom-field definitions and roles get.

---

## 13. Flow — a user's own email and calendar

Provider-agnostic by construction: nothing in `connections.controller.ts` names
Google or Microsoft. Every branch is driven by `connection-providers.ts`
(Google, Microsoft, IMAP, CalDAV).

```
/owner/connections → POST /v1/connections/start → provider consent screen
                   → /owner/connections/callback → POST /v1/connections/complete
                   → connected_accounts (0043)   ← tokens encrypted; the read
                                                    column list never selects them

 worker:
   startMailboxSync   (5 min)  — pulls each USER's own mailbox
   startCalendarSync  (10 min) — pulls each USER's own calendar, forward AND back,
                                 and removes events that get cancelled
```

**Safety rule 1 is the whole design here:** a message or event reaches the
interaction timeline only if its counterparty is *already* a contact. A rep's
private mail and their dentist appointment never enter the CRM. Polling rather
than webhooks is deliberate — see the module headers.

---

## 14. Flow — automation, outreach and scoring

### The automation engine (Layer 2, migration 0049)

```
 API action (deal moved, task created, call risk-flagged…)
      └─ enqueues ONE row and returns          ← tenant config off the critical path:
             │                                    a rule with four actions must not make
             ▼                                    dragging a card slower, and a rule that
   automation_events                              throws must not turn a success into a 500
             │
   startAutomationEngine
      ├─ drain (15 s)  — process enqueued events
      └─ sweep (1 h)   — triggers no person causes: a deal gone quiet, a task gone late
```

**Rule loops are structurally impossible, not merely unlikely:** rules can move
deals, and a moved deal is a stage change, which is a trigger — but nothing the
engine does enqueues an event. It also has **no send-an-email action**,
deliberately.

### Outreach cadences (0058)

`startOutreachSweep` runs every **5 minutes**, not the engine's 10: the first
rung of a speed-to-lead cadence is often "within five minutes", and a sweep
slower than the shortest rung makes that rung a lie.

It moves a step from `waiting` to `due` and **stops**. A due step is work for a
person. There is no dispatcher imported in that file and no outbox written to —
if one ever appears, safety rule 3 has been broken. Order matters: *stop before
promote*, so a journey whose stop condition just became true cannot have another
rung fall due in the same tick.

### Lead scoring (0064)

`startLeadScoringSweep` (15 min) — a rule-based point ledger on contacts scored
off replies, meetings and inactivity that already exist. Pure computation, no
sends, no automation events; it touches none of the three safety rules.

---

## 15. Flow — quote to cash

```
 products (0059) ──► quotations (0059) ──► invoices (0060) ──► payments
      │                    │                    │                 │
   catalogue          line items,          issued doc,       POST /v1/webhooks/razorpay
   + pricing          totals, PDF          due dates          └─ HMAC over the EXACT bytes
                                                                 Razorpay sent — which is why
                                                                 main.ts sets rawBody: true
                                                                 (re-serialising parsed JSON
                                                                  can byte-differ and fail a
                                                                  legitimate signature)
```

`commission_plans` (0071) sits beside this and feeds the reports layer.

---

## 16. Flow — reports and the Report Builder

Two distinct surfaces:

| Surface | What it is |
|---|---|
| `/owner/reports` (`reports` module) | Fixed, hand-written reports: telecaller performance, pipeline, targets (0050), commissions (0071) |
| `/owner/reports/builder` (`report-builder`, 0077) | A **CRM-first report canvas** — pages, widgets, filters, themes, templates, scheduled runs |

### Why the builder cannot be SQL-injected

`report-builder/crm-sources.ts` is a **whitelist, not a query builder**. Seven
fixed sources — `deals`, `contacts`, `leads`, `calls`, `tasks`, `campaigns`,
`invoices` — each a fixed `FROM` clause and a fixed column list with fixed SQL
expressions, written by a person. A widget names a column by its **alias**; the
compiler looks that alias up and rejects anything not found. The only values that
reach the database are filter *values*, as `$n` placeholders.

The reason is structural: Postgres has no placeholder for an identifier, so any
path where a caller-supplied string reaches SQL as an identifier cannot be
parameterised. RLS sits underneath as the second line, not the only one.

CSV data sources never touch the API process as a file — the browser parses with
Papa Parse and posts already-parsed JSON rows, exactly as `/v1/import` has done
since 0062. The ceiling is a row count, because that is the number that predicts
whether a query over it will be slow.

### Scheduled delivery

`startReportScheduleSweep` (5 min) renders a published report, freezes the result
in `report_runs`, and raises an **in-app notification** for each recipient who
still holds a live membership at delivery time. It sends nothing outward, and the
schema gives it nowhere to send one to: `report_schedules.recipients` is
`uuid[]` of platform users — there is no column that could hold an address. That
is a deliberate narrowing of the feature request (design doc D6), because the
rule it protects was broken once, in production, to three real people.

---

## 17. Flow — the external API and MCP server

```
  External system ──► POST /v1/public/leads     ┐
                      GET  /v1/public/leads     ├─ ApiKeyGuard + @RequireScope + TenantGuard
  AI agent ─────────► POST /v1/mcp  (JSON-RPC)  ┘
                                │
                                ▼
                      CrmIngestService  ← the ONE implementation behind both doors
                                │           neither controller contains a SQL statement
                                ▼
                    leads + contacts + deals, in one transaction
                    dedup key = (workspace_id, contact_number_hash)
                              ← deliberately the SAME key upsertLead uses, so a
                                telecaller who later phones a number an integration
                                already pushed converges onto that lead
```

Why a separate controller rather than scopes on the existing routes: every CRM
route is mounted `AdminKeyGuard + TenantGuard` and assumes a signed-in human.
Bolting a second credential onto 200+ routes would make recording playback and
erasure reachable by a headless key the moment someone forgot a scope
annotation. The blast radius of one mistake would be the whole product.

Separately, `mcp/mcp.controller.ts` (0074) manages the tenant's **outbound** MCP
connections — today the Meta MCP server. `access_token` is never in the read
column list, the same rule `CONNECTION_COLUMNS` follows.

---

## 18. Flow — data hygiene

| Feature | Route / module | Notes |
|---|---|---|
| **Bulk import** | `POST /v1/import/preview`, `/run` (0062) | Contacts, accounts, deals. Max 5000 rows, browser-parsed. On `AdminKeyGuard + TenantGuard` only — a bulk write is an org action |
| **Merge / dedupe** | `merge` module (0038, 0042) | Fuzzy duplicate detection → `/owner/duplicates` |
| **Custom fields** | `custom-fields` (0037, 0045) | Definitions are org config; *values* carry provenance so safety rule 2 can be enforced |
| **Tags & marketing sources** | `tags` (0057) | Mixed guard: definitions on org config, record links on `CrmPermissionsGuard` |
| **Projects** | `projects` (0073) | The tenant's own offerings. `detectCallProjects` labels calls by **string match, not an LLM** — the catalogue is a closed list the tenant typed, so it is a lookup, not a judgement, and a model would answer differently on Tuesday |
| **Erasure** | `erasure-requests` (`OrgRoleGuard`) | GDPR/DPDP cascading erasure with signed receipts |
| **Reaper** | worker, 1 h | Retention + erasure sweeps over recordings and transcripts |

---

## 19. Worker sweep inventory

Everything the worker runs, and on what clock. All read their work from
Postgres, so a restart strands nothing.

| Sweep | Default clock | Gate |
|---|---|---|
| `consumePipeline(processCall)` | event-driven | always |
| `startOutboxDrain` | 15 s | always |
| `startAsrPoller` | 15 s | always (no-op for inline ASR) |
| `startAutomationEngine` drain | 15 s | always |
| `startRetrySweeper` | 30 s | always |
| `startFollowUpDrain` | 60 s | always |
| `startBookingConfirmations` | 60 s | always |
| `startBookingNotificationDrain` | 60 s | always |
| `startStalledCallSweeper` | 5 min | always |
| `startCallReminders` | 5 min | always |
| `startFormNudges` | 5 min | always |
| `startOutreachSweep` | 5 min | always |
| `startMailboxSync` | 5 min | no-op until an account is connected |
| `startReportScheduleSweep` | 5 min | always |
| `startCalendarSync` | 10 min | no-op until an account is connected |
| `startCalendarBusySync` | 10 min | no-op without Google credentials |
| `startMetaMcpSweep` | 10 min | **`META_MCP_SYNC_ENABLED="true"`** |
| `startLinkedInSweep` | 10 min | **does not start** without approved LinkedIn app credentials |
| `startLeadScoringSweep` | 15 min | always |
| `startCallCrmIntegritySweep` | 30 min | always |
| `startCrmReconcileSweep` | 30 min | **`CRM_RECONCILE_ENABLED=true`** |
| `startAutomationEngine` sweep | 1 h | always |
| `startFunnelReminderSweep` | 1 h | **`FUNNEL_REMINDERS_ENABLED=true`** |
| `startReaper` | 1 h | always |
| `startFunnelRetentionSweep` | 24 h | always, **not env-configurable** |

---

## 20. How everything converges

The single most important structural fact: **every lead-producing path lands on
the same three tables through the same two functions.**

```
 handset call ──► upsertLead ──┐
 web form     ──┐              │
 email        ──┤              │
 telephony    ──┼─► LeadIntakeService ──┤
 Meta ads     ──┤   (API)               ├──► leads ──► projectLeadToCrm() ──► contacts
 LinkedIn     ──┴─► lead-intake.ts      │                                        │
 public API   ──┐   (worker)            │                                        ▼
 MCP tool     ──┴─► CrmIngestService ───┘                                      deals
 CSV import   ──────► import module ────────────────────────────────────────►  ↑
 typed by hand ─────► console ──────────────────────────────────────────────────┘

 dedup key everywhere: (workspace_id, contact_number_hash)
```

A telecaller phoning a number an ad already delivered converges onto one lead
rather than forking a duplicate. That only holds because nobody invented a
second dedup key — which is exactly the bug this shape was built to prevent, and
which the codebase has already paid for once (`meta-mcp-sync.ts` header).

### The `leads` ↔ `deals` cutover

Both models are **live**. `CRM_SHADOW_READ_ENABLED` decides only which group the
owner sidebar puts first — not which data is real:

- `/owner/board`, `/owner/leads` read `leads` (core Aura, independent of the CRM module)
- `/owner/deals`, `/owner/contacts`, `/owner/accounts`, `/owner/reports` read the CRM object model

Writes stay on `/v1/leads` either way until Milestone 5's flip. See
`CRM_STATUS.md`.

---

## 21. Deployment topology

One VPS, Docker Compose, Caddy for TLS, Supabase for Postgres.

```
        ┌──────────── caddy (the ONLY published ports) ─────────────┐
        │  {$APP_DOMAIN}      /v1/*  → api:4000                     │
        │                     else   → web:3000                     │
        │  {$STORAGE_DOMAIN}         → minio:9000  (presigned       │
        │                               part uploads, no buffering) │
        └───┬───────────────────────────┬──────────────┬────────────┘
            ▼                           ▼              ▼
          web                          api        (worker: no port, no inbound)
       aura-web                     aura-node          aura-node
            │                           │                  │
            └───────────────┬───────────┴──────────────────┘
                            ▼
      Supabase Postgres · rabbitmq · minio (+ minio-init) · redis (provisioned, unused)
                            ▲
                      migrate (one-shot job, same aura-node image)

  marketing (aura-marketing) runs on its own container port 3000 and its own
  vhost — the apex + www, not aura.*. `docker-compose.nginx.yml` is the overlay
  for a VPS whose nginx already owns :80/:443: caddy is profiled out and every
  service publishes on loopback only, so the host nginx is the single edge.
```

**The marketing container is deliberately NOT given `env_file: .env.production`.**
Every other service loads it wholesale; this one gets an explicit allowlist,
because it is the only container serving unauthenticated traffic from the open
internet and that file holds `ADMIN_API_KEY`, the Supabase service-role key, the
S3 secret and the Evolution API key. Running the funnel on a narrow
`aura_marketing` role exists to bound what a compromise yields; handing the same
container the root admin key would throw that away for one less line of YAML.

`app.set("trust proxy", 1)` in `api/main.ts` is load-bearing: Caddy is the only
thing that can reach the API process, and without it every external request
would report Caddy's container address as `req.ip`, collapsing per-IP limits
into one shared bucket — the 5/min login limit would then let any stranger lock
every customer out of signing in.

`assertRequiredEnv()` runs **before anything can bind a port**. In production it
throws when a credential is missing or still holds a published dev default, so
the container dies in its restart loop rather than serving customer data behind
a key anyone can read out of this repository.

| File | Role |
|---|---|
| `docker-compose.prod.yml` | The production stack (no local Postgres — that's Supabase) |
| `docker/node.Dockerfile` | One image for api + worker + the migrate job |
| `docker/web.Dockerfile` | Next.js consoles, standalone output |
| `docker/Caddyfile` | TLS + routing |
| `.env.production.example` | Every production variable, annotated |
| `supabase/migrations/` | Generated from `packages/db/migrations` via `pnpm db:supabase:sync` |
| `deploy.sh` | Pull, build, migrate, restart, verify |

See **`DEPLOYMENT.md`** for the full runbook and the signed Android release build.

---

## 22. Where to change what

| To do this | Change this |
|---|---|
| Add a CRM connector | Append a `CrmProviderSpec` to `CRM_PROVIDERS` — no dispatcher change |
| Add an object to an existing CRM | Append a target to that provider's `targets` |
| Add a lead intake channel | Append to `LEAD_INTAKE_CHANNELS` in `lead-intake.ts` |
| Add an email/calendar provider | Append to `CONNECTION_PROVIDERS` |
| Add a product module / entitlement | Append to `ORG_MODULES` (0072) and add the href to the gated list in `nav.ts` |
| Add a chartable column to reports | `report-builder/crm-sources.ts` — deliberately a code change |
| Rename or add a lead board column | Edit `organizations.lead_stages` — a row edit, not a migration |
| Add an API route for external systems | `public-api.controller.ts` + a scope in `api-scopes.ts`; the SQL goes in `CrmIngestService`, never the controller |
| Add a background job | A `start…Sweep` in `apps/worker/src/pipeline/`, wired in `worker/src/main.ts`, reading its work from Postgres |
| Add a nav destination | `apps/web/lib/nav.ts` — and file it in `OWNER_SECTION_OF`, which is tested to leave nothing unfiled |

### Verification scripts

| Script | Checks |
|---|---|
| `scripts/check-tenancy.js` | Tenant isolation across the schema |
| `scripts/backfill-crm-objects.js` | Replays `projectLeadToCrm` over history — the *same function* live projection uses, so backfill and live cannot drift |
| `scripts/backfill-leads.js` | Replays lead projection |
| `scripts/reprocess-backlog.js` | Re-drives stranded calls |
| `apps/api/verify-report-builder.cjs`, `verify-lead-intake.sql` | SQL-level checks that typecheck cannot catch |
| `tests/isolation.test.ts` | RLS default-deny |
| `apps/api/src/common/guard-mounting.spec.ts` | **Every controller is guarded, or explicitly listed as unguarded-by-design** |

---

## 23. Known seams and disclosed gaps

- **`FAILED_CRM` is unreachable by design.** Read the comment in `pipeline.ts` before "finishing" it the way `FAILED_TRANSCODE` was finished.
- **Redis is provisioned in the stack but no application code touches it.** Two TODOs are waiting on it: making the device challenge nonce single-use (`common/device-nonce.ts`) and giving the throttler a shared storage provider (`config/throttling.ts`) — the latter matters the moment the API runs more than one replica, since per-process limits are per-replica.
- **No dead-letter queue** on the RabbitMQ consumer yet — failures are recorded in the calls state machine and picked up by the retry sweeps instead (checklist §2.3).
- **`Idempotency-Key` on `POST /v1/calls` is accepted but not yet honoured** on retries (checklist §2.2).
- **`wasi` is catalogued but not a toggle** — Wasi is configured manually per client as a `messaging_channels` row (0061); there is no bulk provisioning action.
- **Project detection misses a caller who never names the offering.** That is what the alias list and the human override are for — stated rather than hidden.
- **The handset's `Transcriber` interface is a stub** (`NoopTranscriber`) — on-device transcription was deferred; all real ASR happens server-side.
- **`schema_migrations` cannot be trusted on production** — verify migration state read-only. See `production-migration-drift`.
