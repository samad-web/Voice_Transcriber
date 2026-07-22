package com.voicetranscriber.callrecorder.capture

import android.content.Context

/**
 * User-tunable capture knobs, backed by SharedPreferences. Mirrors Cube ACR, which
 * exposes a selectable audio source precisely because the working method differs per
 * device — the user finds it empirically.
 */
class CaptureSettings(context: Context) {
    private val prefs = context.getSharedPreferences("capture", Context.MODE_PRIVATE)

    /**
     * Force speakerphone on phone calls so the far end is captured acoustically. OFF by
     * default: on this device, changing the audio mode to route the loudspeaker DISRUPTS
     * in-call mic capture (recording fails / goes silent). The reliable way to capture both
     * sides is for the rep to tap Speaker manually — the mic then hears the far end. Enable
     * this only if your device tolerates programmatic speaker routing.
     */
    var forceSpeakerForPhone: Boolean
        get() = prefs.getBoolean(KEY_PHONE_SPEAKER, false)
        set(value) = prefs.edit().putBoolean(KEY_PHONE_SPEAKER, value).apply()

    /**
     * Fixed AudioRecord source for phone calls, or [AUTO] (-1) to probe the priority list.
     * Values are MediaRecorder.AudioSource ints (4=VOICE_CALL, 3=VOICE_DOWNLINK, …).
     */
    var phoneSourceOverride: Int
        get() = prefs.getInt(KEY_PHONE_SOURCE, AUTO)
        set(value) = prefs.edit().putInt(KEY_PHONE_SOURCE, value).apply()

    /**
     * Attempt to record messenger (VoIP) calls via the accessibility service. Often blocked
     * by the OS (the app holds the mic); turn off to stop the attempts and the system notice.
     */
    var recordVoipCalls: Boolean
        get() = prefs.getBoolean(KEY_VOIP, true)
        set(value) = prefs.edit().putBoolean(KEY_VOIP, value).apply()

    /**
     * Play a short record-announcement beep when capture starts (consent transparency).
     * On by default; some jurisdictions require an audible notice that a call is recorded.
     */
    var announceRecording: Boolean
        get() = prefs.getBoolean(KEY_ANNOUNCE, true)
        set(value) = prefs.edit().putBoolean(KEY_ANNOUNCE, value).apply()

    /**
     * Encrypt the stored recording at rest (AES-256-GCM). OFF by default so the
     * local file stays a playable/shareable .m4a for the rep; upload still sends
     * the audio over TLS. Turn on for privacy at the cost of local playback.
     */
    var encryptAtRest: Boolean
        get() = prefs.getBoolean(KEY_ENCRYPT, false)
        set(value) = prefs.edit().putBoolean(KEY_ENCRYPT, value).apply()

    /**
     * Keep the audio file on the device after a successful upload (default ON so
     * the rep retains a local copy). When off, files are deleted once uploaded.
     */
    var keepLocalAfterUpload: Boolean
        get() = prefs.getBoolean(KEY_KEEP_LOCAL, true)
        set(value) = prefs.edit().putBoolean(KEY_KEEP_LOCAL, value).apply()

    /**
     * Import the OEM dialer's own call recordings (Samsung "Auto record calls", MIUI, …).
     * Those files contain BOTH sides — the system dialer taps the telephony stream, which we
     * can't — so on a supported handset this is strictly better than our own capture.
     */
    var oemIngestEnabled: Boolean
        get() = prefs.getBoolean(KEY_OEM_INGEST, true)
        set(value) = prefs.edit().putBoolean(KEY_OEM_INGEST, value).apply()

    /**
     * When the handset provides its own (both-ends) recordings, don't ALSO run our own
     * near-end-only capture — that would save two files per call, the worse one of which
     * only has the local side. Guarded at the call site by
     * [com.voicetranscriber.callrecorder.ingest.OemRecordingIngestor.isAvailable], so devices
     * without OEM recording keep capturing normally.
     */
    var preferOemRecordings: Boolean
        get() = prefs.getBoolean(KEY_PREFER_OEM, true)
        set(value) = prefs.edit().putBoolean(KEY_PREFER_OEM, value).apply()

    /**
     * Set once this handset has been seen to produce its own call recording — and then never
     * unset. The folder is empty until the first call completes, so without this sticky flag
     * the availability check says "no OEM recording here", we capture as well, and the very
     * first call on a fresh phone ends up recorded TWICE.
     */
    var oemRecordingSeen: Boolean
        get() = prefs.getBoolean(KEY_OEM_SEEN, false)
        set(value) = prefs.edit().putBoolean(KEY_OEM_SEEN, value).apply()

    /**
     * Comma-separated folders (relative to external storage) to import from. Configurable
     * because the location differs by OEM and OS version — the defaults are the two Samsung
     * One UI locations confirmed on device; add e.g. `MIUI/sound_recorder/call_rec` for Xiaomi.
     */
    var oemFolders: String
        get() = prefs.getString(KEY_OEM_FOLDERS, DEFAULT_OEM_FOLDERS) ?: DEFAULT_OEM_FOLDERS
        set(value) = prefs.edit().putString(KEY_OEM_FOLDERS, value).apply()

    fun profileFor(kind: ProfileKind): CaptureProfile = when (kind) {
        ProfileKind.PHONE -> {
            // Base tries VOICE_CALL first (clean both-ends where the OEM allows it), then
            // mic sources. When it lands on a mic source, forceSpeakerForMicSources makes
            // the AudioCapturer engage the loudspeaker so the far end is captured
            // acoustically — the only method that works once VOICE_CALL is blocked.
            val base =
                if (phoneSourceOverride != AUTO) {
                    // Explicit pin wins; keep the rest as fallback so it never fails outright.
                    val rest = CaptureProfile.PHONE.sources.filter { it != phoneSourceOverride }
                    CaptureProfile.PHONE.copy(sources = listOf(phoneSourceOverride) + rest)
                } else {
                    CaptureProfile.PHONE
                }
            base.copy(forceSpeakerForMicSources = forceSpeakerForPhone)
        }
        ProfileKind.VOIP -> CaptureProfile.VOIP
    }

    companion object {
        const val AUTO = -1

        /**
         * Candidate OEM call-recording folders, most likely first. Non-existent entries are
         * skipped, so listing every known brand is free.
         *
         * NOTE: there is deliberately no Google Phone (Pixel/Motorola/Nokia) entry — it keeps
         * recordings in `Android/data/com.google.android.dialer/`, which Android 11+ blocks
         * for every other app (All-files access and SAF both refuse it, and the files aren't
         * in MediaStore). Those handsets cannot be ingested from without root.
         */
        const val DEFAULT_OEM_FOLDERS =
            "Recordings/Call," +                      // Samsung One UI (confirmed, SM-M136B)
                "Call," +                             // Samsung (legacy)
                "Sounds," +                           // Samsung (older still)
                "MIUI/sound_recorder/call_rec," +     // Xiaomi / Redmi / POCO
                "Recordings/CallRecord," +            // Xiaomi HyperOS
                "Record/Call," +                      // Vivo, OnePlus, some Oppo
                "Recordings/Call Recordings," +       // Realme / Oppo ColorOS
                "Music/Recordings/Call Recordings," + // Oppo (older ColorOS)
                "PhoneRecord," +
                "CallRecordings"

        private const val KEY_PHONE_SPEAKER = "forceSpeakerForPhone"
        private const val KEY_PHONE_SOURCE = "phoneSourceOverride"
        private const val KEY_OEM_INGEST = "oemIngestEnabled"
        private const val KEY_PREFER_OEM = "preferOemRecordings"
        private const val KEY_OEM_SEEN = "oemRecordingSeen"
        private const val KEY_OEM_FOLDERS = "oemFolders"
        private const val KEY_VOIP = "recordVoipCalls"
        private const val KEY_ANNOUNCE = "announceRecording"
        private const val KEY_ENCRYPT = "encryptAtRest"
        private const val KEY_KEEP_LOCAL = "keepLocalAfterUpload"
    }
}
