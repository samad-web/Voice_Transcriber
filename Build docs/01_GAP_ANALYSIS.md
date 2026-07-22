# Gap Analysis — CallRecorderApp (today) vs. AI Call Intelligence Platform (PRD)

Source documents: `ARCHITECTURE.md` (as-built), `AI_Call_Intelligence_Platform_PRD.md` (target).

---

## 0. Executive summary

The existing app is a well-factored **single-device, offline, owner-operated** recorder.
The PRD describes a **multi-tenant, cloud-processed, admin-supervised** SaaS. The Android
app is roughly **25–30% of the client scope** and **0% of the platform scope**.

Three findings dominate everything else:

| # | Finding | Impact |
|---|---------|--------|
| **F1** | The PRD lists VoIP recording and dual-channel audio as *existing* features. The as-built architecture says both are blocked or OEM-dependent. | Scope credibility. Must be corrected before any commitment. |
| **F2** | The app's stated non-negotiables ("nothing leaves the device", "no exfiltration") are the exact inverse of the platform model. | This is a deliberate product pivot, not an increment. Guardrails need rewriting, not amending. |
| **F3** | Consent liability moves from the device owner to the platform operator the moment recordings reach a shared workspace. | Legal/compliance work is on the v1 critical path, not a later hardening item. |

---

## 1. Capability reality check (F1)

This is the section to resolve first, because it determines what the product can honestly sell.

### 1.1 VoIP recording

**PRD says:** existing feature.
**Architecture says:** on modern Android the messenger holds the microphone exclusively; the
OS hands the recorder digital silence. `RecordingService` detects `capturedAudio == false`,
**deletes the file**, and notifies the user. Marked "do not fight it — this is an OS wall
for non-root apps."

Both statements can't be true. Options:

| Option | Description | Verdict |
|---|---|---|
| A | Ship as-is and hope | No. It produces zero-byte deliverables and support tickets. |
| B | Reframe to **VoIP call metadata only** — the accessibility service already detects the app, call screen, direction and scrapes the callee name. Log the call event, no audio, no ASR. | **Recommended.** Honest, already ~80% built, still feeds analytics and CRM activity logging. |
| C | Accessibility-captured audio via root / OEM partnership / custom ROM | Enterprise-fleet-only, very narrow. Park it. |
| D | In-app SDK for the customer's *own* VoIP app | A different product. Note as future line item. |

Recommendation: **B for v1**, with C/D listed as explicitly out of scope.

### 1.2 Dual-channel audio

**PRD says:** existing feature.
**Architecture says:** `AudioCapturer` produces **16-bit mono, 44.1 kHz** PCM. `VOICE_CALL`
captures uplink+downlink *mixed*, on OEMs that permit it, on one confirmed test device.

Android exposes no API for separate uplink/downlink streams to a third-party app. "Dual
channel" as a capture feature is not achievable.

**Reframe:** what the PRD actually wants from dual-channel is *speaker attribution* — knowing
which utterance was the agent and which was the customer. That is solvable, but as an **ASR-side
diarization** problem, not a capture problem:

- Run diarization (pyannote, WhisperX, or a managed ASR with speaker labels) on the mixed mono track.
- Bias the assignment using known signals: the device owner is a known speaker; enroll a voice
  profile per agent at onboarding; the first speaker on an outgoing call is usually the agent.
- Expected accuracy on mixed-mono telephony: good enough for lead extraction, not good enough
  for compliance-grade attribution. State that limit in the PRD.

Also change capture to **16 kHz mono** — telephony audio has no content above 4 kHz, ASR models
want 16 kHz, and you cut upload volume ~64% versus 44.1 kHz. This is a small change in
`AudioCapturer` with a large cost effect at fleet scale.

### 1.3 Far-end (PSTN) capture

`VOICE_CALL` works "where the OEM permits it — confirmed working on the primary test device."
For a fleet product, one device is not a compatibility claim.

**Required work:** a **device compatibility matrix**. The good news: the app already records
which audio source actually won the probe, per recording. Ship that as telemetry and the matrix
builds itself. Gate onboarding on it — during device enrollment, run a probe test call and
report `FULL_DUPLEX / NEAR_END_ONLY / SPEAKER_REQUIRED / UNSUPPORTED` to the server, so admins
see capability before they deploy 200 handsets.

---

## 2. Android APK — feature-by-feature gap

Legend: **Have** / **Partial** / **None**

| PRD feature | State | What exists | What's missing |
|---|---|---|---|
| Automatic PSTN recording | **Have** | `PhoneStateReceiver` → `RecordingService` → `CaptureProfile.PHONE` probe | Nothing functionally; needs 16 kHz change and telemetry |
| Incoming & outgoing | **Have** | Direction inferred from RINGING-before-OFFHOOK, enriched via `CallLogReader` | — |
| VoIP recording | **None (blocked)** | Detection works; audio does not | See §1.1 — reframe to metadata |
| Dual-channel audio | **None (blocked)** | Mono mixed | See §1.2 — reframe to diarization |
| Background uploads | **None** | Files sit in `getExternalFilesDir()/recordings/` | Entire upload subsystem |
| Instance registration (Instance ID) | **None** | No account/tenant concept anywhere | Enrollment UI + flow + storage |
| Device authentication | **None** | — | Keystore keypair, attestation, token lifecycle |
| Remote configuration sync | **Partial** | `CaptureSettings` (SharedPreferences) is the right seam | Server config document, versioning, precedence rules, poll/push |
| Background synchronization | **None** | — | WorkManager chain, constraints, backoff |
| Device health dashboard | **None** | — | Telemetry collection + upload; server rendering |
| End-to-end encryption | **None** | Plaintext `.m4a` on external storage | At-rest encryption, TLS pinning, key management |
| JWT authentication | **None** | — | Token store, refresh, 401 handling |
| Remote logout & wipe | **None** | — | Push channel (FCM), wipe routine, tamper-resistance |

### 2.1 The upload subsystem (largest single client gap)

Nothing exists. Required design:

- **Room schema migration** — add to `RecordingEntity`: `uploadState` (PENDING / UPLOADING /
  UPLOADED / FAILED / DISCARDED), `remoteCallId`, `attemptCount`, `lastError`, `sha256`,
  `bytesUploaded`, `capturedAt` in UTC epoch, `deviceLocalId`.
- **WorkManager** unique periodic worker + expedited one-shot on recording completion.
  Constraints: network type from server config (wifi-only default), battery-not-low, storage-not-low.
- **Resumable multipart** to presigned S3 URLs, not through the API server. Chunk at 5 MB.
- **Backoff**: exponential with jitter, cap at ~6 h, permanent-fail after N attempts → surfaces
  as a device health alert rather than silent loss.
- **Local retention policy**: delete local file only after server confirms checksum. Then a
  configurable local retention window (default 0 days) so admins can trade privacy vs. recovery.
- **Ordering**: none required. Uploads are independent; do not build a strict queue.

The existing "wait for DB write before `stopSelf()`" discipline in `RecordingService` is exactly
the right instinct — extend it so enqueueing the upload work is part of the same committed step.

### 2.2 Security posture change

Today files live in `getExternalFilesDir()`, chosen deliberately to avoid broad storage
permission. For a fleet product handling third-party voice data, that's now the weak point:
readable via ADB, device backup, and any process with the path on older API levels.

Required: AES-256-GCM at rest with the key in Android Keystore (`setUserAuthenticationRequired=false`,
`StrongBox` where available), envelope-wrapped per device. Encrypt on the capture thread as the
final `AacEncoder` output is closed. Certificate pinning for API and S3 endpoints. `allowBackup=false`.

Note "end-to-end encryption" in the PRD is used loosely — if the server runs ASR, it must decrypt.
Say **"encrypted in transit and at rest, on device and in storage; decrypted only inside the
processing pipeline"** and stop calling it E2E.

### 2.3 Distribution

Accessibility-based call recording remains a Play policy violation, including via Managed
Google Play. Enterprise path: MDM (Intune / Workspace ONE / Android Enterprise) pushing a
signed APK to managed devices, with the accessibility service enabled by device policy where the
MDM allows it. This is workable for the B2B model in the PRD but must be written down — it
changes the sales motion and the onboarding runbook.

### 2.4 Components that survive the pivot unchanged

Worth stating, because it's most of the hard-won parts: `SourceRegistry` / `CallSource`
(server-syncable as-is — it's already declarative), the probe-and-fallback logic in
`AudioCapturer`, `AacEncoder`'s hardening, the transient-overlay filtering in the accessibility
service, and the silence-discard rule. The Room + observed-UI structure survives too. The
`Transcriber` interface becomes an optional on-device fallback rather than the main path.

---

## 3. Platform — gap is total

Everything in PRD §5–§19 is greenfield: no backend, no database, no queue, no storage, no web
app, no auth, no billing. Detailed design is in `02_BACKEND_DESIGN.md`.

Two scoping observations:

**The stack is over-specified for v1.** The PRD names Kafka *and* RabbitMQ *and* SQS,
Elasticsearch/OpenSearch, Prometheus + Grafana, Redis, Postgres, S3. For the first production
release you need Postgres + Redis + one queue + S3. Postgres full-text search will carry
transcript search well past the first hundred tenants; adding Elasticsearch on day one buys a
second consistency problem instead of a feature.

**"Fully dynamic with no customer-specific logic hardcoded"** is the right instinct but needs a
boundary. Dynamic: extraction fields, prompts, classification labels, CRM field mappings,
scoring weights, limits. Not dynamic: tenancy model, auth, the pipeline's stage graph. Trying to
make the pipeline itself configurable is the classic way these platforms become unshippable.

---

## 4. Compliance gap (F3)

Currently: "the user is responsible for legality in their jurisdiction," with a consent-tone
hook stubbed. That allocation of responsibility does not survive contact with multi-tenancy.

| Concern | Now | Needed |
|---|---|---|
| Consent | Device owner's problem | Per-tenant, server-enforced policy: announcement tone/TTS, jurisdiction-aware, non-overridable on device; refuse to record if policy requires consent and the tone fails |
| Role | N/A | Platform = data processor, tenant = controller. Needs a DPA template |
| Erasure (GDPR Art. 17 / DPDP) | Delete a file | Cascading deletion across Postgres, S3, search index, LLM provider logs, CRM copies — with a completion receipt |
| Retention | None | Per-tenant configurable, default-on, enforced by a reaper job |
| Third-party data | Implicit | The far-end speaker never signed up. This is the sharpest exposure — the announcement tone is the mitigation, so it's a feature, not a stub |
| Audit | None | Immutable log of every recording access, export, and admin config change |
| Sub-processors | N/A | OpenAI/Gemini/Anthropic are sub-processors of voice data. Must be disclosed; zero-retention API tiers should be mandatory |

Two-party-consent jurisdictions (much of the EU, several US states, and note that India's DPDP
Act now applies to your likely first market) make the announcement tone effectively mandatory
rather than optional. Build it in Phase 1.

---

## 5. Effort and sequencing

Estimates are for a small team, in engineer-weeks, excluding legal review.

| Workstream | Est. | Risk | Notes |
|---|---|---|---|
| Capability truth-setting + device matrix | 2 | Low | Do first; unblocks all commitments |
| Client: enrollment, auth, keystore | 4 | Med | Attestation integration is the fiddly part |
| Client: upload subsystem + schema migration | 5 | Med | Highest-value client work |
| Client: encryption, remote config, wipe, telemetry | 5 | Med | — |
| Client: 16 kHz + capture telemetry | 1 | Low | Quick, large cost saving |
| Backend: tenancy, auth, RBAC, device API | 6 | Med | Foundation for everything |
| Backend: ingest + pipeline + ASR | 6 | Med | — |
| Backend: agent engine, dynamic schema, provider layer | 7 | **High** | Most likely to sprawl; ruthless scoping needed |
| Backend: CRM connectors | 3/connector | Med | Ship one (HubSpot), not four |
| Web: admin + user app | 10 | Med | — |
| Billing, limits, usage metering | 4 | Med | Meter from day one even if you don't bill |
| Compliance: consent engine, retention, audit, DPA | 5 | **High** | On the critical path |
| Observability, deployment, IaC | 4 | Low | — |

Rough total for a defensible v1: **60–70 engineer-weeks**, i.e. 4 engineers × ~4 months, plus
legal. The four highest-risk items are the agent engine, the compliance engine, per-device
capture variability, and CRM connector maintenance — the last being the one that never appears
in estimates and never stops costing.
