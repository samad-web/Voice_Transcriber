package com.voicetranscriber.callrecorder.platform

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Receives high-priority FCM data messages from the Aura platform server.
 *
 * The server sends a data-only message (no notification payload) so this
 * service is invoked even when the app is in the background or killed by the
 * system.
 *
 * Currently handles one action:
 *   `config_refresh` — the same [ActivationManager.refreshConfig] that
 *   [ConfigRefreshWorker] runs on its ~1h poll, but instantly.
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
