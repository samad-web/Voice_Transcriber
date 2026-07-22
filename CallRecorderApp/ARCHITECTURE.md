# CallRecorderApp — Architecture

Native Android (Kotlin) call recorder + transcriber. A **clean-room reimplementation** of
the *architecture* of Cube ACR (`com.catalinagroup.callrecorder`) — the design ideas were
learned from its decompiled code, but no vendor code was copied. The app is deliberately
transparent and owner-operated: a persistent notification always shows while recording,
there is no hidden icon, and nothing leaves the device.

```
Package: com.voicetranscriber.callrecorder
Stack:   Kotlin, single module (:app), Room, Material 3, coroutines
minSdk/targetSdk: see app/build.gradle.kts
```

## The big picture

Two independent **detectors** notice that a call started or ended and dispatch to one
**recording service**, which asks the **capture pipeline** to produce an `.m4a` file, then
persists metadata to **Room**, which the **UI** observes.

```
  DETECTION                     ORCHESTRATION                CAPTURE
┌─────────────────────┐      ┌──────────────────┐      ┌────────────────────────┐
│ PhoneStateReceiver  │ ───► │ RecordingService │ ───► │ AudioCapturer          │
│  (cellular calls)   │      │  (foreground,    │      │  ├ CaptureProfile      │
├─────────────────────┤      │   microphone     │      │  ├ CaptureSettings     │
│ CallAccessibility-  │ ───► │   type)          │      │  ├ BluetoothScoCtrl    │
│ Service (VoIP apps) │      │                  │      │  └ AacEncoder → .m4a   │
└─────────────────────┘      └────────┬─────────┘      └────────────────────────┘
          │                           │
          ▼                           ▼
   SourceRegistry              Room (RecordingDatabase)  ◄──observed── UI
   (CallSource table:          RecordingEntity                (MainActivity,
    which apps, which           + CallLogReader enrichment     RecordingsViewModel,
    profile to use)             + RecordingNaming rename       RecordingsAdapter)
```

Cube ACR mapping (for orientation): `PhoneStateReceiver` ≈ `OnPhoneState`,
`CallAccessibilityService` ≈ the separate helper APK (here kept in-process),
`RecordingService` ≈ recording service + `ExternalRecordingWork`,
`SourceRegistry`/`CallSource` ≈ `ActivityRecordingFactory` + per-app `*Recording` classes.

## Layer by layer

### 1. Detection — "eyes and ears"

**[PhoneStateReceiver.kt](app/src/main/kotlin/com/voicetranscriber/callrecorder/service/PhoneStateReceiver.kt)**
— native cellular calls. Listens for `PHONE_STATE` broadcasts:

- `RINGING` → remember the incoming number (needs `READ_CALL_LOG` for
  `EXTRA_INCOMING_NUMBER` to be populated) and flag the call as incoming.
- `OFFHOOK` → call is *attended* → `RecordingService.start(...)`. Starting on OFFHOOK
  (never RINGING) means unanswered calls are not recorded. Direction is inferred:
  saw RINGING first = incoming, otherwise outgoing.
- `IDLE` → `RecordingService.stop(...)` and reset state. Receiver instances are
  short-lived, so cross-broadcast state lives in `@Volatile` companion fields.

**[CallAccessibilityService.kt](app/src/main/kotlin/com/voicetranscriber/callrecorder/service/CallAccessibilityService.kt)**
— VoIP calls (WhatsApp, Telegram, Signal, …). Watches `TYPE_WINDOW_STATE_CHANGED`
events and starts recording only when **both** hold:

1. the foreground package is a *known* messenger (`SourceRegistry.matchByPackage`), and
2. the window looks like a *call screen* — exact activity match
   (`SourceRegistry.matchByActivity`) or a class-name hint (`voip`, `webrtc`, `incall`, …)
   so detection survives app updates that rename the activity.

It never fires just because a messenger is open. Stop fires when the foreground moves to
a non-call window, but **ignores transient overlays** (system UI shade, keyboard) so
mid-call multitasking doesn't cut the recording. It also scrapes the callee name from the
source's declared accessibility view IDs when available.

> Note: Google Play bans call recording via the accessibility API — this path makes the
> app sideload-only by design.

### 2. Source registry — declarative call sources

**[CallSource.kt](app/src/main/kotlin/com/voicetranscriber/callrecorder/recordings/CallSource.kt)**
is a plain data class: stable id, label, owning package, call-screen activity classes,
callee view IDs, and which `ProfileKind` (PHONE / VOIP) to capture with.

**[SourceRegistry.kt](app/src/main/kotlin/com/voicetranscriber/callrecorder/recordings/SourceRegistry.kt)**
holds the `BUILT_IN` list (telephony + WhatsApp, Telegram, Signal, Messenger, Meet, Zoom,
Skype, Viber, …) and index maps by package/activity. **Adding support for a new messenger
is one list entry — no code changes anywhere else.**

### 3. Orchestration — RecordingService

**[RecordingService.kt](app/src/main/kotlin/com/voicetranscriber/callrecorder/service/RecordingService.kt)**
is a `foregroundServiceType="microphone"` service (Android 14 granular type) driven by
`ACTION_START` / `ACTION_STOP` intents. It is the only component that touches the
capture pipeline. Lifecycle of one recording:

1. **Start**: resolve the `CallSource`, `startForeground` with an ongoing notification
   (the transparency indicator — also required for a mic foreground service), create the
   output file under `getExternalFilesDir()/recordings/`, resolve the `CaptureProfile`
   via `CaptureSettings`, and start `AudioCapturer`. The source that actually won the
   probe is stored on the entity so the UI can show it. A start failure posts an error
   notification rather than failing silently.
2. **Stop**: stop the capturer, then on a coroutine:
   - If **no real audio** was captured (`capturedAudio == false` — e.g. a VoIP app held
     the mic and the OS handed us digital silence), the empty file is **deleted** and the
     user notified, instead of saving a junk row.
   - Otherwise insert the `RecordingEntity`, wait ~1.2 s for the system call-log row,
     enrich name/number/direction via `CallLogReader`, and rename the file to a readable
     `"<name> <date time>.m4a"` via `RecordingNaming`.
   - Only **after** the DB write completes does the service `stopSelf()` — stopping
     earlier cancels the coroutine scope and loses the recording (a real bug this fixed).

### 4. Capture pipeline

**[CaptureProfile.kt](app/src/main/kotlin/com/voicetranscriber/callrecorder/capture/CaptureProfile.kt)**
— a priority-ordered list of `MediaRecorder.AudioSource` ints plus a
force-speaker flag. Two built-ins:

- `PHONE`: `VOICE_CALL → VOICE_RECOGNITION → VOICE_COMMUNICATION → MIC`. `VOICE_CALL`
  captures both ends (uplink+downlink) *where the OEM permits it* — confirmed working on
  the primary test device without speakerphone. Elsewhere it falls through to mic-type
  sources, optionally with forced speakerphone so the far end is captured acoustically.
- `VOIP`: plain `MIC` only. On modern Android the messenger holds the mic exclusively and
  the OS blocks concurrent capture, so this usually yields silence — see the
  discard-empty logic above. This is an OS wall for non-root apps; do not fight it.

**[CaptureSettings.kt](app/src/main/kotlin/com/voicetranscriber/callrecorder/capture/CaptureSettings.kt)**
— SharedPreferences-backed knobs: force-speaker toggle, a pinned phone audio source
(pinned source goes *first* but the rest remain as fallback, so a bad pin can never abort
recording), and the VoIP-recording on/off toggle (default on).

**[AudioCapturer.kt](app/src/main/kotlin/com/voicetranscriber/callrecorder/capture/AudioCapturer.kt)**
— the engine. `AudioRecord` PCM (44.1 kHz, 16-bit mono) → `AacEncoder`, on a dedicated
thread. Key behaviors:

- **Auto-probe**: tries each source in profile order; a source that fails to construct,
  initialize, or enter `RECORDSTATE_RECORDING` is skipped. First working source wins and
  its name is exposed for the UI (`activeSourceName`).
- **Silence detection**: a cheap sparse scan flips `capturedAudio` once any non-silent
  sample appears; blocked capture is digital zero.
- **Bluetooth**: if a BT headset is the call device, routes audio via SCO
  (`BluetoothScoController`) and probes `VOICE_COMMUNICATION`-family sources instead
  (SCO doesn't carry the `VOICE_CALL` modem stream). Best-effort, device-dependent.
- **Speakerphone**: only when the profile asks for it *and* a mic-type source won;
  previous mode/speaker state is restored on stop.

**[AacEncoder.kt](app/src/main/kotlin/com/voicetranscriber/callrecorder/capture/AacEncoder.kt)**
— PCM → AAC in `.m4a` via `MediaCodec` + `MediaMuxer`. Hardened: never drops PCM (waits
for codec input buffers instead of discarding), monotonic timestamps from a cumulative
sample counter, muxer track added exactly once, bounded EOS drain, exactly-once release
on any failure. Single-threaded by contract (the capture thread owns it).

### 5. Storage

Room, three files in `storage/`:
[RecordingEntity.kt](app/src/main/kotlin/com/voicetranscriber/callrecorder/storage/RecordingEntity.kt)
(file path, source id, callee, timestamps, winning audio source, direction, user note,
transcript slot),
[RecordingDao.kt](app/src/main/kotlin/com/voicetranscriber/callrecorder/storage/RecordingDao.kt),
[RecordingDatabase.kt](app/src/main/kotlin/com/voicetranscriber/callrecorder/storage/RecordingDatabase.kt)
(singleton exposed via `App.instance.database`). Audio files live in app-external storage
(`getExternalFilesDir()/recordings/`) — no broad storage permission needed, and files are
shared with other apps only through the manifest-declared `FileProvider`.

### 6. UI

Classic View-based Material 3 (dynamic color on Android 12+), in `ui/`:

- **[MainActivity.kt](app/src/main/kotlin/com/voicetranscriber/callrecorder/ui/MainActivity.kt)**
  — recordings list, in-app playback (`MediaPlayer` + `Visualizer` level bar), share via
  `FileProvider`, delete, edit note; runtime permission requests; settings bottom sheet
  (audio source pin, speaker toggle, VoIP toggle); accessibility-service status prompt
  (`AccessibilityStatus`).
- **[RecordingsViewModel.kt](app/src/main/kotlin/com/voicetranscriber/callrecorder/ui/RecordingsViewModel.kt)**
  — observes the DAO; the list updates reactively when the service inserts/enriches rows.
- **[RecordingsAdapter.kt](app/src/main/kotlin/com/voicetranscriber/callrecorder/ui/RecordingsAdapter.kt)**
  — one row per recording, showing direction icon, name, time, and which audio source
  actually captured it (useful for diagnosing per-device capture behavior).

### 7. Transcription — the actual goal, pluggable

**[Transcriber.kt](app/src/main/kotlin/com/voicetranscriber/callrecorder/transcription/Transcriber.kt)**
— a one-method interface (`suspend fun transcribe(File): String?`) with a global
`Transcriber.active` slot set at startup; `NoopTranscriber` is the placeholder. The
backend decision (on-device Whisper/Vosk vs. cloud STT) is deliberately deferred — the
rest of the pipeline only ever talks to this interface, and `RecordingEntity.transcript`
is already in the schema.

## Key flows

**Cellular call**: `PHONE_STATE` OFFHOOK → `RecordingService.start(telephony, number,
direction)` → PHONE profile probe (VOICE_CALL usually wins) → IDLE →
stop → save → call-log enrich → rename → UI updates.

**VoIP call**: messenger call screen appears → accessibility service matches package +
activity/hint → `RecordingService.start(source, scrapedName)` → VOIP profile (MIC) →
call screen dismissed → stop → if silent, delete file + notify; else save.

## Constraints & guardrails (locked in)

- **Android ≥10 blocks third-party far-end capture** in general; `VOICE_CALL` works only
  where the OEM allows it (the test device does). The probe + per-recording source label
  exists precisely because this is empirical per device.
- **VoIP recording is not reliably possible** for a non-root app — the OS enforces mic
  exclusivity for the messenger. The app detects the resulting silence, discards, and
  notifies. Don't reinvest here.
- **Sideload-only**: Google Play prohibits accessibility-based call recording.
- **Transparency is non-negotiable**: ongoing recording notification, no covert
  operation, no exfiltration. Call recording is consent-regulated — the user is
  responsible for legality in their jurisdiction (a consent-announcement tone hook is
  stubbed in `RecordingService`).
- **Clean room**: architecture inspired by Cube ACR's decompiled structure; all code and
  data here are original. Never copy vendor code, and never patch Cube ACR's billing.
