package com.voicetranscriber.callrecorder.platform

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
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/**
 * Gets this device's FCM registration token onto the server, and keeps trying
 * until it lands.
 *
 * This replaces a fire-and-forget `CoroutineScope.launch` that caught every
 * failure, logged it at warn, and never tried again. That is the worst shape
 * for this particular job: a token that fails to register produces NO symptom
 * a user or operator can see - the handset keeps recording and uploading
 * normally - it just silently never receives a push again, so remote
 * logout/wipe/ping degrade to the ~1h [ConfigRefreshWorker] poll with nobody
 * aware it happened. WorkManager gives it a retry with backoff that survives
 * process death and reboots.
 *
 * Enqueued from three places:
 * - [ActivationManager.enroll] - first registration, right after enrollment.
 * - [AuraFirebaseMessagingService.onNewToken] - Firebase rotated the token.
 * - [FcmTokenManager.ensureSynced] on app start - heals an earlier failure.
 */
class FcmTokenWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val context = applicationContext

        // Nothing to register against until the device is enrolled; enroll()
        // enqueues this itself, so there is no work to preserve here.
        if (!ActivationStore.isActivated(context)) {
            Log.i(TAG, "skip - device not activated")
            return@withContext Result.success()
        }

        val token = try {
            FcmTokenManager.storedToken(context)
                ?: FirebaseMessaging.getInstance().token.await()
        } catch (t: Throwable) {
            // No Google Play services, no network, or Firebase not initialised.
            Log.w(TAG, "could not obtain an FCM token (attempt ${runAttemptCount + 1})", t)
            return@withContext retryOrGiveUp()
        }
        FcmTokenManager.persistToken(context, token)

        // Already the token the server holds - don't spend a JWT mint on it.
        if (FcmTokenManager.syncedToken(context) == token) {
            Log.i(TAG, "FCM token already registered")
            return@withContext Result.success()
        }

        val baseUrl = ActivationStore.apiBaseUrl(context)
        val deviceId = ActivationStore.deviceId(context) ?: return@withContext Result.success()
        try {
            PlatformApi.updateFcmToken(
                baseUrl,
                ActivationManager.accessToken(baseUrl, deviceId),
                token,
            )
            FcmTokenManager.markSynced(context, token)
            Log.i(TAG, "FCM token synced to server (${token.take(12)}…)")
            Result.success()
        } catch (e: PlatformApi.ApiException) {
            if (e.code == 401) {
                // Revoked / remotely wiped device. Retrying cannot fix this, and
                // refreshConfig has already closed the local recording gate.
                Log.w(TAG, "server rejected device (401) - giving up on token sync")
                Result.success()
            } else {
                Log.w(TAG, "token sync failed: HTTP ${e.code} (attempt ${runAttemptCount + 1})")
                retryOrGiveUp()
            }
        } catch (t: Throwable) {
            Log.w(TAG, "token sync failed (attempt ${runAttemptCount + 1})", t)
            retryOrGiveUp()
        }
    }

    /**
     * Exhausted retries report success, never [Result.failure].
     *
     * Push is an accelerator, not a requirement: a device whose token never
     * registers still gets every policy change on the hourly config poll. A
     * failed terminal state would sit in the fleet's WorkManager telemetry
     * looking like a recording fault, which is the one thing this app must not
     * cry wolf about. [FcmTokenManager.ensureSynced] retries on next launch.
     */
    private fun retryOrGiveUp(): Result =
        if (runAttemptCount < MAX_RUN_ATTEMPTS) Result.retry() else Result.success()

    companion object {
        private const val TAG = "FcmTokenWorker"
        private const val MAX_RUN_ATTEMPTS = 5
        private const val UNIQUE_WORK = "device-fcm-token-sync"

        /**
         * @param replace true when we have a NEW token to register (enrollment,
         *   rotation) and any in-flight attempt is now carrying a stale one;
         *   false for the self-heal path, where an already-queued attempt is
         *   just as good and replacing it would restart its backoff.
         */
        fun enqueue(context: Context, replace: Boolean) {
            val request = OneTimeWorkRequestBuilder<FcmTokenWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
                UNIQUE_WORK,
                if (replace) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.KEEP,
                request,
            )
        }
    }
}
