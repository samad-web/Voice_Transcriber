package com.voicetranscriber.callrecorder.attendance

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.OffsetDateTime

class ScheduleAndClockTest {

    private fun t(value: String): Long = OffsetDateTime.parse(value).toInstant().toEpochMilli()

    private val configJson = """
        {
          "recordingEnabled": true, "version": 3,
          "attendance": {
            "enabled": true, "canApplyLeave": true, "canBookBreaks": false,
            "heartbeatSeconds": 120, "silenceThresholdMinutes": 10, "promptTimeoutMinutes": 3,
            "graceMinutes": 10, "breakAllowanceMinutes": 60, "scheduleVersion": 7,
            "timeZone": "Asia/Kolkata", "noticeVersion": 1, "noticeText": "Notice",
            "days": [
              { "date": "2026-10-01", "kind": "work",
                "shiftStart": "2026-10-01T04:00:00.000Z", "shiftEnd": "2026-10-01T13:00:00.000Z",
                "breaks": [ { "label": "Lunch", "startsAt": "2026-10-01T07:30:00.000Z",
                              "endsAt": "2026-10-01T08:15:00.000Z", "source": "slot" } ] },
              { "date": "2026-10-02", "kind": "holiday", "label": "Gandhi Jayanti", "breaks": [] },
              { "date": "2026-10-03", "kind": "work", "halfDay": "am",
                "shiftStart": "2026-10-03T04:00:00.000Z", "shiftEnd": "2026-10-03T13:00:00.000Z",
                "breaks": [ { "label": "Tea", "startsAt": "2026-10-03T05:00:00.000Z",
                              "endsAt": "2026-10-03T05:15:00.000Z", "source": "slot" } ] }
            ]
          }
        }
    """.trimIndent()

    @Test
    fun `parses the attendance block`() {
        val c = AttendanceJson.parseConfig(JSONObject(configJson))!!
        assertTrue(c.canApplyLeave)
        assertFalse(c.canBookBreaks)
        assertNull(c.approverName) // absent key → null, never "null"
        assertEquals(7, c.scheduleVersion)
        assertEquals(3, c.days.size)
        assertEquals(t("2026-10-01T09:30:00+05:30"), c.days[0].shiftStartMs)
        assertEquals("Lunch", c.days[0].breaks.single().label)
        assertNull(c.days[1].shiftStartMs)
    }

    @Test
    fun `absent, null or disabled block means attendance is off`() {
        assertNull(AttendanceJson.parseConfig(JSONObject("""{"recordingEnabled":true}""")))
        assertNull(AttendanceJson.parseConfig(JSONObject("""{"attendance":null}""")))
        assertNull(AttendanceJson.parseConfig(JSONObject("""{"attendance":{"enabled":false}}""")))
    }

    @Test
    fun `a JSON null approver name is not the string null`() {
        val c = AttendanceJson.parseBlock(JSONObject("""{"enabled":true,"approverName":null,"days":[]}"""))!!
        assertNull(c.approverName)
    }

    @Test
    fun `windows skip off days and halve half days`() {
        val c = AttendanceJson.parseConfig(JSONObject(configJson))!!
        val ws = ShiftSchedule.windows(c.days)
        assertEquals(2, ws.size)
        val half = ws[1]
        // Morning leave: work starts at the midpoint (14:00 IST), and the 10:30 tea break is dropped.
        assertEquals(t("2026-10-03T14:00:00+05:30"), half.startMs)
        assertEquals(t("2026-10-03T18:30:00+05:30"), half.endMs)
        assertTrue(half.breaks.isEmpty())
    }

    @Test
    fun `active and next window`() {
        val c = AttendanceJson.parseConfig(JSONObject(configJson))!!
        assertNull(ShiftSchedule.activeWindow(c.days, t("2026-10-01T09:00:00+05:30")))
        assertEquals("2026-10-01", ShiftSchedule.activeWindow(c.days, t("2026-10-01T09:21:00+05:30"))!!.date)
        assertNull(ShiftSchedule.activeWindow(c.days, t("2026-10-01T18:30:00+05:30")))
        val next = ShiftSchedule.nextWindow(c.days, t("2026-10-01T19:00:00+05:30"))!!
        assertEquals("2026-10-03", next.date)
        assertEquals(t("2026-10-03T13:50:00+05:30"), ShiftSchedule.armTime(next))
    }

    @Test
    fun `overnight shift stays active past midnight`() {
        val day = ScheduleDay(
            "2026-10-01", "work", t("2026-10-01T22:00:00+05:30"), t("2026-10-02T06:00:00+05:30"),
            null, null, emptyList(),
        )
        assertEquals("2026-10-01", ShiftSchedule.activeWindow(listOf(day), t("2026-10-02T02:00:00+05:30"))!!.date)
    }

    @Test
    fun `clock words`() {
        assertEquals("1:00 pm", ShiftSchedule.clock(t("2026-10-01T13:00:00+05:30"), "Asia/Kolkata"))
        assertEquals("9:30 am", ShiftSchedule.clock(t("2026-10-01T09:30:00+05:30"), "Asia/Kolkata"))
        assertEquals("3 Oct", ShiftSchedule.shortDate("2026-10-03"))
    }

    private class FakeClock(var wall: Long, var elapsed: Long, var boot: String = "1") : DeviceClock {
        override fun wallMs() = wall
        override fun elapsedMs() = elapsed
        override fun bootId() = boot
    }

    @Test
    fun `trusted time ignores wall clock changes`() {
        val clock = FakeClock(wall = 1_000_000, elapsed = 50_000)
        val time = TrustedTime(clock)
        clock.elapsed += 60_000
        clock.wall += 60_000 + 3_600_000 // the user moved the clock an hour forward
        assertEquals(1_060_000, time.now())
    }

    @Test
    fun `trusted time re-anchors on a new boot`() {
        val clock = FakeClock(wall = 1_000_000, elapsed = 50_000)
        val time = TrustedTime(clock)
        clock.boot = "2"; clock.elapsed = 5_000; clock.wall = 2_000_000
        assertEquals(2_000_000, time.now())
    }

    @Test
    fun `server skew corrects a clock that was wrong from the start`() {
        val clock = FakeClock(wall = 10_000_000, elapsed = 50_000) // 10 minutes fast
        val time = TrustedTime(clock)
        assertTrue(time.correctFromServer(10_000_000, 50_000, "1", clockSkewSeconds = 600))
        assertEquals(9_400_000, time.now())
        clock.elapsed += 1_000
        assertEquals(9_401_000, time.now())
        // A later batch that agrees does not move it.
        assertFalse(time.correctFromServer(10_001_000, 51_000, "1", clockSkewSeconds = 600))
    }

    @Test
    fun `saved anchor from the same boot is kept`() {
        val clock = FakeClock(wall = 5_000_000, elapsed = 90_000)
        val time = TrustedTime(clock, TrustedTime.Anchor(wallMs = 1_000_000, elapsedMs = 50_000, bootId = "1"))
        assertEquals(1_040_000, time.now())
    }
}
