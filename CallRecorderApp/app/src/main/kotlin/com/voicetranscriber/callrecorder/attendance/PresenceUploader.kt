package com.voicetranscriber.callrecorder.attendance

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import com.voicetranscriber.callrecorder.platform.PlatformApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONArray
import org.json.JSONObject

/**
 * Drains the presence queue to POST /devices/me/presence in batches of at most
 * 500 (PRESENCE_BATCH_MAX), oldest first, deleting rows only after the server
 * accepted them. While the network is down it backs off (30 s doubling to 10
 * min, measured on elapsedRealtime) instead of burning battery on attempts
 * that cannot work; a restored network resets the backoff.
 *
 * The server's unique key (device, boot, monoMs, kind) makes a resent batch
 * harmless, so a response lost in flight is simply sent again.
 */
object PresenceUploader {

    private const val TAG = "PresenceUploader"
    const val BATCH_MAX = 500
    private const val MAX_BATCHES_PER_FLUSH = 40
    private const val BACKOFF_START_MS = 30_000L
    private const val BACKOFF_MAX_MS = 10 * 60_000L

    private val mutex = Mutex()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /** Fire-and-forget flush, holding a short wake lock so a dozing phone finishes the request. */
    fun requestFlush(context: Context) {
        val app = context.applicationContext
        scope.launch {
            val pm = app.getSystemService(PowerManager::class.java)
            val wl = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "aura:presence-upload")
            runCatching { wl?.acquire(60_000) }
            try {
                val ok = flush(app, honourBackoff = true)
                if (!ok) AttendanceSyncWorker.enqueue(app)
            } finally {
                runCatching { if (wl?.isHeld == true) wl.release() }
            }
        }
    }

    fun resetBackoff(context: Context) = AttendanceStore.setBackoff(context, 0, 0)

    /**
     * Sends everything queued. Returns true when the queue is empty (or there
     * was nothing to do), false when something is left for a retry.
     */
    suspend fun flush(context: Context, honourBackoff: Boolean): Boolean = mutex.withLock {
        val dao = AttendanceDb.get(context).dao()
        if (honourBackoff && SystemClock.elapsedRealtime() < AttendanceStore.backoffUntilElapsed(context)) {
            return@withLock dao.eventCount() == 0
        }
        // Events are written on the controller's IO thread; let the ones just queued land first.
        AttendanceController.awaitQueued()
        repeat(MAX_BATCHES_PER_FLUSH) {
            val rows = dao.oldestEvents(BATCH_MAX)
            if (rows.isEmpty()) return@withLock true
            val header = AttendanceController.batchHeader(context)
            val body = JSONObject()
                .put("sentAt", ShiftSchedule.iso(header.sentAtWall))
                .put("sentBootId", header.sentBoot)
                .put("sentMonoMs", header.sentElapsed)
                .put("state", header.state.name)
                .put("stateSince", header.stateSinceIso)
                .put("networkOk", networkOk(context))
                .put("events", JSONArray().apply { rows.forEach { put(toJson(it)) } })
            AttendanceController.batteryPct(context)?.let { body.put("batteryPct", it) }
            try {
                val response = AttendanceApi.postPresence(context, body)
                dao.deleteEventRange(rows.first().id, rows.last().id)
                resetBackoff(context)
                val skew = if (response.has("clockSkewSeconds") && !response.isNull("clockSkewSeconds")) {
                    response.optLong("clockSkewSeconds", 0)
                } else {
                    0L
                }
                val version = if (response.has("scheduleVersion")) response.optInt("scheduleVersion") else null
                AttendanceController.onPresenceAccepted(context, header, skew, version)
            } catch (e: PlatformApi.ApiException) {
                when {
                    e.code == 409 && e.errorCode == "attendance_disabled" -> {
                        // The workspace switched attendance off; these events have nowhere to go.
                        Log.i(TAG, "attendance disabled on the server - dropping ${rows.size} events")
                        dao.deleteEventRange(rows.first().id, rows.last().id)
                        AttendanceController.onServerDisabled(context)
                        return@withLock true
                    }
                    e.code == 400 -> {
                        // A batch the server will never accept would block the queue forever.
                        // Drop it, loudly, rather than lose every event behind it.
                        Log.e(TAG, "presence batch rejected (400) - dropping ${rows.size} events: ${e.message}")
                        dao.deleteEventRange(rows.first().id, rows.last().id)
                    }
                    else -> {
                        backOff(context)
                        Log.w(TAG, "presence upload failed: ${e.message}")
                        return@withLock false
                    }
                }
            } catch (e: AttendanceApi.NotActivated) {
                return@withLock true
            } catch (t: Throwable) {
                backOff(context)
                Log.w(TAG, "presence upload failed (offline?): ${t.message}")
                return@withLock false
            }
        }
        dao.eventCount() == 0
    }

    private fun backOff(context: Context) {
        val next = (AttendanceStore.backoffMs(context) * 2).coerceIn(BACKOFF_START_MS, BACKOFF_MAX_MS)
        AttendanceStore.setBackoff(context, SystemClock.elapsedRealtime() + next, next)
    }

    private fun toJson(e: PresenceEventEntity): JSONObject {
        val o = JSONObject()
            .put("kind", e.kind)
            .put("at", e.at)
            .put("bootId", e.bootId)
            .put("monoMs", e.monoMs)
        e.payload?.let { raw -> runCatching { JSONObject(raw) }.getOrNull()?.let { o.put("payload", it) } }
        return o
    }

    private fun networkOk(context: Context): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
}
