package com.voicetranscriber.callrecorder.alerts

import org.json.JSONObject

/**
 * One phone alert (platform migration 0150): a lead given to this telecaller,
 * a task, a follow-up whose time has come, a missed call on someone else's
 * phone, or a manager's message.
 *
 * [popup] alerts take over the screen over the lock screen; the rest are a
 * heads-up notification. The server decides which - this app only obeys.
 */
data class HandsetAlert(
    val id: String,
    val kind: String,
    val popup: Boolean,
    val title: String,
    val body: String?,
    val createdAt: String,
    val sentBy: String?,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("kind", kind)
        .put("style", if (popup) "popup" else "notify")
        .put("title", title)
        .put("body", body ?: JSONObject.NULL)
        .put("createdAt", createdAt)
        .put("sentBy", sentBy ?: JSONObject.NULL)

    companion object {
        const val KIND_LEAD = "lead_assigned"
        const val KIND_MESSAGE = "manager_message"

        fun fromJson(o: JSONObject): HandsetAlert = HandsetAlert(
            id = o.getString("id"),
            kind = o.optString("kind", ""),
            popup = o.optString("style") == "popup",
            title = o.optString("title", ""),
            body = if (o.isNull("body")) null else o.optString("body").ifBlank { null },
            createdAt = o.optString("createdAt", ""),
            sentBy = if (o.isNull("sentBy")) null else o.optString("sentBy").ifBlank { null },
        )
    }
}
