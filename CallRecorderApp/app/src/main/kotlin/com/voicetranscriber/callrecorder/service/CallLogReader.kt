package com.voicetranscriber.callrecorder.service

import android.content.Context
import android.provider.CallLog
import android.util.Log

/** The number/name/direction of a finished call, read from the system call log. */
data class CallInfo(val number: String?, val name: String?, val direction: String?)

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
            "${CallLog.Calls.DATE} BETWEEN ? AND ?",
            arrayOf((atMillis - toleranceMs).toString(), (atMillis + toleranceMs).toString()),
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

    /** Recording start and call-log start can drift by a few seconds; allow a couple of minutes. */
    private const val DEFAULT_TOLERANCE_MS = 120_000L
}
