package com.voicetranscriber.callrecorder.attendance

import org.json.JSONArray
import org.json.JSONObject

/**
 * JSON for the attendance contract and for the engine's saved state.
 *
 * The same rule as PlatformApi.fetchConfig: an optional field is read with
 * [optStr], which checks `isNull` FIRST. Android's optString(name, fallback)
 * returns the fallback only for an ABSENT key - for a JSON null it returns the
 * four-character string "null". The server omits optional keys rather than
 * sending null, but a phone must not break if one ever arrives.
 */
object AttendanceJson {

    fun optStr(o: JSONObject, key: String): String? =
        if (!o.has(key) || o.isNull(key)) null else o.optString(key, "").ifBlank { null }

    private fun optLong(o: JSONObject, key: String): Long? =
        if (!o.has(key) || o.isNull(key)) null else o.optLong(key)

    /**
     * Parses the `attendance` block of GET /devices/me/config. Null when the
     * block is absent, null, not an object, or not `enabled: true` - all of
     * which mean "attendance is off for this phone".
     */
    fun parseConfig(config: JSONObject): AttendanceConfig? {
        if (!config.has("attendance") || config.isNull("attendance")) return null
        val a = config.optJSONObject("attendance") ?: return null
        return parseBlock(a)
    }

    fun parseBlock(a: JSONObject): AttendanceConfig? {
        if (!a.optBoolean("enabled", false)) return null
        val days = mutableListOf<ScheduleDay>()
        val arr = a.optJSONArray("days") ?: JSONArray()
        for (i in 0 until arr.length()) {
            val d = arr.optJSONObject(i) ?: continue
            val date = optStr(d, "date") ?: continue
            val breaks = mutableListOf<ScheduleBreak>()
            val barr = d.optJSONArray("breaks") ?: JSONArray()
            for (j in 0 until barr.length()) {
                val b = barr.optJSONObject(j) ?: continue
                val s = ShiftSchedule.parseInstant(optStr(b, "startsAt")) ?: continue
                val e = ShiftSchedule.parseInstant(optStr(b, "endsAt")) ?: continue
                breaks += ScheduleBreak(optStr(b, "label") ?: "Break", s, e, optStr(b, "source") ?: "slot")
            }
            days += ScheduleDay(
                date = date,
                kind = optStr(d, "kind") ?: "off",
                shiftStartMs = ShiftSchedule.parseInstant(optStr(d, "shiftStart")),
                shiftEndMs = ShiftSchedule.parseInstant(optStr(d, "shiftEnd")),
                halfDay = optStr(d, "halfDay"),
                label = optStr(d, "label"),
                breaks = breaks,
            )
        }
        return AttendanceConfig(
            canApplyLeave = a.optBoolean("canApplyLeave", false),
            canBookBreaks = a.optBoolean("canBookBreaks", false),
            approverName = optStr(a, "approverName"),
            heartbeatSeconds = a.optInt("heartbeatSeconds", 120),
            silenceThresholdMinutes = a.optInt("silenceThresholdMinutes", 10),
            promptTimeoutMinutes = a.optInt("promptTimeoutMinutes", 3),
            graceMinutes = a.optInt("graceMinutes", 10),
            breakAllowanceMinutes = a.optInt("breakAllowanceMinutes", 60),
            scheduleVersion = a.optInt("scheduleVersion", 0),
            timeZone = optStr(a, "timeZone") ?: "UTC",
            days = days,
            noticeVersion = a.optInt("noticeVersion", 1),
            noticeText = optStr(a, "noticeText") ?: "",
        )
    }

    // ── Engine snapshot ─────────────────────────────────────────────────────

    private fun windowToJson(w: ShiftWindow) = JSONObject()
        .put("date", w.date).put("start", w.startMs).put("end", w.endMs)
        .apply { w.label?.let { put("label", it) } }
        .put(
            "breaks",
            JSONArray().apply {
                w.breaks.forEach {
                    put(
                        JSONObject().put("label", it.label).put("s", it.startsAtMs)
                            .put("e", it.endsAtMs).put("src", it.source),
                    )
                }
            },
        )

    private fun windowFromJson(o: JSONObject): ShiftWindow {
        val arr = o.optJSONArray("breaks") ?: JSONArray()
        val breaks = (0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let {
                ScheduleBreak(optStr(it, "label") ?: "Break", it.getLong("s"), it.getLong("e"), optStr(it, "src") ?: "slot")
            }
        }
        return ShiftWindow(o.getString("date"), o.getLong("start"), o.getLong("end"), breaks, optStr(o, "label"))
    }

    private fun dueToJson(d: PresenceEngine.DueBreak) =
        JSONObject().put("label", d.label).put("due", d.dueAt).put("len", d.lengthMs)

    private fun dueFromJson(o: JSONObject?) =
        o?.let { PresenceEngine.DueBreak(optStr(it, "label") ?: "Break", it.getLong("due"), it.getLong("len")) }

    fun snapshotToJson(s: PresenceEngine.Snapshot): String {
        val o = JSONObject()
        s.window?.let { o.put("window", windowToJson(it)) }
        o.put("state", s.state.name)
        o.put("stateSince", s.stateSince)
        o.put("started", s.started)
        o.put("ended", s.ended)
        o.put("lastActivityAt", s.lastActivityAt)
        s.promptShownAt?.let { o.put("promptShownAt", it) }
        s.cellularCallAt?.let { o.put("cellularCallAt", it) }
        s.cellularDirection?.let { o.put("cellularDirection", it) }
        s.voipCallAt?.let { o.put("voipCallAt", it) }
        s.stateBeforeCall?.let { o.put("stateBeforeCall", it.name) }
        s.breakDue?.let { o.put("breakDue", dueToJson(it)) }
        s.deferredBreak?.let { o.put("deferredBreak", dueToJson(it)) }
        s.currentBreak?.let {
            o.put(
                "currentBreak",
                JSONObject().put("label", it.label).put("scheduled", it.scheduled).put("startedAt", it.startedAt)
                    .apply { it.endsAt?.let { e -> put("endsAt", e) } },
            )
        }
        s.lastHeartbeatAt?.let { o.put("lastHeartbeatAt", it) }
        o.put("handled", JSONArray().apply { s.handledBreaks.forEach { put(it) } })
        o.put("fired", JSONArray().apply { s.firedReminders.forEach { put(it) } })
        o.put(
            "held",
            JSONArray().apply {
                s.held.forEach {
                    put(
                        JSONObject().put("id", it.id).put("text", it.text).put("action", it.action.name)
                            .put("until", it.validUntil),
                    )
                }
            },
        )
        return o.toString()
    }

    fun snapshotFromJson(raw: String): PresenceEngine.Snapshot? = runCatching {
        val o = JSONObject(raw)
        val handled = o.optJSONArray("handled") ?: JSONArray()
        val fired = o.optJSONArray("fired") ?: JSONArray()
        val held = o.optJSONArray("held") ?: JSONArray()
        val cb = o.optJSONObject("currentBreak")
        PresenceEngine.Snapshot(
            window = o.optJSONObject("window")?.let(::windowFromJson),
            state = HandsetState.fromWire(optStr(o, "state")) ?: HandsetState.OFF_SHIFT,
            stateSince = o.optLong("stateSince"),
            started = o.optBoolean("started"),
            ended = o.optBoolean("ended"),
            lastActivityAt = o.optLong("lastActivityAt"),
            promptShownAt = optLong(o, "promptShownAt"),
            cellularCallAt = optLong(o, "cellularCallAt"),
            cellularDirection = optStr(o, "cellularDirection"),
            voipCallAt = optLong(o, "voipCallAt"),
            stateBeforeCall = HandsetState.fromWire(optStr(o, "stateBeforeCall")),
            breakDue = dueFromJson(o.optJSONObject("breakDue")),
            deferredBreak = dueFromJson(o.optJSONObject("deferredBreak")),
            currentBreak = cb?.let {
                PresenceEngine.ActiveBreak(
                    optStr(it, "label") ?: "Break", it.optBoolean("scheduled"), it.getLong("startedAt"),
                    optLong(it, "endsAt"),
                )
            },
            lastHeartbeatAt = optLong(o, "lastHeartbeatAt"),
            handledBreaks = (0 until handled.length()).map { handled.getLong(it) }.toSet(),
            firedReminders = (0 until fired.length()).map { fired.getString(it) }.toSet(),
            held = (0 until held.length()).mapNotNull { i ->
                held.optJSONObject(i)?.let {
                    PresenceEngine.HeldReminder(
                        it.getString("id"), it.getString("text"),
                        runCatching { PresenceEngine.ReminderAction.valueOf(it.getString("action")) }
                            .getOrDefault(PresenceEngine.ReminderAction.NONE),
                        it.getLong("until"),
                    )
                }
            },
        )
    }.getOrNull()

    /** A payload map (String/Number/Boolean values) as a JSON object. */
    fun payload(map: Map<String, Any>): JSONObject = JSONObject().apply { map.forEach { (k, v) -> put(k, v) } }
}
