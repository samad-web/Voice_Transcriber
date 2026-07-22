# Product Requirements Document — AI Call Intelligence Platform

**Version:** 2.0 (supersedes v1)
**Status:** Draft for review
**Changes from v1:** capability claims corrected against the as-built Android client;
scope split into phases; compliance elevated to a Phase-1 requirement; stack right-sized;
success metrics and open questions added.

---

## 1. Problem and vision

Sales and support teams make calls that contain the most valuable and least captured data in the
business: what the customer actually said. CRM records are written from memory, minutes after the
fact, if at all.

**Vision:** a platform that captures calls from Android handsets automatically, transcribes them,
extracts structured information defined by each customer, and writes it into their CRM — with no
per-customer engineering.

**What we are building:** an Android client for automatic call capture and secure upload, plus a
multi-tenant web platform for administration, AI configuration, review, and analytics.

---

## 2. Capability statement (read this before committing anything)

Android restricts third-party call audio capture. These constraints are platform-level and not
engineering-solvable. Sales, marketing, and contracts must reflect them.

| Capability | Reality | Product position |
|---|---|---|
| PSTN both-party audio | Works via `VOICE_CALL` on OEMs that permit it. **Device-dependent.** Verified on one handset to date. | Sell against a **certified device list**. Capability probe at enrollment classifies each device. |
| PSTN near-end only | Always available (mic capture), optionally with forced speakerphone to pick up the far end acoustically. | Documented fallback. Lower transcript quality. |
| VoIP audio (WhatsApp/Telegram/etc.) | **Not possible.** The OS grants the messenger exclusive mic access; the recorder receives digital silence. | **Not a feature.** We capture VoIP call *metadata* only. |
| Dual-channel / separate speaker streams | **Not exposed by Android.** Capture is mixed mono. | Speaker attribution delivered via **ASR diarization**, ~85–92% typical on telephony audio. Not compliance-grade. |
| Google Play distribution | Prohibited (accessibility-based recording). | **MDM / managed sideload only.** Enterprise sales motion. |

Any statement of work, demo, or pricing page that contradicts this table is a defect.

---

## 3. Users

| Persona | Needs | Primary surface |
|---|---|---|
| **Platform admin** (us) | Tenant lifecycle, global health, model routing, cost | Admin console |
| **Org admin** (customer IT/RevOps) | Users, workspaces, devices, agents, CRM, limits, compliance policy | Web platform |
| **Manager** | Team dashboards, transcript search, lead quality, coaching | Web platform |
| **Rep** (device holder) | Recording just works; no daily interaction; clarity on what's captured | Android app + web |
| **Call counterparty** | To know they're being recorded | Announcement tone/TTS |

The last persona is not decorative. They never consented to a contract with us, and their data is
the majority of what we process. Product decisions that ignore them create legal exposure.

---

## 4. Scope by phase

### Phase 1 — Foundation (target: production-ready single-CRM offering)

**Android client**
- Enrollment via instance ID + QR token; hardware-backed device identity (Android Keystore)
- Device JWT auth with nonce-signature refresh
- PSTN recording (existing), retuned to 16 kHz mono for ASR and bandwidth
- Capture capability probe reported at enrollment and per call
- VoIP call **metadata** capture via the existing accessibility detection (no audio)
- AES-256-GCM encryption at rest; TLS pinning; `allowBackup=false`
- Resumable background upload (WorkManager + presigned S3 multipart) with backoff, checksum
  confirmation, and local deletion policy
- Remote configuration sync (versioned document; server policy overrides local settings)
- Consent announcement (tone / TTS) enforced by server policy
- Device health telemetry
- Remote logout and wipe via FCM

**Platform**
- Org / workspace / instance / device hierarchy; RBAC with separate `recordings:listen` and
  `recordings:export` permissions
- Ingest → transcode → ASR (+diarization) → agent analysis → storage pipeline
- Agent builder: system prompt, dynamic extraction fields, classification labels, lead score
- Model provider layer with BYO-key support and cost metering
- Transcript search, playback with timestamp navigation, notes
- One CRM connector (**HubSpot**) plus generic REST/webhook
- Usage metering and limit enforcement
- Consent policy engine, retention reaper, erasure workflow, audit log
- Core analytics: call volume, recording success rate, lead outcomes, device health

**Explicitly out of Phase 1:** Salesforce/Zoho/Dynamics connectors, sentiment analysis, real-time
processing, Elasticsearch, self-serve signup, iOS, on-device ASR, agent A/B testing.

### Phase 2 — Depth
Salesforce and Zoho connectors; sentiment and talk-ratio analytics; agent versioning diffs and
A/B testing; advanced dashboards; SSO/SCIM; data residency regions; public API + docs.

### Phase 3 — Scale
Self-serve onboarding and billing; Dynamics; OpenSearch; real-time/streaming transcription;
coaching and QA scorecards; on-device ASR for low-connectivity fleets.

---

## 5. Functional requirements

### 5.1 Capture (client)
- Start recording on OFFHOOK only; unanswered calls are never recorded.
- Probe audio sources in profile order; record which source won; report it.
- If no audio was captured (digital silence), discard the file, log the event, and report a
  capture failure — never upload an empty artifact.
- Persistent notification while recording. Non-dismissible, no covert mode. Non-negotiable.
- If the tenant's consent policy requires an announcement and it cannot be played, follow the
  tenant's `on_consent_failure` setting: `record_and_flag` or `do_not_record`.

### 5.2 Upload
- Recordings queue locally and survive reboot, app kill, and network loss.
- Upload constraints (network type, charging, time window) come from server config.
- Local file deleted only after server-confirmed checksum, then after the local retention window.
- Permanent upload failure raises a device health alert; it is never silent.

### 5.3 Processing
- Every call reaches a terminal state: COMPLETE or FAILED_{stage}. No call is lost or stuck.
- Failed stages are retryable and replayable from the admin console.
- AI output is validated against the agent's schema; one automatic repair attempt; failures are
  stored and flagged rather than discarded.
- Every AI output records the agent version, model, provider, tokens, and cost.

### 5.4 Agent configuration
- Admins define extraction fields (scalar, enum, array-of-scalar, one nesting level) without
  engineering involvement.
- Agents are versioned and immutable; editing creates a new version.
- Admins can test an agent version against a stored call before activating it.
- Field definitions drive the LLM schema, validation, storage projection, and UI columns from a
  single source.

### 5.5 Access and privacy
- Counterparty phone numbers stored hashed by default; plaintext is an explicit per-org opt-in.
- Every playback and export is audited with actor, time, and IP.
- Per-org retention window, enforced automatically.
- Subject erasure completes across database, object storage, search index, and (best-effort,
  logged) CRM copies, with a completion receipt.

---

## 6. Non-functional requirements

| Area | Requirement |
|---|---|
| Isolation | Postgres RLS on every tenant table; enforced at the connection role, not in app code |
| Availability | 99.5% API uptime (Phase 1); upload endpoint prioritized over web |
| Latency | Transcript available within 10 min of upload for p95 of calls ≤30 min |
| Durability | No acknowledged recording is ever lost; S3 versioning + Object Lock for the retention period |
| Scale target | 200 tenants, 5,000 devices, 50k calls/month without re-architecture |
| Security | Encryption in transit and at rest; hardware-backed device keys; envelope-encrypted provider keys; annual pen test |
| Cost | Per-call AI cost tracked and attributable; per-org hourly spend ceiling with alerting |
| Observability | Distributed trace per `call_id` across device and all pipeline stages |

**Terminology correction:** v1 said "end-to-end encryption." Because the platform performs ASR and
LLM analysis, it necessarily decrypts. The accurate claim is *"encrypted on device, in transit, and
at rest; decrypted only within the processing pipeline."* Do not market it as E2E.

---

## 7. Technical stack

| Layer | Phase 1 | Deferred |
|---|---|---|
| Backend | NestJS or FastAPI, modular monolith + worker pool | Service extraction |
| Database | PostgreSQL (RLS, JSONB, tsvector FTS) | Partitioning, read replicas |
| Cache/counters | Redis | — |
| Queue | SQS or RabbitMQ (one, not three) | Kafka |
| Object storage | S3-compatible, SSE-KMS | Multi-region |
| ASR | Whisper (self-hosted or API) + diarization | Streaming ASR |
| LLM | Provider layer over OpenAI / Gemini / Claude | Self-hosted models |
| Search | Postgres FTS behind a `SearchProvider` port | OpenSearch |
| Monitoring | OpenTelemetry + managed APM | Self-hosted Prometheus/Grafana |
| Web | React + TypeScript | — |

v1 of this PRD named Kafka *and* RabbitMQ *and* SQS, plus Elasticsearch and a self-hosted
metrics stack. Each is defensible at scale and each is a liability at launch. Add them against
measured limits.

---

## 8. Success metrics

| Metric | Target (6 months post-launch) |
|---|---|
| Recording success rate (calls captured / calls made, certified devices) | ≥95% |
| Upload success within 6 h | ≥99% |
| Transcript word error rate (certified devices, clean line) | ≤15% |
| Extraction field accuracy vs. human review | ≥85% on required fields |
| CRM sync success | ≥98% |
| Devices reporting healthy daily | ≥95% |
| AI cost per call | ≤ target margin threshold |
| Time from customer signup to first processed call | <1 day |

Recording success rate is the metric that decides whether the product is real. Instrument it before
anything else, segmented by device model.

---

## 9. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| OEM/Android update breaks `VOICE_CALL` capture on a certified device | **High** | Per-model success-rate monitoring with alerting; multi-source probe already falls back; maintain certified-device list actively |
| Consent/privacy enforcement action | **High** | Server-enforced announcement; DPA; hashed numbers; audit log; legal review before first customer |
| Agent engine scope sprawl | **High** | Hard constraints on schema expressiveness; fixed pipeline graph |
| LLM cost overrun on a large tenant | Medium | Per-org spend ceilings, concurrency limits, BYO-key default for enterprise |
| CRM connector maintenance burden | Medium | Ship one connector well plus generic webhooks; add connectors only with committed revenue |
| Sideload/MDM friction blocks deals | Medium | Documented MDM runbooks for Intune and Android Enterprise; pre-sales device certification |
| Diarization accuracy disappoints | Medium | Set expectations in the capability statement; voice enrollment per rep to improve assignment |

---

## 10. Open questions

1. **Which market first?** This determines the consent regime (India DPDP, EU GDPR, and US
   two-party-consent states impose materially different requirements) and therefore Phase-1 scope.
2. **Which handsets can we certify?** Needs a procurement decision and a test matrix. Nothing can
   be sold until this list exists.
3. **BYO LLM keys — default or premium?** Affects margin model and sub-processor disclosure.
4. **Do we keep original audio after transcription?** Storage cost and breach exposure vs. the
   ability to re-process with better models later.
5. **Is VoIP metadata (without audio) valuable enough to ship in Phase 1**, or does it invite the
   "why can't I hear it" conversation on every demo?
6. **Enterprise on-premise / single-tenant SKU** — worth reserving the architecture for, but is
   there demand?

---

## Appendix — traceability to v1

| v1 section | Disposition |
|---|---|
| §4 "Existing Features" | Corrected — VoIP audio and dual-channel removed; see §2 |
| §5–§9 | Retained, split across phases |
| §6 AI Instances | Split: instance = deployment/limit container; agent = configuration bundle |
| §10 Dynamic Schema | Retained with expressiveness constraints (§5.4) |
| §11 API Keys | Split: platform API keys vs. tenant LLM provider keys — separate systems |
| §12 Pipeline | Retained; language detection folded into ASR; explicit state machine added |
| §13 CRM | Phased — one connector in Phase 1 |
| §20 NFRs | Expanded with targets |
| §21 Stack | Right-sized (§7) |
| Recommendation (model provider layer) | Adopted; specified in `02_BACKEND_DESIGN.md` §8 |
| *(absent in v1)* | **New:** compliance requirements, success metrics, risks, capability statement |
