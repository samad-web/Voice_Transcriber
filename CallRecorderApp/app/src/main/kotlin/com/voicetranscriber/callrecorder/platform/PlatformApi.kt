package com.voicetranscriber.callrecorder.platform

import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import com.voicetranscriber.callrecorder.util.applyNgrokBypass

/**
 * Minimal JSON client for the Aura platform API. Deliberately dependency-free
 * (HttpURLConnection) for v1; the upload subsystem will bring OkHttp +
 * certificate pinning (checklist §3.2).
 */
object PlatformApi {

    class ApiException(val code: Int, message: String) : Exception(message)

    private fun request(
        baseUrl: String,
        method: String,
        path: String,
        body: JSONObject?,
        bearer: String? = null,
    ): JSONObject {
        val connection = URL("$baseUrl/v1$path").openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 10_000
            connection.readTimeout = 20_000
            connection.setRequestProperty("content-type", "application/json")
            connection.applyNgrokBypass()
            if (bearer != null) connection.setRequestProperty("authorization", "Bearer $bearer")
            if (body != null) {
                connection.doOutput = true
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val code = connection.responseCode
            val text = (if (code in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.readText() ?: "{}"
            if (code !in 200..299) throw ApiException(code, "HTTP $code: ${text.take(300)}")
            return JSONObject(text)
        } finally {
            connection.disconnect()
        }
    }

    data class Enrollment(val deviceId: String, val refreshToken: String)

    fun register(
        baseUrl: String,
        instanceId: String,
        enrollmentToken: String,
        publicKeyPem: String,
    ): Enrollment {
        val response = request(
            baseUrl, "POST", "/devices/register",
            JSONObject()
                .put("instanceId", instanceId)
                .put("enrollmentToken", enrollmentToken)
                .put("publicKey", publicKeyPem)
                .put("deviceFingerprint", "${Build.MANUFACTURER} ${Build.MODEL} (${Build.VERSION.RELEASE})")
                // TODO (checklist §2.2): real Play Integrity token.
                .put("playIntegrityToken", "android-stub")
                .put("label", Build.MODEL),
        )
        return Enrollment(response.getString("deviceId"), response.getString("refreshToken"))
    }

    fun challenge(baseUrl: String, deviceId: String): String =
        request(baseUrl, "POST", "/devices/challenge", JSONObject().put("deviceId", deviceId))
            .getString("nonce")

    fun authenticate(baseUrl: String, deviceId: String, nonce: String, signature: String): String =
        request(
            baseUrl, "POST", "/devices/authenticate",
            JSONObject().put("deviceId", deviceId).put("nonce", nonce).put("signature", signature),
        ).getString("accessToken")

    data class DeviceConfig(
        val recordingEnabled: Boolean,
        val version: Int,
        /** Instance-wide mobile app-lock hash, or null when the org hasn't set one. */
        val appLockPasswordHash: String?,
    )

    fun fetchConfig(baseUrl: String, accessToken: String): DeviceConfig {
        val response = request(baseUrl, "GET", "/devices/me/config", null, bearer = accessToken)
        return DeviceConfig(
            recordingEnabled = response.getBoolean("recordingEnabled"),
            version = response.getInt("version"),
            // `isNull` FIRST - the same guard fetchCallResult already uses for
            // `transcript` below, and for the same reason. Android's
            // `optString(name, fallback)` returns the fallback only when the key
            // is ABSENT; for a JSON null it returns the four-character string
            // "null", because JSONObject.NULL.toString() is "null".
            //
            // That is not a cosmetic difference here. The org's app lock is NULL
            // by default (migration 0066: "NULL = no lock (default, backward
            // compatible with every already-enrolled fleet)"), so this key is
            // null for essentially every fleet. Stored raw, "null" is not null,
            // so LockActivity gates the app on it - and AppLock.verify requires
            // `pbkdf2$iterations$salt$hash`, which "null" can never satisfy. As
            // LockActivity is the only exported LAUNCHER (MainActivity and
            // AdminActivationActivity are exported="false"), the handset would
            // be locked with no way back in, not even to de-enroll.
            appLockPasswordHash =
                if (response.isNull("appLockPasswordHash")) null
                else response.optString("appLockPasswordHash", null),
        )
    }

    /**
     * A build the server is offering this handset. `notes` is null when the
     * release carries no note - the server OMITS the key rather than sending a
     * JSON null, for the same reason documented on [DeviceConfig] below.
     */
    data class AppUpdate(
        val versionCode: Int,
        val versionName: String,
        val url: String,
        val sha256: String,
        val sizeBytes: Long,
        val notes: String?,
    )

    /**
     * GET /v1/devices/me/update - the self-update channel.
     *
     * Returns null when this handset is already on the newest published build,
     * which is what almost every call gets. [currentVersionCode] is sent so the
     * server can answer "nothing for you" itself instead of the client having
     * to compare - and so the fleet dashboard learns which build each phone is
     * actually running.
     */
    fun checkUpdate(baseUrl: String, accessToken: String, currentVersionCode: Int): AppUpdate? {
        val response = request(
            baseUrl, "GET", "/devices/me/update?versionCode=$currentVersionCode",
            null, bearer = accessToken,
        )
        if (response.isNull("update")) return null
        val update = response.getJSONObject("update")
        return AppUpdate(
            versionCode = update.getInt("versionCode"),
            versionName = update.getString("versionName"),
            url = update.getString("url"),
            sha256 = update.getString("sha256"),
            sizeBytes = update.getLong("sizeBytes"),
            // `isNull` first - the same guard, and the same reason, as
            // appLockPasswordHash above: optString hands back the four-character
            // string "null" for a JSON null, which would be shown to the user as
            // the release note.
            notes = if (update.isNull("notes")) null else update.optString("notes", null),
        )
    }

    /** POST /v1/devices/me/health - periodic device telemetry for the fleet dashboard. */
    fun reportHealth(
        baseUrl: String,
        accessToken: String,
        batteryLevel: Int,
        accessibilityEnabled: Boolean,
        batteryOptExempt: Boolean,
        pendingUploads: Int,
        freeStorageMb: Long,
        lastUploadAtIso: String?,
    ) {
        val body = JSONObject()
            .put("batteryLevel", batteryLevel)
            .put("accessibilityEnabled", accessibilityEnabled)
            .put("batteryOptExempt", batteryOptExempt)
            .put("pendingUploads", pendingUploads)
            .put("freeStorageMb", freeStorageMb)
        if (lastUploadAtIso != null) body.put("lastUploadAt", lastUploadAtIso)
        request(baseUrl, "POST", "/devices/me/health", body, bearer = accessToken)
    }

    /** POST /v1/devices/me/events - batch of lightweight device events (e.g. call detected). */
    fun reportEvents(baseUrl: String, accessToken: String, events: List<JSONObject>) {
        if (events.isEmpty()) return
        val array = JSONArray()
        events.forEach { array.put(it) }
        request(baseUrl, "POST", "/devices/me/events", JSONObject().put("events", array), bearer = accessToken)
    }

    /**
     * POST /v1/calls/missed - call-log entries nobody picked up (server migration 0133).
     * Idempotent per entry on the server, so a batch whose response was lost is safe to send
     * again. Returns how many were new.
     */
    fun reportMissedCalls(baseUrl: String, accessToken: String, calls: JSONArray): Int =
        request(baseUrl, "POST", "/calls/missed", JSONObject().put("calls", calls), bearer = accessToken)
            .optInt("accepted", 0)

    data class CallResult(val status: String, val transcript: String?)

    /** POST /v1/devices/me/calls/{id} - pipeline status + transcript for a call this device uploaded. */
    fun fetchCallResult(baseUrl: String, accessToken: String, callId: String): CallResult {
        val response = request(baseUrl, "GET", "/devices/me/calls/$callId", null, bearer = accessToken)
        val transcript = if (response.isNull("transcript")) null else response.optString("transcript", null)
        return CallResult(status = response.optString("status", "UNKNOWN"), transcript = transcript)
    }

    /** POST /v1/devices/me/fcm-token - register or update the device's FCM push token. */
    fun updateFcmToken(baseUrl: String, accessToken: String, token: String) {
        request(baseUrl, "POST", "/devices/me/fcm-token", JSONObject().put("token", token), bearer = accessToken)
    }
}
