package com.voicetranscriber.callrecorder.upload

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.voicetranscriber.callrecorder.App
import com.voicetranscriber.callrecorder.platform.ActivationStore
import com.voicetranscriber.callrecorder.platform.DeviceIdentity
import com.voicetranscriber.callrecorder.platform.PlatformApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Fetches transcripts back from the platform for calls this device uploaded, so
 * the app's recordings list can show them. Retries (WorkManager backoff) while
 * any call is still being processed; gives up after MAX_RUN_ATTEMPTS.
 */
class TranscriptWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val context = applicationContext
        if (!ActivationStore.isActivated(context)) return@withContext Result.success()

        val dao = App.instance.database.recordingDao()
        val awaiting = dao.awaitingTranscript()
        if (awaiting.isEmpty()) return@withContext Result.success()

        val jwt = try {
            val baseUrl = ActivationStore.apiBaseUrl(context)
            val deviceId = ActivationStore.deviceId(context) ?: return@withContext Result.success()
            val nonce = PlatformApi.challenge(baseUrl, deviceId)
            PlatformApi.authenticate(baseUrl, deviceId, nonce, DeviceIdentity.signNonce(nonce))
        } catch (t: Throwable) {
            Log.w(TAG, "JWT for transcript fetch failed; will retry", t)
            return@withContext retryOrFail()
        }

        val baseUrl = ActivationStore.apiBaseUrl(context)
        var stillProcessing = false

        for (recording in awaiting) {
            val callId = recording.remoteCallId ?: continue
            try {
                val result = PlatformApi.fetchCallResult(baseUrl, jwt, callId)
                when {
                    result.status == "COMPLETE" && !result.transcript.isNullOrBlank() -> {
                        dao.setTranscript(recording.id, result.transcript)
                        Log.i(TAG, "transcript stored for id=${recording.id}")
                    }
                    result.status.startsWith("FAILED") -> {
                        dao.setTranscript(recording.id, "[transcription failed: ${result.status}]")
                    }
                    else -> stillProcessing = true // AWAITING_AUDIO/TRANSCODING/…
                }
            } catch (t: Throwable) {
                Log.w(TAG, "transcript fetch failed for callId=$callId", t)
                stillProcessing = true
            }
        }

        if (stillProcessing) retryOrFail() else Result.success()
    }

    private fun retryOrFail(): Result =
        if (runAttemptCount < MAX_RUN_ATTEMPTS) Result.retry() else Result.success()

    private companion object {
        const val TAG = "TranscriptWorker"
        const val MAX_RUN_ATTEMPTS = 8
    }
}
