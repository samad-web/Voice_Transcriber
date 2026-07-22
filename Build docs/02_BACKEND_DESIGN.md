# Backend & API Design — AI Call Intelligence Platform

Companion to `01_GAP_ANALYSIS.md`. Targets a defensible v1 that scales to ~200 tenants and
~50k calls/month without re-architecture.

---

## 1. Principles

1. **One tenancy mechanism, enforced at the lowest layer.** Every row carries `org_id`;
   Postgres Row-Level Security enforces it. Application code cannot forget.
2. **The pipeline graph is fixed; its parameters are dynamic.** Prompts, fields, labels, and
   mappings are data. Stages are code.
3. **Idempotency everywhere.** Devices retry on flaky mobile networks; every write endpoint
   takes an idempotency key.
4. **Boring infrastructure.** Postgres, Redis, one queue, S3. Add Elasticsearch and Kafka when a
   measured limit forces it, not before.
5. **Voice data is regulated data.** Consent, retention, and erasure are services, not settings.

---

## 2. Tenancy model

**Shared database, shared schema, `org_id` on every table, Postgres RLS.**

```sql
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON calls
  USING (org_id = current_setting('app.org_id')::uuid);
```

The API sets `app.org_id` from the authenticated principal at the start of each request's
transaction, on a connection from a pool that uses a non-superuser role (superusers bypass RLS —
a classic and expensive mistake).

Alternatives considered: schema-per-tenant (migration pain at ~100 tenants), database-per-tenant
(operationally heavy, justified only if you sell single-tenant isolation as a premium SKU — leave
the door open by keeping the `org_id` column even in that future).

**Hierarchy.** The PRD's Platform → Organization → Workspace → {Instances, Devices, Users} is
sound, but "AI Instance" is doing two jobs: a billing/limit container and a configuration bundle.
Split them:

- **Organization** — billing entity, plan, contract.
- **Workspace** — isolation and access boundary (team, region, or client of the org).
- **Instance** — a *deployment target*: an ID + secret that devices enroll against, with its own
  limits and default agent. Devices belong to instances.
- **Agent** — a configuration bundle (prompt, fields, labels, CRM map). Many agents per
  workspace; a call is processed by one, resolved at ingest.

Keeping instance ≠ agent means you can re-point 200 devices at a new agent version without
re-enrolling any of them.

---

## 3. Identity and authentication

Three principal types, three mechanisms, one authorization model.

### 3.1 Humans
OIDC (Auth0/Cognito/Keycloak) → short session cookie for the web app. Enforce SSO + SCIM for
enterprise plans. MFA required for any role that can play back recordings.

### 3.2 Devices

Enrollment is the security-critical flow:

1. Admin creates an instance → gets `instance_id` + one-time `enrollment_token` (short TTL,
   limited use count, displayed as a QR code).
2. Device generates a P-256 keypair in **Android Keystore** (StrongBox when available). The
   private key never leaves hardware.
3. `POST /v1/devices/register` with `{instance_id, enrollment_token, public_key, device_fingerprint,
   play_integrity_token}`.
4. Server verifies the integrity token (rejects rooted/emulated devices per tenant policy),
   creates the device row, returns `device_id` + a long-lived **refresh token bound to the public key**.
5. `POST /v1/devices/authenticate` — device signs a server nonce with the Keystore key; server
   returns a 15-minute access JWT. This proves possession of hardware-backed key material, so a
   stolen token file alone is useless.

Access JWT claims: `sub` (device_id), `org_id`, `workspace_id`, `instance_id`, `scope`,
`cfg_ver` (current config version — lets the device notice drift on every call).

### 3.3 API keys
`cik_live_<random>`; store only a SHA-256 hash plus a 6-char display prefix. Scoped, revocable,
last-used tracked. These are keys *into* your platform — keep them distinct from customer-supplied
LLM provider keys (§8), which are a different thing entirely and should never share a table.

### 3.4 Authorization
RBAC with roles scoped to a level: `platform_admin`, `org_admin`, `workspace_admin`,
`workspace_member`, `viewer`. Plus two orthogonal permissions that must be separately grantable
because they carry the real privacy weight: `recordings:listen` and `recordings:export`. Many
organizations will want managers who can read transcripts and AI output but not play audio.

---

## 4. Data model

Abbreviated; every table has `id uuid pk`, `org_id uuid`, `created_at`, `updated_at`.

```
organizations      name, plan_id, status, billing_customer_id, retention_days,
                   consent_policy (enum: none | tone | tone_and_tts | prohibited)
workspaces         org_id, name, settings jsonb
users              email, name, status, sso_subject
memberships        user_id, scope_type, scope_id, role
instances          workspace_id, name, secret_hash, default_agent_id, limits jsonb, config_version
devices            instance_id, label, public_key, fingerprint, os_version, app_version,
                   status (active|logged_out|wiped|lost), last_seen_at, capture_capability
device_health      device_id, ts, battery_opt_exempt, accessibility_enabled, perms jsonb,
                   pending_uploads, free_storage_mb, last_upload_at, failure_counts jsonb
calls              workspace_id, device_id, direction, remote_number_hash, remote_name,
                   source_id, started_at, ended_at, duration_s, audio_source_used,
                   status (see §6), consent_status, agent_id
recordings         call_id, s3_key, bytes, sha256, codec, sample_rate, encrypted, uploaded_at
transcripts        call_id, language, engine, text, segments jsonb, confidence, diarized bool
ai_outputs         call_id, agent_id, agent_version, output jsonb, schema_version,
                   tokens_in, tokens_out, cost_usd, provider, model, validation_status
agents             workspace_id, name, version, system_prompt, field_schema jsonb,
                   labels jsonb, scoring jsonb, crm_mapping jsonb, is_active
crm_integrations   workspace_id, provider, auth jsonb (encrypted), field_map jsonb, status
crm_sync_log       call_id, integration_id, status, external_id, error, attempts
usage_events       org_id, workspace_id, kind, quantity, unit, occurred_at, ref_id
audit_log          actor_type, actor_id, action, target_type, target_id, ip, meta jsonb
```

Notes:

- **`remote_number_hash`** — store the counterparty's number hashed (HMAC with a per-org key)
  with only the last 3 digits in clear, unless the tenant explicitly opts into plaintext. It
  materially reduces breach severity, and most workflows only need matching, not reading.
- **`ai_outputs.output` is JSONB** because the schema is tenant-defined. Add a small
  **projection table** (`call_facts(call_id, field_key, value_text, value_num, value_bool)`) so
  filtering and analytics on custom fields don't require JSONB scans across the whole tenant.
- **Agents are versioned, never mutated.** Editing creates a new version; calls reference the
  version they were processed with. Without this, "why did last month's numbers change?" is
  unanswerable.
- Partition `calls`, `transcripts`, `usage_events` by month once past ~10M rows.

---

## 5. Services

Deploy as a **modular monolith** for v1 (NestJS or FastAPI), with clear module boundaries and a
separate worker process. The PRD's nine services are a good *module* map and a premature
*deployment* map; the boundaries below are the ones worth extracting first when load demands it.

```
API process            Worker process(es)
├── auth               ├── ingest
├── tenancy            ├── transcode
├── devices            ├── asr
├── calls (ingest API) ├── analyze  (agent + LLM)
├── agents             ├── crm-dispatch
├── crm (config/OAuth) ├── notify
├── analytics          └── reaper (retention/erasure)
├── billing
└── admin
```

Shared library: `model-provider` (§8), `consent`, `limits`, `audit`.

---

## 6. Ingest and processing pipeline

### 6.1 Upload

Direct-to-S3, never through the API process.

```
POST /v1/calls
  → creates call row (status=AWAITING_AUDIO), returns
    {call_id, upload: {method: multipart, part_urls: [...], upload_id}}
Client PUTs parts directly to S3
POST /v1/calls/{id}/complete  {parts:[{n,etag}], sha256, duration_s, metadata}
  → server verifies checksum via S3 HEAD, sets status=UPLOADED, enqueues ingest
```

Checked at `POST /v1/calls`, before any bytes move: instance limits, storage quota, consent
status, and device status. Rejecting early saves the device's battery and your bandwidth.

### 6.2 Stage graph

```
UPLOADED → transcode → TRANSCODING
         → asr       → TRANSCRIBING
         → analyze   → ANALYZING
         → crm       → SYNCING
         → done      → COMPLETE
                     ↘ FAILED_{STAGE} (with retry policy + DLQ)
```

Each stage is a queue consumer that is **idempotent on `call_id`** and advances a state machine
in Postgres under an optimistic-concurrency check. Never infer progress from queue state; the
database is the source of truth and the queue is just a wake-up signal.

- **transcode** — ffmpeg to 16 kHz mono Opus, decrypt from the device key envelope, store
  normalized copy, keep or drop the original per tenant policy.
- **asr** — provider-abstracted (Whisper self-hosted / OpenAI / Gemini / Deepgram). Emit
  word-level timestamps and segments. Diarize here (§1.2 of the gap analysis), attaching
  `speaker` per segment. Language detection is a by-product; don't build a separate stage for it.
- **analyze** — resolve agent → render prompt → call LLM with **structured output / JSON schema
  mode** → validate against the agent's schema → on failure, one repair attempt with the
  validation errors appended → on second failure, store raw output and mark
  `validation_status=failed` rather than dropping it.
- **crm-dispatch** — map fields, call the connector, log to `crm_sync_log`, retry with backoff,
  never block pipeline completion on CRM availability.

### 6.3 Backpressure and cost control

Per-org concurrency limits on the analyze stage (Redis semaphore). One tenant uploading a
backlog of 5,000 calls must not starve everyone else or blow the month's LLM budget in an hour.
Enforce a per-org hourly spend ceiling with alerting at 80%.

---

## 7. Dynamic extraction schema

Agent defines fields as a constrained JSON Schema subset:

```json
{
  "fields": [
    {"key": "budget",      "type": "number",  "required": false,
     "description": "Stated budget in INR", "validation": {"min": 0}},
    {"key": "intent",      "type": "enum",    "values": ["hot","warm","cold"], "required": true},
    {"key": "follow_up_at","type": "datetime","required": false},
    {"key": "objections",  "type": "string[]"}
  ]
}
```

Compile this to (a) a JSON Schema passed to the LLM's structured-output mode, (b) a runtime
validator, (c) the projection rows in `call_facts`, (d) the web UI's filter and table columns.
One definition, four consumers — that is what makes "no customer-specific code" true in practice.

Constrain deliberately: scalar types, enums, arrays of scalars, one level of nesting maximum.
Unbounded nested-object extraction produces unreliable LLM output and unqueryable data.

---

## 8. Model provider layer

The PRD's closing recommendation is the right one; here is the shape.

```
ProviderRouter
  ├── resolve(org, agent, task) → [primary, fallback...]
  ├── credential resolution: tenant BYO key → platform key → deny
  ├── execute with timeout, retry, circuit breaker per provider
  ├── normalize request/response across OpenAI | Gemini | Anthropic | self-hosted
  └── emit usage_event (tokens, cost, latency, provider, model)
```

- **Key storage: envelope encryption.** Per-org DEK, wrapped by a KMS CMK. Decrypt in memory
  only, never log, never return via API (show prefix + last 4 only). Rotate on demand.
- **BYO keys shift cost *and* liability** to the tenant. Support both, and default enterprise
  plans to BYO — it also removes you from the sub-processor chain for that tenant, which is a
  genuinely useful compliance answer.
- **Failover on 5xx/timeout only**, never on content refusals. Model-swapping mid-agent changes
  extraction behavior, so record which model produced each output (`ai_outputs.model`) and
  surface it in the UI.
- **Zero-retention tiers only** for any provider processing voice transcripts.

---

## 9. API surface

Versioned at `/v1`. Cursor pagination. `Idempotency-Key` header on all POSTs. Problem+JSON errors.

**Device (device JWT)**
```
POST   /v1/devices/register
POST   /v1/devices/authenticate
POST   /v1/devices/token/refresh
GET    /v1/devices/me/config          → {version, capture, upload, consent, sources[]}
POST   /v1/devices/me/health
POST   /v1/devices/me/events          (batched call-detection + probe telemetry)
POST   /v1/calls                      → presigned upload
POST   /v1/calls/{id}/complete
```

**Platform (user session / API key)**
```
GET    /v1/workspaces/{id}/calls?from&to&direction&agent&label&q&cursor
GET    /v1/calls/{id}                  (transcript + ai_output + facts)
GET    /v1/calls/{id}/audio            (short-lived presigned URL; audited)
POST   /v1/calls/{id}/reprocess        (re-run analyze with a different agent version)
CRUD   /v1/agents , /v1/agents/{id}/versions , /v1/agents/{id}/test
CRUD   /v1/instances , /v1/devices , /v1/apikeys , /v1/crm/integrations
POST   /v1/devices/{id}/logout | /wipe | /sync
GET    /v1/analytics/{metric}
GET    /v1/usage , /v1/billing/invoices
POST   /v1/erasure-requests            (subject erasure, cascading)
POST   /v1/webhooks/crm/{provider}     (inbound)
```

`POST /v1/agents/{id}/test` — run an agent against a stored call and diff the output against the
current version. Without it, prompt editing is blind, and every tenant will ask for it in week two.

---

## 10. Limits, metering, billing

Meter from day one even if billing ships later; retrofitting usage history is impossible.

- **Enforcement**: Redis counters keyed `usage:{org}:{period}:{metric}`, checked at admission
  (call creation, API request, device registration). Postgres `usage_events` is the durable
  ledger; Redis is the fast path, reconciled hourly.
- **Metrics**: calls, minutes, storage-GB-months, AI tokens (in/out separately), API requests,
  devices, seats, CRM syncs.
- **Behavior at limit**: soft limit → notify at 80/100%; hard limit → reject new uploads with a
  clear error the device surfaces in its notification. Never silently drop a recording — that
  destroys trust in the product faster than any outage.

---

## 11. Search

**v1: Postgres.** `tsvector` GIN index over transcript text, combined with structured filters on
`calls` and `call_facts`. This handles transcript search, filtering, and highlighting well into
the millions of calls.

**Later, when justified:** OpenSearch for cross-field relevance ranking and fuzzy matching, fed
from a `transcripts` outbox. Design the search interface behind a `SearchProvider` port now so
the swap is contained; do not build the second system yet.

---

## 12. Compliance services (first-class, not settings)

- **Consent service** — resolves policy per (org, device jurisdiction, call direction) and returns
  a directive the device must honor before capture: `none | tone | tts_announcement | prohibited`.
  Device reports back whether the announcement played; server records `consent_status` per call.
  If policy requires consent and the announcement failed, the call is marked and the tenant policy
  decides whether to discard the audio.
- **Retention reaper** — nightly job enforcing per-org `retention_days` across S3, transcripts,
  and the search index.
- **Erasure service** — a subject-erasure request fans out to Postgres rows, S3 objects, search
  index, CRM-pushed copies (best effort, logged), and produces a signed completion receipt.
- **Audit log** — append-only, every recording playback and export, every agent and key change,
  every admin action. Exportable per tenant. This is what enterprise security reviews ask for.

---

## 13. Observability and operations

- OpenTelemetry traces spanning device upload → S3 → each pipeline stage, keyed by `call_id`.
- Golden signals per stage: queue depth, stage latency p50/p95, failure rate, DLQ size.
- Business alerts that matter more than infra ones: *recording success rate per device model*
  (your early warning for an OEM update breaking capture), devices silent >24 h, uploads pending
  >6 h, LLM spend rate, CRM sync failure rate.
- DLQ with a replay tool. Pipeline failures will be routine; make reprocessing a one-click
  operation from the admin UI.

---

## 14. Deployment

Managed Postgres (with PITR), managed Redis, SQS or RabbitMQ, S3 with SSE-KMS + versioning +
Object Lock for the retention window, containers on ECS/GKE with separate API and worker pools,
IaC in Terraform, secrets in a managed secret store. Keep audio in the tenant's region — data
residency will be an early enterprise requirement, so make the S3 bucket and Postgres shard
region-aware at the schema level now (`organizations.region`), even if you only run one region.
