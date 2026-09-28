package com.voicetranscriber.callrecorder.attendance

import android.Manifest
import android.content.ActivityNotFoundException
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.util.Pair
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.google.android.material.button.MaterialButton
import com.google.android.material.datepicker.MaterialDatePicker
import com.google.android.material.timepicker.MaterialTimePicker
import com.google.android.material.timepicker.TimeFormat
import com.voicetranscriber.callrecorder.R
import com.voicetranscriber.callrecorder.databinding.ActivityAttendanceBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneOffset

/**
 * The telecaller's Attendance screen (doc 33 §10): today's schedule and
 * timeline, Start shift / Start break / Back to dialling / End shift, and -
 * only when the workspace switched them on for this person - "Apply for leave"
 * and "Book a break", with the status of past applications.
 *
 * Telecallers see what managers see about themselves (§11): the timeline here
 * is the server's classification of the day. Offline, the phone's own state is
 * shown instead.
 */
class AttendanceActivity : AppCompatActivity() {

    private lateinit var binding: ActivityAttendanceBinding
    private var day: JSONObject? = null
    private var offline = false

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {
        renderSetup()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityAttendanceBinding.inflate(layoutInflater)
        setContentView(binding.root)
        binding.toolbar.setNavigationIcon(R.drawable.ic_arrow_back)
        binding.toolbar.setNavigationOnClickListener { finish() }
        binding.swipe.setOnRefreshListener { refresh() }

        binding.btnUnderstand.setOnClickListener {
            val app = applicationContext
            lifecycleScope.launch {
                withContext(Dispatchers.Default) { AttendanceController.acknowledgeNotice(app) }
                render()
                runSetupGuide()
            }
        }
        binding.btnStartShift.setOnClickListener { act { AttendanceController.startShift(it) } }
        binding.btnStartBreak.setOnClickListener { act { AttendanceController.startBreak(it) } }
        binding.btnBack.setOnClickListener { act { AttendanceController.back(it) } }
        binding.btnEndShift.setOnClickListener {
            AlertDialog.Builder(this)
                .setTitle(R.string.att_end_shift_confirm_title)
                .setMessage(R.string.att_end_shift_confirm_body)
                .setPositiveButton(R.string.att_end_shift) { _, _ -> act { AttendanceController.endShift(it) } }
                .setNegativeButton(android.R.string.cancel, null)
                .show()
        }
        binding.btnApplyLeave.setOnClickListener { showLeaveDialog() }
        binding.btnBookBreak.setOnClickListener { showBreakDialog() }

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                AttendanceController.ui.collect { renderState(it) }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        render()
        refresh()
    }

    private fun act(block: (android.content.Context) -> Unit) {
        val app = applicationContext
        lifecycleScope.launch {
            withContext(Dispatchers.Default) { block(app) }
            renderState(AttendanceController.ui.value)
            refresh()
        }
    }

    // ── Rendering ────────────────────────────────────────────────────────────

    private fun render() {
        val cfg = AttendanceController.config(this)
        val enabled = cfg != null
        binding.offText.visibility = if (enabled) View.GONE else View.VISIBLE
        val notice = enabled && AttendanceController.noticeNeeded(this)
        binding.noticeCard.visibility = if (notice) View.VISIBLE else View.GONE
        if (notice) binding.noticeText.text = cfg?.noticeText
        val tracking = enabled && !notice
        binding.statusCard.visibility = if (tracking) View.VISIBLE else View.GONE
        binding.timelineCard.visibility = if (tracking) View.VISIBLE else View.GONE
        binding.requestsCard.visibility = if (tracking) View.VISIBLE else View.GONE
        // Hidden entirely, not greyed out, when the switch is off (doc 33 §6.1).
        binding.btnApplyLeave.visibility = if (cfg?.canApplyLeave == true) View.VISIBLE else View.GONE
        binding.btnBookBreak.visibility = if (cfg?.canBookBreaks == true) View.VISIBLE else View.GONE
        if (tracking) {
            lifecycleScope.launch {
                val ui = withContext(Dispatchers.Default) { AttendanceController.currentUi(applicationContext) }
                renderState(ui)
            }
        }
        renderSetup()
        renderSchedule()
        renderTimeline()
        renderRequests()
    }

    private fun renderState(ui: AttendanceController.Ui) {
        if (!ui.enabled || ui.noticeNeeded) return
        binding.stateTitle.text = ui.title
        binding.stateDetail.text = ui.detail
        binding.stateDetail.visibility = if (ui.detail.isBlank()) View.GONE else View.VISIBLE
        val started = ui.running && ui.started
        binding.btnStartShift.visibility = if (ui.canStart) View.VISIBLE else View.GONE
        binding.btnBack.visibility = if (started && ui.state in BACKABLE) View.VISIBLE else View.GONE
        binding.btnBack.text = getString(
            if (ui.state == HandsetState.TECHNICAL) R.string.att_fixed else R.string.att_back_to_dialling,
        )
        binding.btnStartBreak.visibility =
            if (started && !ui.inCall && ui.state != HandsetState.ON_BREAK) View.VISIBLE else View.GONE
        binding.btnEndShift.visibility = if (started && !ui.inCall) View.VISIBLE else View.GONE
    }

    private fun renderSchedule() {
        val cfg = AttendanceController.config(this) ?: return
        val zone = cfg.timeZone
        val today = ShiftSchedule.dateKey(System.currentTimeMillis(), zone)
        val lines = mutableListOf<String>()
        for (d in cfg.days.sortedBy { it.date }) {
            val head = if (d.date == today) "Today" else ShiftSchedule.shortDate(d.date)
            val w = ShiftSchedule.windowOf(d)
            lines += when {
                w != null -> buildString {
                    append("$head: ${ShiftSchedule.clock(w.startMs, zone)} - ${ShiftSchedule.clock(w.endMs, zone)}")
                    d.label?.let { append(" ($it)") }
                    for (b in w.breaks) {
                        append("\n   ${b.label} ${ShiftSchedule.clock(b.startsAtMs, zone)} - ${ShiftSchedule.clock(b.endsAtMs, zone)}")
                    }
                }
                d.kind == "holiday" -> "$head: Holiday${d.label?.let { " - $it" } ?: ""}"
                d.kind == "leave" -> "$head: On leave${d.label?.let { " ($it)" } ?: ""}"
                else -> "$head: Day off"
            }
        }
        binding.scheduleText.text = if (lines.isEmpty()) getString(R.string.att_no_schedule) else lines.joinToString("\n")
    }

    private fun renderTimeline() {
        val container = binding.segments
        container.removeAllViews()
        binding.offlineNote.visibility = if (offline) View.VISIBLE else View.GONE
        val d = day
        if (d == null) {
            binding.summaryText.text = getString(if (offline) R.string.att_timeline_offline else R.string.att_loading)
            return
        }
        val zone = AttendanceController.config(this)?.timeZone ?: "UTC"
        val s = d.optJSONObject("summary")
        if (s != null) {
            val status = DAY_STATUS[AttendanceJson.optStr(s, "status")] ?: AttendanceJson.optStr(s, "status") ?: ""
            val parts = listOf(
                "Worked ${ShiftSchedule.duration(s.optLong("workedSeconds"))}",
                "Breaks ${ShiftSchedule.duration(s.optLong("breakSeconds"))}",
                "Technical ${ShiftSchedule.duration(s.optLong("technicalSeconds"))}",
                "Away ${ShiftSchedule.duration(s.optLong("awaySeconds"))}",
            )
            val flags = s.optJSONArray("flags") ?: JSONArray()
            val flagText = (0 until flags.length()).mapNotNull { FLAGS[flags.optString(it)] ?: flags.optString(it) }
            binding.summaryText.text = buildString {
                if (status.isNotBlank()) append("$status\n")
                append(parts.joinToString(" · "))
                if (flagText.isNotEmpty()) append("\n${flagText.joinToString(" · ")}")
            }
        } else {
            binding.summaryText.text = ""
        }
        val segs = d.optJSONArray("segments") ?: JSONArray()
        if (segs.length() == 0) {
            container.addView(line(getString(R.string.att_timeline_empty), secondary = true))
        }
        for (i in 0 until segs.length()) {
            val seg = segs.optJSONObject(i) ?: continue
            val from = ShiftSchedule.parseInstant(AttendanceJson.optStr(seg, "startsAt")) ?: continue
            val to = ShiftSchedule.parseInstant(AttendanceJson.optStr(seg, "endsAt")) ?: continue
            val cls = AttendanceJson.optStr(seg, "class") ?: ""
            val review = if (seg.optBoolean("needsReview")) " · with your manager for review" else ""
            container.addView(
                line("${ShiftSchedule.clock(from, zone)} - ${ShiftSchedule.clock(to, zone)}   ${SEGMENTS[cls] ?: cls}$review"),
            )
        }
    }

    private fun renderRequests() {
        val app = applicationContext
        val currentDay = day
        lifecycleScope.launch {
            val rows = withContext(Dispatchers.IO) { AttendanceRequests.rows(app, currentDay) }
            val container = binding.requests
            container.removeAllViews()
            binding.requestsEmpty.visibility = if (rows.isEmpty()) View.VISIBLE else View.GONE
            for (r in rows) container.addView(requestView(r))
        }
    }

    private fun requestView(r: AttendanceRequests.Row): View {
        val dp = resources.displayMetrics.density
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, (8 * dp).toInt(), 0, (8 * dp).toInt())
        }
        box.addView(line(r.description, bold = true))
        box.addView(line(r.progress, secondary = true))
        r.decisionNote?.let { box.addView(line("“$it”", secondary = true)) }
        if (r.cancellable) {
            val label = when {
                r.local && r.status == "failed" -> R.string.att_request_dismiss
                else -> R.string.att_request_cancel
            }
            box.addView(
                MaterialButton(this, null, androidx.appcompat.R.attr.borderlessButtonStyle).apply {
                    setText(label)
                    setOnClickListener { cancelRequest(r) }
                },
            )
        }
        return box
    }

    private fun cancelRequest(r: AttendanceRequests.Row) {
        val app = applicationContext
        lifecycleScope.launch {
            val message = withContext(Dispatchers.IO) {
                when {
                    r.local && r.clientRef != null -> {
                        AttendanceRequests.dismissFailed(app, r.clientRef)
                        null
                    }
                    r.id != null -> AttendanceRequests.cancel(app, r.id)
                    else -> null
                }
            }
            if (message != null) Toast.makeText(this@AttendanceActivity, message, Toast.LENGTH_LONG).show()
            refresh()
        }
    }

    private fun line(text: String, secondary: Boolean = false, bold: Boolean = false) = TextView(this).apply {
        this.text = text
        setTextAppearance(
            if (secondary) com.google.android.material.R.style.TextAppearance_Material3_BodySmall
            else com.google.android.material.R.style.TextAppearance_Material3_BodyMedium,
        )
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            .apply { topMargin = (2 * resources.displayMetrics.density).toInt() }
    }

    /** Fetches today's timeline and requests; sends any application still waiting. */
    private fun refresh() {
        val cfg = AttendanceController.config(this)
        if (cfg == null || AttendanceController.noticeNeeded(this)) {
            binding.swipe.isRefreshing = false
            return
        }
        val app = applicationContext
        val today = ShiftSchedule.dateKey(System.currentTimeMillis(), cfg.timeZone)
        lifecycleScope.launch {
            val fetched = withContext(Dispatchers.IO) {
                AttendanceRequests.sendPending(app)
                runCatching { AttendanceRequests.fetchDay(app, today) }.getOrNull()
            }
            if (fetched != null) {
                day = fetched
                offline = false
            } else {
                offline = true
                day = AttendanceRequests.cachedDay(app)?.takeIf { AttendanceJson.optStr(it, "date") == today }
            }
            binding.swipe.isRefreshing = false
            renderTimeline()
            renderRequests()
        }
    }

    // ── Guided setup (doc 33 §10) ────────────────────────────────────────────

    private fun renderSetup() {
        val cfg = AttendanceController.config(this)
        if (cfg == null || AttendanceController.noticeNeeded(this)) {
            binding.setupCard.visibility = View.GONE
            return
        }
        val missing = AttendanceSetup.missing(this)
        binding.setupCard.visibility = if (missing.isEmpty()) View.GONE else View.VISIBLE
        binding.setupSteps.removeAllViews()
        for (step in missing) {
            binding.setupSteps.addView(
                MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                    setText(
                        when (step) {
                            AttendanceSetup.Step.NOTIFICATIONS -> R.string.att_setup_notifications
                            AttendanceSetup.Step.BATTERY -> R.string.att_setup_battery
                            AttendanceSetup.Step.FULL_SCREEN -> R.string.att_setup_full_screen
                            AttendanceSetup.Step.EXACT_ALARM -> R.string.att_setup_exact_alarm
                        },
                    )
                    layoutParams = LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                    )
                    setOnClickListener { openSetup(step) }
                },
            )
        }
    }

    private fun openSetup(step: AttendanceSetup.Step) {
        if (step == AttendanceSetup.Step.NOTIFICATIONS) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
            return
        }
        val intent = AttendanceSetup.intentFor(this, step) ?: return
        try {
            startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            runCatching { startActivity(AttendanceSetup.appDetails(this)) }
        } catch (_: SecurityException) {
            runCatching { startActivity(AttendanceSetup.appDetails(this)) }
        }
    }

    /** Right after the notice: walk through what is missing, one system page at a time. */
    private fun runSetupGuide() {
        if (AttendanceStore.setupOffered(this)) return
        val missing = AttendanceSetup.missing(this)
        AttendanceStore.setSetupOffered(this, true)
        if (missing.isEmpty()) return
        AlertDialog.Builder(this)
            .setTitle(R.string.att_setup_title)
            .setMessage(R.string.att_setup_dialog)
            .setPositiveButton(R.string.att_setup_start) { _, _ ->
                // Battery first: it is the one that keeps the shift alive on Samsung.
                openSetup(missing.firstOrNull { it == AttendanceSetup.Step.BATTERY } ?: missing.first())
            }
            .setNegativeButton(R.string.att_setup_later, null)
            .show()
    }

    // ── Apply for leave (doc 33 §6.3) ────────────────────────────────────────

    private fun showLeaveDialog() {
        val cfg = AttendanceController.config(this) ?: return
        if (!cfg.canApplyLeave) return
        val dp = resources.displayMetrics.density
        var range: kotlin.Pair<LocalDate, LocalDate>? = null

        val datesButton = MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle)
            .apply { setText(R.string.att_leave_pick_dates) }
        val fullDay = RadioButton(this).apply { id = View.generateViewId(); setText(R.string.att_leave_full) }
        val morning = RadioButton(this).apply { id = View.generateViewId(); setText(R.string.att_leave_morning) }
        val afternoon = RadioButton(this).apply { id = View.generateViewId(); setText(R.string.att_leave_afternoon) }
        val dayPart = RadioGroup(this).apply {
            orientation = RadioGroup.VERTICAL
            addView(fullDay); addView(morning); addView(afternoon)
            check(fullDay.id)
        }
        val typeSpinner = Spinner(this).apply {
            adapter = ArrayAdapter(
                this@AttendanceActivity, android.R.layout.simple_spinner_dropdown_item,
                LeaveType.entries.map { it.label },
            )
        }
        val reason = EditText(this).apply {
            setHint(R.string.att_reason_optional)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or
                InputType.TYPE_TEXT_FLAG_MULTI_LINE
        }
        val warning = TextView(this).apply {
            setTextColor(getColor(android.R.color.holo_orange_dark))
            visibility = View.GONE
        }

        fun updateRange() {
            val r = range
            val single = r != null && r.first == r.second
            morning.isEnabled = single
            afternoon.isEnabled = single
            if (!single) dayPart.check(fullDay.id)
            datesButton.text = when {
                r == null -> getString(R.string.att_leave_pick_dates)
                single -> ShiftSchedule.shortDate(r.first.toString())
                else -> "${ShiftSchedule.shortDate(r.first.toString())} - ${ShiftSchedule.shortDate(r.second.toString())}"
            }
            val warnings = r?.let { leaveWarnings(cfg, it.first, it.second) }.orEmpty()
            warning.text = warnings.joinToString("\n")
            warning.visibility = if (warnings.isEmpty()) View.GONE else View.VISIBLE
        }
        updateRange()

        datesButton.setOnClickListener {
            val picker = MaterialDatePicker.Builder.dateRangePicker()
                .setTitleText(R.string.att_leave_pick_dates)
                .apply {
                    range?.let { r ->
                        setSelection(Pair(utcMs(r.first), utcMs(r.second)))
                    }
                }
                .build()
            picker.addOnPositiveButtonClickListener { sel ->
                val s = sel.first ?: return@addOnPositiveButtonClickListener
                val e = sel.second ?: s
                range = utcDate(s) to utcDate(e)
                updateRange()
            }
            picker.show(supportFragmentManager, "leave-dates")
        }

        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (20 * dp).toInt()
            setPadding(pad, (8 * dp).toInt(), pad, 0)
            addView(datesButton)
            addView(dayPart)
            addView(TextView(this@AttendanceActivity).apply { setText(R.string.att_leave_type) })
            addView(typeSpinner)
            addView(reason)
            addView(warning)
            addView(
                TextView(this@AttendanceActivity).apply {
                    text = getString(R.string.att_goes_to, cfg.approverName ?: getString(R.string.att_owners))
                    setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_BodySmall)
                },
            )
        }

        val dialog = AlertDialog.Builder(this)
            .setTitle(R.string.att_apply_leave)
            .setView(android.widget.ScrollView(this).apply { addView(content) })
            .setPositiveButton(R.string.att_send, null)
            .setNegativeButton(android.R.string.cancel, null)
            .create()
        dialog.setOnShowListener {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val r = range
                if (r == null) {
                    Toast.makeText(this, R.string.att_leave_pick_dates, Toast.LENGTH_SHORT).show()
                    return@setOnClickListener
                }
                val half = when (dayPart.checkedRadioButtonId) {
                    morning.id -> "am"
                    afternoon.id -> "pm"
                    else -> null
                }
                val type = LeaveType.entries[typeSpinner.selectedItemPosition.coerceAtLeast(0)]
                val body = AttendanceRequests.leaveBody(
                    type, r.first.toString(), r.second.toString(), half, reason.text?.toString(),
                )
                dialog.dismiss()
                send(body)
            }
        }
        dialog.show()
    }

    /** "3 Oct is already a holiday" / "you have an approved break on 3 Oct that this will cancel". */
    private fun leaveWarnings(cfg: AttendanceConfig, from: LocalDate, to: LocalDate): List<String> {
        val out = mutableListOf<String>()
        var d = from
        while (!d.isAfter(to)) {
            val day = ShiftSchedule.dayFor(cfg.days, d.toString())
            val label = ShiftSchedule.shortDate(d.toString())
            when (day?.kind) {
                "holiday" -> out += "$label is already a holiday"
                "off" -> out += "$label is already a day off"
                "leave" -> out += "You already have leave on $label"
                "work" -> if (day.breaks.any { it.source == "booked" }) {
                    out += "You have an approved break on $label that this will cancel"
                }
            }
            d = d.plusDays(1)
        }
        return out
    }

    private fun utcMs(d: LocalDate): Long = d.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
    private fun utcDate(ms: Long): LocalDate = Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate()

    // ── Book a break ─────────────────────────────────────────────────────────

    private fun showBreakDialog() {
        val cfg = AttendanceController.config(this) ?: return
        if (!cfg.canBookBreaks) return
        val now = System.currentTimeMillis()
        val window = AttendanceController.ui.value.window?.takeIf { it.endMs > now }
            ?: ShiftSchedule.windows(cfg.days).firstOrNull { it.endMs > now }
        if (window == null) {
            Toast.makeText(this, R.string.att_break_no_shift, Toast.LENGTH_LONG).show()
            return
        }
        val zone = ShiftSchedule.zone(cfg.timeZone)
        val shiftStartLocal = Instant.ofEpochMilli(window.startMs).atZone(zone)
        val picker = MaterialTimePicker.Builder()
            .setTimeFormat(TimeFormat.CLOCK_12H)
            .setTitleText(getString(R.string.att_break_pick_start, ShiftSchedule.shortDate(window.date)))
            .setHour(shiftStartLocal.hour)
            .setMinute(shiftStartLocal.minute)
            .build()
        picker.addOnPositiveButtonClickListener {
            val time = LocalTime.of(picker.hour, picker.minute)
            var start = LocalDate.parse(window.date).atTime(time).atZone(zone).toInstant().toEpochMilli()
            // An overnight shift: a time before the shift's start means after midnight.
            if (start < window.startMs) start += 24 * 3_600_000L
            chooseBreakLength(cfg, window, start)
        }
        picker.show(supportFragmentManager, "break-start")
    }

    private fun chooseBreakLength(cfg: AttendanceConfig, window: ShiftWindow, start: Long) {
        val lengths = listOf(15, 30, 45, 60, 90, 120).filter { it <= maxOf(15, cfg.breakAllowanceMinutes) }
        val labels = lengths.map { "$it min" }.toTypedArray()
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.att_break_length, ShiftSchedule.clock(start, cfg.timeZone)))
            .setItems(labels) { _, which ->
                val end = start + lengths[which] * 60_000L
                val problem = when {
                    start < System.currentTimeMillis() -> getString(R.string.att_break_in_past)
                    start < window.startMs || end > window.endMs -> getString(
                        R.string.att_break_outside_shift,
                        ShiftSchedule.clock(window.startMs, cfg.timeZone), ShiftSchedule.clock(window.endMs, cfg.timeZone),
                    )
                    else -> null
                }
                if (problem != null) {
                    Toast.makeText(this, problem, Toast.LENGTH_LONG).show()
                } else {
                    send(AttendanceRequests.breakBody(start, end, null))
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun send(body: JSONObject) {
        val app = applicationContext
        lifecycleScope.launch {
            val outcome = withContext(Dispatchers.IO) { AttendanceRequests.submit(app, body) }
            if (outcome == "Waiting to send") AttendanceSyncWorker.enqueue(app)
            Toast.makeText(this@AttendanceActivity, outcome, Toast.LENGTH_LONG).show()
            refresh()
        }
    }

    companion object {
        private val BACKABLE = setOf(
            HandsetState.ON_BREAK, HandsetState.AWAY, HandsetState.TECHNICAL, HandsetState.BREAK_DUE,
        )

        /** SEGMENT_CLASS_LABELS in attendance.ts. */
        private val SEGMENTS = mapOf(
            "working" to "Working", "break" to "Break", "break_overrun" to "Break overrun",
            "unscheduled_break" to "Unscheduled break", "technical" to "Technical", "away" to "Away",
            "leave" to "Leave", "unknown" to "Unknown", "not_started" to "Not started", "absent" to "Absent",
            "overtime" to "Overtime",
        )

        /** DAY_STATUS_LABELS in attendance.ts. */
        private val DAY_STATUS = mapOf(
            "present" to "Present", "late" to "Late", "half_day" to "Half day", "absent" to "Absent",
            "on_leave" to "On leave", "holiday" to "Holiday", "off" to "Day off", "upcoming" to "Upcoming",
        )

        /** FLAG_LABELS in attendance.ts. */
        private val FLAGS = mapOf(
            "late" to "Late", "early_leave" to "Left early", "break_overrun" to "Break overran",
            "unscheduled_break" to "Unscheduled break", "responding_not_dialing" to "Answering checks, not dialling",
            "network_outage" to "Network outage", "clock_skew" to "Phone clock wrong",
            "not_started" to "Shift not started", "worked_on_day_off" to "Worked on a day off",
        )
    }
}
