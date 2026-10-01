package com.voicetranscriber.callrecorder.escalation

import org.json.JSONArray
import org.json.JSONObject

/**
 * Call escalations (platform migration 0151, Build docs/38): a telecaller hands
 * one of their calls up to a senior or a manager.
 *
 * The shapes mirror `@aura/shared` call-escalations.ts - DeviceCallEscalationConfig
 * and DeviceCallEscalationView. The reason list comes from the server in the
 * config block, so this app carries no copy of it to drift from.
 */
data class EscalationReason(val code: String, val label: String, val hint: String?)

/**
 * The `callEscalation` block of GET /devices/me/config. Its ABSENCE means the
 * feature is off for this phone (workspace switch off, or the phone is bound to
 * no active telecaller) and everything escalation-related must be hidden.
 */
data class EscalationConfig(
    /** "Escalate to Priya". Null = every owner and manager. */
    val recipientName: String?,
    val reasons: List<EscalationReason>,
    val noteMax: Int,
) {
    companion object {
        const val REASON_OTHER = "other"
        const val DEFAULT_NOTE_MAX = 500
    }
}

/** One row of GET /devices/me/escalations, and the body of a raise's response. */
data class EscalationView(
    val id: String,
    val callId: String,
    /** open | acknowledged | resolved | withdrawn */
    val status: String,
    val reason: String,
    val reasonLabel: String?,
    val note: String?,
    /** Who has it now. Null = every owner and manager. */
    val assignedToName: String?,
    val acknowledgedByName: String?,
    val resolvedByName: String?,
    val resolutionNote: String?,
    val createdAt: String,
    val resolvedAt: String?,
) {
    /** What the partial unique index `call_escalations_live` calls live. */
    val isLive: Boolean get() = status == STATUS_OPEN || status == STATUS_ACKNOWLEDGED

    /** What the recording's row says about it, or null for nothing (withdrawn / unknown). */
    fun rowStatus(): RowStatus? = when (status) {
        STATUS_OPEN -> RowStatus.Waiting(assignedToName)
        STATUS_ACKNOWLEDGED -> RowStatus.PickedUp(acknowledgedByName)
        STATUS_RESOLVED -> RowStatus.Answered(resolvedByName, resolutionNote)
        else -> null
    }

    sealed class RowStatus {
        /** [with] is who has it now - it changes when a senior passes it up. Null = every manager. */
        data class Waiting(val with: String?) : RowStatus()
        data class PickedUp(val by: String?) : RowStatus()
        data class Answered(val by: String?, val note: String?) : RowStatus()
    }

    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("callId", callId)
        .put("status", status)
        .put("reason", reason)
        .put("reasonLabel", reasonLabel ?: JSONObject.NULL)
        .put("note", note ?: JSONObject.NULL)
        .put("assignedToName", assignedToName ?: JSONObject.NULL)
        .put("acknowledgedByName", acknowledgedByName ?: JSONObject.NULL)
        .put("resolvedByName", resolvedByName ?: JSONObject.NULL)
        .put("resolutionNote", resolutionNote ?: JSONObject.NULL)
        .put("createdAt", createdAt)
        .put("resolvedAt", resolvedAt ?: JSONObject.NULL)

    companion object {
        const val STATUS_OPEN = "open"
        const val STATUS_ACKNOWLEDGED = "acknowledged"
        const val STATUS_RESOLVED = "resolved"
        const val STATUS_WITHDRAWN = "withdrawn"
    }
}

/**
 * Pure JSON parsing (org.json only), so it runs in JVM unit tests.
 *
 * Every nullable string goes through [str], which checks `isNull` FIRST:
 * Android's `optString(name, fallback)` returns the four-character string
 * "null" for a JSON null - see PlatformApi.fetchConfig for the phone that
 * mistake once locked out. Here it would read "Escalate to null".
 */
object EscalationJson {

    /** A JSON null, an absent key and a blank string all read as null. */
    internal fun str(o: JSONObject, name: String): String? =
        if (o.isNull(name)) null else o.optString(name, "").trim().ifBlank { null }

    /**
     * The `callEscalation` block of a config response, or null when it is absent,
     * null or unusable. Never throws: a malformed block must cost the phone the
     * escalation menu, never the rest of its config (recordingEnabled, the lock).
     */
    fun parseConfig(response: JSONObject): EscalationConfig? {
        if (!response.has(CONFIG_KEY) || response.isNull(CONFIG_KEY)) return null
        val block = response.optJSONObject(CONFIG_KEY) ?: return null
        return parseBlock(block)
    }

    /** The block itself - also how the stored copy is re-read offline. */
    fun parseBlock(block: JSONObject): EscalationConfig? = runCatching {
        val arr = block.optJSONArray("reasons") ?: JSONArray()
        val reasons = (0 until arr.length()).mapNotNull { i ->
            val r = arr.optJSONObject(i) ?: return@mapNotNull null
            val code = str(r, "code") ?: return@mapNotNull null
            EscalationReason(code = code, label = str(r, "label") ?: code, hint = str(r, "hint"))
        }
        // Nothing to choose from is nothing to send: hide the feature rather than
        // show a dialog with no reasons in it.
        if (reasons.isEmpty()) return@runCatching null
        val noteMax = block.optInt("noteMax", EscalationConfig.DEFAULT_NOTE_MAX)
            .let { if (it > 0) it else EscalationConfig.DEFAULT_NOTE_MAX }
        EscalationConfig(recipientName = str(block, "recipientName"), reasons = reasons, noteMax = noteMax)
    }.getOrNull()

    /** One DeviceCallEscalationView, or null when it lacks an id, a call or a status. */
    fun parseView(o: JSONObject): EscalationView? {
        val id = str(o, "id") ?: return null
        val callId = str(o, "callId") ?: return null
        val status = str(o, "status") ?: return null
        return EscalationView(
            id = id,
            callId = callId,
            status = status,
            reason = str(o, "reason") ?: "",
            reasonLabel = str(o, "reasonLabel"),
            note = str(o, "note"),
            assignedToName = str(o, "assignedToName"),
            acknowledgedByName = str(o, "acknowledgedByName"),
            resolvedByName = str(o, "resolvedByName"),
            resolutionNote = str(o, "resolutionNote"),
            createdAt = str(o, "createdAt") ?: "",
            resolvedAt = str(o, "resolvedAt"),
        )
    }

    fun parseViews(arr: JSONArray?): List<EscalationView> {
        if (arr == null) return emptyList()
        return (0 until arr.length()).mapNotNull { i -> arr.optJSONObject(i)?.let(::parseView) }
    }

    /**
     * One escalation per call for the row to show: the live one if there is
     * one (there is at most one - the server's `call_escalations_live` index),
     * otherwise the newest.
     */
    fun latestPerCall(views: Collection<EscalationView>): Map<String, EscalationView> =
        views.groupBy { it.callId }.mapValues { (_, list) ->
            list.firstOrNull { it.isLive } ?: list.maxBy { it.createdAt }
        }

    const val CONFIG_KEY = "callEscalation"
}
