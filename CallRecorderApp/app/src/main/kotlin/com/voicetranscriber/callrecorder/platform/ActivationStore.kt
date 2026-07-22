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
        prefs(context).getString("api_base_url", "http://10.0.2.2:4000")!!

    fun isActivated(context: Context): Boolean =
        prefs(context).getString("device_id", null) != null

    fun deviceId(context: Context): String? = prefs(context).getString("device_id", null)

    fun refreshToken(context: Context): String? = prefs(context).getString("refresh_token", null)

    /** Server-pushed flag from GET /v1/devices/me/config — defaults to false. */
    fun isRecordingEnabled(context: Context): Boolean =
        prefs(context).getBoolean("recording_enabled", false)

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

    fun saveConfig(context: Context, recordingEnabled: Boolean, configVersion: Int) {
        prefs(context).edit()
            .putBoolean("recording_enabled", recordingEnabled)
            .putInt("config_version", configVersion)
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
