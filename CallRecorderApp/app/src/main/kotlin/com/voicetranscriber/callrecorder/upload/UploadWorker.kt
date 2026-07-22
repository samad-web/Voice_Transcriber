package com.voicetranscriber.callrecorder.upload

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.voicetranscriber.callrecorder.App
import com.voicetranscriber.callrecorder.capture.CaptureSettings
import com.voicetranscriber.callrecorder.platform.ActivationStore
import com.voicetranscriber.callrecorder.platform.DeviceIdentity
import com.voicetranscriber.callrecorder.platform.FileCrypto
import com.voicetranscriber.callrecorder.platform.PlatformApi
import com.voicetranscriber.callrecorder.storage.RecordingEntity
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.InputStream
import java.time.Instant

/**
 * Drains finished-but-not-yet-uploaded recordings to the platform.
 *
 * Per run: acquire a short-lived device JWT (challenge → Keystore-sign →
 * authenticate), then for each PENDING/FAILED recording compute its SHA-256,
 * POST /v1/calls, PUT each part, POST /complete, and — matching the existing
 * local-retention behaviour — delete the local file only after the server
 * confirms UPLOADED. Failures are recorded per-recording and don't abort the batch.
 */
class UploadWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val context = applicationContext

        // The single gate every capture/upload path asks first.
        if (!ActivationStore.isRecordingAllowed(context)) {
            Log.i(TAG, "skip — device not activated or recording disabled")
            return@withContext Result.success()
        }

        val dao = App.instance.database.recordingDao()
        val pending = dao.pendingUploads()
        if (pending.isEmpty()) return@withContext Result.success()

        // Acquire a device access JWT once for the whole batch.
        val jwt = try {
            acquireJwt(context)
        } catch (t: Throwable) {
            Log.w(TAG, "JWT acquisition failed; will retry", t)
            return@withContext retryOrFail()
        }

        val baseUrl = ActivationStore.apiBaseUrl(context)
        var hadFailure = false

        for (recording in pending) {
            try {
                uploadOne(baseUrl, jwt, dao, recording)
            } catch (t: Throwable) {
                hadFailure = true
                val attempts = recording.attemptCount + 1
                Log.w(TAG, "upload failed for id=${recording.id} (attempt $attempts)", t)
                dao.setUploadResult(
                    id = recording.id,
                    uploadState = STATE_FAILED,
                    remoteCallId = recording.remoteCallId,
                    attemptCount = attempts,
                    lastError = (t.message ?: t.javaClass.simpleName).take(300),
                )
            }
        }

        // Uploaded calls now have a remoteCallId — fetch their transcripts so the
        // app's recordings list can show them.
        UploadScheduler.enqueueTranscriptFetch(context)

        if (hadFailure) retryOrFail() else Result.success()
    }

    private suspend fun uploadOne(
        baseUrl: String,
        jwt: String,
        dao: com.voicetranscriber.callrecorder.storage.RecordingDao,
        recording: RecordingEntity,
    ) {
        val file = File(recording.filePath)
        if (!file.exists() || file.length() == 0L) {
            // Nothing on disk to send — retain the row but take it out of the queue.
            dao.setUploadResult(
                id = recording.id,
                uploadState = STATE_DISCARDED,
                remoteCallId = recording.remoteCallId,
                attemptCount = recording.attemptCount + 1,
                lastError = "local file missing or empty",
            )
            return
        }

        dao.setUploadState(recording.id, STATE_UPLOADING)

        // At-rest encryption: recordings are stored as AES-256-GCM ".enc" files.
        // Decrypt to a temp file so the bytes we hash + upload are the original
        // plaintext (encrypted only on disk, decrypted inside the pipeline; bytes
        // travel plaintext over TLS). Legacy plaintext files upload directly.
        val encrypted = file.name.endsWith(".enc")
        val plainFile = if (encrypted) FileCrypto.decryptToTemp(file) else file
        try {
            val sha256 = UploadApi.sha256Hex(plainFile)
            val bytes = plainFile.length()
            dao.setUploadProgress(recording.id, sha256, 0)

            val startedAtIso = Instant.ofEpochMilli(recording.startedAt).toString()
            val durationS = ((recording.endedAt ?: recording.startedAt) - recording.startedAt)
                .coerceAtLeast(0) / 1000

            // callee holds the resolved contact name OR the raw number. Send the raw
            // string as remoteNumber (server keeps only the first 5 digits) and, when
            // it's clearly a name (has letters), also as remoteName for the call label.
            val callee = recording.callee?.trim()
            val calleeIsName = callee?.any { it.isLetter() } == true

            val created = UploadApi.createCall(
                baseUrl = baseUrl,
                jwt = jwt,
                idempotencyKey = "local-${recording.id}",
                direction = recording.direction,
                startedAt = startedAtIso,
                durationS = durationS,
                audioSourceUsed = recording.audioSource,
                sha256 = sha256,
                bytes = bytes,
                // Reflects whether the record-announcement tone is enabled (played at
                // capture start; see RecordingService.playConsentTone).
                consentPlayed = CaptureSettings(applicationContext).announceRecording,
                remoteNumber = callee,
                remoteName = if (calleeIsName) callee else null,
            )

            val parts = ArrayList<UploadApi.PartResult>()
            var uploaded = 0L
            plainFile.inputStream().buffered().use { input ->
                var n = 1
                while (true) {
                    val chunk = readChunk(input, created.partSizeBytes)
                    if (chunk.isEmpty()) break
                    val url = created.partUrls.getOrNull(n - 1)
                        ?: throw IllegalStateException("server returned ${created.partUrls.size} part URLs, need at least $n")
                    val etag = UploadApi.uploadPart(url, chunk)
                    parts.add(UploadApi.PartResult(n, etag))
                    uploaded += chunk.size
                    dao.setUploadProgress(recording.id, sha256, uploaded)
                    n++
                }
            }

            UploadApi.completeCall(
                baseUrl = baseUrl,
                jwt = jwt,
                callId = created.callId,
                uploadId = created.uploadId,
                parts = parts,
                sha256 = sha256,
            )

            // Success: mark UPLOADED. Keep the local file by default so the rep
            // retains a playable/shareable copy; delete only if retention is off.
            dao.setUploadResult(
                id = recording.id,
                uploadState = STATE_UPLOADED,
                remoteCallId = created.callId,
                attemptCount = recording.attemptCount + 1,
                lastError = null,
            )
            if (!CaptureSettings(applicationContext).keepLocalAfterUpload) {
                runCatching { file.delete() }
            }
            Log.i(TAG, "uploaded id=${recording.id} -> callId=${created.callId}")
        } finally {
            // Always remove the decrypted temp; the .enc original is kept on failure for retry.
            if (encrypted) runCatching { plainFile.delete() }
        }
    }

    /** challenge → Keystore-sign → authenticate. Returns a 15-min access JWT. */
    private fun acquireJwt(context: Context): String {
        val baseUrl = ActivationStore.apiBaseUrl(context)
        val deviceId = ActivationStore.deviceId(context)
            ?: throw IllegalStateException("device not enrolled")
        val nonce = PlatformApi.challenge(baseUrl, deviceId)
        val signature = DeviceIdentity.signNonce(nonce)
        return PlatformApi.authenticate(baseUrl, deviceId, nonce, signature)
    }

    private fun retryOrFail(): Result =
        if (runAttemptCount < MAX_RUN_ATTEMPTS) Result.retry() else Result.success()

    /** Reads up to [size] bytes from [input]; returns fewer only at EOF. */
    private fun readChunk(input: InputStream, size: Long): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        var remaining = size
        while (remaining > 0) {
            val toRead = minOf(buffer.size.toLong(), remaining).toInt()
            val read = input.read(buffer, 0, toRead)
            if (read < 0) break
            out.write(buffer, 0, read)
            remaining -= read
        }
        return out.toByteArray()
    }

    companion object {
        private const val TAG = "UploadWorker"
        private const val MAX_RUN_ATTEMPTS = 5

        private const val STATE_UPLOADING = "UPLOADING"
        private const val STATE_UPLOADED = "UPLOADED"
        private const val STATE_FAILED = "FAILED"
        private const val STATE_DISCARDED = "DISCARDED"
    }
}
