package com.voicetranscriber.callrecorder.escalation

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONArray
import org.json.JSONObject

/**
 * What the phone knows about call escalations (Build docs/38): the config block
 * as the server last sent it, and the latest escalation on each call.
 *
 * The block is stored RAW and re-parsed, like the attendance block, so it reads
 * the same offline. No block = the feature is off: [saveConfig] with null also
 * drops the cached statuses, so a switched-off workspace shows nothing at all.
 *
 * [state] is process-wide, so a refresh from a push (AlertSync) reaches a list
 * that is already on screen.
 */
object EscalationStore {

    private const val PREFS = "aura_escalation"
    private const val KEY_CONFIG = "config_json"
    private const val KEY_STATUSES = "statuses_json"

    /** Calls the cache remembers. The list endpoint reads 30 days, which is far fewer for one phone. */
    private const val MAX_CACHED = 300

    data class State(
        val config: EscalationConfig?,
        /** callId (the server's call id, RecordingEntity.remoteCallId) → its latest escalation. */
        val byCall: Map<String, EscalationView>,
    ) {
        val enabled: Boolean get() = config != null

        /** Live = open or acknowledged; one per call, so a second raise is pointless. */
        fun isLive(callId: String?): Boolean = callId != null && byCall[callId]?.isLive == true
    }

    private val lock = Any()
    @Volatile private var flow: MutableStateFlow<State>? = null

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun flow(context: Context): MutableStateFlow<State> {
        flow?.let { return it }
        synchronized(lock) {
            flow?.let { return it }
            return MutableStateFlow(load(context)).also { flow = it }
        }
    }

    private fun load(context: Context): State {
        val p = prefs(context)
        val config = p.getString(KEY_CONFIG, null)
            ?.let { raw -> runCatching { EscalationJson.parseBlock(JSONObject(raw)) }.getOrNull() }
            ?: return State(null, emptyMap())
        val views = p.getString(KEY_STATUSES, null)
            ?.let { raw -> runCatching { EscalationJson.parseViews(JSONArray(raw)) }.getOrNull() }
            .orEmpty()
        return State(config, EscalationJson.latestPerCall(views))
    }

    fun state(context: Context): StateFlow<State> = flow(context).asStateFlow()

    fun current(context: Context): State = flow(context).value

    fun config(context: Context): EscalationConfig? = current(context).config

    fun isEnabled(context: Context): Boolean = current(context).enabled

    // ── Config ──

    /**
     * From the config refresh. [json] is the raw `callEscalation` block, or null
     * when the server omitted it - the feature is off and everything is cleared.
     */
    fun saveConfig(context: Context, json: String?) {
        val config = json?.let { raw -> runCatching { EscalationJson.parseBlock(JSONObject(raw)) }.getOrNull() }
        synchronized(lock) {
            val f = flow(context)
            if (config == null) {
                prefs(context).edit().remove(KEY_CONFIG).remove(KEY_STATUSES).apply()
                f.value = State(null, emptyMap())
            } else {
                prefs(context).edit().putString(KEY_CONFIG, json).apply()
                f.value = f.value.copy(config = config)
            }
        }
    }

    // ── Statuses ──

    /** The whole list from GET /devices/me/escalations replaces the cache. */
    fun replaceAll(context: Context, views: List<EscalationView>) {
        synchronized(lock) {
            val f = flow(context)
            if (f.value.config == null) return // switched off meanwhile: keep showing nothing
            val byCall = EscalationJson.latestPerCall(views)
            persist(context, byCall)
            f.value = f.value.copy(byCall = byCall)
        }
    }

    /** One escalation from a raise's response. */
    fun put(context: Context, view: EscalationView) {
        synchronized(lock) {
            val f = flow(context)
            if (f.value.config == null) return
            val byCall = f.value.byCall + (view.callId to view)
            persist(context, byCall)
            f.value = f.value.copy(byCall = byCall)
        }
    }

    private fun persist(context: Context, byCall: Map<String, EscalationView>) {
        val arr = JSONArray()
        byCall.values.sortedByDescending { it.createdAt }.take(MAX_CACHED).forEach { arr.put(it.toJson()) }
        prefs(context).edit().putString(KEY_STATUSES, arr.toString()).apply()
    }

    /** De-enrollment: nothing of the old workspace survives. */
    fun clear(context: Context) = saveConfig(context, null)
}
