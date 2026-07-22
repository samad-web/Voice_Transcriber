package com.voicetranscriber.callrecorder.service

import android.app.Notification
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import com.voicetranscriber.callrecorder.App
import com.voicetranscriber.callrecorder.R
import com.voicetranscriber.callrecorder.capture.AudioCapturer
import com.voicetranscriber.callrecorder.capture.CaptureSettings
import com.voicetranscriber.callrecorder.platform.FileCrypto
import com.voicetranscriber.callrecorder.recordings.SourceRegistry
import com.voicetranscriber.callrecorder.storage.RecordingEntity
import com.voicetranscriber.callrecorder.upload.UploadScheduler
import com.voicetranscriber.callrecorder.util.RecordingNaming
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * The "hands" — owns the capture pipeline and lives as a microphone foreground
 * service so it survives while the call app is in front. Analogue of Cube ACR's
 * recording service + `ExternalRecordingWork`.
 */
class RecordingService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var capturer: AudioCapturer? = null
    private var current: RecordingEntity? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> beginRecording(
                sourceId = intent.getStringExtra(EXTRA_SOURCE_ID) ?: SourceRegistry.telephony().id,
                callee = intent.getStringExtra(EXTRA_CALLEE),
                direction = intent.getStringExtra(EXTRA_DIRECTION),
            )
            ACTION_STOP -> stopRecording()
        }
        return START_STICKY
    }

    private fun beginRecording(sourceId: String, callee: String?, direction: String?) {
        if (capturer != null) return // already recording
        // Defense in depth for the activation gate: the receiver already checks,
        // but no capture may ever start on an un-enrolled/disabled device.
        if (!com.voicetranscriber.callrecorder.platform.ActivationStore.isRecordingAllowed(this)) {
            Log.i(TAG, "beginRecording refused — device not activated or recording disabled")
            stopSelf()
            return
        }
        val source = SourceRegistry.BUILT_IN.firstOrNull { it.id == sourceId }
            ?: SourceRegistry.telephony()

        startForeground(NOTIF_ID, buildNotification(callee ?: getString(R.string.unknown_caller)))

        // Name the file after the number (falls back to "call" when unknown, e.g. outgoing).
        val safeName = (callee ?: "call").replace(Regex("[^0-9A-Za-z+]"), "").take(24).ifEmpty { "call" }
        val outFile = File(recordingsDir(), "${safeName}_${startedAtMillisPlaceholder()}.m4a")
        current = RecordingEntity(
            filePath = outFile.absolutePath,
            sourceId = source.id,
            callee = callee,
            startedAt = System.currentTimeMillis(),
            direction = direction,
        )
        try {
            val profile = CaptureSettings(this).profileFor(source.profileKind)
            val cap = AudioCapturer(profile, outFile)
            cap.start()
            capturer = cap
            // Record which source actually won the probe, so the UI can show it.
            current = current?.copy(audioSource = cap.activeSourceName)
            // Consent transparency: play a short record-announcement beep (default on).
            if (CaptureSettings(this).announceRecording) playConsentTone()
        } catch (t: Throwable) {
            Log.e(TAG, "Failed to start capture", t)
            capturer = null
            current = null
            notifyFailure(t.message)
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun stopRecording() {
        val cap = capturer ?: return
        cap.stop()
        val hadAudio = cap.capturedAudio
        capturer = null
        val entity = current?.copy(endedAt = System.currentTimeMillis())
        current = null

        // IMPORTANT: do NOT stopSelf() before the DB write finishes — that cancels this
        // scope mid-delay and the recording is lost (the bug that made calls "not record").
        // Save first so a recording is never lost, then enrich, then stop the service.
        scope.launch {
            try {
                if (entity != null && !hadAudio) {
                    // Nothing was captured — e.g. a VoIP app holds the mic exclusively
                    // (Android blocks concurrent capture). Don't save an empty file.
                    Log.w(TAG, "No audio captured; discarding empty recording")
                    runCatching { File(entity.filePath).delete() }
                    withContext(Dispatchers.Main) { notifyFailure(getString(R.string.record_blocked)) }
                } else if (entity != null) {
                    val dao = App.instance.database.recordingDao()
                    val id = dao.insert(entity)

                    // Resolve the caller's name/number (phone calls read the call log).
                    val telephony = entity.sourceId == SourceRegistry.telephony().id
                    val info = if (telephony) {
                        delay(1_200) // let the system write the call-log row
                        CallLogReader.latest(applicationContext)
                    } else {
                        null
                    }
                    val name = info?.name ?: info?.number ?: entity.callee
                    val direction = info?.direction ?: entity.direction

                    // Rename the file to "<name> <date time>.m4a" — for phone AND VoIP.
                    val newPath = RecordingNaming.renameToReadable(entity.filePath, name, entity.startedAt)

                    // Keep the recording as a plaintext .m4a by default so the rep can
                    // play and share it locally. If at-rest encryption is enabled, store
                    // an AES-256-GCM .m4a.enc instead (the upload worker decrypts a temp
                    // copy only inside the pipeline; local playback is then unavailable).
                    val storedPath =
                        if (CaptureSettings(this@RecordingService).encryptAtRest) {
                            try {
                                val plain = File(newPath)
                                val enc = File("$newPath.enc")
                                FileCrypto.encryptFile(plain, enc)
                                plain.delete()
                                enc.absolutePath
                            } catch (t: Throwable) {
                                Log.e(TAG, "at-rest encryption failed; retaining plaintext", t)
                                newPath
                            }
                        } else {
                            newPath
                        }
                    dao.updateResolved(id, storedPath, name, direction)

                    // DB write is durable now — hand the recording to the upload subsystem.
                    // (Enqueued AFTER the save so we never lose a recording; the worker
                    // itself re-checks the activation gate before touching the network.)
                    UploadScheduler.enqueue(applicationContext)
                }
            } finally {
                withContext(Dispatchers.Main) {
                    stopForeground(STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            }
        }
    }

    /**
     * A ~200ms beep on the voice-call stream so both parties hear that recording started.
     * ToneGenerator plays asynchronously, so release it shortly after the tone finishes.
     */
    private fun playConsentTone() {
        runCatching {
            val tone = ToneGenerator(AudioManager.STREAM_VOICE_CALL, CONSENT_TONE_VOLUME)
            tone.startTone(ToneGenerator.TONE_PROP_BEEP, CONSENT_TONE_MS)
            scope.launch {
                delay((CONSENT_TONE_MS + 100).toLong())
                runCatching { tone.release() }
            }
        }.onFailure { Log.w(TAG, "consent tone failed", it) }
    }

    /** Surfaces a capture-start failure so it isn't silent (e.g. mic busy, source unsupported). */
    private fun notifyFailure(reason: String?) {
        val n = NotificationCompat.Builder(this, App.CHANNEL_RECORDING)
            .setContentTitle(getString(R.string.record_failed_title))
            .setContentText(reason ?: getString(R.string.record_failed_text))
            .setSmallIcon(android.R.drawable.stat_notify_error)
            .setAutoCancel(true)
            .build()
        getSystemService(NotificationManager::class.java).notify(NOTIF_FAIL_ID, n)
    }

    private fun buildNotification(callee: String): Notification =
        NotificationCompat.Builder(this, App.CHANNEL_RECORDING)
            .setContentTitle(getString(R.string.recording_title))
            .setContentText(getString(R.string.recording_text, callee))
            .setSmallIcon(android.R.drawable.presence_audio_online)
            .setOngoing(true) // transparency: user always sees recording is active
            .build()

    private fun recordingsDir(): File =
        File(getExternalFilesDir(null), "recordings").apply { mkdirs() }

    override fun onDestroy() {
        capturer?.stop()
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val ACTION_START = "start"
        private const val ACTION_STOP = "stop"
        private const val EXTRA_SOURCE_ID = "source_id"
        private const val EXTRA_CALLEE = "callee"
        private const val EXTRA_DIRECTION = "direction"
        private const val NOTIF_ID = 42
        private const val NOTIF_FAIL_ID = 43
        private const val TAG = "RecordingService"
        private const val CONSENT_TONE_MS = 200
        private const val CONSENT_TONE_VOLUME = 80 // 0..100

        fun start(context: Context, sourceId: String, callee: String?, direction: String? = null) {
            val i = Intent(context, RecordingService::class.java).apply {
                action = ACTION_START
                putExtra(EXTRA_SOURCE_ID, sourceId)
                putExtra(EXTRA_CALLEE, callee)
                putExtra(EXTRA_DIRECTION, direction)
            }
            context.startForegroundService(i)
        }

        fun stop(context: Context) {
            context.startService(Intent(context, RecordingService::class.java).apply { action = ACTION_STOP })
        }

        // Kept as a function so timestamping stays in one place.
        private fun startedAtMillisPlaceholder(): Long = System.currentTimeMillis()
    }
}
