package com.voicetranscriber.callrecorder.attendance

/**
 * The presence state machine of doc 33 §3.2, the silence timer of §3.1/§3.3,
 * the break handling and the reminders of §6.2 - as plain Kotlin.
 *
 * It owns no clock, no thread and no Android object. Every entry point takes
 * `now` (an instant on the [TrustedTime] timeline) and returns the [Effect]s
 * the caller must carry out: events to queue, notifications to post, a prompt
 * to show, the service to stop. That is what lets the JVM tests drive a whole
 * simulated shift minute by minute.
 *
 * Rules worth knowing before changing anything:
 *  - A shift is not "started" by the clock. At shift start the phone stays
 *    OFF_SHIFT until the telecaller taps Start shift or makes a call (the first
 *    call starts it with `manual:false`). Auto-starting at the scheduled time
 *    would check in everyone on time, including people who are not there, and
 *    the "You're marked late" reminder could never fire.
 *  - The silence timer only runs in ACTIVE. Every call start and end, prompt
 *    answer, Start shift and Back resets it; while a call is in progress there
 *    is nothing to time. Screen unlocks never reset it (weak evidence only).
 *  - A break that falls due during a call is DEFERRED: it starts when the call
 *    ends and keeps its full length, and `break_started` says by how much.
 *  - Every state change emits a `state` event; the server's classifier builds
 *    the day from those, so a missing transition is a wrong timesheet.
 */
class PresenceEngine(settings: EngineSettings) {

    var settings: EngineSettings = settings
        private set

    // ── Effects ──────────────────────────────────────────────────────────────

    enum class ReminderAction { NONE, START_SHIFT, START_BREAK, BACK }

    sealed interface Effect {
        /** Queue a presence event that happened at trusted instant [at]. */
        data class Emit(val kind: String, val at: Long, val payload: Map<String, Any> = emptyMap()) : Effect

        /** Post a reminder. [quiet] = no sound, vibration or heads-up (a call is in progress). */
        data class Remind(
            val id: String,
            val text: String,
            val quiet: Boolean,
            val action: ReminderAction = ReminderAction.NONE,
        ) : Effect

        data object ShowPrompt : Effect
        data object ClosePrompt : Effect
        data object ShowAway : Effect
        data object ClearAway : Effect

        /** Upload the queue now (a heartbeat is due, or the shift just ended). */
        data object Upload : Effect

        /** The shift is over and nothing is in progress: stop the foreground service. */
        data object StopService : Effect
    }

    // ── State (everything here is persisted in [Snapshot]) ───────────────────

    data class DueBreak(val label: String, val dueAt: Long, val lengthMs: Long)

    data class ActiveBreak(
        val label: String,
        val scheduled: Boolean,
        val startedAt: Long,
        /** Null for an unscheduled break ("Taking a break"): it has no planned end. */
        val endsAt: Long?,
    )

    data class HeldReminder(
        val id: String,
        val text: String,
        val action: ReminderAction,
        /** Dropped instead of shown if the call ends after this instant. */
        val validUntil: Long,
    )

    var window: ShiftWindow? = null
        private set
    var state: HandsetState = HandsetState.OFF_SHIFT
        private set
    var stateSince: Long = 0
        private set
    var started: Boolean = false
        private set
    var ended: Boolean = false
        private set
    var lastActivityAt: Long = 0
        private set
    var promptShownAt: Long? = null
        private set
    var cellularCallAt: Long? = null
        private set
    var cellularDirection: String? = null
        private set
    var voipCallAt: Long? = null
        private set
    var stateBeforeCall: HandsetState? = null
        private set
    var breakDue: DueBreak? = null
        private set
    var deferredBreak: DueBreak? = null
        private set
    var currentBreak: ActiveBreak? = null
        private set
    var lastHeartbeatAt: Long? = null
        private set
    private var heartbeatRequested = false
    private val handledBreaks = mutableSetOf<Long>()
    private val firedReminders = mutableSetOf<String>()
    private val held = mutableListOf<HeldReminder>()

    /** Transient, not persisted: AudioManager says a call (maybe an undetected VoIP one) is up. */
    private var audioBusy = false

    val inCall: Boolean get() = cellularCallAt != null || voipCallAt != null

    /** True while the service has a reason to exist. */
    val running: Boolean get() = window != null && !ended

    // ── Configuration ────────────────────────────────────────────────────────

    fun updateSettings(next: EngineSettings) {
        settings = next
    }

    /**
     * Points the engine at the window that should be tracked now.
     *
     *  - Same date as the current one: the window is updated in place (an hours
     *    change or a newly booked break arrives mid-shift).
     *  - A different window: a fresh shift - nothing carries over.
     *  - null: the day is no longer a working day (approved leave arrived, or
     *    attendance was switched off). A started shift is ended.
     */
    fun setWindow(next: ShiftWindow?, now: Long): List<Effect> {
        val out = mutableListOf<Effect>()
        val current = window
        when {
            next == null -> if (current != null && !ended) finish(now, manual = false, out)
            current == null || current.date != next.date -> resetForWindow(next, now)
            // Same day: take the new hours and breaks. A shift already ended stays
            // ended - a config refresh must not reopen it (and fire "late").
            else -> window = next
        }
        out += tick(now)
        return out
    }

    private fun resetForWindow(next: ShiftWindow, now: Long) {
        window = next
        state = HandsetState.OFF_SHIFT
        stateSince = now
        started = false
        ended = false
        lastActivityAt = now
        promptShownAt = null
        cellularCallAt = null
        cellularDirection = null
        voipCallAt = null
        stateBeforeCall = null
        breakDue = null
        deferredBreak = null
        currentBreak = null
        lastHeartbeatAt = null
        heartbeatRequested = false
        handledBreaks.clear()
        firedReminders.clear()
        held.clear()
    }

    fun setAudioBusy(busy: Boolean) {
        audioBusy = busy
    }

    // ── User and phone events ────────────────────────────────────────────────

    /** "Start shift" tapped. Allowed from the arm time (start - 10 min) until the shift ends. */
    fun startShift(now: Long): List<Effect> {
        val out = mutableListOf<Effect>()
        if (!canStart(now)) return out
        if (ended) {
            // "End shift" was tapped earlier today and they are back: reopen the window.
            ended = false
            started = false
            state = HandsetState.OFF_SHIFT
            stateSince = now
        }
        if (started) return out
        beginShift(now, manual = true, out)
        out += tick(now)
        return out
    }

    /** Start shift is offered from the arm time (start - 10 min) until the shift ends. */
    fun canStart(now: Long): Boolean {
        val w = window ?: return false
        return (!started || ended) && now >= w.startMs - ShiftSchedule.ARM_LEAD_MS && now < w.endMs
    }

    private fun beginShift(now: Long, manual: Boolean, out: MutableList<Effect>) {
        started = true
        out += Effect.Emit(EventKind.SHIFT_START, now, mapOf("manual" to manual))
        lastActivityAt = now
        setState(HandsetState.ACTIVE, now, out)
    }

    /** "End shift" tapped. */
    fun endShift(now: Long): List<Effect> {
        val out = mutableListOf<Effect>()
        if (window == null || ended) return out
        if (inCall) return out // the button is hidden during a call; never cut one
        finish(now, manual = true, out)
        return out
    }

    fun onCallStart(now: Long, voip: Boolean, direction: String): List<Effect> {
        val out = mutableListOf<Effect>()
        val w = window ?: return out
        if (ended) return out
        if (voip) {
            if (voipCallAt != null) return out
        } else {
            if (cellularCallAt != null) return out
        }
        if (!started) {
            // Too early to count (before the arm time) or after the shift: not tracked.
            if (now < w.startMs - ShiftSchedule.ARM_LEAD_MS || now >= w.endMs) return out
            beginShift(now, manual = false, out)
        }
        val wasInCall = inCall
        if (voip) voipCallAt = now else {
            cellularCallAt = now
            cellularDirection = direction
        }
        out += Effect.Emit(EventKind.CALL_START, now, mapOf("direction" to direction, "voip" to voip))
        lastActivityAt = now
        if (!wasInCall) {
            stateBeforeCall = state
            when (state) {
                HandsetState.ON_BREAK -> endBreak(now, out) // the first call ends a break (§3.2)
                HandsetState.BREAK_DUE -> {
                    deferredBreak = breakDue
                    breakDue = null
                }
                HandsetState.PROMPTING -> {
                    promptShownAt = null
                    out += Effect.ClosePrompt
                }
                HandsetState.AWAY -> out += Effect.ClearAway
                else -> Unit
            }
            setState(HandsetState.IN_CALL, now, out)
        }
        return out
    }

    fun onCallEnd(now: Long, voip: Boolean): List<Effect> {
        val out = mutableListOf<Effect>()
        val startedAt = (if (voip) voipCallAt else cellularCallAt) ?: return out
        val direction = if (voip) "unknown" else (cellularDirection ?: "unknown")
        if (voip) voipCallAt = null else {
            cellularCallAt = null
            cellularDirection = null
        }
        val durationS = ((now - startedAt) / 1000).coerceAtLeast(0)
        out += Effect.Emit(
            EventKind.CALL_END, now,
            mapOf("durationS" to durationS, "direction" to direction, "voip" to voip),
        )
        lastActivityAt = now
        if (inCall) return out // the other call is still up

        val before = stateBeforeCall
        stateBeforeCall = null
        val w = window
        val deferred = deferredBreak
        when {
            w == null -> Unit
            now >= w.endMs -> {
                // The shift ended during this call; the call itself was overtime (§6.2).
                finish(now, manual = false, out)
                return out
            }
            deferred != null -> {
                val deferredBySec = ((now - deferred.dueAt) / 1000).coerceAtLeast(0)
                startBreak(now, deferred.label, scheduled = true, lengthMs = deferred.lengthMs, deferredBySec, out)
            }
            before == HandsetState.TECHNICAL && durationS < FAILED_CALL_SECONDS -> {
                // A call that failed at once is not "the next successful call": still a problem.
                setState(HandsetState.TECHNICAL, now, out)
            }
            else -> setState(HandsetState.ACTIVE, now, out)
        }
        // Reminders held back during the call (§6.2 "Last call before your break").
        val release = held.filter { it.validUntil > now }
        held.clear()
        for (r in release) out += Effect.Remind(r.id, r.text, quiet = false, action = r.action)
        out += tick(now)
        return out
    }

    /**
     * An answer to the presence prompt, from the full-screen activity or a
     * notification action. Also accepted while AWAY (a late tap on a stale
     * notification is still the person saying they are back). Returns no
     * effects when there is nothing to answer.
     */
    fun answerPrompt(now: Long, answer: PromptAnswer, reason: TechnicalReason? = null): List<Effect> {
        val out = mutableListOf<Effect>()
        if (state != HandsetState.PROMPTING && state != HandsetState.AWAY) return out
        val payload = buildMap<String, Any> {
            put("answer", answer.wire)
            if (answer == PromptAnswer.TECHNICAL && reason != null) put("reason", reason.wire)
        }
        out += Effect.Emit(EventKind.PROMPT_ANSWERED, now, payload)
        if (state == HandsetState.PROMPTING) out += Effect.ClosePrompt else out += Effect.ClearAway
        promptShownAt = null
        lastActivityAt = now
        when (answer) {
            PromptAnswer.HERE -> setState(HandsetState.ACTIVE, now, out)
            PromptAnswer.TECHNICAL -> setState(HandsetState.TECHNICAL, now, out)
            PromptAnswer.BREAK -> startBreak(now, "Break", scheduled = false, lengthMs = null, 0, out)
        }
        out += tick(now)
        return out
    }

    /** "Back to dialling" / "I'm back" / "Fixed". */
    fun back(now: Long): List<Effect> {
        val out = mutableListOf<Effect>()
        if (!started || ended) return out
        when (state) {
            HandsetState.ON_BREAK -> endBreak(now, out)
            HandsetState.AWAY -> out += Effect.ClearAway
            HandsetState.PROMPTING -> return answerPrompt(now, PromptAnswer.HERE)
            HandsetState.BREAK_DUE -> breakDue = null // skipped this break
            HandsetState.TECHNICAL -> Unit
            else -> return out
        }
        lastActivityAt = now
        setState(HandsetState.ACTIVE, now, out)
        out += tick(now)
        return out
    }

    /** "Start break" tapped (screen or reminder action). */
    fun startBreakTapped(now: Long): List<Effect> {
        val out = mutableListOf<Effect>()
        val w = window ?: return out
        if (!started || ended || inCall || state == HandsetState.ON_BREAK) return out
        val due = breakDue
        if (due != null) {
            startBreak(now, due.label, scheduled = true, lengthMs = due.lengthMs, 0, out)
        } else {
            // Starting a scheduled break a little early counts as that break.
            val soon = w.breaks.firstOrNull {
                it.startsAtMs !in handledBreaks && it.startsAtMs - now in 0..EARLY_BREAK_MS
            }
            if (soon != null) {
                handledBreaks += soon.startsAtMs
                startBreak(now, soon.label, scheduled = true, lengthMs = soon.lengthMs, 0, out)
            } else {
                if (state == HandsetState.PROMPTING) {
                    return answerPrompt(now, PromptAnswer.BREAK)
                }
                if (state == HandsetState.AWAY) out += Effect.ClearAway
                startBreak(now, "Break", scheduled = false, lengthMs = null, 0, out)
            }
        }
        out += tick(now)
        return out
    }

    /** FCM `presence_check`: heartbeat now; the tick prompts if ACTIVE and silent past T. */
    fun presenceCheck(now: Long): List<Effect> {
        heartbeatRequested = true
        return tick(now)
    }

    // ── Time ─────────────────────────────────────────────────────────────────

    /** Advances every timer to [now]. Idempotent: calling it twice at the same instant does nothing new. */
    fun tick(now: Long): List<Effect> {
        val out = mutableListOf<Effect>()
        val w = window ?: return out
        if (ended) return out
        val quiet = inCall || audioBusy

        // ── Before and at the start ──
        if (!started) {
            if (now in (w.startMs - ShiftSchedule.ARM_LEAD_MS) until w.startMs) {
                remindOnce("shift_soon", "Shift starts at ${clock(w.startMs)}", quiet, ReminderAction.START_SHIFT, out)
            }
            if (now >= w.startMs + settings.graceMs && now < w.endMs) {
                remindOnce("late", "You're marked late. Tap Start shift.", quiet, ReminderAction.START_SHIFT, out)
            }
            if (now >= w.endMs) {
                // A shift nobody started: nothing to end, just stop.
                ended = true
                out += Effect.Emit(EventKind.SERVICE_STOP, now)
                out += Effect.Upload
                out += Effect.StopService
                return out
            }
            heartbeat(now, out)
            return out
        }

        // ── The end ──
        if (now >= w.endMs) {
            remindOnce("shift_over", "Shift over.", quiet, ReminderAction.NONE, out)
            if (!inCall) finish(now, manual = false, out)
            // During a call: onCallEnd finishes the shift.
            heartbeat(now, out)
            return out
        }
        if (now in (w.endMs - 10 * MINUTE) until w.endMs) {
            remindOnce(
                "shift_ending", "Shift ends at ${clock(w.endMs)}. Log your last follow-ups.",
                quiet, ReminderAction.NONE, out,
            )
        }

        // ── Audio says a call is up that the call hooks did not see (e.g. VoIP with
        //    call detection off): count it as activity, never prompt over it. ──
        if (audioBusy && !inCall) lastActivityAt = now

        breaks(now, w, quiet, out)

        // ── Silence → prompt → away ──
        when (state) {
            HandsetState.ACTIVE -> if (!inCall && !audioBusy && now - lastActivityAt >= settings.silenceMs) {
                promptShownAt = now
                out += Effect.Emit(EventKind.PROMPT_SHOWN, now)
                setState(HandsetState.PROMPTING, now, out)
                out += Effect.ShowPrompt
            }
            HandsetState.PROMPTING -> {
                val shown = promptShownAt ?: now.also { promptShownAt = it }
                if (now - shown >= settings.promptTimeoutMs) {
                    out += Effect.Emit(EventKind.PROMPT_EXPIRED, now)
                    promptShownAt = null
                    out += Effect.ClosePrompt
                    // The server dates AWAY from when the prompt appeared (§3.3); the
                    // phone just reports the transition.
                    setState(HandsetState.AWAY, now, out)
                    out += Effect.ShowAway
                }
            }
            else -> Unit
        }

        heartbeat(now, out)
        return out
    }

    private fun breaks(now: Long, w: ShiftWindow, quiet: Boolean, out: MutableList<Effect>) {
        // A due break starts by itself after 2 minutes.
        breakDue?.let { due ->
            if (state == HandsetState.BREAK_DUE && now - due.dueAt >= settings.breakAutoStartMs) {
                startBreak(now, due.label, scheduled = true, lengthMs = due.lengthMs, 0, out)
            }
        }

        // Reminders for a break in progress.
        val cb = currentBreak
        if (state == HandsetState.ON_BREAK && cb?.endsAt != null) {
            val end = cb.endsAt
            val key = "${cb.startedAt}"
            if (now in (end - 2 * MINUTE) until end) {
                remindOnce("break_end_soon:$key", "Break ends at ${clock(end)}", quiet, ReminderAction.BACK, out)
            }
            if (now in end until end + 5 * MINUTE) {
                remindOnce("break_end:$key", "Back to dialling?", quiet, ReminderAction.BACK, out)
            }
            if (now >= end + 5 * MINUTE) {
                remindOnce("break_over:$key", "Your break has run 5 min over", quiet, ReminderAction.BACK, out)
            }
        }

        for (b in w.breaks) {
            if (b.startsAtMs in handledBreaks) continue
            val key = "${b.startsAtMs}"
            if (now >= b.endsAtMs) {
                // The whole slot passed while the phone was off or the app was dead.
                handledBreaks += b.startsAtMs
                continue
            }
            if (now >= b.startsAtMs) {
                handledBreaks += b.startsAtMs
                val due = DueBreak(b.label, now, b.lengthMs)
                when {
                    inCall -> deferredBreak = due // starts when the call ends, full length
                    state == HandsetState.ON_BREAK -> {
                        // Already on a break: it becomes this one, measured from when it began.
                        val started = currentBreak?.startedAt ?: now
                        currentBreak = ActiveBreak(b.label, true, started, started + b.lengthMs)
                    }
                    else -> {
                        when (state) {
                            HandsetState.PROMPTING -> {
                                promptShownAt = null
                                out += Effect.ClosePrompt
                            }
                            HandsetState.AWAY -> out += Effect.ClearAway
                            else -> Unit
                        }
                        breakDue = due
                        setState(HandsetState.BREAK_DUE, now, out)
                        remindOnce("break_due:$key", "Start your break?", quiet, ReminderAction.START_BREAK, out)
                    }
                }
                continue
            }
            if (state == HandsetState.ON_BREAK) continue
            if (now in (b.startsAtMs - 5 * MINUTE) until (b.startsAtMs - 2 * MINUTE)) {
                remindOnce(
                    "break_5:$key", "${b.label} at ${clock(b.startsAtMs)}. Wrap up your current lead.",
                    quiet, ReminderAction.NONE, out,
                )
            }
            if (now in (b.startsAtMs - 2 * MINUTE) until b.startsAtMs) {
                val id = "break_2:$key"
                if (id !in firedReminders) {
                    firedReminders += id
                    if (quiet) {
                        held += HeldReminder(id, "Last call before your break", ReminderAction.NONE, b.startsAtMs)
                    } else {
                        out += Effect.Remind(id, "Last call before your break", false)
                    }
                }
            }
        }
    }

    private fun heartbeat(now: Long, out: MutableList<Effect>) {
        val w = window ?: return
        if (ended) return
        // Heartbeats only inside the shift (or once it was started early). Nothing before.
        if (!started && now < w.startMs) return
        val last = lastHeartbeatAt
        if (heartbeatRequested || last == null || now - last >= settings.heartbeatMs || now < last) {
            heartbeatRequested = false
            lastHeartbeatAt = now
            out += Effect.Emit(EventKind.HEARTBEAT, now)
            out += Effect.Upload
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    private fun startBreak(
        now: Long,
        label: String,
        scheduled: Boolean,
        lengthMs: Long?,
        deferredBySec: Long,
        out: MutableList<Effect>,
    ) {
        if (state == HandsetState.PROMPTING) out += Effect.ClosePrompt
        if (state == HandsetState.AWAY) out += Effect.ClearAway
        promptShownAt = null
        breakDue = null
        deferredBreak = null
        currentBreak = ActiveBreak(label, scheduled, now, lengthMs?.let { now + it })
        out += Effect.Emit(
            EventKind.BREAK_STARTED, now,
            mapOf("scheduled" to scheduled, "deferredByCallSec" to deferredBySec),
        )
        setState(HandsetState.ON_BREAK, now, out)
    }

    private fun endBreak(now: Long, out: MutableList<Effect>) {
        if (currentBreak == null && state != HandsetState.ON_BREAK) return
        currentBreak = null
        out += Effect.Emit(EventKind.BREAK_ENDED, now)
    }

    /** OFF_SHIFT + shift_end + service_stop, then stop. */
    private fun finish(now: Long, manual: Boolean, out: MutableList<Effect>) {
        if (ended) return
        if (started) {
            if (state == HandsetState.ON_BREAK) endBreak(now, out)
            when (state) {
                HandsetState.PROMPTING -> out += Effect.ClosePrompt
                HandsetState.AWAY -> out += Effect.ClearAway
                else -> Unit
            }
            setState(HandsetState.OFF_SHIFT, now, out)
            out += Effect.Emit(EventKind.SHIFT_END, now, mapOf("manual" to manual))
        }
        ended = true
        promptShownAt = null
        breakDue = null
        deferredBreak = null
        currentBreak = null
        held.clear()
        out += Effect.Emit(EventKind.SERVICE_STOP, now)
        out += Effect.Upload
        out += Effect.StopService
    }

    private fun setState(next: HandsetState, now: Long, out: MutableList<Effect>) {
        if (next == state) return
        state = next
        stateSince = now
        out += Effect.Emit(EventKind.STATE, now, mapOf("state" to next.name))
    }

    private fun remindOnce(id: String, text: String, quiet: Boolean, action: ReminderAction, out: MutableList<Effect>) {
        if (!firedReminders.add(id)) return
        out += Effect.Remind(id, text, quiet, action)
    }

    private fun clock(ms: Long) = ShiftSchedule.clock(ms, settings.zoneId)

    /**
     * The next instant at which [tick] could do something, or null when nothing
     * is pending. The runtime sets a wake-up alarm for it so a sleeping phone
     * still prompts, reminds and heartbeats on time.
     */
    fun nextDeadline(now: Long): Long? {
        val w = window ?: return null
        if (ended) return null
        val c = mutableListOf<Long>()
        c += w.startMs - ShiftSchedule.ARM_LEAD_MS
        c += w.startMs
        c += w.startMs + settings.graceMs
        c += w.endMs - 10 * MINUTE
        c += w.endMs
        for (b in w.breaks) {
            if (b.startsAtMs in handledBreaks) continue
            c += b.startsAtMs - 5 * MINUTE
            c += b.startsAtMs - 2 * MINUTE
            c += b.startsAtMs
        }
        currentBreak?.endsAt?.let { end -> c += end - 2 * MINUTE; c += end; c += end + 5 * MINUTE }
        breakDue?.let { c += it.dueAt + settings.breakAutoStartMs }
        if (started && state == HandsetState.ACTIVE) c += lastActivityAt + settings.silenceMs
        promptShownAt?.let { c += it + settings.promptTimeoutMs }
        if (started || now >= w.startMs) c += (lastHeartbeatAt ?: now) + settings.heartbeatMs
        return c.filter { it > now }.minOrNull()
    }

    // ── Persistence ──────────────────────────────────────────────────────────

    data class Snapshot(
        val window: ShiftWindow?,
        val state: HandsetState,
        val stateSince: Long,
        val started: Boolean,
        val ended: Boolean,
        val lastActivityAt: Long,
        val promptShownAt: Long?,
        val cellularCallAt: Long?,
        val cellularDirection: String?,
        val voipCallAt: Long?,
        val stateBeforeCall: HandsetState?,
        val breakDue: DueBreak?,
        val deferredBreak: DueBreak?,
        val currentBreak: ActiveBreak?,
        val lastHeartbeatAt: Long?,
        val handledBreaks: Set<Long>,
        val firedReminders: Set<String>,
        val held: List<HeldReminder>,
    )

    fun snapshot() = Snapshot(
        window, state, stateSince, started, ended, lastActivityAt, promptShownAt,
        cellularCallAt, cellularDirection, voipCallAt, stateBeforeCall, breakDue, deferredBreak,
        currentBreak, lastHeartbeatAt, handledBreaks.toSet(), firedReminders.toSet(), held.toList(),
    )

    /**
     * Restores after process death. [sameBoot] false means the phone rebooted:
     * no call can have survived that, so call state is dropped (the call_end is
     * lost with the power; the server's gap rules cover it).
     */
    fun restore(s: Snapshot, sameBoot: Boolean, now: Long): List<Effect> {
        window = s.window
        state = s.state
        stateSince = s.stateSince
        started = s.started
        ended = s.ended
        lastActivityAt = s.lastActivityAt
        promptShownAt = s.promptShownAt
        cellularCallAt = s.cellularCallAt
        cellularDirection = s.cellularDirection
        voipCallAt = s.voipCallAt
        stateBeforeCall = s.stateBeforeCall
        breakDue = s.breakDue
        deferredBreak = s.deferredBreak
        currentBreak = s.currentBreak
        lastHeartbeatAt = s.lastHeartbeatAt
        handledBreaks.clear(); handledBreaks += s.handledBreaks
        firedReminders.clear(); firedReminders += s.firedReminders
        held.clear(); held += s.held
        val out = mutableListOf<Effect>()
        if (!sameBoot) {
            cellularCallAt = null
            cellularDirection = null
            voipCallAt = null
            lastHeartbeatAt = null
            if (state == HandsetState.IN_CALL && !ended) {
                val back = stateBeforeCall.takeIf { it != null && it != HandsetState.IN_CALL && it != HandsetState.OFF_SHIFT }
                    ?: HandsetState.ACTIVE
                stateBeforeCall = null
                lastActivityAt = now
                setState(back, now, out)
            }
        }
        return out
    }

    companion object {
        const val MINUTE = 60_000L
        /** Mirrors FAILED_CALL_SECONDS on the server. */
        const val FAILED_CALL_SECONDS = 5L
        /** "Start break" this close to a scheduled slot starts that slot. */
        const val EARLY_BREAK_MS = 15 * MINUTE
    }
}
