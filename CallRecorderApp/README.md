# Call Recorder (clean-room scaffold)

A native Android (Kotlin) call-recorder + transcriber, built from scratch as a
clean-room reimplementation of the *architecture* seen in Cube ACR — **not** its
code. It mirrors the good ideas (source registry, accessibility-assisted detection,
foreground capture service, pluggable transcription) in original code.

## Architecture

```
CallAccessibilityService ──(local intent)──► RecordingService (foreground, mic type)
   detects call screen,                          │
   scrapes callee name                           ├─ AudioCapturer (AudioRecord, VOICE_COMMUNICATION)
                                                  │     └─ AacEncoder (MediaCodec + MediaMuxer → .m4a)
PhoneStateReceiver ──(native call off-hook)──►    ├─ RecordingDatabase (Room metadata)
                                                  └─ Transcriber.active (pluggable; decide later)

SourceRegistry = clean-room ActivityRecordingFactory (activity/package → CallSource)
```

Map to what we found in the APK:

| This scaffold | Cube ACR equivalent |
|---|---|
| `CallAccessibilityService` (in-app) | separate `…callrecorder.helper` app + `HelperConnector` broadcast bridge |
| `SourceRegistry` / `CallSource` | `ActivityRecordingFactory` + per-app `*Recording` classes |
| `AudioCapturer` (pure Kotlin) | `AndroidAudioRecord` → native `libcubeacr.so` (JNI) |
| `AacEncoder` | MediaCodec/MediaMuxer pipeline (+ bundled LAME for MP3) |
| `RecordingDatabase` (Room) | Room metadata DB |
| `Transcriber` interface | `Transcription` / `Recognizer` (a paid feature there) |

### The two-app split (optional)
Cube ACR put the accessibility service in a *second* APK signed with the same key and
talked to it over signature-permission-protected broadcasts (`helper_recordingCallInfo`,
`helper_recordingPhoneCallBegin`, …). We fold it into one app for simplicity. If you ever
need the split (e.g. to update the detector independently), reintroduce a
`BroadcastReceiver` + a `signature`-level `<permission>` and send the same intents.

## Honest constraints (these shaped Cube ACR's messy design; they apply to you too)

1. **Remote-party audio on native calls is blocked since Android 10.** No stock API
   captures the downlink. The `ACCESSIBILITY_ROUTED` strategy (toggle speaker /
   `MODE_IN_COMMUNICATION`) is a fragile best-effort workaround, nothing more.
2. **Google Play bans call recording via Accessibility** — this app is sideload-only.
3. **Call recording is legally regulated** (one-party vs. all-party consent varies by
   jurisdiction). The app shows a consent notice and an always-on recording notification
   by design. Keep it that way.

The unrestricted, Play-safe subset is **your own mic / voice-memo recording +
transcription** — start there if distribution matters.

## Build

Open in Android Studio (AGP 8.13.x / Kotlin 2.0.x), or:

```
./gradlew :app:assembleDebug
```

This is a **scaffold**, not a tested app: it hasn't been run on a device, the encoder
buffering/timestamps need hardening, and `ic_launcher`/theme resources are assumed from
your Android Studio template. Wire a real `Transcriber` and a recordings-list UI next.
```
