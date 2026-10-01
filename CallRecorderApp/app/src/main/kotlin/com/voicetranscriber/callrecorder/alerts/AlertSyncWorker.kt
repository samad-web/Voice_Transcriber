package com.voicetranscriber.callrecorder.alerts

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import com.voicetranscriber.callrecorder.platform.ActivationStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/**
 * The durable path for [AlertSync]: waits for a network, survives the process
 * dying, retries with backoff. Used when the push-time sync failed, when a
 * "Got it" receipt needs sending, when the phone comes back online, and after
 * the hourly config refresh.
 *
 * Not expedited, for the reason [com.voicetranscriber.callrecorder.platform.ConfigRefreshWorker]
 * gives: below API 31 that needs a foreground notification, and minSdk is 26.
 */
class AlertSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        if (!ActivationStore.isActivated(applicationContext)) return Result.success()
        return try {
            withContext(Dispatchers.IO) { AlertSync.sync(applicationContext) }
            Result.success()
        } catch (t: Throwable) {
            Log.w(TAG, "alert sync failed (attempt ${runAttemptCount + 1})", t)
            if (runAttemptCount < MAX_RUN_ATTEMPTS) Result.retry() else Result.success()
        }
    }

    companion object {
        private const val TAG = "AlertSyncWorker"
        private const val MAX_RUN_ATTEMPTS = 5
        private const val UNIQUE_WORK = "handset-alert-sync"

        /**
         * APPEND_OR_REPLACE: a second request while one is running queues one
         * more pass rather than being dropped - the running pass may already
         * have fetched, and the alert that woke this call would wait an hour.
         */
        fun enqueue(context: Context) {
            val request = OneTimeWorkRequestBuilder<AlertSyncWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(UNIQUE_WORK, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
        }
    }
}
