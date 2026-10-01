package com.voicetranscriber.callrecorder.escalation

import android.content.Context
import android.os.SystemClock
import androidx.annotation.WorkerThread
import com.voicetranscriber.callrecorder.platform.ActivationManager
import com.voicetranscriber.callrecorder.platform.ActivationStore
import com.voicetranscriber.callrecorder.platform.PlatformApi
import org.json.JSONObject
import java.net.URLEncoder

/**
 * The escalation routes under /v1/devices/me (Build docs/38). Blocking; call
 * from a background thread.
 *
 * Token reuse, as [com.voicetranscriber.callrecorder.attendance.AttendanceApi]
 * does it: the status list is read on every return to the app, and minting a
 * JWT is two round trips of its own, so the token is kept IN MEMORY ONLY for 10
 * minutes of its 15-minute life and dropped on any 401. It never touches disk.
 */
object EscalationApi {

    private const val TOKEN_REUSE_MS = 10 * 60_000L

    @Volatile private var cachedToken: String? = null
    @Volatile private var cachedAtElapsed: Long = 0
    @Volatile private var cachedFor: String? = null

    class NotActivated : Exception("device not activated")

    data class Raised(val escalation: EscalationView, val duplicate: Boolean)

    private fun token(context: Context): Pair<String, String> {
        if (!ActivationStore.isActivated(context)) throw NotActivated()
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
            if (e.code != 401) throw e
            cachedToken = null
            val (b2, t2) = token(context)
            block(b2, t2)
        }
    }

    /**
     * POST /devices/me/calls/{callId}/escalations → `{escalation, duplicate}`.
     *
     * [clientRef] is the phone's id for this press: the same value on a retry
     * after a lost response is stored once by the server.
     */
    @WorkerThread
    fun raise(context: Context, callId: String, reason: String, note: String?, clientRef: String): Raised {
        val body = JSONObject().put("reason", reason).put("clientRef", clientRef)
        note?.trim()?.takeIf { it.isNotEmpty() }?.let { body.put("note", it) }
        val res = authed(context) { baseUrl, token ->
            PlatformApi.request(
                baseUrl, "POST", "/devices/me/calls/${URLEncoder.encode(callId, "UTF-8")}/escalations",
                body, bearer = token,
            )
        }
        val view = res.optJSONObject("escalation")?.let(EscalationJson::parseView)
            ?: throw IllegalStateException("escalation missing from the response")
        return Raised(view, res.optBoolean("duplicate", false))
    }

    /** GET /devices/me/escalations → this telecaller's escalations of the last 30 days. */
    @WorkerThread
    fun list(context: Context): List<EscalationView> {
        val res = authed(context) { baseUrl, token ->
            PlatformApi.request(baseUrl, "GET", "/devices/me/escalations", null, bearer = token)
        }
        return EscalationJson.parseViews(res.optJSONArray("escalations"))
    }
}
