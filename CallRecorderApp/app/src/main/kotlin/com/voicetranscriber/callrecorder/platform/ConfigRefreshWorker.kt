package com.voicetranscriber.callrecorder.platform

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * Periodic remote-config refresh (~1h) so server-side policy changes - remote
 * logout / wipe / recordingEnabled toggles - reach the device without a manual
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
            Log.i(TAG, "skip - device not activated")
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

        /**
         * A distinct unique name from [UNIQUE_WORK]: WorkManager keeps one
         * chain per name, and enqueuing a one-time request under the name that
         * holds the periodic poll would cancel the poll outright - trading the
         * guaranteed hourly path for a single push-triggered run.
         */
        private const val UNIQUE_WORK_NOW = "device-config-refresh-now"

        /**
         * One-shot refresh for the FCM push path ([AuraFirebaseMessagingService]).
         *
         * Deliberately NOT expedited work: below API 31 WorkManager runs an
         * expedited request as a foreground service and throws
         * IllegalStateException if the worker has no getForegroundInfo()
         * override, and minSdk here is 26 - it would crash on exactly the older
         * handsets this fleet runs. A plain one-time request is enough anyway;
         * the push has just woken the process and the constraint is already met.
         */
        fun runNow(context: Context) {
            val request = OneTimeWorkRequestBuilder<ConfigRefreshWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(UNIQUE_WORK_NOW, ExistingWorkPolicy.REPLACE, request)
        }

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
