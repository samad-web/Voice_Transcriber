package com.voicetranscriber.callrecorder.ui

import android.Manifest
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.util.TypedValue
import android.view.View
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.voicetranscriber.callrecorder.R
import com.voicetranscriber.callrecorder.databinding.ActivityRecordingsScannerBinding
import com.voicetranscriber.callrecorder.databinding.ItemScanRowBinding
import com.voicetranscriber.callrecorder.ingest.OemRecordingIngestor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Finds where THIS handset's own dialer stores its call recordings, and proves we can read
 * them — the prerequisite for the OEM-ingestion path.
 *
 * Why this exists: Samsung ("Auto record calls"), MIUI, Realme etc. record BOTH ends via the
 * system dialer tapping the modem stream, which a normal app can never do. Rather than fight
 * that, we ingest their output. But the folder and filename format differ by OEM and OS
 * version, so we probe instead of hardcoding a guess.
 *
 * Three phases, since any one can come up empty on a given build:
 *  1. Known OEM folders        — needs All-files access (API 30+).
 *  2. Bounded storage sweep    — catches layouts we don't know about.
 *  3. MediaStore audio query   — needs READ_MEDIA_AUDIO; finds files wherever they live and
 *     reports their real path.
 *
 * The whole scan runs off the main thread and reports progress per phase: once All-files
 * access is granted the sweep can see thousands of directories, and doing that inline froze
 * the activity.
 */
class RecordingsScannerActivity : AppCompatActivity() {

    private lateinit var binding: ActivityRecordingsScannerBinding
    private var lastReport: String = ""
    private var scanJob: Job? = null

    private val mediaPermLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { runScan() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityRecordingsScannerBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.toolbar.setNavigationOnClickListener { finish() }
        binding.btnGrantAllFiles.setOnClickListener { requestAllFilesAccess() }
        binding.btnGrantMedia.setOnClickListener { requestMediaPermission() }
        binding.btnRescan.setOnClickListener { runScan() }
        binding.btnCopy.setOnClickListener { copyReport() }
        binding.btnImport.setOnClickListener { importNow() }
    }

    /**
     * Import the found recordings into the app's database so the normal upload → ASR → LLM
     * pipeline picks them up. Runs inline (not via WorkManager) so the count can be reported
     * back immediately; the scheduled worker handles the automatic path.
     */
    private fun importNow() {
        binding.btnImport.isEnabled = false
        binding.btnImport.setText(R.string.scanner_importing)
        lifecycleScope.launch {
            val count = withContext(Dispatchers.IO) {
                runCatching { OemRecordingIngestor.ingest(applicationContext) }.getOrDefault(0)
            }
            binding.btnImport.isEnabled = true
            binding.btnImport.setText(R.string.scanner_import)
            Toast.makeText(
                this@RecordingsScannerActivity,
                if (count > 0) getString(R.string.scanner_imported, count) else getString(R.string.scanner_imported_none),
                Toast.LENGTH_LONG,
            ).show()
        }
    }

    /** Re-scan on resume so returning from the All-files settings screen refreshes the verdict. */
    override fun onResume() {
        super.onResume()
        runScan()
    }

    // ---- permissions -------------------------------------------------------

    private fun hasAllFilesAccess(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && Environment.isExternalStorageManager()

    private fun mediaPermission(): String =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            Manifest.permission.READ_MEDIA_AUDIO
        } else {
            Manifest.permission.READ_EXTERNAL_STORAGE
        }

    private fun hasMediaPermission(): Boolean =
        ContextCompat.checkSelfPermission(this, mediaPermission()) == PackageManager.PERMISSION_GRANTED

    private fun requestAllFilesAccess() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            requestMediaPermission()
            return
        }
        // Per-app screen is the right target; fall back to the global list if the OEM
        // doesn't implement the per-app intent.
        runCatching {
            startActivity(
                Intent(
                    Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:$packageName"),
                ),
            )
        }.onFailure {
            runCatching { startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION)) }
                .onFailure {
                    Toast.makeText(
                        this,
                        "Open Settings > Apps > this app > All files access",
                        Toast.LENGTH_LONG,
                    ).show()
                }
        }
    }

    private fun requestMediaPermission() = mediaPermLauncher.launch(arrayOf(mediaPermission()))

    // ---- scan orchestration ------------------------------------------------

    private data class Progress(
        val phase: String,
        val detail: String,
        val percent: Int,
        val found: Int,
    )

    /**
     * Runs the scan on [Dispatchers.IO] and streams progress back to the UI. Any in-flight
     * scan is cancelled first, so bouncing in and out of the settings screen can't stack them.
     */
    private fun runScan() {
        scanJob?.cancel()
        showScanning(true)
        scanJob = lifecycleScope.launch {
            val result = withContext(Dispatchers.IO) {
                scan { p -> withContext(Dispatchers.Main) { renderProgress(p) } }
            }
            lastReport = result.report
            showScanning(false)
            renderPermissions()
            renderHero(result)
            renderLocations(result)
            renderFiles(result)
        }
    }

    private fun showScanning(active: Boolean) {
        binding.progress.visibility = if (active) View.VISIBLE else View.GONE
        binding.btnRescan.isEnabled = !active
        if (active) {
            binding.progress.progress = 0
            binding.heroStatus.setText(R.string.scanner_scanning)
            binding.heroPath.setText(R.string.scanner_scanning_hint)
            binding.statFilesValue.text = "0"
            binding.statFormatValue.text = "—"
            binding.statLatestValue.text = "—"
        }
    }

    private fun renderProgress(p: Progress) {
        binding.progress.setProgressCompat(p.percent.coerceIn(0, 100), true)
        binding.heroStatus.text = p.phase
        binding.heroPath.text = p.detail
        binding.statFilesValue.text = p.found.toString()
    }

    // ---- rendering ---------------------------------------------------------

    private fun renderPermissions() {
        val granted = themeColor(com.google.android.material.R.attr.colorPrimary)
        val missing = themeColor(com.google.android.material.R.attr.colorError)

        val allFiles = hasAllFilesAccess()
        binding.permAllFilesStatus.setText(
            if (allFiles) R.string.scanner_granted else R.string.scanner_not_granted,
        )
        binding.permAllFilesIcon.setColorFilter(if (allFiles) granted else missing)
        binding.btnGrantAllFiles.visibility = if (allFiles) View.GONE else View.VISIBLE

        val media = hasMediaPermission()
        binding.permMediaStatus.setText(
            if (media) R.string.scanner_granted else R.string.scanner_not_granted,
        )
        binding.permMediaIcon.setColorFilter(if (media) granted else missing)
        binding.btnGrantMedia.visibility = if (media) View.GONE else View.VISIBLE
    }

    private fun renderHero(result: ScanResult) {
        val files = result.callFiles
        if (files.isEmpty()) {
            binding.heroStatus.setText(R.string.scanner_none)
            // Distinguish "recording is off" from "this device can never be ingested from",
            // so a Google-Dialer handset doesn't look like a scanner failure.
            binding.heroPath.setText(
                if (usesGoogleDialer()) R.string.scanner_none_hint_google else R.string.scanner_none_hint,
            )
            binding.statFilesValue.text = "0"
            binding.statFormatValue.text = "—"
            binding.statLatestValue.text = "—"
            return
        }
        binding.heroStatus.setText(R.string.scanner_found)
        // The folder holding the most recordings is the one worth ingesting from.
        binding.heroPath.text = files.groupingBy { it.parent }.eachCount()
            .maxByOrNull { it.value }?.key ?: "—"
        binding.statFilesValue.text = files.size.toString()
        binding.statFormatValue.text = files.groupingBy { ".${it.extension}" }.eachCount()
            .maxByOrNull { it.value }?.key ?: "—"
        binding.statLatestValue.text = shortStamp(files.first().modified)
    }

    private fun renderLocations(result: ScanResult) {
        val container = binding.locationsContainer
        container.removeAllViews()
        if (result.locations.isEmpty()) {
            container.addView(emptyRow())
            return
        }
        result.locations.forEach { loc ->
            val row = ItemScanRowBinding.inflate(layoutInflater, container, false)
            row.rowTitle.text = loc.path.substringAfterLast('/').ifEmpty { loc.path }
            row.rowSubtitle.text = loc.path
            row.rowBadge.text = if (loc.count < 0) "locked" else loc.count.toString()
            container.addView(row.root)
        }
    }

    private fun renderFiles(result: ScanResult) {
        val container = binding.filesContainer
        container.removeAllViews()
        if (result.callFiles.isEmpty()) {
            container.addView(emptyRow())
            return
        }
        result.callFiles.take(12).forEach { f ->
            val row = ItemScanRowBinding.inflate(layoutInflater, container, false)
            row.rowTitle.text = f.name
            row.rowSubtitle.text = stamp(f.modified)
            row.rowBadge.text = "${f.sizeBytes / 1024}KB"
            container.addView(row.root)
        }
    }

    private fun emptyRow() = ItemScanRowBinding.inflate(layoutInflater).apply {
        rowTitle.setText(R.string.scanner_empty_row)
        rowSubtitle.visibility = View.GONE
        rowBadge.visibility = View.GONE
    }.root

    // ---- the probes --------------------------------------------------------

    private data class Found(
        val name: String,
        val path: String,
        val parent: String,
        val extension: String,
        val sizeBytes: Long,
        val modified: Long,
    )

    private data class Location(val path: String, val count: Int)

    private data class ScanResult(
        val locations: List<Location>,
        val callFiles: List<Found>,
        val report: String,
    )

    private suspend fun scan(onProgress: suspend (Progress) -> Unit): ScanResult {
        val root = Environment.getExternalStorageDirectory()
        val found = linkedMapOf<String, Found>() // keyed by absolute path → dedupes phases
        val locations = linkedMapOf<String, Int>()

        // Phase 1 — known OEM folders (0–40%).
        val known = CANDIDATE_DIRS.map { File(root, it) }
        known.forEachIndexed { i, dir ->
            onProgress(
                Progress(
                    phase = getString(R.string.scanner_phase_known),
                    detail = "/${CANDIDATE_DIRS[i]}",
                    percent = (i + 1) * 40 / known.size,
                    found = found.size,
                ),
            )
            ingestDir(dir, found, locations)
        }

        // Phase 2 — bounded sweep for layouts we don't know (40–80%).
        val swept = sweepForCallDirs(root) { visited, current ->
            onProgress(
                Progress(
                    phase = getString(R.string.scanner_phase_sweep),
                    detail = getString(R.string.scanner_sweep_detail, visited, current),
                    percent = 40 + (visited * 40 / MAX_DIRS_VISITED).coerceAtMost(39),
                    found = found.size,
                ),
            )
        }
        swept.filter { it.absolutePath !in locations }
            .forEach { ingestDir(it, found, locations) }

        // Phase 3 — MediaStore sees indexed audio regardless of folder (80–100%).
        onProgress(
            Progress(getString(R.string.scanner_phase_media), "", 85, found.size),
        )
        queryMediaStore().forEach { f ->
            found.putIfAbsent(f.path, f)
            locations.putIfAbsent(f.parent, MEDIASTORE_ONLY)
        }
        onProgress(Progress(getString(R.string.scanner_phase_media), "", 100, found.size))

        val callFiles = found.values.sortedByDescending { it.modified }
        val locs = locations
            .filter { it.value != 0 || callFiles.any { f -> f.parent == it.key } }
            .map {
                Location(
                    it.key,
                    if (it.value == MEDIASTORE_ONLY) callFiles.count { f -> f.parent == it.key } else it.value,
                )
            }
            .sortedByDescending { it.count }

        return ScanResult(locs, callFiles, buildReport(locs, callFiles))
    }

    private fun ingestDir(
        dir: File,
        found: MutableMap<String, Found>,
        locations: MutableMap<String, Int>,
    ) {
        if (!dir.exists()) return
        val kids = dir.listFiles()
        if (kids == null) {
            locations[dir.absolutePath] = UNREADABLE
            return
        }
        val audio = kids.filter { it.isFile && it.extension.lowercase(Locale.US) in AUDIO_EXTS }
        locations[dir.absolutePath] = audio.size
        audio.forEach { f ->
            if (!isCallRecording(f.absolutePath, f.name)) return@forEach
            found[f.absolutePath] = Found(
                name = f.name,
                path = f.absolutePath,
                parent = f.parent ?: "",
                extension = f.extension.lowercase(Locale.US),
                sizeBytes = f.length(),
                modified = f.lastModified(),
            )
        }
    }

    /**
     * Hunt for folders not in [CANDIDATE_DIRS]. Bounded three ways — depth, a visited-dir
     * cap, and a wall-clock budget — because with All-files access this would otherwise walk
     * the entire external storage tree. Bulk media trees are skipped outright: they hold
     * thousands of directories and never contain call recordings.
     */
    private suspend fun sweepForCallDirs(
        root: File,
        onTick: suspend (visited: Int, current: String) -> Unit,
    ): List<File> {
        val hits = mutableListOf<File>()
        val deadline = System.currentTimeMillis() + SWEEP_BUDGET_MS
        var visited = 0

        suspend fun walk(dir: File, depth: Int) {
            if (depth > 3 || hits.size >= 30 || visited >= MAX_DIRS_VISITED) return
            if (System.currentTimeMillis() > deadline) return
            val kids = dir.listFiles() ?: return
            for (child in kids) {
                if (!child.isDirectory || child.name.startsWith(".")) continue
                val name = child.name.lowercase(Locale.US)
                if (name in SWEEP_SKIP_DIRS) continue
                visited++
                if (visited % 15 == 0) onTick(visited, child.name)
                if (name.contains("call") || name.contains("record")) hits += child
                walk(child, depth + 1)
            }
        }

        runCatching { walk(root, 0) }
        return hits
    }

    private fun queryMediaStore(): List<Found> {
        val projection = mutableListOf(
            MediaStore.Audio.Media.DISPLAY_NAME,
            MediaStore.Audio.Media.SIZE,
            MediaStore.Audio.Media.DATE_MODIFIED,
            MediaStore.Audio.Media.DATA,
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) projection += RELATIVE_PATH

        return runCatching {
            val out = mutableListOf<Found>()
            contentResolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                projection.toTypedArray(),
                null,
                null,
                "${MediaStore.Audio.Media.DATE_MODIFIED} DESC",
            )?.use { c ->
                val nameIdx = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
                val sizeIdx = c.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE)
                val dateIdx = c.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_MODIFIED)
                val dataIdx = c.getColumnIndex(MediaStore.Audio.Media.DATA)
                val relIdx = c.getColumnIndex(RELATIVE_PATH)
                while (c.moveToNext()) {
                    val name = c.getString(nameIdx) ?: continue
                    val path = dataIdx.takeIf { it >= 0 }?.let { c.getString(it) }
                        ?: relIdx.takeIf { it >= 0 }?.let { c.getString(it) }
                        ?: continue
                    if (!isCallRecording(path, name)) continue
                    out += Found(
                        name = name,
                        path = path,
                        parent = path.substringBeforeLast('/', ""),
                        extension = name.substringAfterLast('.', "").lowercase(Locale.US),
                        sizeBytes = c.getLong(sizeIdx),
                        modified = c.getLong(dateIdx) * 1000,
                    )
                }
            }
            out
        }.getOrDefault(emptyList())
    }

    /**
     * A call recording, not a voice memo. Samsung names them
     * "Call recording <callee>_<yyMMdd>_<HHmmss>.m4a"; other OEMs differ, so we also accept
     * anything living in a call-ish folder — but never the Voice Recorder folder.
     */
    private fun isCallRecording(path: String, name: String): Boolean {
        val p = path.lowercase(Locale.US)
        val n = name.lowercase(Locale.US)
        if (p.contains("voice recorder") || p.contains("voice_recorder")) return false
        if (name.substringAfterLast('.', "").lowercase(Locale.US) !in AUDIO_EXTS) return false
        return n.startsWith("call recording") ||
            n.startsWith("call_") ||
            p.contains("/call/") ||
            p.contains("/recordings/call") ||
            p.contains("call_rec")
    }

    // ---- misc --------------------------------------------------------------

    private fun buildReport(locations: List<Location>, files: List<Found>): String = buildString {
        appendLine("DEVICE  : ${Build.MANUFACTURER} ${Build.MODEL}")
        appendLine("ANDROID : ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
        appendLine("All-files access  : ${if (hasAllFilesAccess()) "GRANTED" else "NOT granted"}")
        appendLine("Audio/storage perm: ${if (hasMediaPermission()) "GRANTED" else "NOT granted"}")
        appendLine()
        appendLine("--- LOCATIONS ---")
        if (locations.isEmpty()) appendLine("none")
        locations.forEach {
            appendLine("${it.path}  ${if (it.count < 0) "UNREADABLE" else "${it.count} audio"}")
        }
        appendLine()
        appendLine("--- CALL RECORDINGS (${files.size}) ---")
        files.take(20).forEach {
            appendLine("${it.sizeBytes / 1024}KB  ${stamp(it.modified)}  ${it.name}")
            appendLine("    ${it.path}")
        }
    }

    /**
     * Is the Google Phone app the default dialer? If so, its recordings live in private app
     * storage that Android 11+ blocks, so an empty scan is expected rather than a fault.
     */
    private fun usesGoogleDialer(): Boolean = runCatching {
        val pkg = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            getSystemService(android.telecom.TelecomManager::class.java)?.defaultDialerPackage
        } else {
            null
        }
        pkg == "com.google.android.dialer" ||
            packageManager.getLaunchIntentForPackage("com.google.android.dialer") != null
    }.getOrDefault(false)

    private fun themeColor(attr: Int): Int = TypedValue().also {
        theme.resolveAttribute(attr, it, true)
    }.data

    private fun stamp(ms: Long): String =
        SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.US).format(Date(ms))

    private fun shortStamp(ms: Long): String =
        SimpleDateFormat("dd MMM", Locale.US).format(Date(ms))

    private fun copyReport() {
        getSystemService(ClipboardManager::class.java)
            .setPrimaryClip(ClipData.newPlainText("oem-recording-scan", lastReport))
        Toast.makeText(this, R.string.scanner_copied, Toast.LENGTH_SHORT).show()
    }

    private companion object {
        // MediaStore.MediaColumns.RELATIVE_PATH is API 29+; the literal works on every level.
        const val RELATIVE_PATH = "relative_path"

        /** Sentinels for the location->count map. */
        const val UNREADABLE = -1
        const val MEDIASTORE_ONLY = -2

        /** Sweep bounds — keep the walk from touching the whole filesystem. */
        const val MAX_DIRS_VISITED = 400
        const val SWEEP_BUDGET_MS = 2_500L

        val AUDIO_EXTS = setOf("m4a", "3ga", "amr", "awb", "mp3", "wav", "aac", "ogg", "opus")

        /** Bulk media/app trees: thousands of dirs, never call recordings. */
        val SWEEP_SKIP_DIRS = setOf(
            "android", "dcim", "pictures", "movies", "download", "downloads",
            "whatsapp", "telegram", "fonts", "obb", "data", "cache",
        )

        /**
         * Known OEM call-recording locations, relative to external storage root.
         *
         * Google Phone (Pixel/Motorola/Nokia) is absent on purpose: it stores recordings in
         * `Android/data/com.google.android.dialer/`, which Android 11+ blocks for all other
         * apps — All-files access and SAF both refuse it, and they aren't in MediaStore. A
         * scan on those handsets legitimately finds nothing.
         */
        val CANDIDATE_DIRS = listOf(
            "Recordings/Call",                  // Samsung One UI (current) — confirmed on SM-M136B
            "Call",                             // Samsung (legacy)
            "Sounds",                           // Samsung (older still)
            "Recordings",
            "MIUI/sound_recorder/call_rec",     // Xiaomi / Redmi / POCO
            "Recordings/CallRecord",            // Xiaomi HyperOS
            "Record/Call",                      // Vivo, OnePlus, some Oppo
            "Recordings/Call Recordings",       // Realme / Oppo ColorOS
            "Music/Recordings/Call Recordings", // Oppo (older ColorOS)
            "CallRecordings",
            "PhoneRecord",
            "Music/Recordings",
        )
    }
}
