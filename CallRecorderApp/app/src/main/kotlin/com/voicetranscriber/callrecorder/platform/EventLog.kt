package com.voicetranscriber.callrecorder.platform

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/**
 * A tiny, durable, best-effort queue of device events (e.g. "a call went off-hook").
 * Writes are cheap SharedPreferences appends so callers — including a
 * BroadcastReceiver on the main thread — never block. The [HealthWorker] drains it
 * on its periodic run and batch-POSTs to /v1/devices/me/events.
 */
object EventLog {

    private const val PREFS = "aura_events"
    private const val KEY = "queue"
    private const val CAP = 200 // bound the queue so a long offline stretch can't grow unbounded

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun load(context: Context): JSONArray {
        val raw = prefs(context).getString(KEY, null) ?: return JSONArray()
        return runCatching { JSONArray(raw) }.getOrDefault(JSONArray())
    }

    private fun store(context: Context, array: JSONArray) {
        // Keep only the newest CAP entries.
        val capped = if (array.length() <= CAP) {
            array
        } else {
            JSONArray().also { out ->
                for (i in (array.length() - CAP) until array.length()) out.put(array.get(i))
            }
        }
        prefs(context).edit().putString(KEY, capped.toString()).apply()
    }

    /** Appends one event `{type, at, ...extra}`. Non-blocking. */
    @Synchronized
    fun record(context: Context, type: String, extra: Map<String, String> = emptyMap()) {
        val event = JSONObject()
            .put("type", type)
            .put("at", Instant.now().toString())
        extra.forEach { (k, v) -> event.put(k, v) }
        store(context, load(context).apply { put(event) })
    }

    /** Atomically returns all queued events and clears the queue. */
    @Synchronized
    fun takeAll(context: Context): List<JSONObject> {
        val array = load(context)
        prefs(context).edit().remove(KEY).apply()
        return (0 until array.length()).map { array.getJSONObject(it) }
    }

    /** Puts events back at the front of the queue (used when a send fails). */
    @Synchronized
    fun restore(context: Context, events: List<JSONObject>) {
        if (events.isEmpty()) return
        val merged = JSONArray()
        events.forEach { merged.put(it) }
        val existing = load(context)
        for (i in 0 until existing.length()) merged.put(existing.get(i))
        store(context, merged)
    }
}
