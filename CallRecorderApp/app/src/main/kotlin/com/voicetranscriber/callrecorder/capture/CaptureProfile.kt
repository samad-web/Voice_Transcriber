package com.voicetranscriber.callrecorder.capture

import android.media.MediaRecorder

/** Which tuned profile a call source wants. Resolved to a [CaptureProfile] by [CaptureSettings]. */
enum class ProfileKind { PHONE, VOIP }

/**
 * How to capture a given call: a *priority-ordered* list of audio sources to try, and
 * whether to force speakerphone for mic-type sources.
 *
 * This mirrors Cube ACR's design, which we confirmed in its decompiled code: separate
 * selectable audio sources for phone vs VoIP (`voipCallsAudioSource`,
 * `pref_title_phoneAudioSource`) plus a "use speaker for mic" toggle
 * (`useSpeakerForVoipMicAudioSource`, default true). Cube ACR got *both ends* either via
 * VOICE_CALL (where the OEM permits it) or by forcing the speaker so the far end is
 * captured acoustically. We do the same, and probe/fall back automatically.
 */
data class CaptureProfile(
    val sources: List<Int>,
    val forceSpeakerForMicSources: Boolean,
) {
    companion object {
        /**
         * Phone calls, probed in priority order:
         *  1. VOICE_CALL (4) — the true both-ends source. Modern Android restricts it to
         *     system apps so it's often unavailable, BUT it also needs the in-call audio
         *     path to be UP first: [RecordingService] delays the probe
         *     ([CaptureSettings.phoneStartDelaySeconds]) so VOICE_CALL gets its best chance
         *     to initialize and capture both sides (this is what worked on the dev device).
         *  2. VOICE_RECOGNITION (6) / 3. MIC (1) — near-end fallback that at least always
         *     yields a saved recording of the local side when VOICE_CALL is blocked.
         *
         * NOTE: VOICE_COMMUNICATION (7) is deliberately NOT in the auto-probe for cellular.
         * It opens readily (so it would WIN the probe) but on many devices delivers digital
         * SILENCE on a cellular call — which RecordingService discards as an empty file,
         * i.e. "nothing recorded". It stays available as a manual source override for
         * devices where it genuinely carries both ends.
         */
        val PHONE = CaptureProfile(
            sources = listOf(
                MediaRecorder.AudioSource.VOICE_CALL,          // 4 — uplink+downlink where allowed
                MediaRecorder.AudioSource.VOICE_RECOGNITION,   // 6 — reliable near-end capture
                MediaRecorder.AudioSource.MIC,                 // 1 — raw near-end fallback
            ),
            // Off by default: on this device, forcing the loudspeaker (which changes the
            // audio mode) DISRUPTS in-call capture and the recording goes silent. Keep it
            // opt-in — the rep taps Speaker manually to get the far end into the mic.
            forceSpeakerForMicSources = false,
        )

        /**
         * VoIP (WhatsApp/Telegram/…): on modern Android the messenger holds the mic
         * exclusively and the OS blocks concurrent capture, so recording usually yields
         * silence regardless of source. We attempt a plain MIC capture; if it comes back
         * silent, [RecordingService] discards it and notifies rather than saving an empty
         * file. We do NOT force the speaker (it can't defeat the OS block and is intrusive).
         */
        val VOIP = CaptureProfile(
            sources = listOf(MediaRecorder.AudioSource.MIC),
            forceSpeakerForMicSources = false,
        )

        fun nameOf(source: Int): String = when (source) {
            MediaRecorder.AudioSource.VOICE_CALL -> "VOICE_CALL"
            MediaRecorder.AudioSource.VOICE_DOWNLINK -> "VOICE_DOWNLINK"
            MediaRecorder.AudioSource.VOICE_UPLINK -> "VOICE_UPLINK"
            MediaRecorder.AudioSource.VOICE_RECOGNITION -> "VOICE_RECOGNITION"
            MediaRecorder.AudioSource.VOICE_COMMUNICATION -> "VOICE_COMMUNICATION"
            MediaRecorder.AudioSource.MIC -> "MIC"
            else -> "source#$source"
        }
    }
}
