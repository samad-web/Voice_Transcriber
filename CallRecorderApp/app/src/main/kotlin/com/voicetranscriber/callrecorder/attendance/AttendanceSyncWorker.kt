package com.voicetranscriber.callrecorder.attendance

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
import androidx.work.workDataOf
import com.voicetranscriber.callrecorder.platform.ActivationStore
import java.util.concurrent.TimeUnit

/**
 * The attendance backlog outside the shift service: presence events left over
 * when the service stopped or the phone was offline, applications waiting to
 * send, and (after a config refresh) a look for request decisions. Survives
 * process death and reboots; runs only with network.
 */
class AttendanceSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        val context = applicationContext
        if (!ActivationStore.isActivated(context)) return Result.success()
        var retry = false
        try {
            if (!PresenceUploader.flush(context, honourBackoff = false)) retry = true
        } catch (t: Throwable) {
            Log.w(TAG, "presence flush failed", t)
            retry = true
        }
        if (AttendanceStore.config(context) != null) {
            if (AttendanceRequests.sendPending(context) == "Waiting to send") retry = true
            if (inputData.getBoolean(KEY_DECISIONS, false)) {
                val zone = AttendanceStore.config(context)?.timeZone ?: "UTC"
                runCatching {
                    AttendanceRequests.fetchDay(context, ShiftSchedule.dateKey(System.currentTimeMillis(), zone))
                }.onFailure { Log.w(TAG, "day fetch failed: ${it.message}") }
            }
        }
        return if (retry && runAttemptCount < 8) Result.retry() else Result.success()
    }

    companion object {
        private const val TAG = "AttendanceSync"
        private const val KEY_DECISIONS = "decisions"
        private const val UNIQUE = "attendance-sync"
        private const val UNIQUE_DECISIONS = "attendance-sync-decisions"

        fun enqueue(context: Context, checkDecisions: Boolean = false) {
            val request = OneTimeWorkRequestBuilder<AttendanceSyncWorker>()
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .setInputData(workDataOf(KEY_DECISIONS to checkDecisions))
                .build()
            // Two names: a decisions check must not be swallowed by a plain flush
            // already waiting for network. A plain flush keeps the one already
            // queued (it drains everything anyway); a decisions check replaces an
            // older one so it runs against the newest config.
            WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
                if (checkDecisions) UNIQUE_DECISIONS else UNIQUE,
                if (checkDecisions) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
                request,
            )
        }
    }
}
