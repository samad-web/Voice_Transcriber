package com.voicetranscriber.callrecorder.attendance

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Pure schedule arithmetic over the synced days. No Android, no clock of its
 * own: every function takes "now" as an argument.
 */
object ShiftSchedule {

    /** The service is armed this long before a shift starts (doc 33 §6.2, first reminder). */
    const val ARM_LEAD_MS = 10 * 60_000L

    /**
     * The window the phone tracks on [day], or null when there is no shift
     * (off, holiday, full leave, or a malformed day). A half day of leave cuts
     * the window at its midpoint, the same split as `halfDayLeaveWindow` on the
     * server: morning leave keeps the second half, afternoon leave the first.
     */
    fun windowOf(day: ScheduleDay): ShiftWindow? {
        if (day.kind != "work") return null
        val start = day.shiftStartMs ?: return null
        val end = day.shiftEndMs ?: return null
        if (end <= start) return null
        val mid = start + (end - start) / 2
        val (s, e) = when (day.halfDay) {
            "am" -> mid to end
            "pm" -> start to mid
            else -> start to end
        }
        val breaks = day.breaks
            .filter { it.endsAtMs > it.startsAtMs && it.startsAtMs >= s && it.startsAtMs < e }
            .sortedBy { it.startsAtMs }
        return ShiftWindow(day.date, s, e, breaks, day.label)
    }

    /** Every trackable window in [days], earliest first. */
    fun windows(days: List<ScheduleDay>): List<ShiftWindow> =
        days.mapNotNull(::windowOf).sortedBy { it.startMs }

    /**
     * The window the service should be running for right now: one that has
     * reached its arm time (start - [ARM_LEAD_MS]) and not yet ended. When two
     * overlap (an overnight shift running into the next day's early start),
     * the one that started first wins; the next is picked up when it ends.
     */
    fun activeWindow(days: List<ScheduleDay>, now: Long): ShiftWindow? =
        windows(days).firstOrNull { now >= it.startMs - ARM_LEAD_MS && now < it.endMs }

    /** The next window whose arm time is still ahead of [now]. */
    fun nextWindow(days: List<ScheduleDay>, now: Long): ShiftWindow? =
        windows(days).firstOrNull { it.startMs - ARM_LEAD_MS > now }

    /** When to wake the phone for [window]: 10 minutes before it starts. */
    fun armTime(window: ShiftWindow): Long = window.startMs - ARM_LEAD_MS

    /** The schedule day for a calendar date, if the config carries it. */
    fun dayFor(days: List<ScheduleDay>, date: String): ScheduleDay? = days.firstOrNull { it.date == date }

    // ── Words ────────────────────────────────────────────────────────────────

    fun zone(zoneId: String): ZoneId = runCatching { ZoneId.of(zoneId) }.getOrDefault(ZoneId.systemDefault())

    private val CLOCK = DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH)
    private val SHORT_DATE = DateTimeFormatter.ofPattern("d MMM", Locale.ENGLISH)

    /** "1:00 pm" in the workspace zone - the same shape the console uses. */
    fun clock(ms: Long, zoneId: String): String =
        CLOCK.format(Instant.ofEpochMilli(ms).atZone(zone(zoneId)))
            .replace("AM", "am").replace("PM", "pm")

    /** "3 Oct" for a YYYY-MM-DD key. */
    fun shortDate(dateKey: String): String =
        runCatching { SHORT_DATE.format(LocalDate.parse(dateKey)) }.getOrDefault(dateKey)

    /** The calendar date an instant falls on in the workspace zone. */
    fun dateKey(ms: Long, zoneId: String): String =
        Instant.ofEpochMilli(ms).atZone(zone(zoneId)).toLocalDate().toString()

    /** "1 h 05 min" / "25 min" for a duration in seconds. */
    fun duration(seconds: Long): String {
        val minutes = (seconds.coerceAtLeast(0) + 30) / 60
        return if (minutes >= 60) "%d h %02d min".format(minutes / 60, minutes % 60) else "$minutes min"
    }

    /** Parses an ISO instant with an offset or Z; null when absent or malformed. */
    fun parseInstant(value: String?): Long? {
        if (value.isNullOrBlank()) return null
        return runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
            ?: runCatching { java.time.OffsetDateTime.parse(value).toInstant().toEpochMilli() }.getOrNull()
    }

    fun iso(ms: Long): String = Instant.ofEpochMilli(ms).toString()
}
