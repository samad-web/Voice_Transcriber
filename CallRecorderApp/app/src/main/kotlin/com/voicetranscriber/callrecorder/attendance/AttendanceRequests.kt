package com.voicetranscriber.callrecorder.attendance

import android.content.Context
import android.util.Log
import com.voicetranscriber.callrecorder.platform.PlatformApi
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/**
 * Leave and break applications from the phone (doc 33 §6.3), and the
 * telecaller's own day from GET /devices/me/attendance.
 *
 * An application is written to Room BEFORE the first attempt, with a clientRef
 * made when Send was tapped. Every retry reuses it, so a request whose response
 * was lost is stored once on the server. Blocking; call from an IO thread.
 */
object AttendanceRequests {

    private const val TAG = "AttendanceRequests"

    /** A request as the Attendance screen shows it: from the server, or still on the phone. */
    data class Row(
        val id: String?,
        val clientRef: String?,
        val kind: String,
        val status: String,
        val description: String,
        val progress: String,
        val decisionNote: String?,
        val cancellable: Boolean,
        val local: Boolean,
    )

    // ── Building bodies ──────────────────────────────────────────────────────

    fun leaveBody(leaveType: LeaveType, startDate: String, endDate: String, halfDay: String?, reason: String?): JSONObject =
        JSONObject()
            .put("kind", "leave")
            .put("leaveType", leaveType.wire)
            .put("startDate", startDate)
            .put("endDate", endDate)
            .apply {
                if (halfDay != null) put("halfDay", halfDay)
                if (!reason.isNullOrBlank()) put("reason", reason.trim().take(500))
            }

    fun breakBody(startsAtMs: Long, endsAtMs: Long, reason: String?): JSONObject =
        JSONObject()
            .put("kind", "break")
            .put("startsAt", ShiftSchedule.iso(startsAtMs))
            .put("endsAt", ShiftSchedule.iso(endsAtMs))
            .apply { if (!reason.isNullOrBlank()) put("reason", reason.trim().take(500)) }

    /** Queues [body] with a fresh clientRef, then tries to send it. Returns the send outcome text. */
    fun submit(context: Context, body: JSONObject): String {
        val clientRef = UUID.randomUUID().toString()
        body.put("clientRef", clientRef)
        AttendanceDb.get(context).dao().upsertRequest(
            PendingRequestEntity(clientRef, body.toString(), System.currentTimeMillis(), "waiting", null),
        )
        return sendPending(context) ?: "Sent"
    }

    /**
     * Sends every waiting application. Returns null when all went through,
     * otherwise a short message about the first one that did not.
     */
    fun sendPending(context: Context): String? {
        val dao = AttendanceDb.get(context).dao()
        var message: String? = null
        for (p in dao.pendingRequests()) {
            if (p.status != "waiting") continue
            try {
                val response = AttendanceApi.postRequest(context, JSONObject(p.body))
                dao.deleteRequest(p.clientRef)
                response.optJSONObject("request")?.let { rememberStatus(context, it) }
            } catch (e: PlatformApi.ApiException) {
                val why = when {
                    e.code == 403 && e.errorCode == "app_requests_disabled" ->
                        "Your workspace has not switched this on for you."
                    e.code == 409 && e.errorCode == "attendance_disabled" -> "Attendance is switched off."
                    e.code == 400 -> e.errorMessage ?: "The server did not accept this application."
                    else -> null
                }
                if (why != null) {
                    // Refused for good: keep it on screen as "Not sent" until dismissed.
                    dao.upsertRequest(p.copy(status = "failed", lastError = why))
                    message = message ?: why
                } else {
                    message = message ?: "Waiting to send"
                    Log.w(TAG, "request send failed: ${e.message}")
                }
            } catch (e: AttendanceApi.NotActivated) {
                message = message ?: "This phone is not activated"
            } catch (t: Throwable) {
                message = message ?: "Waiting to send"
            }
        }
        return message
    }

    fun dismissFailed(context: Context, clientRef: String) = AttendanceDb.get(context).dao().deleteRequest(clientRef)

    /** Cancels a pending request. Returns null on success, or why not. */
    fun cancel(context: Context, id: String): String? = try {
        val response = AttendanceApi.cancelRequest(context, id)
        response.optJSONObject("request")?.let { rememberStatus(context, it) }
        null
    } catch (e: PlatformApi.ApiException) {
        if (e.code == 409 && e.errorCode == "not_cancellable") {
            "It has already been decided - only a manager can change it now."
        } else {
            e.errorMessage ?: "Could not cancel (HTTP ${e.code})"
        }
    } catch (t: Throwable) {
        "No connection - try again when you're online"
    }

    // ── The day ──────────────────────────────────────────────────────────────

    /** GET /devices/me/attendance for [date], cached for offline display, decisions announced. */
    fun fetchDay(context: Context, date: String): JSONObject {
        val day = AttendanceApi.getDay(context, date)
        AttendanceStore.saveCachedDay(context, day.toString())
        announceDecisions(context, day.optJSONArray("requests") ?: JSONArray())
        return day
    }

    fun cachedDay(context: Context): JSONObject? =
        AttendanceStore.cachedDay(context)?.let { runCatching { JSONObject(it) }.getOrNull() }

    private fun rememberStatus(context: Context, request: JSONObject) {
        val id = AttendanceJson.optStr(request, "id") ?: return
        val status = AttendanceJson.optStr(request, "status") ?: return
        val map = AttendanceStore.requestStatuses(context)
        map[id] = status
        AttendanceStore.saveRequestStatuses(context, map)
    }

    /**
     * "Your leave on 3 Oct was approved by Ravi" - once, when a request this
     * phone last saw as pending is now decided. A request first seen already
     * decided is only remembered (it was decided before this phone knew it).
     */
    fun announceDecisions(context: Context, requests: JSONArray) {
        val known = AttendanceStore.requestStatuses(context)
        val cfg = AttendanceStore.config(context)
        for (i in 0 until requests.length()) {
            val r = requests.optJSONObject(i) ?: continue
            val id = AttendanceJson.optStr(r, "id") ?: continue
            val status = AttendanceJson.optStr(r, "status") ?: continue
            val before = known[id]
            if (before == "pending" && (status == "approved" || status == "rejected")) {
                AttendanceNotifications.decision(context, id, decisionText(r, status, cfg?.timeZone ?: "UTC"))
            }
            known[id] = status
        }
        AttendanceStore.saveRequestStatuses(context, known)
    }

    private fun decisionText(r: JSONObject, status: String, zone: String): String {
        val who = AttendanceJson.optStr(r, "approverName")
        val by = if (who != null) " by $who" else ""
        val what = when (AttendanceJson.optStr(r, "kind")) {
            "leave" -> "leave on ${leaveDates(r)}"
            "break" -> "break on ${timedWhen(r, zone)}"
            else -> "hours change on ${timedWhen(r, zone)}"
        }
        val note = AttendanceJson.optStr(r, "decisionNote")
        val verb = if (status == "approved") "approved" else "rejected"
        return "Your $what was $verb$by" + (note?.let { ": $it" } ?: "")
    }

    private fun leaveDates(r: JSONObject): String {
        val s = AttendanceJson.optStr(r, "startDate") ?: return "?"
        val e = AttendanceJson.optStr(r, "endDate") ?: s
        val half = AttendanceJson.optStr(r, "halfDay")
        return when {
            half != null -> "${ShiftSchedule.shortDate(s)} ${if (half == "am") "morning" else "afternoon"}"
            s == e -> ShiftSchedule.shortDate(s)
            else -> "${ShiftSchedule.shortDate(s)} - ${ShiftSchedule.shortDate(e)}"
        }
    }

    private fun timedWhen(r: JSONObject, zone: String): String {
        val s = ShiftSchedule.parseInstant(AttendanceJson.optStr(r, "startsAt")) ?: return "?"
        val e = ShiftSchedule.parseInstant(AttendanceJson.optStr(r, "endsAt"))
        val date = ShiftSchedule.shortDate(ShiftSchedule.dateKey(s, zone))
        return "$date at ${ShiftSchedule.clock(s, zone)}" + (e?.let { " - ${ShiftSchedule.clock(it, zone)}" } ?: "")
    }

    // ── Rows for the screen ──────────────────────────────────────────────────

    fun rows(context: Context, day: JSONObject?): List<Row> {
        val cfg = AttendanceStore.config(context)
        val zone = cfg?.timeZone ?: "UTC"
        val approver = cfg?.approverName ?: "Owners"
        val out = mutableListOf<Row>()
        for (p in AttendanceDb.get(context).dao().pendingRequests()) {
            val body = runCatching { JSONObject(p.body) }.getOrNull() ?: continue
            out += Row(
                id = null, clientRef = p.clientRef,
                kind = AttendanceJson.optStr(body, "kind") ?: "leave",
                status = p.status,
                description = describe(body, zone),
                progress = if (p.status == "failed") "Not sent: ${p.lastError ?: "refused"}" else "Waiting to send",
                decisionNote = null, cancellable = true, local = true,
            )
        }
        val arr = day?.optJSONArray("requests") ?: JSONArray()
        for (i in 0 until arr.length()) {
            val r = arr.optJSONObject(i) ?: continue
            val status = AttendanceJson.optStr(r, "status") ?: "pending"
            val with = AttendanceJson.optStr(r, "approverName") ?: approver
            val progress = when (status) {
                "pending" -> "Sent → With $with"
                "approved" -> "Sent → With $with → Approved"
                "auto_approved" -> "Approved automatically"
                "rejected" -> "Sent → With $with → Rejected"
                "cancelled" -> "Cancelled"
                else -> status
            }
            out += Row(
                id = AttendanceJson.optStr(r, "id"), clientRef = null,
                kind = AttendanceJson.optStr(r, "kind") ?: "leave",
                status = status,
                description = describe(r, zone),
                progress = progress,
                decisionNote = AttendanceJson.optStr(r, "decisionNote"),
                cancellable = status == "pending",
                local = false,
            )
        }
        return out
    }

    fun describe(r: JSONObject, zone: String): String = when (AttendanceJson.optStr(r, "kind")) {
        "leave" -> {
            val type = LeaveType.fromWire(AttendanceJson.optStr(r, "leaveType"))?.label ?: "Leave"
            "$type leave · ${leaveDates(r)}"
        }
        "break" -> "Break · ${timedWhen(r, zone)}"
        else -> "Hours change · ${timedWhen(r, zone)}"
    }
}
