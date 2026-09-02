package com.voicetranscriber.callrecorder.update

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
 * Periodic update check (~6h): asks the server for a newer build, downloads and
 * verifies it, then posts the notification that offers it.
 *
 * Six hours, not one. The config poll runs hourly because remote logout and wipe
 * are safety controls that must land fast; a new APK is not urgent, and each
 * check that finds something costs a multi-megabyte download on a handset that
 * is also uploading call audio all day.
 */
class AppUpdateWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result {
        return when (val outcome = AppUpdateManager.sync(applicationContext)) {
            is AppUpdateManager.Outcome.Ready -> {
                UpdateNotification.show(applicationContext, outcome.versionName, outcome.notes)
                Log.i(TAG, "v${outcome.versionName} ready to install")
                Result.success()
            }

            is AppUpdateManager.Outcome.UpToDate -> {
                // Covers the moment after a successful self-update: the phone is
                // now ON the build the notification was advertising, so the
                // notification has to go with it.
                UpdateNotification.dismiss(applicationContext)
                Result.success()
            }

            // Never Result.failure(): a failed update check is not a failed
            // device. WorkManager would keep the failure on the record and, more
            // to the point, there is nothing here worth escalating - the next
            // cycle tries again. Recording was never affected either way.
            is AppUpdateManager.Outcome.Unavailable -> {
                Log.i(TAG, "no update this cycle: ${outcome.reason}")
                Result.success()
            }
        }
    }

    companion object {
        private const val TAG = "AppUpdateWorker"
        private const val UNIQUE_WORK = "app-update-check"

        /** Idempotent: safe on every app start (KEEP preserves the running schedule). */
        fun schedule(context: Context) {
            val constraints = Constraints.Builder()
                // UNMETERED = wifi. Matches the fleet's existing posture -
                // DeviceConfig ships wifiOnlyUpload=true, so these handsets are
                // already assumed to reach wifi regularly for call uploads, and
                // a multi-MB APK has less claim on a mobile data plan than the
                // recordings do. The tradeoff: a phone that genuinely never sees
                // wifi never updates. If that turns up in the fleet, the manual
                // "Check for updates" in the settings sheet has no such
                // constraint, and CONNECTED is a one-word change here.
                .setRequiredNetworkType(NetworkType.UNMETERED)
                // A device below 15% battery is one the holder needs for calls,
                // not one that should be pulling megabytes in the background.
                .setRequiresBatteryNotLow(true)
                .setRequiresStorageNotLow(true)
                .build()
            val request = PeriodicWorkRequestBuilder<AppUpdateWorker>(6, TimeUnit.HOURS)
                .setConstraints(constraints)
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniquePeriodicWork(UNIQUE_WORK, ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
