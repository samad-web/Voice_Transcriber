# 11 — Data inventory: what actually exists vs. what the code thinks exists

**Author:** Data analyst (Stage 0/1 of `08_ROAD_TO_10.md`)
**Method:** static only. Every statement below is derived by reading
`platform/packages/db/migrations/0001…0018` in order and grepping the TypeScript. **No database
was connected to.** `platform/apps/web/.env.local` and `platform/.env.production` point at live
production and were never read or executed.

**Scope note:** `platform/supabase/migrations/2026010100000{01..18}_*.sql` are byte-identical to
`platform/packages/db/migrations/00{01..18}_*.sql` (verified by `diff`). There is no schema drift
between the two migration directories. Everything below applies to both.

---

## 0. Executive summary

- **24 tables** exist (23 application tables + `schema_migrations`).
- **21 tables carry `org_id`.** All 21 have `ENABLE` + `FORCE ROW LEVEL SECURITY` and an
  `org_isolation` policy. **There is no missing-policy gap today.** The gap is that
  `verify-rls.js` only *proves* it for 4 of them, so migration 0019 can introduce an unprotected
  table and CI will stay green. Dev D's rewrite must enumerate `information_schema`, not a list.
- **`users` has no RLS at all** and no `org_id`. It holds `email`, `password_hash` and
  `sso_subject` for every tenant, and the app role can read all of it. The tenant boundary on the
  platform's identity table is 100% application code.
- **26 orphan columns** and **1 orphan table** found. The three known ones were verified; **one of
  the three (`organizations.region`) turned out to be wrong** — it *is* written. See §2.
- **The most expensive defects are missing indexes on `call_id`.** `transcripts`, `recordings` and
  `ai_outputs` have **no index on `call_id` at all**, and every one of them is read by `call_id`
  multiple times per call in the pipeline hot path.
- **`packages/shared/src/enums.ts` is out of sync with two CHECK constraints.** `CallStatus` is
  missing `TRANSCRIPTION_OFF` (added in 0014, written by the worker at `pipeline.ts:511`);
  `CrmSyncStatus` is missing `dead` (added in 0008, written by `outbox.ts:111`). Dev C must not
  write fixtures from `enums.ts` — it is wrong.

---

## 1. Effective schema after 0001 → 0018

Legend: **PK** primary key · **FK→** foreign key with its `ON DELETE` behaviour · **RLS** carries
`org_id` + `FORCE ROW LEVEL SECURITY` + `org_isolation` policy.

### 1.1 Tenancy and identity

#### `organizations` — RLS via `org_self` policy on `id` (not `org_id`)
| column | type | notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `name` | text NOT NULL | |
| `plan_id` | text | **orphan — neither written nor read** |
| `status` | text NOT NULL DEFAULT `'active'` | CHECK ∈ (`active`, `suspended`, `churned`) |
| `billing_customer_id` | text | **orphan — neither written nor read** |
| `retention_days` | int NOT NULL DEFAULT 90 | drives `reaper.ts` |
| `consent_policy` | text NOT NULL DEFAULT `'tone'` | CHECK ∈ (`none`,`tone`,`tone_and_tts`,`prohibited`) |
| `on_consent_failure` | text NOT NULL DEFAULT `'do_not_record'` | CHECK ∈ (`record_and_flag`,`do_not_record`) |
| `region` | text NOT NULL DEFAULT `'ap-south-1'` | written + displayed, but never *used* — see §2.4 |
| `lead_stages` (0010) | jsonb NOT NULL | 6-entry default; validated by API, not by CHECK |
| `store_full_number` (0011) | boolean NOT NULL DEFAULT false | gates `calls.remote_number_full` |
| `transcription_enabled` (0014) | boolean NOT NULL DEFAULT true | |
| `asr_language` (0016) | text | CHECK: NULL or one of 24 BCP-47 codes (see §6.C) |
| `asr_mode` (0016) | text | CHECK: NULL or ∈ (`transcribe`,`translate`,`verbatim`,`translit`,`codemix`) |
| `vocabulary` (0016) | text[] NOT NULL DEFAULT `'{}'` | |
| `created_at`, `updated_at` | timestamptz NOT NULL | `updated_at` trigger |

Indexes: PK only. No index on `status` (used cross-tenant by `reaper.ts:23`).

#### `users` — **NO org_id, NO RLS**
| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `email` | text NOT NULL **UNIQUE** | login matches on `lower(email)` — the unique index cannot serve that predicate |
| `name` | text | |
| `status` | text NOT NULL DEFAULT `'active'` | CHECK ∈ (`active`, `disabled`) |
| `sso_subject` | text **UNIQUE** | the Supabase Auth subject; the *only* link between a browser session and a tenant |
| `password_hash` (0004) | text | `scrypt$<salt_hex>$<hash_hex>` |
| `created_at`, `updated_at` | timestamptz | |

Indexes: PK, `UNIQUE(email)`, `UNIQUE(sso_subject)`.

#### `workspaces` — RLS
`id` uuid PK · `org_id` FK→`organizations` **CASCADE** · `name` text NOT NULL · `settings` jsonb
NOT NULL DEFAULT `'{}'` (**orphan — never written, never read**) · `created_at`, `updated_at`.
Indexes: PK only (no index on `org_id`).

#### `memberships` — RLS
| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | uuid FK→`organizations` **CASCADE** | |
| `user_id` | uuid FK→`users` **CASCADE** | |
| `scope_type` | text NOT NULL | CHECK ∈ (`org`, `workspace`) |
| `scope_id` | uuid NOT NULL | **no FK** — points at `organizations.id` or `workspaces.id` depending on `scope_type`. Polymorphic, unconstrained. |
| `role` | text NOT NULL | CHECK ∈ (`platform_admin`,`org_admin`,`workspace_admin`,`workspace_member`,`viewer`) |
| `recordings_listen` | bool NOT NULL DEFAULT false | |
| `recordings_export` | bool NOT NULL DEFAULT false | |
| `owner_role` (0018) | text | CHECK: NULL or ∈ (`owner`,`manager`,`telecaller`) |
| `created_at`, `updated_at` | timestamptz | |

Indexes: PK, `UNIQUE(user_id, scope_type, scope_id)`.

#### `sessions` (0004) — RLS
`id` PK · `org_id` FK→`organizations` **CASCADE** · `user_id` FK→`users` **CASCADE** ·
`token_hash` text NOT NULL · `expires_at` timestamptz NOT NULL · `created_at`.
Indexes: PK, `sessions_token_hash (token_hash)`. **No expiry sweep exists** — nothing ever deletes
rows past `expires_at`; the table grows forever.

#### `telecallers` (0017) — RLS
`id` PK · `org_id` FK→`organizations` **CASCADE** · `user_id` FK→`users` **SET NULL** ·
`display_name` text NOT NULL · `status` text NOT NULL DEFAULT `'active'` CHECK ∈
(`active`,`archived`) · `created_at`, `updated_at`.
Indexes: PK, `UNIQUE(org_id, user_id) WHERE user_id IS NOT NULL`. **No index on `org_id` alone.**

### 1.2 Fleet

#### `instances` — RLS
`id` PK · `org_id` FK→`organizations` **CASCADE** · `workspace_id` FK→`workspaces` **CASCADE** ·
`name` text NOT NULL · `default_agent_id` uuid (**no FK; orphan — see §2.1**) · `limits` jsonb NOT
NULL DEFAULT `'{}'` (**orphan**) · `config_version` int NOT NULL DEFAULT 0 · `created_at`,
`updated_at`. Indexes: PK only (no index on `workspace_id` or `org_id`).

#### `enrollment_tokens` — RLS
`id` PK · `org_id` FK→`organizations` **CASCADE** · `instance_id` FK→`instances` **CASCADE** ·
`token_hash` text NOT NULL · `expires_at` timestamptz NOT NULL · `max_uses` int NOT NULL DEFAULT 1
· `use_count` int NOT NULL DEFAULT 0 · `created_at`, `updated_at`.
Indexes: PK only. The enrollment lookup (`devices.controller.ts:57`) filters on
`(instance_id, token_hash, expires_at, use_count)` — **unindexed**.

#### `devices` — RLS
| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | FK→`organizations` **CASCADE** | |
| `instance_id` | FK→`instances` **CASCADE** | **no index** |
| `label` | text | |
| `public_key` | text NOT NULL | read at `devices.controller.ts:161` for signature verify |
| `fingerprint` | text | |
| `os_version` | text | **read-never-written** — always NULL in the fleet UI |
| `app_version` | text | **read-never-written** — always NULL in the fleet UI |
| `status` | text NOT NULL DEFAULT `'active'` | CHECK ∈ (`active`,`logged_out`,`wiped`,`lost`) |
| `capture_capability` | text | CHECK: NULL or ∈ (`FULL_DUPLEX`,`NEAR_END_ONLY`,`SPEAKER_REQUIRED`,`UNSUPPORTED`) |
| `last_seen_at` | timestamptz | |
| `refresh_token_hash` (0002) | text | **written-never-read** — see §2.2 |
| `telecaller_name` (0010) | text | still the live attribution source |
| `telecaller_id` (0017) | FK→`telecallers` **SET NULL** | |
| `created_at`, `updated_at` | | |

#### `device_health` — RLS · **write-only table (§2.3)**
`id` PK · `org_id` FK **CASCADE** · `device_id` FK→`devices` **CASCADE** · `ts` timestamptz NOT
NULL · `battery_opt_exempt` bool · `accessibility_enabled` bool · `perms` jsonb NOT NULL DEFAULT
`'{}'` (**never written**) · `battery_level` int · `pending_uploads` int · `free_storage_mb` int ·
`last_upload_at` timestamptz · `failure_counts` jsonb NOT NULL DEFAULT `'{}'` (**never written**) ·
`created_at`. Index: `device_health_device_ts (device_id, ts DESC)` — never used, nothing reads
this table.

### 1.3 Call data

#### `calls` — RLS
| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | FK→`organizations` **CASCADE** | |
| `workspace_id` | FK→`workspaces` **CASCADE** | |
| `device_id` | FK→`devices` — **NO `ON DELETE` CLAUSE** | the only FK in the schema without one |
| `direction` | text NOT NULL | CHECK ∈ (`incoming`,`outgoing`) |
| `remote_number_hash` | text | HMAC(per-org key); dedup key for leads and contact history |
| `remote_number_last3` | text | |
| `remote_number_prefix` (0006) | text | first 5 digits |
| `remote_number_full` (0011) | text | **only** when `organizations.store_full_number = true` |
| `remote_name` | text | |
| `source_id` | text | **orphan — neither written nor read** |
| `started_at` | timestamptz NOT NULL | |
| `ended_at` | timestamptz | **orphan — neither written nor read** |
| `duration_s` | int NOT NULL DEFAULT 0 | |
| `audio_source_used` | text | e.g. `SOURCE@RATE` |
| `status` | text NOT NULL DEFAULT `'AWAITING_AUDIO'` | **`calls_status_check`, rewritten by 0014** — see §3.5 |
| `consent_status` | text NOT NULL DEFAULT `'pending'` | CHECK ∈ (`not_required`,`played`,`failed`,`pending`) |
| `agent_id` | uuid | **no FK** (agents are versioned-immutable, `PK(id,version)`) |
| `agent_version` | int | **no FK** |
| `error_message` (0012) | text | truncated to 500 chars by `reasonOf()` |
| `pipeline_attempts` (0013) | int NOT NULL DEFAULT 0 | |
| `next_attempt_at` (0013) | timestamptz | |
| `asr_job_id` (0015) | text | |
| `asr_job_started_at` (0015) | timestamptz | |
| `created_at`, `updated_at` | | |

Indexes:
- `calls_ws_started (org_id, workspace_id, started_at DESC)`
- `calls_status (org_id, status) WHERE status NOT IN ('COMPLETE')`
- `calls_workspace_number_hash (workspace_id, remote_number_hash) WHERE remote_number_hash IS NOT NULL` (0010)
- `calls_retry_due (next_attempt_at) WHERE next_attempt_at IS NOT NULL` (0013)
- `calls_asr_job_pending (asr_job_started_at) WHERE asr_job_id IS NOT NULL` (0015)

#### `recordings` — RLS
`id` PK · `org_id` FK **CASCADE** · `call_id` FK→`calls` **CASCADE** · `s3_key` text NOT NULL ·
`bytes` bigint · `sha256` text · `codec` text · `sample_rate` int · `encrypted` bool NOT NULL
DEFAULT true (**orphan**) · `uploaded_at` timestamptz · `created_at`, `updated_at`.
**Indexes: PK only. No index on `call_id`.**

#### `transcripts` — RLS
`id` PK · `org_id` FK **CASCADE** · `call_id` FK→`calls` **CASCADE** · `language` text ·
`engine` text · `text` text · `segments` jsonb NOT NULL DEFAULT `'[]'` · `confidence` real
(**orphan**) · `diarized` bool NOT NULL DEFAULT false · `intelligence` jsonb (0005) ·
`tsv` tsvector GENERATED ALWAYS AS `to_tsvector('simple', coalesce(text,''))` STORED ·
`created_at`, `updated_at`.
Indexes: PK, `transcripts_fts GIN(tsv)`. **No index on `call_id`.**

#### `agents` — RLS · **PK is `(id, version)`**
`id` uuid NOT NULL DEFAULT `gen_random_uuid()` · `org_id` FK **CASCADE** · `workspace_id`
FK→`workspaces` **CASCADE** · `name` text NOT NULL · `version` int NOT NULL DEFAULT 1 ·
`system_prompt` text NOT NULL DEFAULT `''` · `field_schema` jsonb NOT NULL DEFAULT
`'{"fields": []}'` · `labels` jsonb NOT NULL DEFAULT `'[]'` · `scoring` jsonb NOT NULL DEFAULT
`'{}'` (**orphan**) · `crm_mapping` jsonb NOT NULL DEFAULT `'{}'` (**orphan**) · `is_active` bool
NOT NULL DEFAULT false · `lead_rules` jsonb NOT NULL DEFAULT `'{}'` (0010) · `created_at`,
`updated_at`. Indexes: PK `(id, version)` only. **No index on `(workspace_id, is_active)`** — the
analyze stage's agent lookup (`pipeline.ts:341`) scans.

#### `ai_outputs` — RLS
`id` PK · `org_id` FK **CASCADE** · `call_id` FK→`calls` **CASCADE** · `agent_id` uuid NOT NULL
(no FK) · `agent_version` int NOT NULL (no FK) · `output` jsonb NOT NULL DEFAULT `'{}'` ·
`schema_version` int (**orphan**) · `tokens_in` int · `tokens_out` int · `cost_usd` numeric(12,6)
(**orphan — §2.1**) · `provider` text · `model` text · `validation_status` text NOT NULL DEFAULT
`'valid'` CHECK ∈ (`valid`,`repaired`,`failed`) · `created_at`, `updated_at`.
**Indexes: PK only. No index on `call_id`.**

#### `call_facts` — RLS · **PK is `(call_id, field_key)`**
`org_id` FK **CASCADE** · `call_id` FK→`calls` **CASCADE** · `field_key` text NOT NULL ·
`value_text` text · `value_num` numeric · `value_bool` bool.
Indexes: PK `(call_id, field_key)`, `call_facts_kv (org_id, field_key, value_text)`.

#### `call_notes` (0003) — RLS
`id` PK · `org_id` FK **CASCADE** · `call_id` FK→`calls` **CASCADE** · `body` text NOT NULL ·
`author` text · `created_at`. Index: `call_notes_call (call_id, created_at DESC)`.

### 1.4 Outbound and pipeline bookkeeping

#### `crm_integrations` — RLS
Base (0001): `id` PK · `org_id` FK **CASCADE** · `workspace_id` FK→`workspaces` **CASCADE** ·
`provider` text NOT NULL · `auth` jsonb NOT NULL DEFAULT `'{}'` · `field_map` jsonb NOT NULL
DEFAULT `'{}'` · `status` text NOT NULL DEFAULT `'disconnected'` CHECK ∈
(`connected`,`disconnected`,`error`) · `created_at`, `updated_at`.
0008: `endpoint` text · `auth_type` text NOT NULL DEFAULT `'none'` · `auth_header` text NOT NULL
DEFAULT `'X-API-Key'` · `auth_secret` text · `headers` jsonb NOT NULL DEFAULT `'{}'` ·
`max_attempts` int NOT NULL DEFAULT 6 · `rate_limit_per_min` int NOT NULL DEFAULT 60.
0009: `label` text · `target` text · `method` text NOT NULL DEFAULT `'POST'` CHECK ∈
(`POST`,`PUT`,`PATCH`) · `config` jsonb NOT NULL DEFAULT `'{}'` · `body_template` jsonb ·
`id_path` text · `pair_keys` text[] · `auth_prefix` text NOT NULL DEFAULT `''` ·
`last_success_at` timestamptz · `last_error` text.
0011: `only_qualified` boolean NOT NULL DEFAULT false.
**`crm_integrations_auth_type_check` (final, from 0009):** `auth_type ∈ ('none','bearer','header','header_prefix','basic','query')`.
Index: `crm_integrations_workspace_status (workspace_id, status)`.
`auth_secret` holds `v1.gcm:<iv>:<tag>:<ct>` when `CRM_SECRET_KEY` is set, **plaintext otherwise**.

#### `crm_sync_log` — RLS · this *is* the outbox
`id` PK · `org_id` FK **CASCADE** · `call_id` FK→`calls` **CASCADE** · `integration_id`
FK→`crm_integrations` **CASCADE** · `status` text NOT NULL · `external_id` text · `error` text ·
`attempts` int NOT NULL DEFAULT 0 · `next_attempt_at`, `request_body` jsonb, `response_status` int,
`response_body` text, `request_id` text, `last_attempt_at` (0008) · `target` text, `request_url`
text (0009) · `created_at`, `updated_at`.
**`crm_sync_log_status_check` (final, from 0008):** `status ∈ ('pending','synced','failed','dead')`.
Indexes: PK, `UNIQUE(call_id, integration_id)`,
`crm_sync_log_due (status, next_attempt_at) WHERE status = 'pending'`,
`crm_sync_log_integration_recent (integration_id, updated_at DESC)`.

#### `leads` (0010) — RLS
| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `org_id` | FK→`organizations` **CASCADE** | |
| `workspace_id` | FK→`workspaces` **CASCADE** | |
| `contact_name`, `contact_number_hash`, `contact_number_prefix`, `contact_number_last3` | text | |
| `title` | text NOT NULL | |
| `stage` | text NOT NULL DEFAULT `'new'` | **no CHECK** — validated against `organizations.lead_stages` in app code |
| `status` | text NOT NULL DEFAULT `'open'` | CHECK ∈ (`open`,`won`,`lost`) |
| `score` | numeric | |
| `value_num` | numeric | the agent's `valueField` |
| `summary`, `next_action`, `notes` | text | |
| `facts` | jsonb NOT NULL DEFAULT `'{}'` | merged with `\|\|`, never blanked |
| `telecaller_device_id` | FK→`devices` **SET NULL** | |
| `telecaller_id` (0017) | FK→`telecallers` **SET NULL** | **written-never-read — §2.2** |
| `first_call_id`, `last_call_id` | FK→`calls` **SET NULL** | |
| `agent_id` uuid, `agent_version` int | | no FK |
| `call_count` | int NOT NULL DEFAULT 1 | recomputed, not incremented |
| `last_activity_at`, `stage_changed_at`, `created_at`, `updated_at` | timestamptz NOT NULL | |

Indexes: PK · `UNIQUE(workspace_id, contact_number_hash) WHERE contact_number_hash IS NOT NULL` ·
`leads_org_stage (org_id, stage, last_activity_at DESC)` ·
`leads_org_activity (org_id, last_activity_at DESC)` ·
`leads_org_telecaller (org_id, telecaller_device_id)` ·
`leads_org_telecaller_id (org_id, telecaller_id)` (0017, **dead — nothing queries it**).

#### `usage_events` — RLS · append-only (UPDATE/DELETE revoked from `aura_app`)
`id` PK · `org_id` FK **CASCADE** · `workspace_id` uuid (**no FK; orphan — never written**) ·
`kind` text NOT NULL · `quantity` numeric NOT NULL · `unit` text NOT NULL · `occurred_at`
timestamptz NOT NULL DEFAULT now() · `ref_id` uuid (**write-only**) · `created_at`.
Index: `usage_events_org_time (org_id, occurred_at DESC)`.
**Actual `kind` values written:** `asr_seconds` (`pipeline.ts:217`), `llm_tokens_in`,
`llm_tokens_out` (`pipeline.ts:327`, `:417`). The 0001 comment claims
`calls | minutes | storage_gb | tokens_in | tokens_out` — none of those five are ever written.
`billing.controller.ts:33` reads only `llm_tokens_in` / `llm_tokens_out`; `asr_seconds` is
written and never read.

#### `audit_log` — RLS · append-only
`id` PK · `org_id` FK **CASCADE** · `actor_type` text NOT NULL · `actor_id` text NOT NULL ·
`action` text NOT NULL · `target_type` text · `target_id` text · `ip` text (**orphan — never
written**) · `meta` jsonb NOT NULL DEFAULT `'{}'` · `created_at`.
Index: `audit_log_org_time (org_id, created_at DESC)`.

#### `api_keys` (0003) — RLS
`id` PK · `org_id` FK **CASCADE** · `name` text · `key_hash` text NOT NULL (**written-never-read
— §2.2, the whole feature authenticates nothing**) · `prefix` text NOT NULL · `last_used_at`
timestamptz (**read-never-written**) · `created_at`.
Index: `api_keys_org (org_id, created_at DESC)`.

#### `schema_migrations`
`name` text PK · `applied_at` timestamptz NOT NULL DEFAULT now(). Created by `migrate.js:20`.
All privileges revoked from `aura_app`. No `org_id`, no RLS — correct.

---

## 2. Orphan columns — written-never-read, read-never-written, neither

**This is the highest-value section. 26 orphan columns across 12 tables, plus 1 orphan table.**

Method: for every column in §1, `grep -rnw` across `platform/apps/**` and `platform/packages/**`
(excluding `node_modules` and `dist`), then read each hit to classify it as a SQL read, a SQL
write, or an unrelated identifier.

### 2.1 The three "known" ones — verified, and one correction

| claim | verdict | evidence |
|---|---|---|
| `ai_outputs.cost_usd` exists, never written | ✅ **CONFIRMED — and never read either** | `pipeline.ts:362-379` inserts `(org_id, call_id, agent_id, agent_version, output, provider, model, tokens_in, tokens_out, validation_status)`. `cost_usd` is absent. Zero occurrences of the string `cost_usd` anywhere in TypeScript. |
| `instances.default_agent_id` exists since 0001, never READ | ✅ **CONFIRMED — and never WRITTEN either** | Exactly one occurrence in the whole repo, and it is a comment: `apps/api/src/modules/agents/agents.controller.ts:35` — `* active agent per workspace. TODO: instance.default_agent_id routing.` Neither `INSERT INTO instances` site (`admin.controller.ts:93`, `instances.controller.ts:79`) supplies it. Routing is `agents.controller`'s "one `is_active` agent per workspace" (`pipeline.ts:341-345`: `WHERE c.id = $1 AND a.is_active = true ORDER BY a.version DESC LIMIT 1`), which caps a tenant at exactly one extraction shape per workspace. |
| `organizations.region` exists, never written | ❌ **WRONG — it IS written** | `admin.controller.ts:74` — `INSERT INTO organizations (name, consent_policy, retention_days, region) VALUES ($1, COALESCE($2,'tone'), COALESCE($3,90), COALESCE($4,'ap-south-1'))`. It is also read at `admin.controller.ts:79`, `:139` and `tenancy.controller.ts:69`. The *real* defect is different — see §2.4. |

### 2.2 Written but never read

| table.column | written at | consequence |
|---|---|---|
| `api_keys.key_hash` | `apikeys.controller.ts:47` | **The API-key feature is a facade.** There is no code path anywhere that hashes an inbound key and looks it up. `AdminKeyGuard` accepts only `x-admin-key` or `Bearer aus_…`. A customer can mint a `cik_live_…` key in the console and it authenticates nothing. |
| `devices.refresh_token_hash` (0002) | `devices.controller.ts:88` | Written once at enrollment, never verified. Device re-auth is signature-over-nonce against `devices.public_key` (`devices.controller.ts:146,161`). The "long-lived refresh token" design in 0002's header does not exist in code. |
| `leads.telecaller_id` (0017) | `leads.ts:193` (param `$18`) | **Silently useless.** `LEAD_COLUMNS` (`leads.controller.ts:48-53`) selects `l.telecaller_device_id` and `COALESCE(d.telecaller_name, d.label)` via a join on `telecaller_device_id`. The list filter (`leads.controller.ts:96`) filters `l.telecaller_device_id = $?`. The whole point of 0017 — an attribution that survives handset reassignment — is written and then ignored. The index `leads_org_telecaller_id` is dead. Worse: the PATCH at `leads.controller.ts:262` reassigns `telecaller_device_id` **without touching `telecaller_id`**, so the two columns diverge permanently the first time an owner re-attributes a card. |
| `usage_events.ref_id` | `pipeline.ts:217,327,417` | Always set to the `call_id`; nothing ever selects it. Per-call cost attribution is therefore impossible even though the data is there. |
| `usage_events.kind = 'asr_seconds'` | `pipeline.ts:217` | The only consumer (`billing.controller.ts:33`) filters on `llm_tokens_in`/`llm_tokens_out`. ASR seconds are billed nowhere. |
| `recordings.codec`, `recordings.sample_rate` | `calls.controller.ts:188` | Written at upload-complete, never selected. |
| `recordings.bytes`, `recordings.sha256` | `calls.controller.ts:188` | Read back only inside the same upload flow (`calls.controller.ts:217`) to validate the upload; never surfaced or used again. Borderline — listed for completeness. |
| `transcripts.diarized` (partially) | `pipeline.ts:315` | Read by `crm-dispatch.ts:163` into the CRM payload, and by `calls.controller.ts:353`. **Not** an orphan, but note §5 feature 1: it is *not* evidence both sides were captured. |
| **`device_health` (whole table)** | `device-telemetry.controller.ts:49-58` | **Orphan table.** One `INSERT`, zero `SELECT`s. Every handset writes a health beacon on an interval and nothing on the platform ever looks at it. This is the single largest write-only surface in the schema, and it is exactly the data Stage-5 feature 3.1 (Recording assurance SLA) needs. |

### 2.3 Read but never written — these silently return NULL

| table.column | read at | consequence |
|---|---|---|
| `devices.os_version` | `devices.controller.ts:275` | The fleet list renders an always-empty OS column. No enrollment or telemetry path writes it. |
| `devices.app_version` | `devices.controller.ts:275` | Same. An operator cannot tell which handsets are on an old build — which is the first question in any capture-failure triage. |
| `api_keys.last_used_at` | `apikeys.controller.ts:66` | Always NULL in the console. Consistent with §2.2: nothing authenticates with the key, so nothing could stamp it. |

### 2.4 Neither written nor read

| table.column | note |
|---|---|
| `organizations.plan_id` | Zero occurrences. Plan is not modelled. |
| `organizations.billing_customer_id` | Zero occurrences. |
| `workspaces.settings` | Zero SQL occurrences. |
| `instances.default_agent_id` | See §2.1. |
| `instances.limits` | Zero SQL occurrences (all 10 grep hits are unrelated `limit` identifiers). The per-tenant quota surface does not exist. |
| `device_health.perms` | Absent from the only INSERT. |
| `device_health.failure_counts` | Absent from the only INSERT. |
| `calls.source_id` | Zero occurrences. The OEM recording's own id is discarded at ingest, so a duplicate upload cannot be detected. |
| `calls.ended_at` | Zero occurrences. `duration_s` is the only temporal fact besides `started_at`. |
| `recordings.encrypted` | Defaults `true` and is never checked. Encryption-at-rest is not implemented (0001 TODO §2.3). The column asserts a property that does not hold. |
| `transcripts.confidence` | `AsrResult` (`asr.ts:11-17`) has no confidence field. The per-segment `confidence` in `TranscriptSegment` (`entities.ts:58`) is a different, also-unwritten thing. |
| `agents.scoring` | Only occurrence is the zod shape at `entities.ts:21`; never in SQL. |
| `agents.crm_mapping` | Zero occurrences. Superseded by `crm_integrations.field_map` (0008). |
| `ai_outputs.schema_version` | Zero occurrences. An agent's `field_schema` can change under a stored output with no way to know which shape produced it. |
| `ai_outputs.cost_usd` | See §2.1. |
| `usage_events.workspace_id` | All three INSERTs omit it; no SELECT references it. Per-workspace metering is impossible. |
| `audit_log.ip` | Zero write sites across ~20 `INSERT INTO audit_log` statements. Every audit row has a NULL source address — a real problem for Stage 4.3's evidence trail. |
| `memberships.scope_id` when `scope_type='workspace'` | Written, but no FK and nothing validates it points at a workspace in the same org. |

### 2.5 The `organizations.region` defect (the real one)

`region` is written and displayed, but **never used to place data**. All three S3 clients hardcode
`process.env.S3_REGION ?? "ap-south-1"` (`pipeline.ts:13`, `reaper.ts:7`, `erasure.controller.ts:22`,
`instances.controller.ts:24`). A tenant provisioned with `region = 'eu-west-1'` has its recordings
stored in `ap-south-1` anyway, while the console tells the operator otherwise. That is worse than an
unwritten column: it is a *false* residency claim in a product sold on data-protection terms.

---

## 3. Data-integrity defects

### 3.1 RLS coverage — the actual gap

**All 21 `org_id`-carrying tables have a policy today.** Enumerated in migration order:

| # | table | policy from |
|---|---|---|
| 1–16 | `workspaces`, `memberships`, `instances`, `enrollment_tokens`, `devices`, `device_health`, `calls`, `recordings`, `transcripts`, `agents`, `ai_outputs`, `call_facts`, `crm_integrations`, `crm_sync_log`, `usage_events`, `audit_log` | 0001 loop |
| 17–18 | `api_keys`, `call_notes` | 0003 loop |
| 19 | `sessions` | 0004 |
| 20 | `leads` | 0010 |
| 21 | `telecallers` | 0017 |

Plus `organizations`, which uses a different predicate (`id = current_setting('app.org_id')`,
policy name `org_self`, **not** `org_isolation`).

**What is actually wrong:**

1. **`verify-rls.js` proves 4 tables, not 6, and not 21.** It exercises `workspaces` (assertions
   1–3), `organizations` (assertion 4), `telecallers` (assertion 5) and `audit_log` (assertion 6).
   A migration 0019 that adds `commitments (org_id, …)` and forgets the policy loop passes CI
   silently, and the table is then readable cross-tenant by `aura_app` — the exact bug class the
   whole RLS design exists to prevent. **This is Dev D's item.**
2. **0007's FORCE-RLS loop is derived from `pg_policies`.** That is the right call (forcing RLS on
   a policy-less table is a deny-all outage) but it means a table with no policy is silently
   skipped rather than loudly broken. Nothing anywhere fails when a table is unprotected.
3. **`users` has no `org_id` and no RLS.** It holds `email`, `password_hash` and `sso_subject` for
   every tenant. 0007 revokes `anon`/`authenticated`/`service_role`/`PUBLIC`, so only `aura_app`
   and the migration owner can read it — but `aura_app` is the API's own runtime role. Any SQL
   injection, any missing `WHERE`, any future controller that queries `users` without an org
   predicate reads the whole platform's identity table. The boundary is 100% application code.
   `sessions` at least carries `org_id` and is protected; `users` is not.
4. **`AuthService` runs entirely on `adminPool()`** (`auth.service.ts:48, 108, 118, 139, 160`) —
   the RLS-bypassing owner connection. Justified for `login`/`contextFor` (there is no org context
   yet), but `principalFromToken` (`:139`) and `logout` (`:160`) both operate on `sessions`, which
   *does* have RLS, and both bypass it. A token-hash collision or a mistyped predicate crosses
   tenants with no database-level backstop.

### 3.2 Missing indexes on hot paths

Ordered by expected impact.

| # | missing index | hot path it serves | evidence |
|---|---|---|---|
| 1 | **`transcripts (call_id)`** | Pipeline runs 4 statements keyed on `call_id` per call: `DELETE` (`pipeline.ts:202`), `SELECT text, segments, diarized` (`:268`), `UPDATE … SET segments/intelligence` (`:309`/`:321`), `SELECT text` (`:349`). Plus `crm-dispatch.ts:172` `LEFT JOIN transcripts t ON t.call_id = c.id`, plus reaper (`reaper.ts:43`) and erasure (`erasure.controller.ts:83`). | Only index is `GIN(tsv)`. Every one of these is a seq scan of the tenant's whole transcript corpus. |
| 2 | **`ai_outputs (call_id)`** | `leads.ts:98-99` and `crm-dispatch.ts:168-169` both run `(SELECT ao.validation_status FROM ai_outputs ao WHERE ao.call_id = c.id ORDER BY ao.created_at DESC LIMIT 1)` — a correlated subquery, once per call, on both the lead-projection and every CRM delivery attempt. | PK only. |
| 3 | **`recordings (call_id)`** | `pipeline.ts:564` `SELECT s3_key FROM recordings WHERE call_id = $1` on every call; `calls.controller.ts:217, 242, 392`; `reaper.ts:31`; `erasure.controller.ts:53`; `instances.controller.ts:213`. | PK only. |
| 4 | **`calls (org_id, started_at DESC)`** | The Call Explorer list (`calls.controller.ts:311`) is `ORDER BY c.started_at DESC` with **no `workspace_id` predicate** — it filters by `instance_id`/`device_id` through joins. `calls_ws_started` leads with `(org_id, workspace_id)`, so it cannot serve this ordering. The reaper's `WHERE c.started_at < now() - make_interval(days => $1)` (`reaper.ts:32`) has the same problem. | This is the single most-executed read in the console. |
| 5 | **`calls (status, updated_at)`** | `requeueStuckUploads` (`retry.ts:88-96`) runs **cross-tenant on the admin pool every 30 s**: `WHERE status = 'UPLOADED' AND updated_at < now() - … ORDER BY updated_at`. `calls_status` is `(org_id, status)` partial, so a cross-tenant scan cannot use it. This is a full seq scan of the entire `calls` table, twice a minute, forever. | `retry.ts:110` interval default 30 000 ms. |
| 6 | **`agents (workspace_id, is_active, version DESC)`** | `pipeline.ts:341-345` resolves the active agent for every single call. | PK is `(id, version)`; nothing indexes `workspace_id`. |
| 7 | **`devices (instance_id)`** | `instances.controller.ts:191, 216, 238` and the fleet list. Also the FK-cascade check when an instance is deleted. | PK only. |
| 8 | **`enrollment_tokens (instance_id, token_hash)`** | `devices.controller.ts:57` — every handset enrollment. | PK only. |
| 9 | **`users (lower(email))`** | `auth.service.ts:53` `WHERE lower(u.email) = lower($1)` and `:111` `lower(email) = lower($2)`. The `UNIQUE(email)` btree indexes the raw value and **cannot** serve `lower(email)`. Every login and every `/v1/auth/context` call (i.e. every owner-console page render) seq-scans `users`. | Needs `CREATE INDEX ON users (lower(email))`. |
| 10 | trigram on `leads (title, contact_name, summary)` | `leads.controller.ts:104` — `l.title ILIKE '%q%' OR l.contact_name ILIKE '%q%' OR l.summary ILIKE '%q%'`. Leading-wildcard `ILIKE` cannot use a btree. | Needs `pg_trgm` + GIN, or accept the scan and document it. |
| 11 | `telecallers (org_id)` | The owner dashboard lists them (`owner.controller.ts:106`). | Only `UNIQUE(org_id, user_id) WHERE user_id IS NOT NULL` — useless when `user_id` is NULL, which is what the 0017 backfill produced for every existing row. |

**Not missing (verified good):** the retry sweep (`calls_retry_due`), the ASR poller
(`calls_asr_job_pending`), the outbox drain (`crm_sync_log_due`), the lead board
(`leads_org_stage`), lead dormancy reaping (`leads_org_activity`), contact history
(`calls_workspace_number_hash`), billing (`usage_events_org_time`), session lookup
(`sessions_token_hash`).

### 3.3 Foreign keys and erasure

| finding | detail |
|---|---|
| **`calls.device_id` has no `ON DELETE` clause** | `0001_init.sql:140` — `device_id uuid NOT NULL REFERENCES devices(id)`. It is the **only** FK in the schema without one, so it defaults to `NO ACTION`. Deleting a device with calls raises a FK violation. Today the only delete path (`instances.controller.ts:198`) guards on `counts.calls > 0 && !purgeCalls`, but that count is taken in a separate statement from the delete — a call landing in between turns a tenant-offboarding request into a 500. |
| **No tenant-deletion path exists in code** | There is no `DELETE FROM organizations` anywhere. Offboarding is a manual SQL operation against production. Nothing has been exercised, so the cascade order (`calls.org_id` CASCADE vs `calls.device_id` NO ACTION) has never been proven to work. |
| **Erasure leaves `leads` behind on instance delete** | `instances.controller.ts:238-247` deletes calls and cascades devices, but never touches `leads`. `leads.telecaller_device_id` and `first_call_id`/`last_call_id` go to NULL (0010, `ON DELETE SET NULL`) and the lead survives holding `contact_name`, `contact_number_hash`, `summary` and `facts` — i.e. the subject's personal data outlives the instance that produced it. `ErasureController` handles this correctly (`erasure.controller.ts:68-73` deletes leads by contact hash); the instance-delete path does not. |
| **Erasure cannot reach `audit_log` / `usage_events`** | Both are append-only for `aura_app` (UPDATE/DELETE revoked in 0001 and re-asserted in 0007). `audit_log.target_id` and `usage_events.ref_id` retain the erased `call_id` forever. Defensible as a compliance record, but it should be a documented decision, not an accident. |
| **Cross-table `agent_id` references are unconstrained** | `calls.agent_id`, `ai_outputs.agent_id`, `leads.agent_id` and `instances.default_agent_id` are all bare `uuid` with no FK, because `agents` has a composite PK `(id, version)`. `leads.ts:103` joins `LEFT JOIN agents a ON a.id = c.agent_id AND a.version = c.agent_version` — a dangling pair produces a silent NULL `lead_rules`, which `parseLeadRules` then turns into `DEFAULT_LEAD_RULES`. A deleted agent version therefore silently re-qualifies calls under the default rule instead of failing. |
| **`memberships.scope_id` has no FK and no cross-org check** | `members.controller.ts:92` inserts `(org_id, user_id, scope_type, scope_id, …)`. Nothing constrains `scope_id` to a workspace belonging to `org_id`. |

### 3.4 Tenant boundaries that depend on application code, not constraints

1. **`leads.stage`** — no CHECK. Validity is enforced at `leads.controller.ts:242` against
   `organizations.lead_stages`. A direct write, a future worker path, or a bug puts an
   unrenderable stage on the board. (This is a deliberate, documented trade — 0010's header — but
   Dev C must test it, because it is the only guard.)
2. **`SELECT lead_stages FROM organizations LIMIT 1`** (`leads.controller.ts:75`) — no `WHERE`.
   Correct *only* because RLS narrows `organizations` to one row. Run on `adminPool()` it would
   return an arbitrary tenant's board columns. Several queries share this shape:
   `analytics.controller.ts:52` (`SELECT kind, sum(quantity) FROM usage_events GROUP BY kind`),
   `billing.controller.ts:41` (`SELECT count(*) FROM devices`), `:44` (`FROM api_keys`),
   `apikeys.controller.ts:66`. All are correct today and all are one `adminPool()` slip from
   cross-tenant disclosure.
3. **`AdminKeyGuard` trusts `x-org-id`** (`admin-key.guard.ts:38-50`). It validates the id names a
   *real* org, not that the caller may act for it. That is by design (the key is cross-tenant) —
   but it means the whole tenant boundary for admin-key traffic is the secrecy of one env var that
   **defaults to the literal `"dev-admin-key"`** at `admin-key.guard.ts:36`.
4. **`OwnerRoleGuard` fails open** (`owner-role.guard.ts:41`): `if (principal.viaAdminKey &&
   principal.ownerRole == null) return true;`. And `resolveOwnerRole` (`roles.ts:22`) defaults an
   absent/invalid value to `"owner"`, the **most** permissive persona. Both are documented choices
   for backward compatibility; both mean the persona model is advisory.

### 3.5 `calls_status_check` vs. what the worker actually writes

The effective constraint is from **0014** (0001's was dropped):

```
CHECK (status IN (
  'AWAITING_AUDIO', 'UPLOADED', 'TRANSCODING', 'TRANSCRIBING',
  'ANALYZING', 'SYNCING', 'COMPLETE', 'TRANSCRIPTION_OFF',
  'FAILED_TRANSCODE', 'FAILED_ASR', 'FAILED_ANALYZE', 'FAILED_CRM'))
```

Every status the code can write:

| value | written by | in CHECK? |
|---|---|---|
| `AWAITING_AUDIO` | `calls.controller.ts:165` (literal in INSERT) | ✅ |
| `UPLOADED` | `calls.controller.ts:239`; `retry.ts:25` (CLAIM_SQL rewind) | ✅ |
| `TRANSCODING` | `pipeline.ts:525` `advance("UPLOADED","TRANSCODING")` | ✅ |
| `TRANSCRIBING` | `pipeline.ts:545` | ✅ |
| `ANALYZING` | `pipeline.ts:237` | ✅ |
| `SYNCING` | `pipeline.ts:428` | ✅ |
| `COMPLETE` | `pipeline.ts:460` | ✅ |
| `TRANSCRIPTION_OFF` | `pipeline.ts:511` | ✅ |
| `FAILED_ASR` | `pipeline.ts:594`, `asr-poll.ts:138`, `:159` — via `fail("ASR", …)` → `` `FAILED_${stage}` `` (`pipeline.ts:163`) | ✅ |
| `FAILED_ANALYZE` | `pipeline.ts:423` via `fail("ANALYZE", …)` | ✅ |

**Verdict: no mismatch. The worker cannot write a value the CHECK rejects.** But two related
defects fall out of the same audit:

- **`FAILED_TRANSCODE` and `FAILED_CRM` are never written.** `fail()` is only ever called with
  `"ASR"` and `"ANALYZE"`. The transcode stage (`pipeline.ts:521-528`) is a pass-through with no
  `try/catch`, so a future ffmpeg failure there would **throw out of `processCall` entirely** — no
  `error_message`, no `pipeline_attempts` increment, no `next_attempt_at`, and the call is left in
  `TRANSCODING` where neither the retry sweep (`FAILED_%` only) nor the stuck-upload sweep
  (`UPLOADED` only) will ever find it. CRM failures are explicitly non-blocking
  (`pipeline.ts:454-458`), so `FAILED_CRM` is dead by design. Both values are nonetheless offered
  as filters in `calls.controller.ts:51-54` and as stage names in `admin.controller.ts:16,19`.
- **`packages/shared/src/enums.ts` disagrees with the database.** `CallStatus`
  (`enums.ts:4-16`) lists the 11 values from **0001** and is missing `TRANSCRIPTION_OFF`.
  `CrmSyncStatus` (`enums.ts:52`) is `['pending','synced','failed']` and is missing `'dead'`,
  which `outbox.ts:111` writes routinely. Both feed `Call` in `entities.ts:73,77`. Nothing parses
  a live row through `Call` today, so it is latent — but it is a loaded gun for Dev C, who will
  reach for `enums.ts` as the source of legal values. **It is not.** The CHECK constraints are.

---

## 4. Pipeline data flow

`apps/worker/src/pipeline/` — stage by stage. "R" = read, "W" = written.

| stage / entry point | tables R | tables W | on failure |
|---|---|---|---|
| **ingest** (API, not worker) `calls.controller.ts:160` | `devices`, `instances`, `organizations` | `calls` (`AWAITING_AUDIO`) | `ConflictException` if device or org not `active`, or `consent_policy='prohibited'`. Nothing is written. |
| **upload complete** `calls.controller.ts:188,239,242` | `recordings` | `recordings` (INSERT, then `uploaded_at`), `calls` (`AWAITING_AUDIO`→`UPLOADED`) | call stays `AWAITING_AUDIO`; no sweeper covers that state. |
| **0. transcription gate** `pipeline.ts:500-519` | `organizations` (`transcription_enabled`, `asr_language`, `asr_mode`) | `calls` → `TRANSCRIPTION_OFF`, clears `error_message`/`next_attempt_at`/`pipeline_attempts` | terminal by design; only a manual reprocess moves it. |
| **1. transcode** `pipeline.ts:525-542` | `calls` | `calls` (`UPLOADED`→`TRANSCODING`), clears `error_message`, `next_attempt_at`, `asr_job_id`, `asr_job_started_at` | **no `try/catch`** — an exception escapes `processCall`, leaving the call stranded in `TRANSCODING`, invisible to both sweepers. See §3.5. |
| **2a. ASR inline (Gemini)** `pipeline.ts:591`, `asr.ts` | `calls.duration_s`, `recordings.s3_key`, S3 object | `transcripts` (DELETE + INSERT), `usage_events` (`asr_seconds`) | `fail("ASR")` → `status='FAILED_ASR'`, `error_message` (≤500 ch), `pipeline_attempts+1`, `next_attempt_at = now() + 30·4^(n-1) s` capped 3600 s, or NULL once `pipeline_attempts ≥ PIPELINE_MAX_ATTEMPTS` (default 5). |
| **2b. ASR batch submit (Sarvam)** `pipeline.ts:568-588`, `asr-sarvam.ts` | same | `calls.asr_job_id`, `calls.asr_job_started_at`; **run ends here**, call parked in `TRANSCRIBING` | as 2a. |
| **2c. ASR poll** `asr-poll.ts:64-151` | `calls` (cross-tenant, `adminPool`) `WHERE asr_job_id IS NOT NULL AND status='TRANSCRIBING'` | claims by nulling `asr_job_id` under `status='TRANSCRIBING'`; then `transcripts`, `usage_events` | provider `failed` or job older than `ASR_JOB_TIMEOUT_MS` (30 min) → `fail("ASR")`. Lock contention (`55P03`/`57014`) is swallowed as "someone else got there first". Transport errors leave the job pending. |
| **3. conversation intelligence** `pipeline.ts:264-336` | `transcripts` (`text`,`segments`,`diarized`), `organizations.vocabulary`, `calls.direction` | `transcripts.segments`, `.diarized`, `.intelligence`; `usage_events` (`llm_tokens_in/out`) | **swallowed** (`pipeline.ts:334`) — logged, never fails the call. |
| **4. extraction** `pipeline.ts:338-421` | `agents` (active, highest version, by workspace), `transcripts.text`, `organizations.vocabulary` | `ai_outputs`, `calls.agent_id`/`agent_version`, `call_facts` (upsert, absent values **skipped** not NULLed — `isAbsent()` at `pipeline.ts:79`), `usage_events` | `fail("ANALYZE")` → `FAILED_ANALYZE` + same retry budget. Skipped entirely when no active agent or no transcript text. |
| **5. lead projection** `leads.ts:82-227` | `calls`, `organizations.lead_stages`, `agents.lead_rules`, `transcripts.intelligence->>'summary'`, `call_facts`, `ai_outputs.validation_status`, `devices.telecaller_id` | `leads` (upsert on `(workspace_id, contact_number_hash)`; never resets `stage`/`status`/`telecaller_device_id`/`telecaller_id`) | **swallowed** (`pipeline.ts:446`). `qualified` stays `false`, which suppresses `only_qualified` integrations. |
| **6. CRM enqueue + first attempt** `outbox.ts:43-165` | `crm_integrations` (`status='connected'`, workspace-matched, `only_qualified` filter), then `buildSourceDocument` reads `calls`, `devices`, `transcripts`, `recordings`, `call_facts`, `ai_outputs` | `crm_sync_log` (upsert on `(call_id, integration_id)`), `crm_integrations.last_success_at`/`last_error` | payload-build failure → `status='dead'`, `next_attempt_at=NULL`. Delivery failure → `pending` with backoff (or `Retry-After`), or `dead` once `attempts ≥ max_attempts` or the error is terminal. **Never blocks the call.** |
| **7. complete** `pipeline.ts:460-467` | — | `calls` `SYNCING`→`COMPLETE`, then `pipeline_attempts=0`, `next_attempt_at=NULL` | — |
| **sweeper: retry** `retry.ts:32-74` | `calls` (`adminPool`, cross-tenant) `WHERE next_attempt_at <= now() AND status LIKE 'FAILED_%'` | claims `status='UPLOADED'`, `next_attempt_at=NULL` under the same predicate, then republishes | claim is the lock; a lost publish leaves the call in `UPLOADED` for the stuck sweep. |
| **sweeper: stuck uploads** `retry.ts:87-107` | `calls` (`adminPool`) `WHERE status='UPLOADED' AND updated_at < now()-10min` | nothing — just republishes | idempotent; `processCall`'s `UPLOADED→TRANSCODING` guard absorbs duplicates. **Unindexed full scan — §3.2 #5.** |
| **sweeper: CRM outbox** `outbox.ts:175-233` | `crm_sync_log` ⨝ `crm_integrations` (`adminPool`), LIMIT 500 | per-org `attemptOne` writes as stage 6 | per-integration cap = `rate_limit_per_min × (interval/60 s)`. |
| **sweeper: reaper** `reaper.ts:21-76` | `organizations` (`status='active'`) via `adminPool`; per-org `calls ⨝ recordings` older than `retention_days`, LIMIT 500 | S3 delete; `DELETE` from `transcripts`, `ai_outputs`, `call_facts`, `crm_sync_log`, `recordings`, then `calls`; `DELETE FROM leads WHERE last_activity_at < …`; `audit_log` | S3 delete failure is swallowed (`.catch(() => undefined)`) — the DB row goes and the object leaks. **Suspended/churned orgs are never reaped**, so their data is retained indefinitely. |

---

## 5. Feature-to-data matrix (top 6 of `09_FEATURE_CATALOGUE.md`'s build order)

### 1 — §5.1 Real speaker diarization

| need | supplied by | missing |
|---|---|---|
| per-turn speaker labels | `transcripts.segments` jsonb — `[{speaker, text, intent, startMs, endMs}]` written at `pipeline.ts:308` | nothing holds *how* the speaker was determined. `transcripts.engine` names the ASR model only. |
| "was this really two-sided?" | `transcripts.diarized` bool — but it is set to `speakers.size >= 2 \|\| t.diarized` (`pipeline.ts:315`), i.e. **true whenever the LLM invented a second speaker** | a `diarization_source` column (`provider` / `llm_text` / `none`) and a per-turn confidence. Neither exists. |
| channel cross-check | `calls.audio_source_used` (written at `calls.controller.ts:162`, format `SOURCE@RATE`) and `devices.capture_capability` (`FULL_DUPLEX` / `NEAR_END_ONLY` / `SPEAKER_REQUIRED` / `UNSUPPORTED`) | nothing joins them. A `NEAR_END_ONLY` handset producing `diarized=true` is a provable fiction today and no query makes that assertion. |
| per-segment confidence | **`transcripts.confidence` exists and is never written** (§2.4); `TranscriptSegment.confidence` in `entities.ts:58` is optional and never populated | both. |

### 2 — §3.1 Recording assurance SLA

| need | supplied by | missing |
|---|---|---|
| handset health history | **`device_health` — fully populated and read by nothing** (§2.2). `battery_opt_exempt`, `accessibility_enabled`, `battery_level`, `pending_uploads`, `free_storage_mb`, `last_upload_at`, indexed `(device_id, ts DESC)` | only the read path. This feature is ~80% pre-built and invisible. |
| capture success rate | `calls.audio_source_used` + `devices.capture_capability` + `device_health.pending_uploads` | no "expected call" signal. Nothing records a call the OS placed that the app failed to capture — `calls` only has rows for recordings that *arrived*. The denominator of the SLA does not exist in the schema. |
| build/OS correlation | `devices.os_version`, `devices.app_version` — **read but never written** (§2.3) | the write path. Two `ALTER`-free fixes: populate them at enrollment (`devices.controller.ts:88`) or at telemetry (`device-telemetry.controller.ts:63`). |
| per-handset failure taxonomy | `device_health.failure_counts` jsonb — **exists, never written** | the write. |

### 3 — §1.1 Objection & VoC intelligence

| need | supplied by | missing |
|---|---|---|
| per-call objection/competitor fields | The generic mechanism is complete: define an agent with `field_schema = {"fields":[{"key":"objection_type","type":"enum","enumValues":[…]}, …]}` → `ai_outputs.output` + one `call_facts` row per filled field, indexed by `call_facts_kv (org_id, field_key, value_text)`. | nothing structural. This is an agent template plus a rollup query. |
| aggregation | `call_facts (org_id, field_key, value_text)` is exactly the right index for `GROUP BY value_text WHERE field_key='objection_type'` | no materialised view; a `mv_objections_weekly` is new. Also `call_facts` has **no `started_at`**, so any time-bucketed rollup must join `calls` — and see §3.2 #4, that join has no supporting index. |
| join to outcome | `leads.status` (`open`/`won`/`lost`) and `leads.stage_changed_at` | `leads` links to calls only via `first_call_id`/`last_call_id` (both `ON DELETE SET NULL`). There is **no** call→lead join table, so "objections on lost deals" needs `calls.remote_number_hash = leads.contact_number_hash` scoped by `workspace_id` — supported by `calls_workspace_number_hash`. Workable, but it is a hash join, not a foreign key. |
| **hard blocker** | — | **One active agent per workspace** (`pipeline.ts:341-345`, `instances.default_agent_id` unused — §2.1). A tenant cannot run their existing lead-extraction agent *and* an objection agent on the same call. Multi-agent routing is a prerequisite for this feature, not an optimisation. |

### 4 — §1.2 Price & quote intelligence

| need | supplied by | missing |
|---|---|---|
| quoted unit price | **No column holds it.** The tenant's agent schema puts it in `call_facts` as a dynamic key — for RD Interlock the doc names `cost_per_brick` / `cost_per_unit`, with `brick_quantity` and `total_budget`. It lands in `call_facts.value_num` when `field.type === 'number'` (`pipeline.ts:409`), otherwise in `value_text`. | a per-tenant declaration of *which* key is the price. `agents.lead_rules.valueField` names the **deal value**, not the unit price, and there is no `priceField`. Without one, the rollup has to be configured per tenant outside the schema. |
| deal value | `leads.value_num` — **already holds this**, written from `qualifyLead().valueNum` (`leads.ts:146`) which is `Number(facts[rules.valueField])` | nothing. |
| win/loss outcome | `leads.status` + `leads.stage` + `leads.stage_changed_at` | nothing. |
| per-telecaller split | `leads.telecaller_device_id` (indexed) — **but see §2.2**: `leads.telecaller_id`, the reassignment-proof identity, is written and never read. Building this feature on `telecaller_device_id` re-creates the exact bug 0017 was written to fix. | Dev work: switch the reads to `telecaller_id`. |
| unit normalisation | nothing | `call_facts.value_num` is a bare `numeric` with no unit column. ₹32/brick and ₹3 200/1 000-bricks are indistinguishable. |

### 5 — §2.2.1 WhatsApp post-call summary

| need | supplied by | missing |
|---|---|---|
| the summary text | `transcripts.intelligence->>'summary'` — already extracted at `leads.ts:95` into `leads.summary` | nothing. |
| a number to send to | **`calls.remote_number_full`, and only when `organizations.store_full_number = true`** (0011). Default is `false`, so for a default tenant the schema holds a 5-digit prefix, the last 3, and an HMAC — **not a dialable number**. `contact.masked` in `crm-dispatch.ts:240` is `"98765…321"`. | the opt-in has to be set per tenant before this feature can work at all, and it is **not retroactive** — historical calls have no digits to recover. |
| delivery state | nothing | no `notifications` / `messages` table. `crm_sync_log` is the closest analogue and is keyed `(call_id, integration_id)` against `crm_integrations`, so a WhatsApp channel would either need a fake integration row or a new table. |
| opt-out / consent | `organizations.consent_policy` covers *recording* consent, not messaging consent | a separate flag. Sending a WhatsApp message to a number captured under `consent_policy='tone'` is a different legal basis. |

### 6 — §1.5 Commitment tracking

| need | supplied by | missing |
|---|---|---|
| commitments as text | `transcripts.intelligence->'action_items'` — a `string[]`, populated on every analysed call (`pipeline.ts:302`, shape from `llm/src/index.ts:174`) | it is free text with no owner, no due date, no status. |
| structured commitments | agent-template route: `{"key":"commitment_text","type":"string"}`, `{"key":"commitment_due","type":"datetime"}`, `{"key":"commitment_owner","type":"enum","enumValues":["agent","customer"]}` → `call_facts` | `call_facts` PK is `(call_id, field_key)` — **one value per key per call**. A call containing three commitments cannot be represented. This feature genuinely needs a new `commitments` table (which the catalogue already says). |
| "was it kept?" | nothing | needs the new table plus a resolution sweep. Note the RLS trap: a new `commitments (org_id, …)` table added without the policy loop **passes `verify-rls.js` today** (§3.1). This is precisely why Dev D's work must land before Stage 5. |
| notification path | `crm_sync_log` retry/backoff shape is reusable as a pattern | no generic outbox; `crm_sync_log` is CRM-specific. |

---

## 6. Per-developer guidance

### Dev A — API security (`apps/api/**`)

**Which tables the admin key can currently reach.** `AdminKeyGuard` (`admin-key.guard.ts:36-71`)
mints a synthetic `platform_admin` principal with `recordingsListen: true`,
`recordingsExport: true`, `viaAdminKey: true`. It is applied on **20 controllers** — effectively
every non-device route: `admin`, `agents`, `analytics`, `search`, `apikeys`, `auth`, `billing`,
`calls`, `notes`, `crm`, `devices`, `instances`, `leads`, `owner`, `owners`, `erasure`, `members`,
`tenancy`, `workspaces`. Through them the key reaches **all 21 org-scoped tables plus
`organizations` and `users`**, for **any tenant**, because `x-org-id` is trusted (`:38-50` only
checks the org *exists*, via `OrgRegistryService`). It also reaches the two `@CrossTenant()`
surfaces — `admin.controller.ts:48` (tenant provisioning + the platform tenant list) and
`analytics.controller.ts:85` (cross-tenant rollup) — which query on `adminPool()` and bypass RLS
entirely. **The default value `"dev-admin-key"` at `admin-key.guard.ts:36` is therefore the single
credential protecting every customer's data.** (`erasure.controller.ts:97` has the same shape for
`JWT_SECRET ?? "dev-jwt-secret-change-me"`, and `device-auth.guard.ts:33` for the device JWT.)

**`organizations.status` values: exactly three** — `'active'`, `'suspended'`, `'churned'`
(CHECK, `0001_init.sql:24-25`). Default `'active'`. Where it is enforced:
- `calls.controller.ts:131` — ingest rejects unless `org_status === 'active'` **and**
  `device_status === 'active'`.
- `devices.controller.ts:210` — `recordingEnabled` is false unless org is `'active'`.
- `reaper.ts:23` — **only `'active'` orgs are reaped**, so a suspended tenant's data is retained
  past its own `retention_days`. Fix belongs to whoever owns the worker, not you — but note it.
- **`AuthService.login()` (`auth.service.ts:45-82`) does NOT check org status.** It checks
  `users.status !== 'active'` only. A user in a `suspended` or `churned` org can still obtain a
  session token and read every tenant-scoped endpoint. `contextFor` returns `orgStatus`
  (`:119`) and leaves the decision to the caller. When you add the fail-fast env assertion, add
  an org-status assertion in the same pass — it is the same class of bug.

**What a request with no org can legitimately do.** Only two routes: `@CrossTenant()` on
`admin.controller.ts:48` and `analytics.controller.ts:85` (plus `auth.controller.ts:65,75`).
`admin-key.guard.ts:46` deliberately allows an absent `x-org-id` for exactly these. Everything
else goes through `TenantGuard`, and `tenant.guard.ts:102` already throws if `@OrgId()` is used
without it. **Do not tighten the missing-header case into a hard 400** — you will break tenant
provisioning and the platform rollup.

**Two `throttler` targets you should size from data, not guesswork.** `AuthService.login` and
`/v1/auth/context` both seq-scan `users` on `lower(email)` (§3.2 #9). `/v1/auth/context` is called
on **every owner-console render** (`owner-context.ts:103`). Rate-limiting it is protecting an
unindexed query, not just an endpoint.

**Do not add a NOT NULL or a CHECK to `calls.status` while you are in there.** The constraint is
already correct (§3.5); the mismatch is in `packages/shared/src/enums.ts`, which is Dev C's blast
radius, not yours.

### Dev B — Web security (`apps/web/**`)

**What `memberships` actually contains.** One row per `(user_id, scope_type, scope_id)` —
`UNIQUE`, so a user can hold both an `org`-scoped and a `workspace`-scoped membership in the same
org. Columns that matter to you: `role`, `owner_role`, `recordings_listen`, `recordings_export`.

**Legal `role` values (CHECK, `0001_init.sql:64-65`) — exactly five:**
`'platform_admin'`, `'org_admin'`, `'workspace_admin'`, `'workspace_member'`, `'viewer'`.
`members.controller.ts:20` says "these four roles" and its `Role` zod omits `platform_admin`;
the DB allows it. **Every membership the owner console has ever created is `'org_admin'`** —
`OWNER_ROLE = "org_admin"` at `owners.controller.ts:29`, and nothing else writes that value
(0018's backfill relies on exactly this).

**Legal `owner_role` values (CHECK, 0018) — `NULL` or one of three:**
`'owner'`, `'manager'`, `'telecaller'`. Mirrored by `OwnerRole` in `packages/shared/src/roles.ts:9`.
**Three traps:**
1. `resolveOwnerRole` (`roles.ts:20-23`) maps `null`/invalid → **`'owner'`**, the most permissive
   persona. `owner-context.ts:119` applies it to every membership. So a membership with
   `owner_role IS NULL` renders as a full Owner. 0018 backfilled `role='org_admin'` → `'owner'`,
   so today every real row has a value — but any row created by `members.controller.ts:92`
   (which never sets `owner_role`) is NULL and silently becomes an Owner.
2. `owner_role` and `role` are **deliberately independent** (0018's header). `members.controller.ts:127`
   `UPDATE memberships SET role = COALESCE($2, role) … WHERE user_id = $1` — **no `org_id` and no
   scope filter**. It updates *every* membership that user holds, in every org. That is a
   cross-tenant write reachable from the operator console. It is outside your partition; report
   it, do not fix it.
3. `OwnerRoleGuard` fails open for admin-key callers with no asserted persona
   (`owner-role.guard.ts:41`). The web tier asserts one via `x-caller-owner-role`
   (`owner-context.ts:167` → `apiGetAs`), so real console traffic is checked; anything else is not.

**What `users.sso_subject` holds.** The Supabase Auth **subject** (`user.id` from
`getSessionUser()`), written at `owners.controller.ts:140-144` with
`sso_subject = COALESCE(users.sso_subject, EXCLUDED.sso_subject)` — i.e. **write-once, never
rotated**. It is `UNIQUE` and nullable. It is the *only* link between a browser session and a
tenant. `AuthService.contextFor` (`auth.service.ts:106-115`) matches on `sso_subject` first and
falls back to `lower(email)`, ordered `(sso_subject = $1) DESC NULLS LAST`. **That email fallback
is a real attack surface**: a Supabase account whose email happens to equal a provisioned owner's
email resolves to that owner's membership even with a different subject. Not yours to fix, but do
not build anything that widens it.

**`isOperator` today (`owner-context.ts:143-147`) fails OPEN:**
```ts
if (!principal || principal.kind !== "operator") return false;
if (OPERATOR_EMAILS.length === 0) return true;      // ← unset env ⇒ everyone is an operator
```
`PLATFORM_OPERATOR_EMAILS` is unset by default. Combined with `getPrincipal`'s no-auth branch
(`:78-96`), which returns `kind: "operator"` with `membership.orgId = DEV_ORG_ID` and
`ownerRole: "owner"` when `AUTH_ENABLED` is false, **an unauthenticated request in that
configuration is a full platform operator pinned to `DEV_ORG_ID`.** Inverting this to fail closed
is your item; the data fact you need is that **`DEV_ORG_ID` defaults to the literal
`"00000000-0000-4000-8000-000000000001"`** (`server-api.ts:10`) — the exact id `seed.js:11` gives
"Dev Org". In production that id may or may not name a live tenant; `server-api.ts:24` already
warns about it. Do not assume it is inert.

**Typed API results.** The zod shapes in `packages/shared/src/entities.ts` are **not safe to
validate live rows against**: `Call.status` uses `CallStatus`, which is missing
`TRANSCRIPTION_OFF`; `Call.crmSyncStatus` uses `CrmSyncStatus`, missing `'dead'` (§3.5). Both
values occur in production data. If you introduce runtime parsing of API results, either fix
`enums.ts` first (coordinate with Dev C, who owns that file's test coverage) or type-only the
results.

**`memberships.orgStatus` in `owner-context.ts:125`:** `memberships.find(m => m.orgStatus ===
'active') ?? memberships[0] ?? null` — a user whose only membership is in a `suspended` org still
gets a `membership`, hence `kind: "owner"`, hence a rendered console. The legal values are the
three in §6.A.

### Dev C — Tests (first unit tests in this repo)

**The pure functions worth testing** — no DB, no fetch, no node builtins, all already exported:

| function | file | why |
|---|---|---|
| `qualifyLead` | `packages/shared/src/leads.ts:138` | decides whether a call becomes a lead. Highest-consequence pure function in the repo. |
| `isFilled` | `leads.ts:111` | the "did the call say anything" predicate. |
| `parseLeadRules` / `parseLeadStages` | `leads.ts:99` / `:54` | must fall back, never throw. |
| `entryStage` / `statusForStage` | `leads.ts:65` / `:60` | board semantics. |
| `mergeFacts` | `leads.ts:178` | must never blank an established fact. |
| `resolveOwnerRole` | `packages/shared/src/roles.ts:20` | fails open to `'owner'` — pin that behaviour so a later "fix" is a conscious decision. |
| `validateExtraction` / `compileToJsonSchema` | `packages/shared/src/extraction.ts:81` / `:43` | |
| `isAbsent` | `apps/worker/src/pipeline/pipeline.ts:79` (module-private — export it or test via `runPostAsrStages`) | the `"null"`-named-contact bug guard. |
| `retryBackoffSeconds` | `pipeline.ts:44` | `30·4^(n-1)` capped at 3600. |
| `reasonOf` | `pipeline.ts:88` | 500-char truncation with `…`. |
| `leadTitle` | `apps/worker/src/pipeline/leads.ts:57` | |
| `confidenceScore`, `mapFields`, `mapPayload` | `apps/worker/src/pipeline/crm-dispatch.ts:89`, `:283` | |
| `AuthService.hashPassword` / `verifyPassword` | `apps/api/src/modules/auth/auth.service.ts:25`, `:31` | static, no DB. |

**⚠ Do not source legal values from `packages/shared/src/enums.ts`. It is wrong.** `CallStatus`
omits `TRANSCRIPTION_OFF`; `CrmSyncStatus` omits `'dead'`. Source from the CHECK constraints:

```ts
// calls.status — 0014_transcription_toggle.sql (the effective constraint)
export const CALL_STATUSES = [
  "AWAITING_AUDIO", "UPLOADED", "TRANSCODING", "TRANSCRIBING",
  "ANALYZING", "SYNCING", "COMPLETE", "TRANSCRIPTION_OFF",
  "FAILED_TRANSCODE", "FAILED_ASR", "FAILED_ANALYZE", "FAILED_CRM",
] as const;
// …of which the worker can only ever WRITE these ten:
//   AWAITING_AUDIO UPLOADED TRANSCODING TRANSCRIBING ANALYZING SYNCING
//   COMPLETE TRANSCRIPTION_OFF FAILED_ASR FAILED_ANALYZE
// FAILED_TRANSCODE and FAILED_CRM are unreachable (see 11_DATA_INVENTORY §3.5).

export const CRM_SYNC_STATUSES = ["pending", "synced", "failed", "dead"] as const;  // 0008
export const LEAD_STATUSES     = ["open", "won", "lost"] as const;                  // 0010
export const CALL_DIRECTIONS   = ["incoming", "outgoing"] as const;                 // 0001
export const CONSENT_STATUSES  = ["not_required", "played", "failed", "pending"] as const;
export const CONSENT_POLICIES  = ["none", "tone", "tone_and_tts", "prohibited"] as const;
export const ON_CONSENT_FAILURE= ["record_and_flag", "do_not_record"] as const;
export const ORG_STATUSES      = ["active", "suspended", "churned"] as const;
export const USER_STATUSES     = ["active", "disabled"] as const;
export const DEVICE_STATUSES   = ["active", "logged_out", "wiped", "lost"] as const;
export const CAPTURE_CAPABILITIES = ["FULL_DUPLEX","NEAR_END_ONLY","SPEAKER_REQUIRED","UNSUPPORTED"] as const;
export const MEMBER_ROLES      = ["platform_admin","org_admin","workspace_admin","workspace_member","viewer"] as const;
export const OWNER_ROLES       = ["owner", "manager", "telecaller"] as const;       // 0018, or NULL
export const TELECALLER_STATUSES = ["active", "archived"] as const;                 // 0017
export const VALIDATION_STATUSES = ["valid", "repaired", "failed"] as const;        // ai_outputs
export const CRM_AUTH_TYPES    = ["none","bearer","header","header_prefix","basic","query"] as const; // 0009
export const CRM_METHODS       = ["POST", "PUT", "PATCH"] as const;                 // 0009
export const CRM_INTEGRATION_STATUSES = ["connected", "disconnected", "error"] as const;
export const ASR_MODES         = ["transcribe","translate","verbatim","translit","codemix"] as const; // 0016, or NULL
export const ASR_LANGUAGES     = ["unknown","en-IN","hi-IN","bn-IN","kn-IN","ml-IN","mr-IN","od-IN",
  "pa-IN","ta-IN","te-IN","gu-IN","as-IN","ur-IN","ne-IN","kok-IN","ks-IN","sd-IN","sa-IN",
  "sat-IN","mni-IN","brx-IN","mai-IN","doi-IN"] as const;                           // 0016, or NULL
export const MEMBERSHIP_SCOPE_TYPES = ["org", "workspace"] as const;
export const USAGE_KINDS_ACTUALLY_WRITTEN = ["asr_seconds","llm_tokens_in","llm_tokens_out"] as const;
```

**Real fixture shapes.**

`agents.field_schema` — parsed by `ExtractionSchema` at `pipeline.ts:354`. Keys must match
`/^[a-z][a-z0-9_]*$/`, max 64 chars, max 64 fields. This is the RD Interlock Brick shape named in
`09_FEATURE_CATALOGUE.md:68` and `10_LANDING_PAGE_PLAN.md:121`:

```json
{
  "fields": [
    { "key": "customer_name",  "type": "string",   "description": "Caller's name as stated",        "required": false },
    { "key": "place",          "type": "string",   "description": "Delivery location",              "required": false },
    { "key": "brick_type",     "type": "enum",     "description": "Product asked for",              "required": false,
      "enumValues": ["solid", "hollow", "paver", "unknown"] },
    { "key": "brick_quantity", "type": "number",   "description": "Units requested",                "required": false,
      "validation": { "min": 0, "max": 10000000 } },
    { "key": "cost_per_brick", "type": "number",   "description": "Quoted unit price in INR",       "required": false },
    { "key": "total_budget",   "type": "number",   "description": "Total budget in INR",            "required": false },
    { "key": "follow_up",      "type": "boolean",  "description": "Caller asked to be rung back",   "required": false },
    { "key": "quotation_date", "type": "datetime", "description": "Date a quote was promised",      "required": false },
    { "key": "objections",     "type": "string[]", "description": "Objections raised",              "required": false }
  ]
}
```

`agents.lead_rules` — parsed by `parseLeadRules`. **`{}` is the production default** and is what
every real row holds today; `LeadRules.parse({})` yields:

```json
{ "requiredFields": [], "anyFields": [], "minFilled": 1,
  "allowFailedValidation": false }
```
(`titleField` and `valueField` are `.optional()` — **absent, not null**.) A configured example:
```json
{ "requiredFields": ["customer_name"],
  "anyFields": ["brick_quantity", "total_budget"],
  "minFilled": 2,
  "titleField": "customer_name",
  "valueField": "total_budget",
  "allowFailedValidation": false }
```

`organizations.lead_stages` — the 0010 default, byte-for-byte, and identical to
`DEFAULT_LEAD_STAGES` (`leads.ts:35-42`). `LeadStages` requires 1–16 entries, `key` matching
`/^[a-z][a-z0-9_]*$/` max 40, `label` 1–60, `terminal` optional ∈ `won|lost`:

```json
[ {"key":"new","label":"New"},
  {"key":"contacted","label":"Contacted"},
  {"key":"qualified","label":"Qualified"},
  {"key":"negotiation","label":"Negotiation"},
  {"key":"won","label":"Won","terminal":"won"},
  {"key":"lost","label":"Lost","terminal":"lost"} ]
```
`entryStage()` on this returns `"new"`. Also fixture a **renamed** tenant list — that is the whole
point of the column — e.g. `[{"key":"enquiry","label":"Enquiry"},{"key":"order_placed",
"label":"Order Placed","terminal":"won"}]`, where `entryStage()` must return `"enquiry"` and
`statusForStage(…, "order_placed")` must return `"won"`.

`transcripts.segments` — **two different shapes live in this column.** Test both.
*After ASR* (`persistTranscript`, `pipeline.ts:212`, from `AsrResult.segments`):
```json
[ {"speaker":"S1","text":"Hello, RD Interlock?","startMs":0,"endMs":1450},
  {"speaker":"S2","text":"ஆமா சொல்லுங்க","startMs":1450,"endMs":2900} ]
```
*After the intelligence pass* (`pipeline.ts:284-292`) — `speaker` is rewritten to
`Agent`/`Customer`, an `intent` key is **added**, and `startMs`/`endMs` fall back to `0` for any
turn the analyser re-split:
```json
[ {"speaker":"Agent","text":"Hello, RD Interlock?","intent":"greeting","startMs":0,"endMs":1450},
  {"speaker":"Customer","text":"ஆமா சொல்லுங்க","intent":"acknowledgement","startMs":1450,"endMs":2900},
  {"speaker":"Customer","text":"Rate enna?","intent":"price_enquiry","startMs":0,"endMs":0} ]
```
Note `entities.ts:53-59` `TranscriptSegment` models neither shape exactly (it has no `intent`, and
`confidence` is never written). Do not validate against it.

`transcripts.intelligence` — written at `pipeline.ts:294-303`, exactly these eight keys, never
more, never fewer. `sentiment` is coerced to `neutral` unless the model said `positive`/`negative`
(`llm/src/index.ts:587-588`); `outcome` is free text defaulting to `"other"` (`:598`) with the
prompt suggesting `interested|not_interested|follow_up|callback|no_answer|wrong_number|other`
(`llm/src/index.ts:403`) — **so do not fixture `outcome` as a closed enum**:
```json
{ "summary": "Customer asked the rate for 5000 solid bricks for delivery to Ambattur. Agent quoted ₹32 and promised a written quote today.",
  "overall_intent": "price_enquiry",
  "customer_intent": "wants a bulk quote for solid bricks",
  "agent_intent": "qualify and quote",
  "sentiment": "positive",
  "outcome": "follow_up",
  "key_points": ["5000 units", "delivery to Ambattur", "quoted ₹32/unit"],
  "action_items": ["Send written quotation today"] }
```
Also fixture the **empty** case, which is what a failed or silent call produces
(`llm/src/index.ts:318-324`): every string `""`, `sentiment: "neutral"`, `outcome: "unknown"`,
both arrays `[]`. And the **NULL** case — `intelligence` is nullable and is NULL for every call
that predates 0005 or whose intelligence pass threw (it is swallowed at `pipeline.ts:334`).
`leads.ts:95` reads `t.intelligence ->> 'summary'`, which is NULL-safe; your test must prove
`upsertLead` still qualifies a lead when `summary` is NULL.

`call_facts` rows for the extraction above — note **`value_text` is NULL for number and boolean
fields** and the value goes in the typed column (`pipeline.ts:404-410`), and that
`string[]` is stored as **`JSON.stringify`d text**, not an array:

| org_id | call_id | field_key | value_text | value_num | value_bool |
|---|---|---|---|---|---|
| … | … | `customer_name` | `Rajesh` | NULL | NULL |
| … | … | `brick_quantity` | NULL | `5000` | NULL |
| … | … | `cost_per_brick` | NULL | `32` | NULL |
| … | … | `follow_up` | NULL | NULL | `true` |
| … | … | `objections` | `["price too high","delivery slow"]` | NULL | NULL |

The `facts` object `qualifyLead` actually receives is the jsonb built by
`leads.ts:95-98` — `COALESCE(to_jsonb(value_num), to_jsonb(value_bool), to_jsonb(value_text))`,
so **numbers come back as JSON numbers and booleans as JSON booleans**, and a `string[]` comes
back as the *string* `'["price too high","delivery slow"]'`:
```json
{ "customer_name": "Rajesh", "brick_quantity": 5000, "cost_per_brick": 32,
  "follow_up": true, "objections": "[\"price too high\",\"delivery slow\"]" }
```
`isFilled` (`leads.ts:113`) explicitly treats the string `"[]"` as **not** filled — test that.

**Non-obvious behaviours your tests must pin (each is a real bug the code already guards):**
1. `qualifyLead({}, "valid", DEFAULT_LEAD_RULES)` → `qualified: false`,
   `reason: "only 0 field(s) extracted, 1 required"`. A wrong number must never become a lead.
2. `qualifyLead(facts, "failed", DEFAULT_LEAD_RULES)` → false,
   `"extraction failed validation"` — **even when facts are full**.
   With `allowFailedValidation: true` → true.
3. `validationStatus === "repaired"` qualifies. Only `"failed"` blocks.
4. `isFilled(" ")` → false; `isFilled("[]")` → false; `isFilled([])` → false; `isFilled(0)` →
   **true**; `isFilled(false)` → **true**. A quantity of 0 and a `follow_up: false` are answers.
5. `qualifyLead` with `valueField` naming a **string** field → `valueNum: null` (guarded by
   `Number.isFinite`), and `Number("")` is `0` — but `isFilled("")` is false, so it short-circuits.
   Test `valueField` pointing at `"abc"` → `null`, not `NaN`.
6. `mergeFacts({budget: 50000}, {quantity: 200})` keeps `budget`. `mergeFacts({budget: 50000},
   {budget: null})` **keeps 50000**. This is the follow-up-call bug 0010 exists to prevent.
7. `parseLeadStages(null)` / `parseLeadStages([])` / `parseLeadStages("garbage")` →
   `DEFAULT_LEAD_STAGES`, never a throw. Same for `parseLeadRules(undefined)`.
8. `entryStage([{key:"won",label:"Won",terminal:"won"}])` → `"won"` (the `?? stages[0]` fallback
   when every stage is terminal).
9. `resolveOwnerRole(null)` → `"owner"`; `resolveOwnerRole("admin")` → `"owner"`;
   `resolveOwnerRole("telecaller")` → `"telecaller"`. **Pin the fail-open**, and add a comment
   pointing at `roles.ts:14-19` so the next reader knows it is deliberate.
10. `isAbsent("null")` / `"N/A"` / `"not_discussed"` / `""` → true; `isAbsent("none of the
    above")` → **false**. The full token list is `pipeline.ts:60-77` — 16 entries, matched
    case-insensitively after `.trim()`.
11. `retryBackoffSeconds(1)=30`, `(2)=120`, `(3)=480`, `(4)=1920`, `(5)=3600` (capped),
    `(0)=30` (the `Math.max(0, …)` guard).
12. `reasonOf(new Error("x".repeat(600)))` → 501 chars ending `…`. `reasonOf(new Error(" "))` →
    `"unknown error"`.
13. `leadTitle(null, null, "98765", "321")` → `"98765…"`; `leadTitle(null,null,null,"321")` →
    `"…321"`; `leadTitle(null,null,null,null)` → `"Unknown caller"`; a 300-char name is sliced
    to 200.
14. `validateExtraction` against an `enum` field whose `enumValues` is absent → the value can
    never validate (`extraction.ts:112` → `(field.enumValues ?? [])`). That is a real footgun in
    tenant config; pin it so it is visible.

**Fixture identity values** (from `packages/db/seed.js`, version-4-shaped because zod 4's
`.uuid()` checks version bits — **do not use `00000000-0000-0000-0000-000000000000`, it fails
validation**):
`org` `00000000-0000-4000-8000-000000000001` · `workspace` `00000000-0000-4000-8000-000000000002`
· `user` `00000000-0000-4000-8000-000000000003` · membership
`('org', <org_id>, 'org_admin', listen=true, export=true)` — and note `seed.js` **does not set
`owner_role`**, so that row resolves to `'owner'` via the fail-open in item 9.
`password_hash` format: `scrypt$<32-hex-salt>$<64-hex-hash>` (`auth.service.ts:25-29`).

**Do not write tests that connect to Postgres or S3.** Everything above is pure. `withOrgContext`
requires a live pool; `upsertLead`, `buildSourceDocument` and `enqueueDispatch` all take a
`DbClient` you can hand a fake `{ query }` to — that is the seam, and it is already exported
(`crm-dispatch.ts` `DbClient`).

### Dev D — CI / tooling (owns `packages/db/verify-rls.js`)

**What the current script proves.** Six assertions across **four** tables: `workspaces` (1–3),
`organizations` (4), `telecallers` (5), `audit_log` (6). Seventeen of the 21 org-scoped tables are
untested, and — more importantly — the script is a **hand-kept list**, so a table added without a
policy passes.

**The exact list of tables carrying `org_id` (21), for the rewrite:**

```
agents            ai_outputs        api_keys          audit_log         call_facts
call_notes        calls             crm_integrations  crm_sync_log      device_health
devices           enrollment_tokens instances         leads             memberships
recordings        sessions          telecallers       transcripts       usage_events
workspaces
```

**Do not hard-code that list.** Derive it, and assert the derivation:

```sql
-- Every table in `public` with an org_id column…
SELECT c.table_name
  FROM information_schema.columns c
  JOIN information_schema.tables t
    ON t.table_schema = c.table_schema AND t.table_name = c.table_name
 WHERE c.table_schema = 'public'
   AND c.column_name  = 'org_id'
   AND t.table_type   = 'BASE TABLE';

-- …must each have RLS enabled AND forced…
SELECT relname, relrowsecurity, relforcerowsecurity
  FROM pg_class
 WHERE relnamespace = 'public'::regnamespace AND relkind = 'r';

-- …and an org_isolation policy with both USING and WITH CHECK.
SELECT tablename, policyname, qual, with_check
  FROM pg_policies WHERE schemaname = 'public';
```

The check is a set difference: `{tables with org_id}` minus `{tables where relrowsecurity AND
relforcerowsecurity AND a policy exists}` must be **empty**. Fail the build with the offending
names, not a count.

**Four things the naive version will get wrong:**
1. **`organizations` is a special case.** It has no `org_id` column and its policy is named
   `org_self`, keyed on `id`, not `org_id`. It must be asserted separately, not skipped, and not
   expected to be named `org_isolation`.
2. **`users` and `schema_migrations` legitimately have no `org_id`.** They must be an explicit,
   commented allowlist — otherwise the next person adds a table to that allowlist to make CI
   green. Better: assert `users` is *unreachable* by `aura_app` in a future hardening pass, and
   for now assert only that it is on a two-entry allowlist so growing it requires an edit someone
   reviews.
3. **`relforcerowsecurity` is the load-bearing flag, not `relrowsecurity`.** The migration owner
   (`postgres` on Supabase) owns these tables and would bypass a merely-enabled policy. 0007's
   loop sets FORCE only for tables already in `pg_policies` — so a policy-less table has
   `relrowsecurity = false` *and* `relforcerowsecurity = false` and looks like a normal
   non-tenant table. Your check is the only thing that would catch it.
4. **Verify the policy has a `WITH CHECK`, not just a `USING`.** A `USING`-only policy blocks
   cross-tenant reads and silently permits cross-tenant **writes**. All 21 today have both
   (`0001_init.sql:339-342` and the copies in 0003/0004/0010/0017), so this is a regression guard,
   not a current fix.

**Also worth adding while you are in this file:**
- Assert `usage_events` and `audit_log` are UPDATE/DELETE-denied for `aura_app` (the script covers
  `audit_log` at assertion 6; `usage_events` has the same REVOKE in 0001 and 0007 and is untested).
- Assert the two CHECK constraints that the TypeScript disagrees with (§3.5), so the drift in
  `packages/shared/src/enums.ts` becomes a CI failure rather than a latent one:
  `calls_status_check` must contain `TRANSCRIPTION_OFF`; `crm_sync_log_status_check` must contain
  `dead`.
- The script currently seeds with `DELETE FROM organizations WHERE name LIKE 'rls-test-%'` and
  runs against `DATABASE_URL`/`APP_DATABASE_URL` **whose defaults are localhost** — but a
  developer with production env vars exported would run destructive DELETEs against production.
  Add a hard refusal when the host is not in the local allowlist unless an explicit
  `RLS_TEST_ALLOW_REMOTE=1` is set. This is the highest-value guard in your partition.

---

## Appendix — reported outside this document's scope

Changes these findings imply that fall outside any single developer's partition, listed here rather
than made:

1. `members.controller.ts:127` — `UPDATE memberships SET role = … WHERE user_id = $1` with no
   `org_id` and no scope filter: a cross-tenant write from the operator console.
2. `packages/shared/src/enums.ts` — `CallStatus` missing `TRANSCRIPTION_OFF`, `CrmSyncStatus`
   missing `dead`.
3. `pipeline.ts:521-542` — the transcode stage has no `try/catch`; a throw strands the call in
   `TRANSCODING`, invisible to both sweepers.
4. `reaper.ts:23` — suspended and churned orgs are never reaped, so their data outlives their
   own `retention_days`.
5. `auth.service.ts:45-82` — `login()` does not check `organizations.status`.
6. `leads.controller.ts` — reads `telecaller_device_id` where 0017 intended `telecaller_id`, and
   the PATCH at `:262` lets the two diverge permanently.
7. Missing indexes, in priority order: `transcripts(call_id)`, `ai_outputs(call_id)`,
   `recordings(call_id)`, `calls(org_id, started_at DESC)`, `calls(status, updated_at)`,
   `agents(workspace_id, is_active)`, `users(lower(email))`.
8. `calls.device_id` is the only FK with no `ON DELETE` clause.
9. `audit_log.ip` is never written by any of the ~20 audit insert sites.
10. No `sessions` expiry sweep exists.
