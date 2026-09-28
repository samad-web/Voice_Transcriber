package com.voicetranscriber.callrecorder.attendance

import com.voicetranscriber.callrecorder.attendance.PresenceEngine.Effect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.time.OffsetDateTime

class PresenceEngineTest {

    private fun t(hhmm: String, date: String = "2026-10-01"): Long =
        OffsetDateTime.parse("${date}T$hhmm:00+05:30").toInstant().toEpochMilli()

    private val min = 60_000L
    private lateinit var engine: PresenceEngine
    private lateinit var window: ShiftWindow
    private val settings = EngineSettings(
        silenceMs = 10 * 60_000L,
        promptTimeoutMs = 3 * 60_000L,
        graceMs = 10 * 60_000L,
        heartbeatMs = 120_000L,
        zoneId = "Asia/Kolkata",
    )

    @Before
    fun setUp() {
        window = ShiftWindow(
            date = "2026-10-01",
            startMs = t("09:30"),
            endMs = t("18:30"),
            breaks = listOf(ScheduleBreak("Lunch", t("13:00"), t("13:45"), "slot")),
            label = null,
        )
        engine = PresenceEngine(settings)
        engine.setWindow(window, t("09:15"))
    }

    private fun List<Effect>.emits(kind: String) = filterIsInstance<Effect.Emit>().filter { it.kind == kind }
    private fun List<Effect>.states() = emits(EventKind.STATE).map { it.payload["state"] }
    private fun List<Effect>.reminders() = filterIsInstance<Effect.Remind>()

    /** Ticks every 30 s from [from] to [to] inclusive, collecting effects. */
    private fun run(from: Long, to: Long): List<Effect> {
        val out = mutableListOf<Effect>()
        var now = from
        while (now <= to) {
            out += engine.tick(now)
            now += 30_000
        }
        return out
    }

    @Test
    fun `shift does not start by itself and nags when late`() {
        val fx = run(t("09:20"), t("09:45"))
        assertEquals(HandsetState.OFF_SHIFT, engine.state)
        assertFalse(engine.started)
        val texts = fx.reminders().map { it.text }
        assertTrue(texts.contains("Shift starts at 9:30 am"))
        assertTrue(texts.contains("You're marked late. Tap Start shift."))
        assertEquals(1, texts.count { it == "You're marked late. Tap Start shift." })
        // No heartbeats before the shift window.
        assertTrue(run(t("09:21"), t("09:29")).emits(EventKind.HEARTBEAT).isEmpty())
    }

    @Test
    fun `start shift emits shift_start and ACTIVE`() {
        val fx = engine.startShift(t("09:28"))
        assertEquals(listOf(true), fx.emits(EventKind.SHIFT_START).map { it.payload["manual"] })
        assertEquals(listOf("ACTIVE"), fx.states())
        assertTrue(fx.contains(Effect.Upload)) // first heartbeat goes out at once
    }

    @Test
    fun `first call starts the shift automatically`() {
        val fx = engine.onCallStart(t("09:31"), voip = false, direction = "outgoing")
        assertEquals(listOf(false), fx.emits(EventKind.SHIFT_START).map { it.payload["manual"] })
        assertEquals(listOf("ACTIVE", "IN_CALL"), fx.states())
    }

    @Test
    fun `calls before the arm time are not tracked`() {
        val fx = engine.onCallStart(t("08:00"), voip = false, direction = "outgoing")
        assertTrue(fx.isEmpty())
        assertFalse(engine.started)
    }

    @Test
    fun `silence prompts after T, expires to AWAY after P, and any call returns to ACTIVE`() {
        engine.startShift(t("09:30"))
        val quiet = run(t("09:30"), t("09:39") + 30_000)
        assertTrue(quiet.emits(EventKind.PROMPT_SHOWN).isEmpty())

        val prompt = run(t("09:40"), t("09:40"))
        assertEquals(1, prompt.emits(EventKind.PROMPT_SHOWN).size)
        assertTrue(prompt.contains(Effect.ShowPrompt))
        assertEquals(HandsetState.PROMPTING, engine.state)

        val expire = run(t("09:40") + 30_000, t("09:43"))
        assertEquals(1, expire.emits(EventKind.PROMPT_EXPIRED).size)
        assertEquals(listOf("AWAY"), expire.states())
        assertTrue(expire.contains(Effect.ShowAway))

        // No re-prompting while away.
        assertTrue(run(t("09:44"), t("10:30")).emits(EventKind.PROMPT_SHOWN).isEmpty())

        val call = engine.onCallStart(t("10:31"), voip = false, direction = "incoming")
        assertTrue(call.contains(Effect.ClearAway))
        assertEquals(listOf("IN_CALL"), call.states())
        val end = engine.onCallEnd(t("10:35"), voip = false)
        assertEquals(listOf("ACTIVE"), end.states())
        assertEquals(240L, end.emits(EventKind.CALL_END).single().payload["durationS"])
    }

    @Test
    fun `silence timer is paused during a call and restarts from its end`() {
        engine.startShift(t("09:30"))
        engine.onCallStart(t("09:35"), voip = false, direction = "outgoing")
        // A 20-minute call: no prompt while it lasts.
        assertTrue(run(t("09:35"), t("09:55")).emits(EventKind.PROMPT_SHOWN).isEmpty())
        engine.onCallEnd(t("09:55"), voip = false)
        assertTrue(run(t("09:55"), t("10:04") + 30_000).emits(EventKind.PROMPT_SHOWN).isEmpty())
        assertEquals(1, run(t("10:05"), t("10:05")).emits(EventKind.PROMPT_SHOWN).size)
    }

    @Test
    fun `a VoIP call resets the timer like a cellular one`() {
        engine.startShift(t("09:30"))
        engine.onCallStart(t("09:38"), voip = true, direction = "unknown")
        val end = engine.onCallEnd(t("09:39"), voip = true)
        assertEquals(true, end.emits(EventKind.CALL_END).single().payload["voip"])
        assertTrue(run(t("09:39"), t("09:48") + 30_000).emits(EventKind.PROMPT_SHOWN).isEmpty())
    }

    @Test
    fun `audio busy counts as activity`() {
        engine.startShift(t("09:30"))
        engine.setAudioBusy(true)
        assertTrue(run(t("09:30"), t("10:00")).emits(EventKind.PROMPT_SHOWN).isEmpty())
        engine.setAudioBusy(false)
        assertEquals(1, run(t("10:00"), t("10:10")).emits(EventKind.PROMPT_SHOWN).size)
    }

    @Test
    fun `screen unlock is not an engine input - only calls and answers reset silence`() {
        engine.startShift(t("09:30"))
        run(t("09:30"), t("09:40"))
        val fx = engine.answerPrompt(t("09:41"), PromptAnswer.HERE)
        assertEquals(listOf("here"), fx.emits(EventKind.PROMPT_ANSWERED).map { it.payload["answer"] })
        assertEquals(listOf("ACTIVE"), fx.states())
        assertTrue(fx.contains(Effect.ClosePrompt))
        // Timer restarted from the answer.
        assertTrue(run(t("09:41"), t("09:50") + 30_000).emits(EventKind.PROMPT_SHOWN).isEmpty())
        assertEquals(1, run(t("09:51"), t("09:51")).emits(EventKind.PROMPT_SHOWN).size)
    }

    @Test
    fun `technical answer holds until a successful call`() {
        engine.startShift(t("09:30"))
        run(t("09:30"), t("09:40"))
        val fx = engine.answerPrompt(t("09:41"), PromptAnswer.TECHNICAL, TechnicalReason.NO_SIGNAL)
        val answered = fx.emits(EventKind.PROMPT_ANSWERED).single()
        assertEquals("technical", answered.payload["answer"])
        assertEquals("no_signal", answered.payload["reason"])
        assertEquals(HandsetState.TECHNICAL, engine.state)
        // No prompting while technical.
        assertTrue(run(t("09:41"), t("10:30")).emits(EventKind.PROMPT_SHOWN).isEmpty())
        // A failed 2-second call keeps it technical...
        engine.onCallStart(t("10:31"), voip = false, direction = "outgoing")
        engine.onCallEnd(t("10:31") + 2_000, voip = false)
        assertEquals(HandsetState.TECHNICAL, engine.state)
        // ...a real call clears it.
        engine.onCallStart(t("10:33"), voip = false, direction = "outgoing")
        engine.onCallEnd(t("10:36"), voip = false)
        assertEquals(HandsetState.ACTIVE, engine.state)
    }

    @Test
    fun `break reminders then BREAK_DUE then auto start after 2 minutes`() {
        engine.startShift(t("09:30"))
        // Keep the silence timer from firing: a call every 5 minutes, the last ending 12:51.
        var now = t("09:30")
        while (now < t("12:54")) {
            engine.onCallStart(now, false, "outgoing"); engine.onCallEnd(now + 60_000, false); now += 5 * min
        }
        val pre = run(t("12:55"), t("12:59") + 30_000)
        val texts = pre.reminders().map { it.text }
        assertTrue(texts.contains("Lunch at 1:00 pm. Wrap up your current lead."))
        assertTrue(texts.contains("Last call before your break"))

        val due = run(t("13:00"), t("13:00"))
        assertEquals(listOf("BREAK_DUE"), due.states())
        assertEquals(PresenceEngine.ReminderAction.START_BREAK, due.reminders().single().action)

        val auto = run(t("13:00") + 30_000, t("13:02"))
        val started = auto.emits(EventKind.BREAK_STARTED).single()
        assertEquals(true, started.payload["scheduled"])
        assertEquals(0L, started.payload["deferredByCallSec"])
        assertEquals(HandsetState.ON_BREAK, engine.state)
        assertEquals(t("13:02") + 45 * min, engine.currentBreak!!.endsAt)

        val end = run(t("13:02") + 30_000, t("13:53"))
        val endTexts = end.reminders().map { it.text }
        assertTrue(endTexts.contains("Break ends at 1:47 pm"))
        assertTrue(endTexts.contains("Back to dialling?"))
        assertTrue(endTexts.contains("Your break has run 5 min over"))
        // No prompting on a break.
        assertTrue(end.emits(EventKind.PROMPT_SHOWN).isEmpty())

        val back = engine.back(t("13:54"))
        assertEquals(1, back.emits(EventKind.BREAK_ENDED).size)
        assertEquals(listOf("ACTIVE"), back.states())
    }

    @Test
    fun `a break due during a call is deferred and keeps its full length`() {
        engine.startShift(t("09:30"))
        engine.onCallStart(t("12:50"), false, "outgoing")
        val during = run(t("12:55"), t("13:10"))
        // Break-5 shown quietly, break-2 held, no BREAK_DUE while the call lasts.
        val b5 = during.reminders().single { it.text.startsWith("Lunch at") }
        assertTrue(b5.quiet)
        assertTrue(during.reminders().none { it.text == "Last call before your break" })
        assertTrue(during.states().isEmpty())
        assertEquals(HandsetState.IN_CALL, engine.state)

        val end = engine.onCallEnd(t("13:10"), false)
        val started = end.emits(EventKind.BREAK_STARTED).single()
        assertEquals(true, started.payload["scheduled"])
        assertEquals(600L, started.payload["deferredByCallSec"])
        assertEquals(listOf("ON_BREAK"), end.states())
        assertEquals(t("13:10") + 45 * min, engine.currentBreak!!.endsAt)
        // The held "last call" reminder is stale once the break time passed: dropped.
        assertTrue(end.reminders().none { it.text == "Last call before your break" })
    }

    @Test
    fun `last-call reminder held during a call is shown when it ends before the break`() {
        engine.startShift(t("09:30"))
        engine.onCallStart(t("12:57"), false, "outgoing")
        val during = run(t("12:58"), t("12:59"))
        assertTrue(during.reminders().none { it.text == "Last call before your break" })
        val end = engine.onCallEnd(t("12:59"), false)
        assertEquals(1, end.reminders().count { it.text == "Last call before your break" && !it.quiet })
    }

    @Test
    fun `a call during a break ends the break`() {
        engine.startShift(t("09:30"))
        engine.startBreakTapped(t("11:00"))
        assertEquals(HandsetState.ON_BREAK, engine.state)
        assertFalse(engine.currentBreak!!.scheduled)
        val fx = engine.onCallStart(t("11:10"), false, "incoming")
        assertEquals(1, fx.emits(EventKind.BREAK_ENDED).size)
        assertEquals(listOf("IN_CALL"), fx.states())
        engine.onCallEnd(t("11:12"), false)
        assertEquals(HandsetState.ACTIVE, engine.state)
    }

    @Test
    fun `taking a break from the prompt is an unscheduled break`() {
        engine.startShift(t("09:30"))
        run(t("09:30"), t("09:40"))
        val fx = engine.answerPrompt(t("09:41"), PromptAnswer.BREAK)
        assertEquals(false, fx.emits(EventKind.BREAK_STARTED).single().payload["scheduled"])
        assertNull(engine.currentBreak!!.endsAt)
    }

    @Test
    fun `shift end during a call waits for the call then stops`() {
        engine.startShift(t("09:30"))
        engine.onCallStart(t("18:25"), false, "outgoing")
        val atEnd = run(t("18:30"), t("18:35"))
        assertTrue(atEnd.reminders().any { it.text == "Shift over." && it.quiet })
        assertFalse(atEnd.contains(Effect.StopService))
        assertTrue(engine.running)
        val end = engine.onCallEnd(t("18:40"), false)
        assertEquals(listOf("OFF_SHIFT"), end.states())
        assertEquals(1, end.emits(EventKind.SHIFT_END).size)
        assertEquals(1, end.emits(EventKind.SERVICE_STOP).size)
        assertTrue(end.contains(Effect.StopService))
        assertFalse(engine.running)
        // Order: the call_end (overtime) is logged before OFF_SHIFT.
        val kinds = end.filterIsInstance<Effect.Emit>().map { it.kind }
        assertTrue(kinds.indexOf(EventKind.CALL_END) < kinds.indexOf(EventKind.STATE))
    }

    @Test
    fun `explicit end shift and a later config refresh do not reopen it`() {
        engine.startShift(t("09:30"))
        val fx = engine.endShift(t("17:00"))
        assertEquals(listOf("OFF_SHIFT"), fx.states())
        assertEquals(listOf(true), fx.emits(EventKind.SHIFT_END).map { it.payload["manual"] })
        val again = engine.setWindow(window, t("17:05"))
        assertTrue(again.reminders().isEmpty())
        assertFalse(engine.running)
        // But Start shift reopens it.
        val restart = engine.startShift(t("17:10"))
        assertEquals(1, restart.emits(EventKind.SHIFT_START).size)
        assertTrue(engine.running)
    }

    @Test
    fun `a shift nobody started just stops at its end`() {
        val fx = run(t("09:20"), t("18:31"))
        assertTrue(fx.contains(Effect.StopService))
        assertTrue(fx.emits(EventKind.SHIFT_END).isEmpty())
    }

    @Test
    fun `heartbeats every interval while on shift`() {
        engine.startShift(t("09:30"))
        engine.onCallStart(t("09:30"), false, "outgoing") // keep prompts out of the way
        val fx = run(t("09:30") + 30_000, t("09:40"))
        assertEquals(5, fx.emits(EventKind.HEARTBEAT).size) // 9:32, 9:34, 9:36, 9:38, 9:40
    }

    @Test
    fun `presence check forces a heartbeat and prompts when silent`() {
        engine.startShift(t("09:30"))
        run(t("09:30"), t("09:31"))
        val fx = engine.presenceCheck(t("09:31") + 10_000)
        assertEquals(1, fx.emits(EventKind.HEARTBEAT).size)
        assertTrue(fx.emits(EventKind.PROMPT_SHOWN).isEmpty())
        val late = engine.presenceCheck(t("09:45"))
        assertEquals(1, late.emits(EventKind.PROMPT_SHOWN).size)
    }

    @Test
    fun `leave arriving mid-shift ends it`() {
        engine.startShift(t("09:30"))
        val fx = engine.setWindow(null, t("11:00"))
        assertEquals(1, fx.emits(EventKind.SHIFT_END).size)
        assertTrue(fx.contains(Effect.StopService))
    }

    @Test
    fun `next deadline points at the silence threshold`() {
        engine.startShift(t("09:30"))
        engine.tick(t("09:30"))
        assertEquals(t("09:32"), engine.nextDeadline(t("09:30"))) // heartbeat first
        engine.tick(t("09:39"))
        assertEquals(t("09:40"), engine.nextDeadline(t("09:39") + 1))
    }

    @Test
    fun `snapshot round trip keeps timers and drops calls across a reboot`() {
        engine.startShift(t("09:30"))
        engine.onCallStart(t("10:00"), false, "outgoing")
        val json = AttendanceJson.snapshotToJson(engine.snapshot())
        val restored = PresenceEngine(settings)
        val snap = AttendanceJson.snapshotFromJson(json)
        assertNotNull(snap)
        restored.restore(snap!!, sameBoot = true, now = t("10:01"))
        assertEquals(HandsetState.IN_CALL, restored.state)
        assertTrue(restored.inCall)

        val rebooted = PresenceEngine(settings)
        val fx = rebooted.restore(snap, sameBoot = false, now = t("10:05"))
        assertFalse(rebooted.inCall)
        assertEquals(HandsetState.ACTIVE, rebooted.state)
        assertEquals(listOf("ACTIVE"), fx.states())
    }
}
