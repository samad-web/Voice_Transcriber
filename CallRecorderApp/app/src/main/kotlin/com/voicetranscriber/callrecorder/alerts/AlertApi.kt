package com.voicetranscriber.callrecorder.alerts

import android.content.Context
import com.voicetranscriber.callrecorder.platform.ActivationManager
import com.voicetranscriber.callrecorder.platform.ActivationStore
import com.voicetranscriber.callrecorder.platform.PlatformApi
import org.json.JSONArray
import org.json.JSONObject

/**
 * GET /devices/me/alerts and POST /devices/me/alerts/ack. Blocking; call from
 * a background thread.
 *
 * One token per [session]: a sync fetches and then acks, and minting a JWT is
 * two round trips of its own, so the pair shares one. Nothing is cached past
 * the call - alerts are rare enough that the reuse [AttendanceApi] does for a
 * two-minute heartbeat would buy nothing here.
 */
object AlertApi {

    class Session internal constructor(private val baseUrl: String, private val token: String) {
        fun fetch(): List<HandsetAlert> {
            val res = PlatformApi.request(baseUrl, "GET", "/devices/me/alerts", null, bearer = token)
            val arr = res.optJSONArray("alerts") ?: JSONArray()
            return (0 until arr.length()).mapNotNull { i ->
                arr.optJSONObject(i)?.let { runCatching { HandsetAlert.fromJson(it) }.getOrNull() }
            }
        }

        fun ack(delivered: Collection<String>, opened: Collection<String>) {
            if (delivered.isEmpty() && opened.isEmpty()) return
            val body = JSONObject()
                .put("delivered", JSONArray(delivered.take(200)))
                .put("opened", JSONArray(opened.take(200)))
            PlatformApi.request(baseUrl, "POST", "/devices/me/alerts/ack", body, bearer = token)
        }
    }

    /** Null when the phone is not paired - there is nobody to fetch for. */
    fun session(context: Context): Session? {
        if (!ActivationStore.isActivated(context)) return null
        val deviceId = ActivationStore.deviceId(context) ?: return null
        val baseUrl = ActivationStore.apiBaseUrl(context)
        return Session(baseUrl, ActivationManager.accessToken(baseUrl, deviceId))
    }
}
