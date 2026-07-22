package com.voicetranscriber.callrecorder.platform

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Periodic remote-config refresh (~1h) so server-side policy changes — remote
 * logout / wipe / recordingEnabled toggles — reach the device without a manual
 * refresh. Delegates to [ActivationManager.refreshConfig], which closes the local
 * gate on a 401 (revoked device). No-ops when the device isn't activated.
 */
class ConfigRefreshWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val context = applicationContext
        if (!ActivationStore.isActivated(context)) {
            Log.i(TAG, "skip — device not activated")
            return Result.success()
        }
        return try {
            val result = ActivationManager.refreshConfig(context)
            Log.i(TAG, result)
            Result.success()
        } catch (t: Throwable) {
            Log.w(TAG, "config refresh failed (attempt ${runAttemptCount + 1})", t)
            if (runAttemptCount < MAX_RUN_ATTEMPTS) Result.retry() else Result.success()
        }
    }

    companion object {
        private const val TAG = "ConfigRefreshWorker"
        private const val MAX_RUN_ATTEMPTS = 3
        private const val UNIQUE_WORK = "device-config-refresh"

        /** Idempotent: safe to call on every app start (KEEP preserves the running schedule). */
        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val request = PeriodicWorkRequestBuilder<ConfigRefreshWorker>(1, TimeUnit.HOURS)
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniquePeriodicWork(UNIQUE_WORK, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
