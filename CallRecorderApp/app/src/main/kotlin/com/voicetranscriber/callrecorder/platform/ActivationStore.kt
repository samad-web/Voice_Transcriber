package com.voicetranscriber.callrecorder.platform

import android.content.Context
import android.content.SharedPreferences
import android.content.pm.ApplicationInfo

/**
 * The activation gate's local state. A device that has never enrolled — or was
 * remotely logged out / wiped — has isActivated == false, and NOTHING records.
 *
 * TODO (checklist §3.5): move refreshToken into EncryptedSharedPreferences.
 */
object ActivationStore {

    private const val PREFS = "aura_activation"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun apiBaseUrl(context: Context): String =
        prefs(context).getString("api_base_url", "https://aura.sirahagents.com")!!

    fun isActivated(context: Context): Boolean =
        prefs(context).getString("device_id", null) != null

    fun deviceId(context: Context): String? = prefs(context).getString("device_id", null)

    fun refreshToken(context: Context): String? = prefs(context).getString("refresh_token", null)

    /** Server-pushed flag from GET /v1/devices/me/config — defaults to false. */
    fun isRecordingEnabled(context: Context): Boolean =
        prefs(context).getBoolean("recording_enabled", false)

    /**
     * The instance's mobile app-lock hash (`pbkdf2$iterations$saltHex$hashHex`),
     * synced from the same config document — null when the org hasn't set one,
     * in which case [ui.LockActivity] lets the app open with no prompt.
     *
     * Anything that is not a well-formed PBKDF2 record reads as NO LOCK, rather
     * than as a lock nobody can open. A stored value can only ever be verified
     * by [AppLock.verify], which requires `pbkdf2$iterations$salt$hash`; a value
     * failing this check could therefore never unlock the app, and honouring it
     * would leave the handset gated forever behind the only exported LAUNCHER.
     *
     * This is the recovery path as much as a guard: a device that already synced
     * the literal string "null" (see PlatformApi.fetchConfig, now fixed at the
     * source) heals itself on next launch instead of needing a reinstall.
     * Failing OPEN is deliberate and is the safer direction — the lock protects
     * a recordings list on a company handset, and the cost of wrongly locking a
     * telecaller out of their own device is far higher than the cost of a
     * missing prompt on a malformed value that was never a real password.
     */
    fun appLockPasswordHash(context: Context): String? =
        prefs(context).getString("app_lock_password_hash", null)
            ?.takeIf { it.startsWith("pbkdf2$") && it.split("$").size == 4 }

    /** The single question every capture path asks before starting. */
    fun isRecordingAllowed(context: Context): Boolean =
        isDebugBuild(context) || (isActivated(context) && isRecordingEnabled(context))

    /**
     * Debug builds bypass the enrollment gate so call recording can be tested on a device
     * with no reachable backend. Uninstalling wipes the [PREFS] enrollment, which otherwise
     * silently disables ALL recording (isActivated == false) until the device is re-enrolled
     * against the platform. Release builds (FLAG_DEBUGGABLE == 0) are unaffected — still fully
     * gated on real enrollment + the server recording flag.
     */
    private fun isDebugBuild(context: Context): Boolean =
        (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0

    fun saveEnrollment(
        context: Context,
        apiBaseUrl: String,
        instanceId: String,
        deviceId: String,
        refreshToken: String,
    ) {
        prefs(context).edit()
            .putString("api_base_url", apiBaseUrl)
            .putString("instance_id", instanceId)
            .putString("device_id", deviceId)
            .putString("refresh_token", refreshToken)
            .apply()
    }

    /**
     * [appLockPasswordHash] must be passed explicitly (no default) — callers that only
     * mean to update recordingEnabled/configVersion (e.g. the 401 handler) should pass
     * [appLockPasswordHash] back through unchanged, never null, or a transient auth
     * failure would silently strip a fleet's app lock.
     */
    fun saveConfig(
        context: Context,
        recordingEnabled: Boolean,
        configVersion: Int,
        appLockPasswordHash: String?,
    ) {
        prefs(context).edit()
            .putBoolean("recording_enabled", recordingEnabled)
            .putInt("config_version", configVersion)
            .putString("app_lock_password_hash", appLockPasswordHash)
            .apply()
    }

    fun statusSummary(context: Context): String {
        val p = prefs(context)
        val base = if (!isActivated(context)) {
            "NOT ACTIVATED — recording disabled"
        } else {
            "Device ${p.getString("device_id", "?")?.take(8)}… · " +
                "recording ${if (isRecordingEnabled(context)) "ENABLED" else "DISABLED"} · " +
                "cfg v${p.getInt("config_version", 0)}"
        }
        return if (isDebugBuild(context)) {
            "$base\n(debug build: activation gate bypassed — recording allowed)"
        } else {
            base
        }
    }

    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
    }
}
