package com.voicetranscriber.callrecorder.platform

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.voicetranscriber.callrecorder.alerts.AlertSync
import com.voicetranscriber.callrecorder.alerts.AlertSyncWorker
import com.voicetranscriber.callrecorder.attendance.AttendanceController
import com.voicetranscriber.callrecorder.attendance.AttendanceSyncWorker

/**
 * Receives high-priority FCM data messages from the Aura platform server.
 *
 * The server sends a data-only message (no notification payload) so this
 * service is invoked even when the app is in the background or killed by the
 * system.
 *
 * Actions:
 *   `config_refresh` — the same [ActivationManager.refreshConfig] that
 *   [ConfigRefreshWorker] runs on its ~1h poll, but instantly.
 *   `presence_check` — attendance (doc 33).
 *   `alert` — a phone alert is waiting (platform 0150); the push carries no
 *   content, the phone fetches it.
 *
 * Both callbacks below hand off to WorkManager rather than doing the work here.
 * Android gives a high-priority data message ~20 seconds, but this service is
 * destroyed as soon as [onMessageReceived] returns and the process is a
 * candidate for death immediately after - so a coroutine launched on a
 * service-owned scope can be killed halfway through the HTTP call, and the
 * logout or wipe it was delivering is simply lost with nothing to retry it. The
 * handoff is cheap and the work then survives process death, reboots, and a
 * network that is not there yet.
 */
class AuraFirebaseMessagingService : FirebaseMessagingService() {

    override fun onMessageReceived(message: RemoteMessage) {
        val action = message.data["action"]
        Log.i(TAG, "FCM message received: action=$action")

        when (action) {
            "config_refresh" -> ConfigRefreshWorker.runNow(applicationContext)
            // Attendance (doc 33 §4): the server lost this phone's heartbeat mid-shift.
            // The engine step is local and fast (it prompts if ACTIVE and silent past the
            // threshold); the heartbeat it queues is sent by the uploader, and the sync
            // worker picks it up if this process dies first - the same hand-off rule as above.
            "presence_check" -> {
                AttendanceController.presenceCheck(applicationContext)
                AttendanceSyncWorker.enqueue(applicationContext)
            }
            // Phone alerts (platform 0150): a lead, task or manager's message is
            // waiting. The ONE exception to the hand-off rule above, because a
            // popup that waits for WorkManager's scheduling is not a popup: fetch
            // and show inline, inside the window the high-priority push grants.
            // Nothing is lost if this process dies halfway - the server keeps the
            // alert until a phone acks it and pushes again a minute later - and
            // any failure falls back to the durable worker.
            "alert" -> {
                val ok = runCatching { AlertSync.sync(applicationContext) }
                    .onFailure { Log.w(TAG, "inline alert sync failed - handing to the worker", it) }
                    .isSuccess
                if (!ok) AlertSyncWorker.enqueue(applicationContext)
            }
            else -> Log.w(TAG, "Unknown FCM action: $action")
        }
    }

    /**
     * Called when the FCM registration token is created or rotated. Token
     * rotation is rare (app reinstall, cleared data, FCM's own refresh), but
     * when it happens the old token is dead and the server is still holding it,
     * so this device is unreachable by push until the new one lands.
     */
    override fun onNewToken(token: String) {
        Log.i(TAG, "FCM token refreshed")
        FcmTokenManager.persistAndSync(applicationContext, token)
    }

    companion object {
        private const val TAG = "AuraFCM"
    }
}
