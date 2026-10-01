package com.voicetranscriber.callrecorder.connectivity

import android.content.Context
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.TimeUnit

/**
 * The safety net for [ConnectivityWatch]: its network callback only exists
 * while this process does, and Android kills idle processes. Every ~15 minutes
 * (WorkManager's floor) this re-checks and shows or clears the "no internet"
 * notice. No network constraint, on purpose - running while offline is the
 * entire point.
 */
class ConnectivityCheckWorker(context: Context, params: WorkerParameters) : Worker(context, params) {

    override fun doWork(): Result {
        ConnectivityWatch.evaluate(applicationContext)
        return Result.success()
    }

    companion object {
        private const val UNIQUE_WORK = "connectivity-check"

        /** Idempotent: KEEP preserves the running schedule across app starts. */
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<ConnectivityCheckWorker>(15, TimeUnit.MINUTES).build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniquePeriodicWork(UNIQUE_WORK, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
