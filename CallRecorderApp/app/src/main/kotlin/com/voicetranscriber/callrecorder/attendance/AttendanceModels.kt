package com.voicetranscriber.callrecorder.attendance

/**
 * The handset's half of the attendance contract (Build docs/33, server types in
 * platform/packages/shared/src/attendance.ts). Plain Kotlin on purpose: nothing
 * in this file touches Android, so the state machine that uses it runs in a JVM
 * unit test with a fake clock.
 *
 * Every instant here is epoch milliseconds on the TRUSTED timeline (see
 * [TrustedTime]), never a raw System.currentTimeMillis() reading.
 */

/** Mirrors `HandsetState` in attendance.ts. The enum NAME is the wire value. */
enum class HandsetState(val label: String) {
    OFF_SHIFT("Off shift"),
    ACTIVE("Active"),
    IN_CALL("In call"),
    PROMPTING("Prompted"),
    AWAY("Away"),
    TECHNICAL("Technical problem"),
    BREAK_DUE("Break due"),
    ON_BREAK("On break"),
    ;

    companion object {
        fun fromWire(value: String?): HandsetState? = entries.firstOrNull { it.name == value }
    }
}

/** `PresenceEventKind` in attendance.ts. */
object EventKind {
    const val HEARTBEAT = "heartbeat"
    const val STATE = "state"
    const val SHIFT_START = "shift_start"
    const val SHIFT_END = "shift_end"
    const val CALL_START = "call_start"
    const val CALL_END = "call_end"
    const val PROMPT_SHOWN = "prompt_shown"
    const val PROMPT_ANSWERED = "prompt_answered"
    const val PROMPT_EXPIRED = "prompt_expired"
    const val BREAK_STARTED = "break_started"
    const val BREAK_ENDED = "break_ended"
    const val NETWORK_LOST = "network_lost"
    const val NETWORK_RESTORED = "network_restored"
    const val BOOT = "boot"
    const val APP_START = "app_start"
    const val SERVICE_START = "service_start"
    const val SERVICE_STOP = "service_stop"
    const val SCREEN_UNLOCK = "screen_unlock"
    const val NOTICE_ACKNOWLEDGED = "notice_acknowledged"
}

enum class PromptAnswer(val wire: String) {
    HERE("here"),
    TECHNICAL("technical"),
    BREAK("break"),
    ;

    companion object {
        fun fromWire(value: String?): PromptAnswer? = entries.firstOrNull { it.wire == value }
    }
}

enum class TechnicalReason(val wire: String, val label: String) {
    NO_SIGNAL("no_signal", "No signal"),
    CALLS_FAILING("calls_failing", "Calls failing"),
    HEADSET_OR_MIC("headset_or_mic", "Headset or mic"),
    PHONE_SLOW("phone_slow", "Phone slow"),
    OTHER("other", "Other"),
    ;

    companion object {
        fun fromWire(value: String?): TechnicalReason? = entries.firstOrNull { it.wire == value }
    }
}

enum class LeaveType(val wire: String, val label: String) {
    CASUAL("casual", "Casual"),
    SICK("sick", "Sick"),
    EARNED("earned", "Earned"),
    UNPAID("unpaid", "Unpaid"),
    OTHER("other", "Other"),
    ;

    companion object {
        fun fromWire(value: String?): LeaveType? = entries.firstOrNull { it.wire == value }
    }
}

/** A break on the synced schedule (`DeviceScheduleBreak`). */
data class ScheduleBreak(
    val label: String,
    val startsAtMs: Long,
    val endsAtMs: Long,
    /** "slot" (fixed, from the shift pattern) or "booked" (approved request). */
    val source: String,
) {
    val lengthMs: Long get() = (endsAtMs - startsAtMs).coerceAtLeast(0)
}

/** One day of the synced schedule (`DeviceScheduleDay`). */
data class ScheduleDay(
    /** YYYY-MM-DD in the workspace zone. */
    val date: String,
    /** "work" | "off" | "holiday" | "leave". */
    val kind: String,
    val shiftStartMs: Long?,
    val shiftEndMs: Long?,
    /** "am" | "pm" for a half day of leave, else null. */
    val halfDay: String?,
    val label: String?,
    val breaks: List<ScheduleBreak>,
)

/**
 * The part of a day the phone actually tracks: the shift window, cut in half
 * when half the day is leave, with only the breaks that fall inside it.
 */
data class ShiftWindow(
    val date: String,
    val startMs: Long,
    val endMs: Long,
    val breaks: List<ScheduleBreak>,
    val label: String?,
)

/** The `attendance` block of GET /devices/me/config (`DeviceAttendanceConfig`). */
data class AttendanceConfig(
    val canApplyLeave: Boolean,
    val canBookBreaks: Boolean,
    /** Who a request goes to; null = the owners. */
    val approverName: String?,
    val heartbeatSeconds: Int,
    val silenceThresholdMinutes: Int,
    val promptTimeoutMinutes: Int,
    val graceMinutes: Int,
    val breakAllowanceMinutes: Int,
    val scheduleVersion: Int,
    val timeZone: String,
    val days: List<ScheduleDay>,
    val noticeVersion: Int,
    val noticeText: String,
)

/** Timings the engine runs on, in milliseconds, clamped to sane ranges. */
data class EngineSettings(
    val silenceMs: Long,
    val promptTimeoutMs: Long,
    val graceMs: Long,
    val heartbeatMs: Long,
    val zoneId: String,
    /** A due break starts by itself after this long (doc 33 §3.2: 2 min). */
    val breakAutoStartMs: Long = 2 * MINUTE,
) {
    companion object {
        const val MINUTE = 60_000L

        fun from(config: AttendanceConfig) = EngineSettings(
            silenceMs = config.silenceThresholdMinutes.coerceIn(1, 240) * MINUTE,
            promptTimeoutMs = config.promptTimeoutMinutes.coerceIn(1, 60) * MINUTE,
            graceMs = config.graceMinutes.coerceIn(0, 480) * MINUTE,
            heartbeatMs = config.heartbeatSeconds.coerceIn(30, 1800) * 1000L,
            zoneId = config.timeZone,
        )
    }
}
