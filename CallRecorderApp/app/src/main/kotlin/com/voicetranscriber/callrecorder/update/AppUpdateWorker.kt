package com.voicetranscriber.callrecorder.update

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit

/**
 * Periodic update check (~6h): asks the server for a newer build, downloads and
 * verifies it, then installs it through [AutoInstaller] - unattended on Android
 * 12+, via the tap-to-install notification on older phones.
 *
 * Also runs as a one-off, install-only retry ([retryInstallLater]) when the
 * install had to wait for a call to end.
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
        if (inputData.getBoolean(KEY_INSTALL_ONLY, false)) {
            // The retry: the APK is already on disk and verified, so there is
            // nothing to fetch - which is also why this request carries no
            // wifi constraint.
            AutoInstaller.installReady(applicationContext)
            return Result.success()
        }

        return when (val outcome = AppUpdateManager.sync(applicationContext)) {
            is AppUpdateManager.Outcome.Ready -> {
                Log.i(TAG, "v${outcome.versionName} ready to install")
                AutoInstaller.installReady(applicationContext)
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

        /** A distinct name: sharing the periodic check's would cancel that schedule. */
        private const val UNIQUE_RETRY = "app-update-install-retry"
        private const val KEY_INSTALL_ONLY = "install_only"
        private const val RETRY_MINUTES = 30L

        /**
         * Try the install again in [RETRY_MINUTES] - long enough for most calls
         * to end, far shorter than waiting for the next 6h check.
         *
         * REPLACE, not KEEP: the caller is often the retry itself, still
         * RUNNING, and KEEP would see that and enqueue nothing - ending the
         * retries after the first deferral.
         */
        fun retryInstallLater(context: Context) {
            val request = OneTimeWorkRequestBuilder<AppUpdateWorker>()
                .setInitialDelay(RETRY_MINUTES, TimeUnit.MINUTES)
                .setInputData(workDataOf(KEY_INSTALL_ONLY to true))
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(UNIQUE_RETRY, ExistingWorkPolicy.REPLACE, request)
        }

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
