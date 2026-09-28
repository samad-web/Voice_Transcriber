package com.voicetranscriber.callrecorder.attendance

import android.content.Context
import android.content.SharedPreferences
import android.os.SystemClock
import android.provider.Settings
import org.json.JSONObject

/** The real clocks. BOOT_COUNT exists since API 24; a missing value falls back to "0". */
class SystemDeviceClock(private val context: Context) : DeviceClock {
    override fun wallMs(): Long = System.currentTimeMillis()
    override fun elapsedMs(): Long = SystemClock.elapsedRealtime()
    override fun bootId(): String =
        runCatching { Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT) }
            .getOrDefault(0).toString()
}

/**
 * Small attendance state that must survive process death and is not a queue:
 * the synced config block, the notice acknowledgement, the engine snapshot,
 * the clock anchor, upload backoff, and the last-known request statuses.
 * The event and request QUEUES live in Room ([AttendanceDb]).
 */
object AttendanceStore {

    private const val PREFS = "aura_attendance"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ── Config ──

    fun configJson(context: Context): String? = prefs(context).getString("config_json", null)

    fun config(context: Context): AttendanceConfig? =
        configJson(context)?.let { raw -> runCatching { AttendanceJson.parseBlock(JSONObject(raw)) }.getOrNull() }

    fun saveConfig(context: Context, json: String?, scheduleVersion: Int) {
        prefs(context).edit().apply {
            if (json == null) remove("config_json") else putString("config_json", json)
            putInt("schedule_version", scheduleVersion)
        }.apply()
    }

    fun scheduleVersion(context: Context): Int = prefs(context).getInt("schedule_version", -1)

    // ── Notice (doc 33 §11) ──

    fun noticeAckVersion(context: Context): Int = prefs(context).getInt("notice_ack_version", 0)

    fun setNoticeAckVersion(context: Context, version: Int) {
        prefs(context).edit().putInt("notice_ack_version", version).apply()
    }

    fun noticeNotifiedVersion(context: Context): Int = prefs(context).getInt("notice_notified_version", 0)

    fun setNoticeNotifiedVersion(context: Context, version: Int) {
        prefs(context).edit().putInt("notice_notified_version", version).apply()
    }

    fun setupOffered(context: Context): Boolean = prefs(context).getBoolean("setup_offered", false)

    fun setSetupOffered(context: Context, offered: Boolean) {
        prefs(context).edit().putBoolean("setup_offered", offered).apply()
    }

    // ── Engine + clock ──

    fun snapshot(context: Context): String? = prefs(context).getString("engine_snapshot", null)

    /** commit(), not apply(): the snapshot is what a killed process restarts from. */
    fun saveSnapshot(context: Context, json: String?) {
        prefs(context).edit().apply {
            if (json == null) remove("engine_snapshot") else putString("engine_snapshot", json)
        }.commit()
    }

    fun anchor(context: Context): TrustedTime.Anchor? {
        val p = prefs(context)
        val boot = p.getString("anchor_boot", null) ?: return null
        return TrustedTime.Anchor(p.getLong("anchor_wall", 0), p.getLong("anchor_elapsed", 0), boot)
    }

    fun saveAnchor(context: Context, anchor: TrustedTime.Anchor) {
        prefs(context).edit()
            .putString("anchor_boot", anchor.bootId)
            .putLong("anchor_wall", anchor.wallMs)
            .putLong("anchor_elapsed", anchor.elapsedMs)
            .apply()
    }

    /** The boot the last snapshot was written in: a different one now means the phone rebooted. */
    fun snapshotBoot(context: Context): String? = prefs(context).getString("snapshot_boot", null)

    fun setSnapshotBoot(context: Context, bootId: String) {
        prefs(context).edit().putString("snapshot_boot", bootId).apply()
    }

    // ── Upload backoff (elapsedRealtime-based, so a clock change cannot skip it) ──

    fun backoffUntilElapsed(context: Context): Long = prefs(context).getLong("backoff_until", 0)
    fun backoffMs(context: Context): Long = prefs(context).getLong("backoff_ms", 0)

    fun setBackoff(context: Context, untilElapsed: Long, backoffMs: Long) {
        prefs(context).edit().putLong("backoff_until", untilElapsed).putLong("backoff_ms", backoffMs).apply()
    }

    // ── Requests ──

    /** id → status as last seen, so a change to approved/rejected can be announced once. */
    fun requestStatuses(context: Context): MutableMap<String, String> {
        val raw = prefs(context).getString("request_statuses", null) ?: return mutableMapOf()
        return runCatching {
            val o = JSONObject(raw)
            o.keys().asSequence().associateWith { o.getString(it) }.toMutableMap()
        }.getOrDefault(mutableMapOf())
    }

    fun saveRequestStatuses(context: Context, map: Map<String, String>) {
        val o = JSONObject()
        // Keep the newest few hundred; ids only matter while a request can still change.
        map.entries.toList().takeLast(300).forEach { (k, v) -> o.put(k, v) }
        prefs(context).edit().putString("request_statuses", o.toString()).apply()
    }

    /** The last GET /devices/me/attendance answer, shown when the phone is offline. */
    fun cachedDay(context: Context): String? = prefs(context).getString("cached_day", null)

    fun saveCachedDay(context: Context, json: String) {
        prefs(context).edit().putString("cached_day", json).apply()
    }

    /** Wipes everything but the notice acknowledgement (attendance switched off). */
    fun clearTracking(context: Context) {
        prefs(context).edit()
            .remove("config_json")
            .remove("engine_snapshot")
            .remove("backoff_until")
            .remove("backoff_ms")
            .remove("cached_day")
            .putInt("schedule_version", -1)
            .apply()
    }
}
