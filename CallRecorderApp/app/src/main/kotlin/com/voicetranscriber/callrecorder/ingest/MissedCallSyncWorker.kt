package com.voicetranscriber.callrecorder.ingest

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.ContextCompat
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
import com.voicetranscriber.callrecorder.capture.CaptureSettings
import com.voicetranscriber.callrecorder.platform.ActivationStore
import com.voicetranscriber.callrecorder.platform.DeviceIdentity
import com.voicetranscriber.callrecorder.platform.EventLog
import com.voicetranscriber.callrecorder.platform.PlatformApi
import com.voicetranscriber.callrecorder.service.CallLogReader
import com.voicetranscriber.callrecorder.service.MissedCallEntry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * Sends the calls nobody picked up to the platform (server migration 0133).
 *
 * Everything else this app uploads is a RECORDING, and a missed call has none: capture starts on
 * OFFHOOK, never on RINGING. So until this existed an unanswered call left no trace on the server
 * at all, and the console's red "missed" number counted nothing real. The system call log is the
 * one place a missed call is recorded, so this reads it.
 *
 * ── THE CALL LOG IS THE QUEUE ───────────────────────────────────────────────
 *
 * No local table. The call log already holds every entry durably, so the only state kept here is
 * a cursor - the newest entry the server has acknowledged ([CaptureSettings.missedCallsSince]).
 * It moves only after the server answers, so a phone that is offline, asleep or killed for a day
 * simply sends that day's missed calls when it next runs. The server is idempotent per entry
 * (`missed-<DATE>`), so a batch whose response was lost is resent harmlessly.
 *
 * Each run re-reads [OVERLAP_MS] behind the cursor, because the dialer writes an entry when the
 * call ENDS but dates it when it STARTED: two calls ringing at once can land in the log out of
 * order. [CaptureSettings.missedCallsRecentlySent] keeps that overlap from costing a request for
 * entries already sent.
 *
 * ── TWO TRIGGERS ────────────────────────────────────────────────────────────
 *
 *  - [enqueueAfterCall], from PhoneStateReceiver when a call that rang goes idle - so a missed
 *    call reaches the console within seconds while the app is alive.
 *  - [schedule], every 15 minutes - the safety net for everything the broadcast never delivered
 *    because the phone had put the app to sleep, which on this fleet is often.
 *
 * Gated like every capture path: an un-enrolled or remotely-disabled device sends nothing.
 */
class MissedCallSyncWorker(
    context: Context,
    params: WorkerParameters,
) : CoroutineWorker(context, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val context = applicationContext
        if (!ActivationStore.isRecordingAllowed(context)) {
            Log.i(TAG, "skip - device not activated or recording disabled")
            return@withContext Result.success()
        }
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALL_LOG) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            // Nothing to read. The cursor stays put, so granting the permission later picks up
            // everything from where it stopped (within the call log's own retention).
            Log.i(TAG, "skip - READ_CALL_LOG not granted")
            return@withContext Result.success()
        }

        val settings = CaptureSettings(context)
        if (settings.missedCallsSince == 0L) {
            settings.missedCallsSince = System.currentTimeMillis() - CaptureSettings.MISSED_BACKLOG_GRACE_MS
        }
        val baseUrl = ActivationStore.apiBaseUrl(context)
        var jwt: String? = null
        var sent = 0

        for (batch in 0 until MAX_BATCHES_PER_RUN) {
            val recent = recentlySent(settings)
            val entries = CallLogReader
                .missedSince(context, settings.missedCallsSince - OVERLAP_MS, BATCH_SIZE + recent.size)
                .filterNot { it.date in recent }
                .take(BATCH_SIZE)
            if (entries.isEmpty()) break

            try {
                val token = jwt ?: acquireJwt(context, baseUrl).also { jwt = it }
                val accepted = PlatformApi.reportMissedCalls(baseUrl, token, toJson(entries))
                markSent(settings, entries)
                sent += entries.size
                Log.i(TAG, "sent ${entries.size} missed call(s), $accepted new on the server")
            } catch (e: PlatformApi.ApiException) {
                when (e.code) {
                    // The device or org is no longer active. Retrying cannot help, and the
                    // cursor stays put so a re-activated phone still sends what it missed.
                    409 -> {
                        Log.i(TAG, "missed-call sync refused - device or org inactive")
                        return@withContext Result.success()
                    }
                    // A batch the server will never accept. Holding the cursor on it would
                    // block every missed call after it, forever - so step past it, and leave a
                    // trace in the health events for whoever wonders why some are absent.
                    400, 413, 422 -> {
                        Log.w(TAG, "missed-call batch rejected (HTTP ${e.code}); skipping it", e)
                        markSent(settings, entries)
                        EventLog.record(
                            context,
                            "missed_calls_rejected",
                            mapOf("count" to entries.size.toString(), "status" to e.code.toString()),
                        )
                    }
                    // Auth hiccups and server trouble: try again later from the same cursor.
                    else -> {
                        Log.w(TAG, "missed-call sync failed (HTTP ${e.code})", e)
                        return@withContext retryOrGiveUp()
                    }
                }
            } catch (t: Throwable) {
                Log.w(TAG, "missed-call sync failed (attempt ${runAttemptCount + 1})", t)
                return@withContext retryOrGiveUp()
            }
            if (entries.size < BATCH_SIZE) break
        }

        if (sent > 0) EventLog.record(context, "missed_calls_synced", mapOf("count" to sent.toString()))
        Result.success()
    }

    private fun retryOrGiveUp(): Result =
        if (runAttemptCount < MAX_RUN_ATTEMPTS) Result.retry() else Result.success()

    /** challenge -> Keystore-sign -> authenticate, as every worker here does. */
    private fun acquireJwt(context: Context, baseUrl: String): String {
        val deviceId = ActivationStore.deviceId(context)
            ?: throw IllegalStateException("device not enrolled")
        val nonce = PlatformApi.challenge(baseUrl, deviceId)
        return PlatformApi.authenticate(baseUrl, deviceId, nonce, DeviceIdentity.signNonce(nonce))
    }

    private fun toJson(entries: List<MissedCallEntry>): JSONArray = JSONArray().also { array ->
        for (entry in entries) {
            val json = JSONObject()
                // Stable per entry, so the server treats a resend as the same call.
                .put("idempotencyKey", "missed-${entry.date}")
                .put("startedAt", Instant.ofEpochMilli(entry.date).toString())
                .put("direction", entry.direction)
                .put("reason", entry.reason)
            // Optional and ABSENT rather than null: the server's schema refuses a null
            // (the same rule as UploadApi.createCall). Trimmed to what it will store.
            entry.number?.let { json.put("remoteNumber", it.trim().take(40)) }
            entry.name?.let { json.put("remoteName", it.trim().take(120)) }
            array.put(json)
        }
    }

    companion object {
        private const val TAG = "MissedCallSync"
        private const val MAX_RUN_ATTEMPTS = 5

        /** The server's MISSED_CALLS_BATCH_MAX. */
        private const val BATCH_SIZE = 200

        /** A day's backlog is a handful of batches; this only bounds one run, not the backlog. */
        private const val MAX_BATCHES_PER_RUN = 10

        /** Re-read this far behind the cursor - see the class note on out-of-order entries. */
        private const val OVERLAP_MS = 10L * 60 * 1000

        /** How many sent DATEs to remember; comfortably more than an overlap's worth. */
        private const val RECENT_CAP = 200

        private const val UNIQUE_PERIODIC = "missed-call-sync-periodic"
        private const val UNIQUE_ONESHOT = "missed-call-sync-now"

        /** The dialer writes its call-log entry as the call ends; give it a moment. */
        private const val AFTER_CALL_DELAY_SEC = 10L

        private fun constraints() = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()

        /** Idempotent: safe on every app start (KEEP preserves the running schedule). */
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<MissedCallSyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(constraints())
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniquePeriodicWork(UNIQUE_PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        /**
         * Right after a call that rang goes idle. APPEND_OR_REPLACE rather than REPLACE: a run
         * already sending must not be cancelled half way, and a queued one after it costs one
         * cheap call-log read that finds nothing new.
         */
        fun enqueueAfterCall(context: Context) {
            val request = OneTimeWorkRequestBuilder<MissedCallSyncWorker>()
                .setInitialDelay(AFTER_CALL_DELAY_SEC, TimeUnit.SECONDS)
                .setConstraints(constraints())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(UNIQUE_ONESHOT, ExistingWorkPolicy.APPEND_OR_REPLACE, request)
        }

        private fun recentlySent(settings: CaptureSettings): Set<Long> =
            settings.missedCallsRecentlySent
                .split(',')
                .mapNotNull { it.trim().toLongOrNull() }
                .toSet()

        /**
         * Advance the cursor past what the server just acknowledged, and remember those DATEs.
         * Synchronized because the periodic run and an after-call run can overlap; the cursor
         * only ever moves forward regardless of which finishes first.
         */
        @Synchronized
        private fun markSent(settings: CaptureSettings, entries: List<MissedCallEntry>) {
            val newest = entries.maxOf { it.date }
            if (newest > settings.missedCallsSince) settings.missedCallsSince = newest
            val merged = (recentlySent(settings) + entries.map { it.date }).sorted().takeLast(RECENT_CAP)
            settings.missedCallsRecentlySent = merged.joinToString(",")
        }
    }
}
