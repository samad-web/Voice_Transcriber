package com.voicetranscriber.callrecorder.platform

import android.content.Context
import android.content.SharedPreferences

/**
 * Local state for the FCM registration token. The actual network work lives in
 * [FcmTokenWorker]; this object only owns the stored values and the decision
 * about when a sync is worth enqueuing.
 *
 * Two keys, not one, and that distinction is the point:
 * - `fcm_token` is what Firebase last gave us.
 * - `fcm_token_synced` is what the SERVER is known to hold.
 *
 * Storing only the token cannot express "we have a token but the POST failed",
 * which is exactly the state that used to be lost silently. When the two differ
 * there is work outstanding, and [ensureSynced] picks it up on the next launch.
 *
 * Both live in the `aura_activation` prefs alongside the enrollment, so
 * [ActivationStore.clear] wipes the token with the device identity it belongs
 * to - a deactivated handset must not keep claiming a push channel.
 */
object FcmTokenManager {

    private const val PREFS = "aura_activation"
    private const val KEY_TOKEN = "fcm_token"
    private const val KEY_TOKEN_SYNCED = "fcm_token_synced"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    internal fun storedToken(context: Context): String? =
        prefs(context).getString(KEY_TOKEN, null)

    internal fun syncedToken(context: Context): String? =
        prefs(context).getString(KEY_TOKEN_SYNCED, null)

    internal fun persistToken(context: Context, token: String) {
        prefs(context).edit().putString(KEY_TOKEN, token).apply()
    }

    internal fun markSynced(context: Context, token: String) {
        prefs(context).edit().putString(KEY_TOKEN_SYNCED, token).apply()
    }

    /**
     * Register this device's token now. Called right after enrollment succeeds,
     * when there is a device id to register against for the first time.
     */
    fun syncNow(context: Context) = FcmTokenWorker.enqueue(context, replace = true)

    /**
     * Firebase rotated the token (reinstall, cleared data, or FCM's own
     * refresh). The old one is dead, so persist the new one immediately - the
     * write is cheap and synchronous-enough on the binder thread - and replace
     * any in-flight sync that is still carrying the stale value.
     */
    fun persistAndSync(context: Context, token: String) {
        persistToken(context, token)
        // REPLACE, not KEEP: an attempt already RUNNING would finish and call
        // markSynced() with the token it started with, leaving stored != synced
        // and nothing queued to close the gap until the next launch.
        FcmTokenWorker.enqueue(context, replace = true)
    }

    /**
     * Called on every app start. No-ops when the server already has the current
     * token, so this costs one SharedPreferences read in the normal case; when
     * an earlier attempt exhausted its retries, this is what tries again.
     */
    fun ensureSynced(context: Context) {
        if (!ActivationStore.isActivated(context)) return
        val stored = storedToken(context)
        if (stored != null && stored == syncedToken(context)) return
        FcmTokenWorker.enqueue(context, replace = false)
    }
}
