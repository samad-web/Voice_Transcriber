package com.voicetranscriber.callrecorder.capture

import android.annotation.SuppressLint
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.util.Log
import com.voicetranscriber.callrecorder.App
import java.io.File
import kotlin.concurrent.thread

/**
 * PCM capture via [AudioRecord] → [AacEncoder]. The source is chosen by probing
 * [CaptureProfile.sources] in priority order, and — crucially — each source is
 * tried at BOTH 8 kHz and 16 kHz. Clean-room version of Cube ACR's capture, which
 * we confirmed records calls at 8 kHz (`C6032c`): the telephony sources
 * (VOICE_CALL / VOICE_COMMUNICATION) are narrowband and often only initialize at
 * 8 kHz, so a fixed 16 kHz open fails and the app silently falls back to a mic
 * source that hears only the near end. Probing 8 kHz lets VOICE_CALL succeed and
 * capture BOTH ends directly where the OEM permits it.
 *
 * Bluetooth: if the call is on a BT headset, route audio through SCO and capture
 * VOICE_COMMUNICATION (SCO doesn't carry VOICE_CALL). Best-effort — device dependent.
 *
 * Fallback: if no both-ends source opens, we use a raw mic source and force the
 * loudspeaker so the far end plays out loud and the mic captures it acoustically
 * (requires the call on speaker). See logcat: adb logcat -s AudioCapturer
 */
class AudioCapturer(
    private val profile: CaptureProfile,
    private val outFile: File,
    // Preferred rate. 16 kHz suits ASR; we fall back to 8 kHz when a call source
    // only initializes there (telephony narrowband).
    private val sampleRate: Int = 16_000,
) {
    private var encoder: AacEncoder? = null
    private val am: AudioManager = App.instance.getSystemService(AudioManager::class.java)
    private val sco = BluetoothScoController(am)

    @Volatile private var running = false
    @Volatile private var sawAudio = false
    private var worker: Thread? = null
    private var chosenSource = -1
    private var chosenRate = sampleRate
    private var chosenBufSize = 0
    private var btRouted = false

    /** True once any real (non-silent) audio was captured. False = we were handed silence. */
    val capturedAudio: Boolean get() = sawAudio

    private var speakerEngaged = false
    private var restoreMode = AudioManager.MODE_NORMAL
    private var restoreSpeaker = false
    private var clearCommDevice = false

    /** Source (+ rate) that won the probe, annotated if routed over Bluetooth (for the UI row). */
    val activeSourceName: String
        get() = "${CaptureProfile.nameOf(chosenSource)}@${chosenRate}" + if (btRouted) " (BT)" else ""

    @SuppressLint("MissingPermission") // RECORD_AUDIO requested at runtime
    fun start() {
        // On a Bluetooth headset call, route via SCO and capture VOICE_COMMUNICATION.
        btRouted = sco.headsetPresent()
        if (btRouted) sco.engage()
        val sources = if (btRouted) BT_SOURCES else profile.sources

        val record = openBestSource(sources)
            ?: run {
                sco.release()
                throw IllegalStateException("No usable audio source (mic busy, denied, or all blocked)")
            }
        Log.i(
            TAG,
            "Capturing with ${CaptureProfile.nameOf(chosenSource)} @ ${chosenRate}Hz" +
                if (btRouted) " over Bluetooth SCO" else "",
        )

        if (!btRouted) engageSpeakerIfNeeded()
        val enc = AacEncoder(outFile, chosenRate).also { it.start() }
        encoder = enc
        running = true

        val bufSize = chosenBufSize
        worker = thread(name = "audio-capture") {
            val buffer = ByteArray(bufSize)
            try {
                while (running) {
                    val n = record.read(buffer, 0, buffer.size)
                    when {
                        n > 0 -> {
                            if (!sawAudio && hasSignal(buffer, n)) sawAudio = true
                            enc.feed(buffer, n)
                        }
                        n < 0 -> running = false
                    }
                }
            } finally {
                runCatching { record.stop() }
                runCatching { record.release() }
                enc.finish()
                disengageSpeaker()
                sco.release()
            }
        }
    }

    fun stop() {
        running = false
        worker?.join(2_000)
        worker = null
    }

    /**
     * Rates to try per source. VOICE_CALL / VOICE_DOWNLINK carry BOTH ends but are
     * narrowband — they only open at the telephony HAL's 8 kHz (this is how Cube ACR
     * captures both sides: it records calls at 8 kHz, see C6032c). We try 8 kHz FIRST for
     * those, then 16 kHz. Mic sources stay at the proven 16 kHz. No audio-mode change is
     * involved, so this cannot disrupt capture the way forcing the speaker did.
     */
    private fun candidateRates(source: Int): List<Int> = when (source) {
        MediaRecorder.AudioSource.VOICE_CALL,
        MediaRecorder.AudioSource.VOICE_DOWNLINK,
        MediaRecorder.AudioSource.VOICE_UPLINK -> listOf(8_000, 16_000)
        else -> listOf(sampleRate)
    }.distinct()

    @SuppressLint("MissingPermission")
    private fun openBestSource(sources: List<Int>): AudioRecord? {
        for (source in sources) {
            for (rate in candidateRates(source)) {
                val minBuf = AudioRecord.getMinBufferSize(
                    rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                )
                if (minBuf <= 0) continue
                val bufSize = minBuf * 4
                var record: AudioRecord? = null
                try {
                    record = AudioRecord(
                        source, rate,
                        AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufSize,
                    )
                    if (record.state != AudioRecord.STATE_INITIALIZED) {
                        Log.d(TAG, "${CaptureProfile.nameOf(source)}@$rate: not initialized")
                        record.release()
                        continue
                    }
                    record.startRecording()
                    if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                        Log.d(TAG, "${CaptureProfile.nameOf(source)}@$rate: didn't enter recording state")
                        record.stop(); record.release()
                        continue
                    }
                    chosenSource = source
                    chosenRate = rate
                    chosenBufSize = bufSize
                    return record
                } catch (t: Throwable) {
                    Log.d(TAG, "${CaptureProfile.nameOf(source)}@$rate unavailable: ${t.message}")
                    record?.let { r -> runCatching { r.release() } }
                }
            }
        }
        return null
    }

    private fun engageSpeakerIfNeeded() {
        // Only raw mic sources need the speaker — VOICE_CALL/VOICE_COMMUNICATION already
        // carry the far end (and forcing speaker onto VOICE_COMMUNICATION's AEC would
        // strip it). MIC / VOICE_RECOGNITION hear only the near end, so play the far end
        // out loud and capture it acoustically.
        val rawMic = chosenSource == MediaRecorder.AudioSource.MIC ||
            chosenSource == MediaRecorder.AudioSource.VOICE_RECOGNITION
        if (!(profile.forceSpeakerForMicSources && rawMic)) return
        // Speaker routing must NEVER fail the recording — capture is already running by
        // now. Any error here just means we may capture one side; we still keep the file.
        try {
            restoreMode = am.mode
            am.mode = AudioManager.MODE_IN_COMMUNICATION
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // Android 12+: isSpeakerphoneOn is deprecated and widely ignored. Route
                // audio to the built-in loudspeaker via the communication-device API so the
                // far end actually plays out loud (and the mic can hear it).
                val speaker = am.availableCommunicationDevices
                    .firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
                if (speaker != null && am.setCommunicationDevice(speaker)) clearCommDevice = true
                else Log.w(TAG, "could not route to loudspeaker; far-end capture may be silent")
            } else {
                @Suppress("DEPRECATION") run {
                    restoreSpeaker = am.isSpeakerphoneOn
                    am.isSpeakerphoneOn = true
                }
            }
            speakerEngaged = true
            Log.i(TAG, "Forced speakerphone for far-end capture (source=${CaptureProfile.nameOf(chosenSource)})")
        } catch (t: Throwable) {
            Log.w(TAG, "speaker engage failed; recording continues without it", t)
        }
    }

    private fun disengageSpeaker() {
        if (!speakerEngaged) return
        speakerEngaged = false
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (clearCommDevice) {
                am.clearCommunicationDevice()
                clearCommDevice = false
            }
        } else {
            @Suppress("DEPRECATION") run { am.isSpeakerphoneOn = restoreSpeaker }
        }
        am.mode = restoreMode
    }

    /** Cheap sparse scan for any non-silent 16-bit sample (blocked capture is digital zero). */
    private fun hasSignal(buf: ByteArray, len: Int): Boolean {
        var i = 0
        while (i + 1 < len) {
            val sample = ((buf[i + 1].toInt() shl 8) or (buf[i].toInt() and 0xFF)).toShort().toInt()
            if (kotlin.math.abs(sample) > SILENCE_THRESHOLD) return true
            i += 64
        }
        return false
    }

    private companion object {
        const val TAG = "AudioCapturer"
        const val SILENCE_THRESHOLD = 30
        // SCO carries communication audio, not the VOICE_CALL modem stream.
        val BT_SOURCES = listOf(
            MediaRecorder.AudioSource.VOICE_COMMUNICATION,
            MediaRecorder.AudioSource.VOICE_RECOGNITION,
            MediaRecorder.AudioSource.MIC,
        )
    }
}
