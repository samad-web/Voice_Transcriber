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
 * Periodic device-health reporter (~6h). Posts battery / accessibility / storage /
 * pending-upload telemetry and drains queued call-detection events. No-ops on a
 * device that isn't activated.
 */
class HealthWorker(
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
            HealthReporter.report(context)
            Result.success()
        } catch (t: Throwable) {
            Log.w(TAG, "health report failed (attempt ${runAttemptCount + 1})", t)
            if (runAttemptCount < MAX_RUN_ATTEMPTS) Result.retry() else Result.success()
        }
    }

    companion object {
        private const val TAG = "HealthWorker"
        private const val MAX_RUN_ATTEMPTS = 3
        private const val UNIQUE_WORK = "device-health"

        /** Idempotent: safe to call on every app start (KEEP preserves the running schedule). */
        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build()
            val request = PeriodicWorkRequestBuilder<HealthWorker>(6, TimeUnit.HOURS)
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniquePeriodicWork(UNIQUE_WORK, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
