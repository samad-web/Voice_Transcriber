package com.voicetranscriber.callrecorder.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.media.MediaPlayer
import android.media.audiofx.Visualizer
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.util.Log
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.SeekBar
import android.widget.Spinner
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.app.AppCompatDelegate
import androidx.appcompat.view.ActionMode
import com.voicetranscriber.callrecorder.platform.TelecallerProfile
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.recyclerview.widget.LinearLayoutManager
import com.google.android.material.bottomsheet.BottomSheetDialog
import com.voicetranscriber.callrecorder.R
import com.voicetranscriber.callrecorder.capture.CaptureSettings
import com.voicetranscriber.callrecorder.databinding.ActivityMainBinding
import com.voicetranscriber.callrecorder.databinding.SheetSettingsBinding
import com.voicetranscriber.callrecorder.ingest.OemIngestWorker
import com.voicetranscriber.callrecorder.ingest.OemRecordingIngestor
import com.voicetranscriber.callrecorder.upload.UploadScheduler
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import com.voicetranscriber.callrecorder.service.AccessibilityStatus
import com.voicetranscriber.callrecorder.storage.RecordingEntity
import com.voicetranscriber.callrecorder.util.ThemeManager
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File
import kotlin.math.sqrt

class MainActivity : AppCompatActivity() {

    private lateinit var binding: ActivityMainBinding
    private val viewModel: RecordingsViewModel by viewModels()
    private val adapter =
        RecordingsAdapter(
            ::togglePlayback, ::deleteRecording, ::shareRecording, ::editRecording,
            ::enterSelection, ::toggleSelection,
        )
    private val settings by lazy { CaptureSettings(this) }
    private val profile by lazy { TelecallerProfile(this) }
    private var actionMode: ActionMode? = null

    private var player: MediaPlayer? = null
    private var visualizer: Visualizer? = null
    private var playingId: Long? = null
    private var progressJob: Job? = null
    @Volatile private var level = 0f

    private val permissions = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        setSupportActionBar(binding.toolbar)

        // Hidden admin entry (activation gate): long-press the toolbar to open
        // the device-activation screen. Not reachable from normal navigation.
        binding.toolbar.setOnLongClickListener {
            startActivity(android.content.Intent(this, AdminActivationActivity::class.java))
            true
        }

        binding.recordings.layoutManager = LinearLayoutManager(this)
        binding.recordings.adapter = adapter
        binding.playerPanel.visibility = View.GONE
        binding.enableAccessibility.setOnClickListener { openAccessibilitySettings() }
        binding.swipeRefresh.setOnRefreshListener { refreshRecordings() }

        // Telecaller greeting — tap the header to set/change the name.
        binding.greetingHeader.setOnClickListener { showProfileDialog() }
        renderGreeting()
        if (!profile.hasName) showProfileDialog() // first run: ask who this handset belongs to

        binding.seek.setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
            override fun onProgressChanged(sb: SeekBar, progress: Int, fromUser: Boolean) {
                if (fromUser) runCatching { player?.seekTo(progress) }
            }
            override fun onStartTrackingTouch(sb: SeekBar) {}
            override fun onStopTrackingTouch(sb: SeekBar) {}
        })

        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                viewModel.recordings.collect { list ->
                    adapter.submitList(list)
                    val empty = list.isEmpty()
                    binding.emptyState.visibility = if (empty) View.VISIBLE else View.GONE
                    binding.recordings.visibility = if (empty) View.GONE else View.VISIBLE
                }
            }
        }

        requestRuntimePermissions()
    }

    override fun onResume() {
        super.onResume()
        // Prompt to enable the accessibility service only while it's off.
        binding.setupBanner.visibility =
            if (AccessibilityStatus.isEnabled(this)) View.GONE else View.VISIBLE
        renderGreeting() // keep the time-of-day greeting current
    }

    /**
     * Import any OEM recordings that haven't been picked up yet. The automatic ingest only
     * runs ~15s after a call ends and on a 15-minute cycle, so a call made moments ago won't
     * be listed until then — this makes it immediate. The list itself is a Room Flow, so new
     * rows render on their own once inserted; we only report the count.
     */
    private fun refreshRecordings() {
        lifecycleScope.launch {
            val added = withContext(Dispatchers.IO) {
                runCatching { OemRecordingIngestor.ingest(applicationContext) }.getOrDefault(0)
            }
            // Also nudge the uploader so anything still PENDING retries now.
            UploadScheduler.enqueue(applicationContext)
            binding.swipeRefresh.isRefreshing = false
            Toast.makeText(
                this@MainActivity,
                if (added > 0) getString(R.string.refresh_found, added) else getString(R.string.refresh_none),
                Toast.LENGTH_SHORT,
            ).show()
        }
    }

    // ---- telecaller profile / greeting -------------------------------------

    @SuppressLint("SetTextI18n")
    private fun renderGreeting() {
        val greetRes = when (TelecallerProfile.currentGreeting()) {
            TelecallerProfile.Greeting.MORNING -> R.string.greeting_morning
            TelecallerProfile.Greeting.AFTERNOON -> R.string.greeting_afternoon
            TelecallerProfile.Greeting.EVENING -> R.string.greeting_evening
        }
        binding.greetingLine.text = getString(R.string.greeting_line, getString(greetRes))
        val name = profile.name
        if (name != null) {
            binding.greetingName.text = name
            binding.greetingAvatar.text = name.take(1).uppercase()
        } else {
            binding.greetingName.text = getString(R.string.tap_to_set_name)
            binding.greetingAvatar.text = "?"
        }
    }

    private fun showProfileDialog() {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val input = EditText(this).apply {
            hint = getString(R.string.profile_set_name_hint)
            setText(profile.name)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_WORDS
            setSelection(text.length)
        }
        val container = FrameLayout(this).apply {
            setPadding(pad, pad / 2, pad, 0)
            addView(input)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.profile_set_name_title)
            .setView(container)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                profile.name = input.text.toString()
                renderGreeting()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    // ---- toolbar / settings ------------------------------------------------

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.menu_main, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean = when (item.itemId) {
        R.id.action_settings -> { showSettings(); true }
        R.id.action_profile -> { showProfileDialog(); true }
        R.id.action_refresh -> {
            binding.swipeRefresh.isRefreshing = true // mirror the pull gesture's spinner
            refreshRecordings()
            true
        }
        R.id.action_find_oem_recordings -> {
            startActivity(Intent(this, RecordingsScannerActivity::class.java)); true
        }
        else -> super.onOptionsItemSelected(item)
    }

    // ---- multi-select (contextual action bar) ------------------------------

    /** Long-press a row: open the selection action bar and select that row. */
    private fun enterSelection(item: RecordingEntity) {
        if (actionMode == null) {
            adapter.setSelectionMode(true)
            actionMode = startSupportActionMode(selectionCallback)
        }
        adapter.toggle(item)
        updateActionModeTitle()
    }

    /** Tap a row while selecting: toggle it; close the bar when nothing is left. */
    private fun toggleSelection(item: RecordingEntity) {
        adapter.toggle(item)
        if (adapter.selectedCount() == 0) actionMode?.finish() else updateActionModeTitle()
    }

    private fun updateActionModeTitle() {
        actionMode?.title = getString(R.string.selected_count, adapter.selectedCount())
    }

    private fun confirmDeleteSelected() {
        val items = adapter.selectedItems()
        if (items.isEmpty()) return
        AlertDialog.Builder(this)
            .setTitle(R.string.delete_selected_title)
            .setMessage(getString(R.string.delete_selected_message, items.size))
            .setPositiveButton(R.string.delete_action) { _, _ ->
                if (items.any { it.id == playingId }) stopPlayback()
                viewModel.deleteMany(items)
                actionMode?.finish()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private val selectionCallback = object : ActionMode.Callback {
        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
            mode.menuInflater.inflate(R.menu.menu_selection, menu)
            return true
        }

        override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean = false

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean =
            when (item.itemId) {
                R.id.action_select_all -> { adapter.selectAll(); updateActionModeTitle(); true }
                R.id.action_delete_selected -> { confirmDeleteSelected(); true }
                else -> false
            }

        override fun onDestroyActionMode(mode: ActionMode) {
            adapter.setSelectionMode(false)
            actionMode = null
        }
    }

    private fun showSettings() {
        val sheet = SheetSettingsBinding.inflate(layoutInflater)
        val on = AccessibilityStatus.isEnabled(this)
        sheet.accessibilityStatus.text =
            getString(if (on) R.string.accessibility_on else R.string.accessibility_off)
        sheet.btnAccessibility.visibility = if (on) View.GONE else View.VISIBLE
        sheet.btnAccessibility.setOnClickListener { openAccessibilitySettings() }

        sheet.oemIngest.isChecked = settings.oemIngestEnabled
        sheet.oemIngest.setOnCheckedChangeListener { _, checked ->
            settings.oemIngestEnabled = checked
            // Turning it on should surface the existing backlog straight away.
            if (checked) OemIngestWorker.enqueueNow(this)
        }
        sheet.forceSpeaker.isChecked = settings.forceSpeakerForPhone
        sheet.forceSpeaker.setOnCheckedChangeListener { _, checked ->
            settings.forceSpeakerForPhone = checked
        }
        sheet.recordVoip.isChecked = settings.recordVoipCalls
        sheet.recordVoip.setOnCheckedChangeListener { _, checked ->
            settings.recordVoipCalls = checked
        }
        setupThemeToggle(sheet)
        setupSourcePicker(sheet.sourcePicker)

        BottomSheetDialog(this).apply {
            setContentView(sheet.root)
            show()
        }
    }

    /** Phone audio-source dropdown — test each source to find both-ends capture. */
    private fun setupSourcePicker(spinner: Spinner) {
        val labels = resources.getStringArray(R.array.source_option_labels)
        val values = resources.getIntArray(R.array.source_option_values)
        spinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, labels)
        spinner.setSelection(values.indexOf(settings.phoneSourceOverride).coerceAtLeast(0))
        spinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>, view: View?, position: Int, id: Long) {
                settings.phoneSourceOverride = values[position]
            }
            override fun onNothingSelected(parent: AdapterView<*>) {}
        }
    }

    /** Light / Dark / System segmented control. Applying recreates the activity. */
    private fun setupThemeToggle(sheet: SheetSettingsBinding) {
        val checkedId = when (ThemeManager.current(this)) {
            AppCompatDelegate.MODE_NIGHT_NO -> R.id.themeLight
            AppCompatDelegate.MODE_NIGHT_YES -> R.id.themeDark
            else -> R.id.themeSystem
        }
        sheet.themeGroup.check(checkedId) // set before adding the listener so it doesn't fire now
        sheet.themeGroup.addOnButtonCheckedListener { _, id, isChecked ->
            if (!isChecked) return@addOnButtonCheckedListener
            val mode = when (id) {
                R.id.themeLight -> AppCompatDelegate.MODE_NIGHT_NO
                R.id.themeDark -> AppCompatDelegate.MODE_NIGHT_YES
                else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
            }
            ThemeManager.set(this, mode)
        }
    }

    private fun openAccessibilitySettings() {
        startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }

    // ---- row actions -------------------------------------------------------

    private fun deleteRecording(item: RecordingEntity) {
        if (playingId == item.id) stopPlayback()
        viewModel.delete(item)
    }

    private fun editRecording(item: RecordingEntity) {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val nameField = EditText(this).apply {
            hint = getString(R.string.edit_name_hint)
            setText(item.callee)
        }
        val noteField = EditText(this).apply {
            hint = getString(R.string.edit_note_hint)
            setText(item.note)
        }
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            addView(nameField)
            addView(noteField)
        }
        AlertDialog.Builder(this)
            .setTitle(R.string.edit_recording)
            .setView(container)
            .setPositiveButton(android.R.string.ok) { _, _ ->
                viewModel.updateMeta(item, nameField.text.toString(), noteField.text.toString())
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun shareRecording(item: RecordingEntity) {
        val file = File(item.filePath)
        if (!file.exists()) {
            Toast.makeText(this, R.string.file_missing, Toast.LENGTH_SHORT).show()
            return
        }
        val uri = FileProvider.getUriForFile(this, "$packageName.fileprovider", file)
        val title = file.nameWithoutExtension // "<name> <date time>"
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "audio/mp4"
            putExtra(Intent.EXTRA_STREAM, uri)
            putExtra(Intent.EXTRA_TITLE, title)   // shown in the share sheet
            putExtra(Intent.EXTRA_SUBJECT, title) // email/subject fallback
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        startActivity(Intent.createChooser(send, getString(R.string.share_recording)))
    }

    // ---- playback ----------------------------------------------------------

    private fun togglePlayback(item: RecordingEntity) {
        if (playingId == item.id) { stopPlayback(); return }
        stopPlayback()

        val file = File(item.filePath)
        if (!file.exists()) {
            Toast.makeText(this, R.string.file_missing, Toast.LENGTH_SHORT).show()
            return
        }
        try {
            val mp = MediaPlayer().apply {
                setDataSource(file.absolutePath)
                setOnCompletionListener { stopPlayback() }
                setOnErrorListener { _, _, _ -> stopPlayback(); true }
                prepare()
                start()
            }
            player = mp
            playingId = item.id
            adapter.setPlaying(item.id)
            attachVisualizer(mp.audioSessionId)
            binding.playerPanel.visibility = View.VISIBLE
            binding.nowPlaying.text = item.callee ?: getString(R.string.unknown_caller)
            binding.seek.max = mp.duration.coerceAtLeast(0)
            startProgressUpdates()
        } catch (t: Throwable) {
            Log.e(TAG, "playback failed", t)
            stopPlayback()
            Toast.makeText(this, R.string.playback_failed, Toast.LENGTH_SHORT).show()
        }
    }

    private fun startProgressUpdates() {
        progressJob?.cancel()
        progressJob = lifecycleScope.launch {
            while (isActive) {
                val p = player ?: break
                val pos = runCatching { p.currentPosition }.getOrDefault(0)
                val dur = runCatching { p.duration }.getOrDefault(0)
                binding.seek.progress = pos
                binding.time.text = getString(R.string.time_progress, fmt(pos), fmt(dur))
                binding.levelBar.push(level)
                delay(90)
            }
        }
    }

    private fun attachVisualizer(sessionId: Int) {
        runCatching {
            val range = Visualizer.getCaptureSizeRange()
            visualizer = Visualizer(sessionId).apply {
                captureSize = 512.coerceIn(range[0], range[1])
                setDataCaptureListener(
                    object : Visualizer.OnDataCaptureListener {
                        override fun onWaveFormDataCapture(v: Visualizer, waveform: ByteArray, rate: Int) {
                            var sum = 0.0
                            for (b in waveform) {
                                val dev = (b.toInt() and 0xFF) - 128
                                sum += (dev * dev).toDouble()
                            }
                            val rms = sqrt(sum / waveform.size)
                            level = ((rms / 128.0) * 2.0).toFloat().coerceIn(0f, 1f)
                        }
                        override fun onFftDataCapture(v: Visualizer, fft: ByteArray, rate: Int) {}
                    },
                    Visualizer.getMaxCaptureRate() / 2, true, false,
                )
                enabled = true
            }
        }.onFailure { Log.d(TAG, "visualizer unavailable: ${it.message}") }
    }

    private fun stopPlayback() {
        progressJob?.cancel(); progressJob = null
        level = 0f
        binding.levelBar.clear()
        visualizer?.let { runCatching { it.enabled = false }; runCatching { it.release() } }
        visualizer = null
        player?.let { runCatching { it.stop() }; it.release() }
        player = null
        playingId = null
        adapter.setPlaying(null)
        binding.playerPanel.visibility = View.GONE
    }

    // ---- misc --------------------------------------------------------------

    private fun requestRuntimePermissions() {
        val needed = buildList {
            add(Manifest.permission.RECORD_AUDIO)
            add(Manifest.permission.READ_PHONE_STATE)
            add(Manifest.permission.READ_CALL_LOG)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        permissions.launch(needed.toTypedArray())
    }

    override fun onStop() {
        super.onStop()
        stopPlayback()
    }

    private fun fmt(ms: Int): String {
        val s = (ms / 1000).coerceAtLeast(0)
        return "%d:%02d".format(s / 60, s % 60)
    }

    private companion object { const val TAG = "MainActivity" }
}
