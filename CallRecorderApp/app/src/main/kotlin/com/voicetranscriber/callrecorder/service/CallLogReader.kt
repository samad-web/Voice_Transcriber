package com.voicetranscriber.callrecorder.service

import android.content.Context
import android.provider.CallLog
import android.util.Log

/** The number/name/direction of a finished call, read from the system call log. */
data class CallInfo(val number: String?, val name: String?, val direction: String?)

/**
 * A call-log entry nobody picked up. [direction] and [reason] are the
 * server's MissedCallDirection/MissedCallReason (packages/shared device-api
 * .ts): `incoming` pairs with `unanswered`/`declined`/`voicemail`, `outgoing`
 * pairs only with `no_answer` - one of OUR OWN attempts that rang out.
 */
data class MissedCallEntry(
    val date: Long,
    val number: String?,
    val name: String?,
    val direction: String,
    val reason: String,
)

/**
 * Reads the most recent call-log entry. Far more reliable than PHONE_STATE's
 * EXTRA_INCOMING_NUMBER: it works for outgoing calls too and includes the cached
 * contact name. Requires READ_CALL_LOG.
 */
object CallLogReader {
    fun latest(context: Context): CallInfo? = try {
        context.contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            arrayOf(CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.CACHED_NAME),
            null, null,
            "${CallLog.Calls.DATE} DESC",
        )?.use { c ->
            if (c.moveToFirst()) {
                val number = c.getString(0)?.takeIf { it.isNotBlank() }
                val direction = when (c.getInt(1)) {
                    CallLog.Calls.INCOMING_TYPE -> "incoming"
                    CallLog.Calls.OUTGOING_TYPE -> "outgoing"
                    else -> null
                }
                val name = c.getString(2)?.takeIf { it.isNotBlank() }
                CallInfo(number, name, direction)
            } else null
        }
    } catch (t: Throwable) {
        Log.d("CallLogReader", "call log read failed: ${t.message}")
        null
    }

    /**
     * The call-log entry closest to [atMillis], within [toleranceMs]. Used to enrich an OEM
     * recording (whose filename carries a timestamp but no direction) with the direction and
     * the contact name/number. Unlike [latest] this works for historical files, so a backlog
     * of existing recordings can be imported correctly rather than all matching the last call.
     *
     * Only ANSWERED or DIALLED entries are candidates. A recording exists only for a call that
     * connected, so a missed or declined entry can never be the call it is of - and letting one
     * win (a customer's missed call a minute before the rep rang them back) left the recording
     * with no direction, which the server rejects on every retry, so it never uploaded.
     */
    fun nearest(context: Context, atMillis: Long, toleranceMs: Long = DEFAULT_TOLERANCE_MS): CallInfo? = try {
        context.contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            arrayOf(
                CallLog.Calls.NUMBER,
                CallLog.Calls.TYPE,
                CallLog.Calls.CACHED_NAME,
                CallLog.Calls.DATE,
            ),
            "${CallLog.Calls.DATE} BETWEEN ? AND ? AND ${CallLog.Calls.TYPE} IN (?, ?)",
            arrayOf(
                (atMillis - toleranceMs).toString(),
                (atMillis + toleranceMs).toString(),
                CallLog.Calls.INCOMING_TYPE.toString(),
                CallLog.Calls.OUTGOING_TYPE.toString(),
            ),
            "${CallLog.Calls.DATE} DESC",
        )?.use { c ->
            var best: CallInfo? = null
            var bestDelta = Long.MAX_VALUE
            while (c.moveToNext()) {
                val delta = kotlin.math.abs(c.getLong(3) - atMillis)
                if (delta >= bestDelta) continue
                bestDelta = delta
                best = CallInfo(
                    number = c.getString(0)?.takeIf { it.isNotBlank() },
                    name = c.getString(2)?.takeIf { it.isNotBlank() },
                    direction = when (c.getInt(1)) {
                        CallLog.Calls.INCOMING_TYPE -> "incoming"
                        CallLog.Calls.OUTGOING_TYPE -> "outgoing"
                        else -> null
                    },
                )
            }
            best
        }
    } catch (t: Throwable) {
        Log.d("CallLogReader", "call log lookup failed: ${t.message}")
        null
    }

    /**
     * Calls nobody picked up that rang AFTER [afterMillis], oldest first, at most [limit].
     *
     * MISSED, REJECTED and VOICEMAIL - the three ways an incoming call ends unheard. BLOCKED is
     * left out on purpose: the person holding the phone chose never to hear that number, and
     * reporting it as missed business would put their blocklist on the owner's dashboard.
     *
     * Also OUTGOING with a zero DURATION - one of OUR OWN attempts that rang out and nobody
     * answered. Not "missed" in the console's sense (that word stays for the customer side,
     * console-palette rule), but the same shape of fact: a call nobody spoke on, worth the
     * telecaller trying again.
     *
     * A number is kept only when the network actually presented one. A withheld or unknown
     * caller's NUMBER column holds a placeholder ("-1", "-2") on many dialers, and digits from a
     * placeholder would make every withheld caller look like the same person. Meaningless for the
     * outgoing case (we dialled it), but harmless to apply the same way.
     *
     * The limit is applied while walking the cursor rather than as `LIMIT` in the sort order,
     * which some providers reject on newer Android.
     */
    fun missedSince(context: Context, afterMillis: Long, limit: Int): List<MissedCallEntry> = try {
        context.contentResolver.query(
            CallLog.Calls.CONTENT_URI,
            arrayOf(
                CallLog.Calls.DATE,
                CallLog.Calls.NUMBER,
                CallLog.Calls.CACHED_NAME,
                CallLog.Calls.TYPE,
                CallLog.Calls.NUMBER_PRESENTATION,
            ),
            "(${CallLog.Calls.TYPE} IN (?, ?, ?) OR " +
                "(${CallLog.Calls.TYPE} = ? AND ${CallLog.Calls.DURATION} = 0)) " +
                "AND ${CallLog.Calls.DATE} > ?",
            arrayOf(
                CallLog.Calls.MISSED_TYPE.toString(),
                CallLog.Calls.REJECTED_TYPE.toString(),
                CallLog.Calls.VOICEMAIL_TYPE.toString(),
                CallLog.Calls.OUTGOING_TYPE.toString(),
                afterMillis.toString(),
            ),
            "${CallLog.Calls.DATE} ASC",
        )?.use { c ->
            val out = ArrayList<MissedCallEntry>()
            while (out.size < limit && c.moveToNext()) {
                val (direction, reason) = when (c.getInt(3)) {
                    CallLog.Calls.MISSED_TYPE -> "incoming" to "unanswered"
                    CallLog.Calls.REJECTED_TYPE -> "incoming" to "declined"
                    CallLog.Calls.VOICEMAIL_TYPE -> "incoming" to "voicemail"
                    CallLog.Calls.OUTGOING_TYPE -> "outgoing" to "no_answer"
                    else -> continue
                }
                val presented = c.getInt(4) == CallLog.Calls.PRESENTATION_ALLOWED
                out += MissedCallEntry(
                    date = c.getLong(0),
                    number = c.getString(1)?.takeIf { presented && it.any(Char::isDigit) },
                    name = c.getString(2)?.takeIf { it.isNotBlank() },
                    direction = direction,
                    reason = reason,
                )
            }
            out
        } ?: emptyList()
    } catch (t: Throwable) {
        // Most often READ_CALL_LOG revoked. Nothing is lost: the caller's cursor does not move,
        // so these entries are read again once the permission is back.
        Log.d("CallLogReader", "missed-call read failed: ${t.message}")
        emptyList()
    }

    /** Recording start and call-log start can drift by a few seconds; allow a couple of minutes. */
    private const val DEFAULT_TOLERANCE_MS = 120_000L
}
