package com.voicetranscriber.callrecorder.alerts

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

/**
 * What this phone has already shown, and the receipts it still owes the server.
 *
 * - `shown`: alert id -> when it was shown. A push can arrive twice (the
 *   console's immediate push and the worker's retry), and an ack can be lost on
 *   a bad network so the server returns the same alert again. Either way the
 *   person sees it once. Pruned after two days, longer than any alert lives.
 * - `recent`: the last alerts, so the popup screen and a tapped notification
 *   can show the full text without the network.
 * - `popups`: popup alerts not yet answered - what the full-screen screen lists.
 * - `delivered` / `opened`: ids to report, kept until the server has them so a
 *   receipt survives the process dying or the phone being offline.
 */
object AlertStore {

    private const val PREFS = "handset_alerts"
    private const val SHOWN_TTL_MS = 48 * 60 * 60 * 1000L
    private const val RECENT_MAX = 60

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun SharedPreferences.json(key: String): JSONObject =
        runCatching { JSONObject(getString(key, "{}") ?: "{}") }.getOrDefault(JSONObject())

    private fun SharedPreferences.ids(key: String): MutableSet<String> =
        (getStringSet(key, emptySet()) ?: emptySet()).toMutableSet()

    /** Records [alerts] as shown and returns the ones that had not been. */
    @Synchronized
    fun takeNew(context: Context, alerts: List<HandsetAlert>, now: Long = System.currentTimeMillis()): List<HandsetAlert> {
        val p = prefs(context)
        val shown = p.json("shown")
        // Prune first, so the map stays small however long the phone runs.
        shown.keys().asSequence().toList().forEach { k ->
            if (now - shown.optLong(k, 0) > SHOWN_TTL_MS) shown.remove(k)
        }
        val fresh = alerts.filter { !shown.has(it.id) }
        fresh.forEach { shown.put(it.id, now) }

        val recent = p.json("recent")
        fresh.forEach { recent.put(it.id, it.toJson()) }
        while (recent.length() > RECENT_MAX) {
            val oldest = recent.keys().asSequence()
                .minByOrNull { recent.optJSONObject(it)?.optString("createdAt") ?: "" } ?: break
            recent.remove(oldest)
        }

        val popups = popupIds(p)
        fresh.filter { it.popup }.forEach { if (it.id !in popups) popups.add(it.id) }

        p.edit()
            .putString("shown", shown.toString())
            .putString("recent", recent.toString())
            .putString("popups", JSONArray(popups).toString())
            .apply()
        return fresh
    }

    /** Lets an alert that could not be shown (notifications blocked) be shown on a later fetch. */
    @Synchronized
    fun forget(context: Context, ids: Collection<String>) {
        val p = prefs(context)
        val shown = p.json("shown")
        ids.forEach { shown.remove(it) }
        val popups = popupIds(p).filterNot { it in ids }
        p.edit().putString("shown", shown.toString()).putString("popups", JSONArray(popups).toString()).apply()
    }

    private fun popupIds(p: SharedPreferences): MutableList<String> {
        val arr = runCatching { JSONArray(p.getString("popups", "[]") ?: "[]") }.getOrDefault(JSONArray())
        return MutableList(arr.length()) { arr.getString(it) }
    }

    fun get(context: Context, id: String): HandsetAlert? =
        prefs(context).json("recent").optJSONObject(id)?.let { runCatching { HandsetAlert.fromJson(it) }.getOrNull() }

    /** Unanswered popups, oldest first. */
    @Synchronized
    fun popups(context: Context): List<HandsetAlert> {
        val p = prefs(context)
        return popupIds(p).mapNotNull { get(context, it) }
    }

    @Synchronized
    fun queueDelivered(context: Context, ids: Collection<String>) {
        if (ids.isEmpty()) return
        val p = prefs(context)
        p.edit().putStringSet("delivered", p.ids("delivered").apply { addAll(ids) }).apply()
    }

    /** The person saw it: off the popup list, and owed to the server as read. */
    @Synchronized
    fun markOpened(context: Context, ids: Collection<String>) {
        if (ids.isEmpty()) return
        val p = prefs(context)
        val popups = popupIds(p).filterNot { it in ids }
        p.edit()
            .putStringSet("opened", p.ids("opened").apply { addAll(ids) })
            .putString("popups", JSONArray(popups).toString())
            .apply()
    }

    /** The receipts still owed, as (delivered, opened). */
    @Synchronized
    fun pendingAcks(context: Context): Pair<Set<String>, Set<String>> {
        val p = prefs(context)
        return p.ids("delivered") to p.ids("opened")
    }

    /** The server has these - stop resending them. */
    @Synchronized
    fun clearAcks(context: Context, delivered: Set<String>, opened: Set<String>) {
        val p = prefs(context)
        p.edit()
            .putStringSet("delivered", p.ids("delivered").apply { removeAll(delivered) })
            .putStringSet("opened", p.ids("opened").apply { removeAll(opened) })
            .apply()
    }
}
