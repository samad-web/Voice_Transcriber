# Call Recorder — feature roadmap

Tracking parity with apps like Cube ACR. ✅ done · 🟡 partial · ⬜ planned

## Recording
- ✅ Auto-record phone calls, **only when answered** (off-hook), not on ring
- ✅ Incoming vs outgoing detection (from call log)
- 🟡 VoIP recording (WhatsApp/Telegram/Signal) — detection via accessibility built; capture is device-dependent
- ✅ Selectable audio source + auto-probe fallback (VOICE_CALL → … → MIC)
- ✅ Both-ends capture via VOICE_CALL where the device allows it
- ✅ Force-speaker fallback for far-end (acoustic)
- 🟡 Bluetooth headset capture via SCO (best-effort, device-dependent)
- ⬜ Master "auto-record" on/off toggle
- ⬜ Per-contact include/exclude (whitelist / blacklist)
- ⬜ Manual record button (record without a call)

## Library / playback
- ✅ Recordings list (newest first)
- ✅ Player: seekbar, running timer, live waveform
- ✅ Name = contact name or phone number (from call log)
- ✅ Share (system share sheet)
- ✅ Delete (row + file)
- ✅ Edit name + note (long-press)
- ⬜ Search (by name / number / note / transcript)
- ⬜ Favorite / star + filter
- ⬜ Sort & group (by date / contact)
- ⬜ Playback speed, skip ±10s

## Transcription (the Voice_Transcriber goal)
- 🟡 Pluggable `Transcriber` interface in place; no engine wired yet
- ⬜ Auto-transcribe after each recording
- ⬜ Show transcript under each call + make it searchable
- ⬜ On-device (Whisper/Vosk) or cloud STT backend

## Settings
- ✅ Phone audio-source picker; force-speaker toggle
- ⬜ Format / quality (MP3 via LAME, bitrate, sample rate)
- ⬜ Storage location (SAF) + auto-delete old recordings / size cap
- ⬜ Record announcement / beep (consent)

## Security & backup
- ✅ Consent notice + always-on recording notification
- ⬜ PIN / biometric lock
- ⬜ Encrypt recordings at rest
- ⬜ Cloud backup (Drive / Dropbox / etc.)

## Suggested next batch (my recommendation)
1. **Search + favorite + master auto-record toggle** — quick, high-value library polish
2. **Transcription** — the actual project goal (pick on-device vs cloud)
3. **Settings**: format/quality + auto-delete
4. **PIN lock**, then **cloud backup**
