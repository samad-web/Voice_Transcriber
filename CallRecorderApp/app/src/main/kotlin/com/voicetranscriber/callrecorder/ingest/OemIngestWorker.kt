package com.voicetranscriber.callrecorder.ingest

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Imports new OEM dialer recordings into the app's database.
 *
 * Two triggers, because neither alone is sufficient:
 *  - [enqueueAfterCall] right after a call ends — responsive, catches the file the dialer
 *    just wrote (with a short delay so it's finished writing).
 *  - [schedule] every 15 min — the safety net that picks up anything missed while the app
 *    was killed, plus the existing backlog on first run.
 *
 * No network needed: this only reads local files and writes rows. The upload it triggers is
 * a separate, network-constrained worker.
 */
class OemIngestWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = try {
        val count = OemRecordingIngestor.ingest(applicationContext)
        if (count > 0) Log.i(TAG, "ingested $count new OEM recording(s)")
        Result.success()
    } catch (t: Throwable) {
        Log.w(TAG, "ingest failed (attempt ${runAttemptCount + 1})", t)
        if (runAttemptCount < MAX_RUN_ATTEMPTS) Result.retry() else Result.success()
    }

    companion object {
        private const val TAG = "OemIngestWorker"
        private const val MAX_RUN_ATTEMPTS = 3
        private const val UNIQUE_PERIODIC = "oem-ingest-periodic"
        private const val UNIQUE_ONESHOT = "oem-ingest-now"

        /** The dialer needs a moment to finalize the file after hang-up. */
        private const val AFTER_CALL_DELAY_SEC = 15L

        /** Idempotent: safe on every app start (KEEP preserves the running schedule). */
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<OemIngestWorker>(15, TimeUnit.MINUTES).build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniquePeriodicWork(UNIQUE_PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        /** Fire shortly after a call ends, once the dialer has written the file. */
        fun enqueueAfterCall(context: Context) = enqueueNow(context, AFTER_CALL_DELAY_SEC)

        /** Run the import as soon as possible (also used by the scanner's "Import" action). */
        fun enqueueNow(context: Context, delaySeconds: Long = 0) {
            val request = OneTimeWorkRequestBuilder<OemIngestWorker>()
                .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(UNIQUE_ONESHOT, ExistingWorkPolicy.REPLACE, request)
        }
    }
}
