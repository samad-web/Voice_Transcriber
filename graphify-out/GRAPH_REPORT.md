# Graph Report - CallRecorderApp  (2026-07-22)

## Corpus Check
- Corpus is ~22,417 words - fits in a single context window. You may not need a graph.

## Summary
- 513 nodes · 803 edges · 42 communities (33 shown, 9 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 39 edges (avg confidence: 0.83)
- Token cost: 68,258 input · 0 output

## Community Hubs (Navigation)
- Room DAO & Recordings List
- OEM Recordings Scanner UI
- Main Activity & Playback UI
- Audio Capture & AAC Encoding
- Capture Profiles & OEM Ingest
- Event Log & File Encryption
- Recording Foreground Service
- Call Source Detection
- Activation State Storage
- Platform API Client
- Platform Backend Services
- Chunked Upload API
- Multi-Tenant AI Platform
- Application & Room Database
- Admin Activation Screen
- QR Scanner Overlay View
- Upload Worker
- VoIP Capture Constraints
- Cellular Recording Flow
- OEM Ingest Worker
- Device Identity Keypair
- Clean-Room Scaffold Policy
- Audio Source & Model Providers
- Telecaller Greeting Profile
- Recordings Library Concepts
- Web Portal & Device Management
- Config Refresh Worker
- Device Health Reporter
- Health Reporting Worker
- Audio Level Bar View
- Activation Manager
- Call Log Reader
- Transcript Fetch Worker
- Theme Manager
- Bluetooth SCO Controller
- Transcriber Interface
- Upload Scheduler
- Accessibility Status Check
- Recording File Naming

## God Nodes (most connected - your core abstractions)
1. `RecordingsScannerActivity` - 35 edges
2. `MainActivity` - 33 edges
3. `RecordingEntity` - 29 edges
4. `RecordingDao` - 19 edges
5. `RecordingsAdapter` - 14 edges
6. `ActivationStore` - 13 edges
7. `PlatformApi` - 13 edges
8. `RecordingService` - 13 edges
9. `AudioCapturer` - 12 edges
10. `AacEncoder` - 11 edges

## Surprising Connections (you probably didn't know these)
- `Android APK (recording client)` --semantically_similar_to--> `CallRecorderApp (Android call recorder + transcriber)`  [INFERRED] [semantically similar]
  AI_Call_Intelligence_Platform_PRD.md → ARCHITECTURE.md
- `Dynamic schema (admin-defined extraction fields)` --semantically_similar_to--> `SourceRegistry (declarative call sources)`  [INFERRED] [semantically similar]
  AI_Call_Intelligence_Platform_PRD.md → ARCHITECTURE.md
- `Model Provider Layer (recommendation)` --semantically_similar_to--> `Audio-source auto-probe`  [INFERRED] [semantically similar]
  AI_Call_Intelligence_Platform_PRD.md → ARCHITECTURE.md
- `ASR Service (Whisper/OpenAI/Gemini)` --semantically_similar_to--> `Transcriber interface (pluggable transcription)`  [INFERRED] [semantically similar]
  AI_Call_Intelligence_Platform_PRD.md → ARCHITECTURE.md
- `Remote-party audio blocked since Android 10` --semantically_similar_to--> `OS mic-exclusivity wall for VoIP capture`  [INFERRED] [semantically similar]
  README.md → ARCHITECTURE.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Audio capture pipeline components** — architecture_audiocapturer, architecture_captureprofile, architecture_capturesettings, architecture_bluetoothscocontroller, architecture_aacencoder [EXTRACTED 1.00]
- **VoIP detect → record → discard-if-silent flow** — architecture_callaccessibilityservice, architecture_sourceregistry, architecture_callsource, architecture_recordingservice, architecture_silencedetection, architecture_voipmicexclusivity [EXTRACTED 1.00]
- **PRD AI processing chain (ASR → agent → LLM → CRM)** — ai_call_intelligence_platform_prd_aiprocessingpipeline, ai_call_intelligence_platform_prd_asrservice, ai_call_intelligence_platform_prd_agentengine, ai_call_intelligence_platform_prd_airuntime, ai_call_intelligence_platform_prd_apikeymanagement, ai_call_intelligence_platform_prd_crmservice [EXTRACTED 1.00]

## Communities (42 total, 9 thin omitted)

### Community 0 - "Room DAO & Recordings List"
Cohesion: 0.06
Nodes (14): AndroidViewModel, RecordingDao, RecordingEntity, areContentsTheSame(), areItemsTheSame(), View, RecordingsAdapter, VH (+6 more)

### Community 1 - "OEM Recordings Scanner UI"
Cohesion: 0.12
Nodes (9): ActivityRecordingsScannerBinding, Found, AppCompatActivity, Bundle, Job, Location, Progress, RecordingsScannerActivity (+1 more)

### Community 2 - "Main Activity & Playback UI"
Cohesion: 0.09
Nodes (12): ActionMode, ActivityMainBinding, AppCompatActivity, Bundle, Job, MainActivity, MediaPlayer, Menu (+4 more)

### Community 3 - "Audio Capture & AAC Encoding"
Cohesion: 0.10
Nodes (12): ActivityQrScannerBinding, AacEncoder, ByteArray, AudioCapturer, ByteArray, AppCompatActivity, Bundle, QrScannerActivity (+4 more)

### Community 4 - "Capture Profiles & OEM Ingest"
Cohesion: 0.11
Nodes (13): CaptureProfile, ProfileKind, PHONE, VOIP, CaptureSettings, com, Context, OemRecordingIngestor (+5 more)

### Community 5 - "Event Log & File Encryption"
Cohesion: 0.22
Nodes (7): EventLog, Context, JSONObject, FileCrypto, KeyStore, JSONArray, SecretKey

### Community 6 - "Recording Foreground Service"
Cohesion: 0.19
Nodes (9): Context, Intent, RecordingService, start(), startedAtMillisPlaceholder(), stop(), IBinder, Notification (+1 more)

### Community 7 - "Call Source Detection"
Cohesion: 0.17
Nodes (6): AccessibilityEvent, AccessibilityNodeInfo, AccessibilityService, CallSource, SourceRegistry, CallAccessibilityService

### Community 8 - "Activation State Storage"
Cohesion: 0.33
Nodes (3): ActivationStore, Context, SharedPreferences

### Community 9 - "Platform API Client"
Cohesion: 0.26
Nodes (7): ApiException, CallResult, DeviceConfig, Enrollment, Exception, JSONObject, PlatformApi

### Community 10 - "Platform Backend Services"
Cohesion: 0.16
Nodes (14): AI processing pipeline (Audio → ASR → LLM → CRM → Storage), Analytics (calls, conversion, sentiment, AI cost, device health), API endpoints (devices, instances, calls, agents, apikeys, crm), ASR Service (Whisper/OpenAI/Gemini), Backend API, Billing & usage tracking, CRM Service (Salesforce, HubSpot, Zoho, Dynamics, webhooks), Non-functional requirements (RBAC, queues, scalability, audit, observability) (+6 more)

### Community 11 - "Chunked Upload API"
Cohesion: 0.27
Nodes (7): ApiException, CreateCallResult, ByteArray, Exception, JSONObject, PartResult, UploadApi

### Community 12 - "Multi-Tenant AI Platform"
Cohesion: 0.20
Nodes (12): Agent Engine, AI Agent Builder (dynamic agent configuration), AI Instance (Instance ID, secret, limits, model, language), Android APK (recording client), Database entities, Device authentication & JWT / E2E encryption, Dynamic schema (admin-defined extraction fields), Multi-tenant hierarchy (Platform → Org → Workspace) (+4 more)

### Community 13 - "Application & Room Database"
Cohesion: 0.18
Nodes (8): App, get(), Context, migrate(), RecordingDatabase, Application, RoomDatabase, SupportSQLiteDatabase

### Community 14 - "Admin Activation Screen"
Cohesion: 0.27
Nodes (5): AdminActivationActivity, AppCompatActivity, Bundle, EditText, TextView

### Community 15 - "QR Scanner Overlay View"
Cohesion: 0.29
Nodes (3): Canvas, View, ScannerOverlayView

### Community 16 - "Upload Worker"
Cohesion: 0.24
Nodes (6): ByteArray, com, Context, CoroutineWorker, Result, UploadWorker

### Community 17 - "VoIP Capture Constraints"
Cohesion: 0.21
Nodes (12): CallAccessibilityService (VoIP call-screen detection), CallSource (call source data class), CaptureProfile (PHONE / VOIP audio-source priority), Sideload-only distribution constraint, Silence detection & discard-empty policy, VoIP call recording flow, OS mic-exclusivity wall for VoIP capture, VoIP recording (partial — detection built, capture device-dependent) (+4 more)

### Community 18 - "Cellular Recording Flow"
Cohesion: 0.24
Nodes (10): AacEncoder (PCM → AAC/.m4a), CallLogReader (call-log enrichment), CaptureSettings (SharedPreferences capture knobs), Cellular call recording flow, PhoneStateReceiver (cellular call detection), RecordingNaming (readable file rename), RecordingService (foreground orchestration), Call Recorder feature roadmap (+2 more)

### Community 19 - "OEM Ingest Worker"
Cohesion: 0.31
Nodes (7): enqueueAfterCall(), enqueueNow(), Context, CoroutineWorker, Result, OemIngestWorker, schedule()

### Community 21 - "Clean-Room Scaffold Policy"
Cohesion: 0.25
Nodes (9): CallRecorderApp (Android call recorder + transcriber), Clean-room reimplementation policy, Cube ACR (com.catalinagroup.callrecorder), SourceRegistry (declarative call sources), Per-contact whitelist / blacklist (planned), ActivityRecordingFactory (Cube ACR), Build setup (AGP 8.13.x / Kotlin 2.0.x, gradlew assembleDebug), Call Recorder clean-room scaffold (+1 more)

### Community 22 - "Audio Source & Model Providers"
Cohesion: 0.29
Nodes (8): AI Runtime, API key management (encrypted provider profiles), Model Provider Layer (recommendation), AudioCapturer (AudioRecord capture engine), Audio-source auto-probe, BluetoothScoController (SCO routing), Bluetooth headset capture via SCO (partial), libcubeacr.so JNI capture path (Cube ACR)

### Community 23 - "Telecaller Greeting Profile"
Cohesion: 0.36
Nodes (7): currentGreeting(), Greeting, AFTERNOON, EVENING, MORNING, greetingHour(), TelecallerProfile

### Community 24 - "Recordings Library Concepts"
Cohesion: 0.29
Nodes (8): App-external recordings storage + FileProvider, MainActivity (recordings list + player UI), RecordingDao, RecordingDatabase (Room singleton), RecordingEntity (Room row), RecordingsAdapter, RecordingsViewModel, Library & playback features

### Community 25 - "Web Portal & Device Management"
Cohesion: 0.29
Nodes (7): Device management (register, rename, force sync, remote logout, health), Device Service, Search & playback (transcript search, timestamps, notes), Web Platform (multi-tenant SaaS portal), Suggested next batch of work, Transcription roadmap (the Voice_Transcriber goal), Search by name / number / note / transcript (planned)

### Community 26 - "Config Refresh Worker"
Cohesion: 0.29
Nodes (5): ConfigRefreshWorker, Context, CoroutineWorker, Result, schedule()

### Community 28 - "Health Reporting Worker"
Cohesion: 0.29
Nodes (5): HealthWorker, Context, CoroutineWorker, Result, schedule()

### Community 29 - "Audio Level Bar View"
Cohesion: 0.29
Nodes (3): Canvas, View, LevelBarView

### Community 31 - "Call Log Reader"
Cohesion: 0.53
Nodes (3): CallInfo, CallLogReader, Context

### Community 32 - "Transcript Fetch Worker"
Cohesion: 0.47
Nodes (3): CoroutineWorker, Result, TranscriptWorker

## Ambiguous Edges - Review These
- `Transparency guardrail (non-negotiable)` → `Device authentication & JWT / E2E encryption`  [AMBIGUOUS]
  AI_Call_Intelligence_Platform_PRD.md · relation: conceptually_related_to
- `Transparency guardrail (non-negotiable)` → `AI Call Intelligence Platform`  [AMBIGUOUS]
  AI_Call_Intelligence_Platform_PRD.md · relation: conceptually_related_to

## Knowledge Gaps
- **17 isolated node(s):** `PHONE`, `VOIP`, `MORNING`, `AFTERNOON`, `EVENING` (+12 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **9 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **What is the exact relationship between `Transparency guardrail (non-negotiable)` and `Device authentication & JWT / E2E encryption`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **What is the exact relationship between `Transparency guardrail (non-negotiable)` and `AI Call Intelligence Platform`?**
  _Edge tagged AMBIGUOUS (relation: conceptually_related_to) - confidence is low._
- **Why does `RecordingEntity` connect `Room DAO & Recordings List` to `Main Activity & Playback UI`, `Capture Profiles & OEM Ingest`, `Recording Foreground Service`, `Admin Activation Screen`, `Upload Worker`, `Device Identity Keypair`?**
  _High betweenness centrality (0.233) - this node is a cross-community bridge._
- **Why does `AudioCapturer` connect `Audio Capture & AAC Encoding` to `Recording Foreground Service`?**
  _High betweenness centrality (0.118) - this node is a cross-community bridge._
- **What connects `PHONE`, `VOIP`, `MORNING` to the rest of the system?**
  _17 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Room DAO & Recordings List` be split into smaller, more focused modules?**
  _Cohesion score 0.058673469387755105 - nodes in this community are weakly interconnected._
- **Should `OEM Recordings Scanner UI` be split into smaller, more focused modules?**
  _Cohesion score 0.11711711711711711 - nodes in this community are weakly interconnected._