package com.voicetranscriber.callrecorder.attendance

import android.content.Context
import android.os.SystemClock
import com.voicetranscriber.callrecorder.platform.ActivationManager
import com.voicetranscriber.callrecorder.platform.ActivationStore
import com.voicetranscriber.callrecorder.platform.PlatformApi
import org.json.JSONObject
import java.net.URLEncoder

/**
 * The attendance routes under /v1/devices/me (doc 33 §9). Blocking; call from
 * an IO thread.
 *
 * Token reuse: every other device call mints a fresh JWT (challenge +
 * authenticate) per request. A phone on shift talks to the server every two
 * minutes, so that would triple the requests for the heartbeat alone. The
 * token is kept IN MEMORY ONLY for 10 minutes of a 15-minute life, and
 * dropped on any 401 - it never touches disk.
 */
object AttendanceApi {

    private const val TOKEN_REUSE_MS = 10 * 60_000L

    @Volatile private var cachedToken: String? = null
    @Volatile private var cachedAtElapsed: Long = 0
    @Volatile private var cachedFor: String? = null

    class NotActivated : Exception("device not activated")

    private fun token(context: Context): Pair<String, String> {
        val baseUrl = ActivationStore.apiBaseUrl(context)
        val deviceId = ActivationStore.deviceId(context) ?: throw NotActivated()
        val t = cachedToken
        if (t != null && cachedFor == deviceId && SystemClock.elapsedRealtime() - cachedAtElapsed < TOKEN_REUSE_MS) {
            return baseUrl to t
        }
        val fresh = ActivationManager.accessToken(baseUrl, deviceId)
        cachedToken = fresh
        cachedFor = deviceId
        cachedAtElapsed = SystemClock.elapsedRealtime()
        return baseUrl to fresh
    }

    private fun <T> authed(context: Context, block: (baseUrl: String, token: String) -> T): T {
        val (baseUrl, token) = token(context)
        return try {
            block(baseUrl, token)
        } catch (e: PlatformApi.ApiException) {
            if (e.code == 401) {
                cachedToken = null
                val (b2, t2) = token(context)
                block(b2, t2)
            } else {
                throw e
            }
        }
    }

    /** POST /devices/me/presence. Returns the response body. */
    fun postPresence(context: Context, batch: JSONObject): JSONObject = authed(context) { baseUrl, token ->
        PlatformApi.request(baseUrl, "POST", "/devices/me/presence", batch, bearer = token)
    }

    /** GET /devices/me/attendance?date= */
    fun getDay(context: Context, date: String): JSONObject = authed(context) { baseUrl, token ->
        PlatformApi.request(
            baseUrl, "GET", "/devices/me/attendance?date=${URLEncoder.encode(date, "UTF-8")}", null, bearer = token,
        )
    }

    /** POST /devices/me/attendance/requests → `{ request, duplicate }`. */
    fun postRequest(context: Context, body: JSONObject): JSONObject = authed(context) { baseUrl, token ->
        PlatformApi.request(baseUrl, "POST", "/devices/me/attendance/requests", body, bearer = token)
    }

    /** DELETE /devices/me/attendance/requests/{id} → `{ request }`. */
    fun cancelRequest(context: Context, id: String): JSONObject = authed(context) { baseUrl, token ->
        PlatformApi.request(
            baseUrl, "DELETE", "/devices/me/attendance/requests/${URLEncoder.encode(id, "UTF-8")}", null,
            bearer = token,
        )
    }
}
