package com.voicetranscriber.callrecorder.attendance

import android.content.Context
import android.media.AudioManager
import android.os.BatteryManager
import android.util.Log
import com.voicetranscriber.callrecorder.attendance.PresenceEngine.Effect
import com.voicetranscriber.callrecorder.platform.ActivationStore
import com.voicetranscriber.callrecorder.platform.ConfigRefreshWorker
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.concurrent.Executors

/**
 * The Android side of attendance: one process-wide owner of the
 * [PresenceEngine], so a call hook, a notification action, an alarm and the
 * shift service all drive the SAME state machine, whichever of them woke the
 * process.
 *
 * Every entry point does the same four things under one lock:
 *  1. load the engine (restoring its snapshot after process death),
 *  2. feed it the event with "now" from [TrustedTime],
 *  3. carry out the effects (queue events, notifications, prompt, service),
 *  4. save the snapshot, re-arm the wake-up alarm, publish [ui].
 *
 * Nothing here runs unless attendance is enabled for this phone AND the
 * telecaller has acknowledged the notice (doc 33 §11) - see [trackingAllowed].
 */
object AttendanceController {

    private const val TAG = "Attendance"

    private val lock = Any()
    private var engine: PresenceEngine? = null
    private var time: TrustedTime? = null
    private var clock: DeviceClock? = null
    private var pendingInit: List<Effect> = emptyList()
    private var lastMono = -1L
    private var lastMonoBoot = ""

    /** Room writes, in order, off the caller's thread (receivers run on main). */
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "attendance-io") }

    // ── UI state ─────────────────────────────────────────────────────────────

    data class Ui(
        val enabled: Boolean = false,
        val noticeNeeded: Boolean = false,
        val running: Boolean = false,
        val started: Boolean = false,
        val state: HandsetState = HandsetState.OFF_SHIFT,
        val stateSince: Long = 0,
        val window: ShiftWindow? = null,
        val canStart: Boolean = false,
        val inCall: Boolean = false,
        val currentBreak: PresenceEngine.ActiveBreak? = null,
        val title: String = "Off shift",
        val detail: String = "",
    )

    private val _ui = MutableStateFlow(Ui())
    val ui: StateFlow<Ui> = _ui

    // ── Gates ────────────────────────────────────────────────────────────────

    fun config(context: Context): AttendanceConfig? = AttendanceStore.config(context)

    fun noticeNeeded(context: Context): Boolean {
        val cfg = config(context) ?: return false
        return AttendanceStore.noticeAckVersion(context) < cfg.noticeVersion
    }

    fun trackingAllowed(context: Context): Boolean =
        ActivationStore.isActivated(context) && config(context) != null && !noticeNeeded(context)

    // ── Engine plumbing ──────────────────────────────────────────────────────

    private fun ensureLoaded(context: Context): Pair<PresenceEngine, TrustedTime> {
        engine?.let { e -> time?.let { t -> return e to t } }
        val c = SystemDeviceClock(context.applicationContext)
        val t = TrustedTime(c, AttendanceStore.anchor(context))
        AttendanceStore.saveAnchor(context, t.anchor)
        val cfg = config(context)
        val e = PresenceEngine(cfg?.let(EngineSettings::from) ?: defaultSettings())
        val raw = AttendanceStore.snapshot(context)
        val init = mutableListOf<Effect>()
        if (raw != null) {
            val snap = AttendanceJson.snapshotFromJson(raw)
            if (snap != null) {
                val sameBoot = AttendanceStore.snapshotBoot(context) == c.bootId()
                val now = t.now()
                init += e.restore(snap, sameBoot, now)
                if (e.running && cfg != null) {
                    // The process died while a shift was being tracked (doc 33 §4 rule 8
                    // needs to know which of the two it was).
                    init.add(0, Effect.Emit(if (sameBoot) EventKind.APP_START else EventKind.BOOT, now))
                }
            }
        }
        engine = e
        time = t
        clock = c
        pendingInit = init
        return e to t
    }

    private fun defaultSettings() = EngineSettings(
        silenceMs = 10 * 60_000L, promptTimeoutMs = 3 * 60_000L, graceMs = 10 * 60_000L,
        heartbeatMs = 120_000L, zoneId = java.util.TimeZone.getDefault().id,
    )

    /**
     * Runs one engine step. [block] gets the engine and trusted now and returns
     * the effects. Returns silently when tracking is not allowed.
     */
    private fun step(context: Context, requireTracking: Boolean = true, block: (PresenceEngine, Long) -> List<Effect>) {
        val app = context.applicationContext
        // Attendance must never be able to break what calls this - above all the
        // call receivers, whose next job is starting a recording.
        try {
            if (requireTracking && !trackingAllowed(app)) return
            synchronized(lock) {
                val (e, t) = ensureLoaded(app)
                e.setAudioBusy(audioBusy(app))
                val now = t.now()
                val fx = mutableListOf<Effect>()
                fx += pendingInit
                pendingInit = emptyList()
                fx += block(e, now)
                fx += pickWindow(app, e, now)
                carryOut(app, e, t, fx)
                afterStep(app, e, t)
            }
        } catch (t: Throwable) {
            Log.e(TAG, "attendance step failed", t)
        }
    }

    /**
     * Chooses the window to track: keeps a running one (an overnight shift must
     * not vanish when the config rolls to the next day), updates it when the
     * config has a newer version of the same date, and otherwise picks the one
     * whose arm time has come.
     */
    private fun pickWindow(context: Context, e: PresenceEngine, now: Long): List<Effect> {
        val cfg = config(context) ?: return if (e.running) e.setWindow(null, now) else emptyList()
        val current = e.window
        if (current != null && e.running) {
            val day = ShiftSchedule.dayFor(cfg.days, current.date) ?: return emptyList()
            val updated = ShiftSchedule.windowOf(day)
            if (updated == current) return emptyList()
            return e.setWindow(updated, now)
        }
        val active = ShiftSchedule.activeWindow(cfg.days, now) ?: return emptyList()
        if (current != null && current.date == active.date && current == active) return emptyList()
        return e.setWindow(active, now)
    }

    private fun carryOut(context: Context, e: PresenceEngine, t: TrustedTime, effects: List<Effect>) {
        var upload = false
        var stop = false
        for (fx in effects) {
            when (fx) {
                is Effect.Emit -> queue(context, fx, t)
                is Effect.Remind -> AttendanceNotifications.remind(context, fx.text, fx.quiet, fx.action)
                Effect.ShowPrompt -> AttendanceNotifications.showPrompt(context)
                Effect.ClosePrompt -> AttendanceNotifications.closePrompt(context)
                Effect.ShowAway -> AttendanceNotifications.showAway(context)
                Effect.ClearAway -> AttendanceNotifications.clearAway(context)
                Effect.Upload -> upload = true
                Effect.StopService -> stop = true
            }
        }
        if (upload) PresenceUploader.requestFlush(context)
        if (stop) {
            AttendanceNotifications.closePrompt(context)
            AttendanceNotifications.clearAway(context)
            ShiftService.stop(context)
            // Whatever the last heartbeat could not send goes out when there is network.
            AttendanceSyncWorker.enqueue(context)
        }
    }

    private fun afterStep(context: Context, e: PresenceEngine, t: TrustedTime) {
        val c = clock ?: return
        AttendanceStore.saveSnapshot(context, AttendanceJson.snapshotToJson(e.snapshot()))
        AttendanceStore.setSnapshotBoot(context, c.bootId())
        AttendanceStore.saveAnchor(context, t.anchor)
        val now = t.now()
        val ui = buildUi(context, e, now)
        _ui.value = ui
        if (e.running) {
            if (!ShiftService.isRunning) ShiftService.start(context, ui)
            else AttendanceNotifications.updateShift(context, ui)
            val deadline = e.nextDeadline(now)
            val heartbeatCap = now + e.settings.heartbeatMs
            val next = (deadline ?: heartbeatCap).coerceAtMost(heartbeatCap).coerceAtLeast(now + 5_000)
            AttendanceAlarms.scheduleTick(context, t.toElapsed(next))
        } else {
            AttendanceAlarms.cancelTick(context)
        }
    }

    /** Stamps an engine event with the phone's clocks and queues it durably. */
    private fun queue(context: Context, fx: Effect.Emit, t: TrustedTime) {
        val c = clock ?: return
        val lag = (t.now() - fx.at).coerceAtLeast(0)
        val boot = c.bootId()
        var mono = (c.elapsedMs() - lag).coerceAtLeast(0)
        // (device, boot, monoMs, kind) is the server's idempotency key: two events
        // may never share a millisecond, or the second would be dropped as a duplicate.
        if (boot == lastMonoBoot && mono <= lastMono) mono = lastMono + 1
        lastMono = mono
        lastMonoBoot = boot
        val payload = if (fx.kind == EventKind.HEARTBEAT) {
            fx.payload + (batteryPct(context)?.let { mapOf("batteryPct" to it) } ?: emptyMap())
        } else {
            fx.payload
        }
        val entity = PresenceEventEntity(
            kind = fx.kind,
            at = ShiftSchedule.iso(c.wallMs() - lag),
            bootId = boot,
            monoMs = mono,
            payload = if (payload.isEmpty()) null else AttendanceJson.payload(payload).toString(),
        )
        io.execute {
            runCatching {
                val dao = AttendanceDb.get(context).dao()
                dao.insertEvent(entity)
                if (dao.eventCount() > MAX_QUEUE) dao.dropOldestHeartbeats(1_000)
            }.onFailure { Log.e(TAG, "could not queue ${entity.kind}", it) }
        }
    }

    private const val MAX_QUEUE = 20_000

    /** Blocks until every event queued so far is in Room. Call off the main thread. */
    fun awaitQueued() {
        runCatching { io.submit {}.get(5, java.util.concurrent.TimeUnit.SECONDS) }
    }

    private fun buildUi(context: Context, e: PresenceEngine, now: Long): Ui {
        val cfg = config(context)
        val zone = e.settings.zoneId
        fun clock(ms: Long) = ShiftSchedule.clock(ms, zone)
        val w = e.window
        val nextBreak = w?.breaks?.firstOrNull { it.startsAtMs > now }
        val (title, detail) = when {
            w == null || !e.running -> "Off shift" to ""
            !e.started && now < w.startMs -> "Shift starts at ${clock(w.startMs)}" to "Tap Start shift when you begin"
            !e.started -> "Shift not started" to "It started at ${clock(w.startMs)}. Tap Start shift."
            else -> when (e.state) {
                HandsetState.ACTIVE, HandsetState.IN_CALL -> {
                    val head = if (e.state == HandsetState.IN_CALL) "On shift · in a call" else "On shift"
                    val tail = nextBreak?.let { "next break ${clock(it.startsAtMs)}" } ?: "until ${clock(w.endMs)}"
                    "$head · $tail" to "Shift ${clock(w.startMs)} - ${clock(w.endMs)}"
                }
                HandsetState.PROMPTING -> "Are you there?" to "Answer the check on screen"
                HandsetState.AWAY -> "Away" to "Tap when you're back"
                HandsetState.TECHNICAL -> "Phone or network problem" to "Tap Back to dialling when it's fixed"
                HandsetState.BREAK_DUE -> "Break time" to "Your break starts by itself in 2 min"
                HandsetState.ON_BREAK -> {
                    val b = e.currentBreak
                    "On break" to (b?.endsAt?.let { "until ${clock(it)}" } ?: b?.let { "since ${clock(it.startedAt)}" } ?: "")
                }
                HandsetState.OFF_SHIFT -> "Off shift" to ""
            }
        }
        return Ui(
            enabled = cfg != null,
            noticeNeeded = noticeNeeded(context),
            running = e.running,
            started = e.started,
            state = e.state,
            stateSince = e.stateSince,
            window = w,
            canStart = e.canStart(now),
            inCall = e.inCall,
            currentBreak = e.currentBreak,
            title = title,
            detail = detail,
        )
    }

    fun currentUi(context: Context): Ui {
        if (!trackingAllowed(context)) {
            return Ui(enabled = config(context) != null, noticeNeeded = noticeNeeded(context))
        }
        synchronized(lock) {
            val (e, t) = ensureLoaded(context.applicationContext)
            return buildUi(context.applicationContext, e, t.now()).also { _ui.value = it }
        }
    }

    private fun audioBusy(context: Context): Boolean {
        val audio = context.getSystemService(AudioManager::class.java) ?: return false
        return audio.mode != AudioManager.MODE_NORMAL
    }

    fun batteryPct(context: Context): Int? {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager ?: return null
        return bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY).takeIf { it in 0..100 }
    }

    // ── Config, notice, lifecycle ────────────────────────────────────────────

    /**
     * Called on every config refresh with the parsed block (null = absent =
     * attendance off). Re-arms, starts or stops the service, and asks the sync
     * worker to look for request decisions.
     */
    fun onConfig(context: Context, cfg: AttendanceConfig?, json: String?) {
        // A config refresh is also the recording gate; attendance must not be able to fail it.
        try {
            applyConfig(context.applicationContext, cfg, json)
        } catch (t: Throwable) {
            Log.e(TAG, "applying the attendance config failed", t)
        }
    }

    private fun applyConfig(app: Context, cfg: AttendanceConfig?, json: String?) {
        if (cfg == null || json == null) {
            if (AttendanceStore.configJson(app) != null || engine?.running == true) shutdown(app)
            return
        }
        AttendanceStore.saveConfig(app, json, cfg.scheduleVersion)
        synchronized(lock) { engine?.updateSettings(EngineSettings.from(cfg)) }
        if (noticeNeeded(app)) {
            // Nothing is tracked until "I understand" (doc 33 §11). Ask once per notice version.
            if (AttendanceStore.noticeNotifiedVersion(app) < cfg.noticeVersion) {
                AttendanceStore.setNoticeNotifiedVersion(app, cfg.noticeVersion)
                AttendanceNotifications.showNoticeNeeded(app)
            }
            // A new notice version stops tracking until it is acknowledged.
            if (engine?.running == true) stopTracking(app)
            _ui.value = Ui(enabled = true, noticeNeeded = true)
            return
        }
        sync(app)
        AttendanceSyncWorker.enqueue(app, checkDecisions = true)
    }

    /** "I understand" on the notice. */
    fun acknowledgeNotice(context: Context) {
        val app = context.applicationContext
        val cfg = config(app) ?: return
        AttendanceStore.setNoticeAckVersion(app, cfg.noticeVersion)
        AttendanceNotifications.cancelNotice(app)
        step(app) { _, now -> listOf(Effect.Emit(EventKind.NOTICE_ACKNOWLEDGED, now, mapOf("version" to cfg.noticeVersion))) }
        AttendanceSyncWorker.enqueue(app, checkDecisions = true)
        sync(app)
    }

    /** Recomputes the window, re-arms the shift-start alarm, starts or stops the service. */
    fun sync(context: Context) {
        val app = context.applicationContext
        try {
            if (!trackingAllowed(app)) {
                AttendanceAlarms.cancelShift(app)
                return
            }
            step(app) { _, _ -> emptyList() }
            armNext(app)
        } catch (t: Throwable) {
            Log.e(TAG, "attendance sync failed", t)
        }
    }

    private fun armNext(context: Context) {
        val cfg = config(context) ?: return
        val now = synchronized(lock) { ensureLoaded(context).second.now() }
        val next = ShiftSchedule.nextWindow(cfg.days, now)
        if (next != null) {
            AttendanceAlarms.armShift(context, ShiftSchedule.armTime(next), now)
        } else {
            AttendanceAlarms.cancelShift(context)
        }
    }

    /** Attendance switched off (or device revoked): stop everything, forget the schedule. */
    private fun shutdown(context: Context) {
        stopTracking(context)
        AttendanceAlarms.cancelShift(context)
        AttendanceNotifications.cancelAll(context)
        AttendanceStore.clearTracking(context)
        synchronized(lock) {
            engine = null
            pendingInit = emptyList()
        }
        _ui.value = Ui()
        // Events already queued are still the telecaller's record; try to send them.
        AttendanceSyncWorker.enqueue(context)
    }

    private fun stopTracking(context: Context) {
        step(context, requireTracking = false) { e, now -> if (e.running) e.setWindow(null, now) else emptyList() }
        ShiftService.stop(context)
        AttendanceAlarms.cancelTick(context)
    }

    /** App.onCreate: restores a shift that was being tracked when the process died. */
    fun onProcessStart(context: Context) {
        AttendanceNotifications.createChannels(context)
        if (!trackingAllowed(context)) return
        sync(context)
    }

    /** BOOT_COMPLETED / exact-alarm permission granted / package replaced. */
    fun onBootOrRearm(context: Context) {
        if (!trackingAllowed(context)) return
        sync(context)
    }

    // ── Event hooks ──────────────────────────────────────────────────────────

    fun onCallStart(context: Context, voip: Boolean, direction: String) =
        step(context) { e, now -> e.onCallStart(now, voip, direction) }

    fun onCallEnd(context: Context, voip: Boolean) = step(context) { e, now -> e.onCallEnd(now, voip) }

    fun startShift(context: Context) = step(context) { e, now -> e.startShift(now) }

    fun endShift(context: Context) = step(context) { e, now -> e.endShift(now) }

    fun startBreak(context: Context) = step(context) { e, now -> e.startBreakTapped(now) }

    fun back(context: Context) = step(context) { e, now -> e.back(now) }

    fun answer(context: Context, answer: PromptAnswer, reason: TechnicalReason?) =
        step(context) { e, now -> e.answerPrompt(now, answer, reason) }

    fun tick(context: Context) = step(context) { e, now -> e.tick(now) }

    /** FCM `presence_check`: heartbeat now; prompts if ACTIVE and silent past the threshold. */
    fun presenceCheck(context: Context) = step(context) { e, now -> e.presenceCheck(now) }

    /** Weak evidence only (doc 33 §3.1): logged, never resets the silence timer. */
    fun onScreenUnlock(context: Context) = step(context) { e, now ->
        if (e.running && e.started) listOf(Effect.Emit(EventKind.SCREEN_UNLOCK, now)) else emptyList()
    }

    fun onServiceStarted(context: Context) = step(context) { e, now ->
        if (e.running) listOf(Effect.Emit(EventKind.SERVICE_START, now)) else emptyList()
    }

    /** [lostAgoMs]: how long ago the loss was first seen (it is confirmed after a short debounce). */
    fun onNetworkLost(context: Context, lostAgoMs: Long) = step(context) { e, now ->
        if (e.running) listOf(Effect.Emit(EventKind.NETWORK_LOST, now - lostAgoMs)) else emptyList()
    }

    fun onNetworkRestored(context: Context) {
        step(context) { e, now ->
            if (e.running) listOf(Effect.Emit(EventKind.NETWORK_RESTORED, now), Effect.Upload) else emptyList()
        }
        PresenceUploader.resetBackoff(context)
    }

    // ── Upload support ───────────────────────────────────────────────────────

    data class BatchHeader(
        val state: HandsetState,
        val stateSinceIso: String,
        val sentAtWall: Long,
        val sentElapsed: Long,
        val sentBoot: String,
    )

    /** The batch's `state`/`stateSince` and the clock readings for `sentAt`/`sentMonoMs`. */
    fun batchHeader(context: Context): BatchHeader = synchronized(lock) {
        val (e, t) = ensureLoaded(context.applicationContext)
        val c = clock!!
        val now = t.now()
        val wall = c.wallMs()
        val running = e.running
        val state = if (running) e.state else HandsetState.OFF_SHIFT
        val since = if (running) e.stateSince else now
        BatchHeader(state, ShiftSchedule.iso(wall - (now - since).coerceAtLeast(0)), wall, c.elapsedMs(), c.bootId())
    }

    /** A presence batch was accepted: fix the clock, and refetch config on a new schedule. */
    fun onPresenceAccepted(context: Context, header: BatchHeader, clockSkewSeconds: Long, scheduleVersion: Int?) {
        synchronized(lock) {
            val t = time
            if (t != null && t.correctFromServer(header.sentAtWall, header.sentElapsed, header.sentBoot, clockSkewSeconds)) {
                AttendanceStore.saveAnchor(context, t.anchor)
                Log.i(TAG, "clock re-anchored from server (skew ${clockSkewSeconds}s)")
            }
        }
        if (scheduleVersion != null && scheduleVersion != AttendanceStore.scheduleVersion(context)) {
            ConfigRefreshWorker.runNow(context)
        }
    }

    /** Server said attendance is disabled: stop until the next config says otherwise. */
    fun onServerDisabled(context: Context) {
        ConfigRefreshWorker.runNow(context)
    }
}
