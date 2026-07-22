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

    data class DeviceConfig(val recordingEnabled: Boolean, val version: Int)

    fun fetchConfig(baseUrl: String, accessToken: String): DeviceConfig {
        val response = request(baseUrl, "GET", "/devices/me/config", null, bearer = accessToken)
        return DeviceConfig(
            recordingEnabled = response.getBoolean("recordingEnabled"),
            version = response.getInt("version"),
        )
    }

    /** POST /v1/devices/me/health — periodic device telemetry for the fleet dashboard. */
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

    /** POST /v1/devices/me/events — batch of lightweight device events (e.g. call detected). */
    fun reportEvents(baseUrl: String, accessToken: String, events: List<JSONObject>) {
        if (events.isEmpty()) return
        val array = JSONArray()
        events.forEach { array.put(it) }
        request(baseUrl, "POST", "/devices/me/events", JSONObject().put("events", array), bearer = accessToken)
    }

    data class CallResult(val status: String, val transcript: String?)

    /** GET /v1/devices/me/calls/{id} — pipeline status + transcript for a call this device uploaded. */
    fun fetchCallResult(baseUrl: String, accessToken: String, callId: String): CallResult {
        val response = request(baseUrl, "GET", "/devices/me/calls/$callId", null, bearer = accessToken)
        val transcript = if (response.isNull("transcript")) null else response.optString("transcript", null)
        return CallResult(status = response.optString("status", "UNKNOWN"), transcript = transcript)
    }
}
