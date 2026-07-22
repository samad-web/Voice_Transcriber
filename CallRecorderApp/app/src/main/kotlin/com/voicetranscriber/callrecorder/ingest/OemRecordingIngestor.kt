package com.voicetranscriber.callrecorder.ingest

import android.content.Context
import android.os.Build
import android.os.Environment
import android.util.Log
import com.voicetranscriber.callrecorder.App
import com.voicetranscriber.callrecorder.capture.CaptureSettings
import com.voicetranscriber.callrecorder.platform.ActivationStore
import com.voicetranscriber.callrecorder.recordings.SourceRegistry
import com.voicetranscriber.callrecorder.service.CallLogReader
import com.voicetranscriber.callrecorder.storage.RecordingEntity
import com.voicetranscriber.callrecorder.upload.UploadScheduler
import java.io.File
import java.text.SimpleDateFormat
import java.util.Locale

/**
 * Adopts the OEM dialer's own call recordings instead of capturing audio ourselves.
 *
 * Samsung's "Auto record calls" (and the MIUI/Realme equivalents) records BOTH ends, because
 * the system dialer taps the telephony stream directly — something a normal app can never do
 * (that path needs CAPTURE_AUDIO_OUTPUT, a signature|privileged permission). So rather than
 * fight the audio stack, we read the files it produces, parse their metadata, and insert a
 * normal [RecordingEntity]. Everything downstream — upload, ASR, LLM — is unchanged.
 *
 * Verified on Samsung SM-M136B / Android 14:
 *   /storage/emulated/0/Recordings/Call/Call recording <callee>_<yyMMdd>_<HHmmss>.m4a
 * where <callee> is a phone number OR a contact name that may contain spaces and emoji.
 * The embedded timestamp is the call START; the file's mtime is when it was finalized on
 * hang-up, which we use as the end time.
 */
object OemRecordingIngestor {

    private const val TAG = "OemIngestor"

    /** Matches a trailing `_yyMMdd_HHmmss`. Greedy head so a callee may contain `_`. */
    private val STAMPED_NAME = Regex("""^(.*)_(\d{6})_(\d{6})$""")

    /** Samsung's prefix; stripped case-insensitively so other locales still parse. */
    private val CALL_PREFIX = Regex("""^call\s+recording\s+""", RegexOption.IGNORE_CASE)

    private val AUDIO_EXTS = setOf("m4a", "3ga", "amr", "awb", "mp3", "wav", "aac")

    /** Don't touch a file the dialer may still be writing. */
    private const val SETTLE_MS = 10_000L

    /**
     * How far our capture's start may drift from the OEM's and still be the same call. Ours
     * begins at OFFHOOK; the OEM's begins when the call actually connects.
     */
    private const val OVERLAP_TOLERANCE_MS = 120_000L

    /**
     * Scan the configured folders and import anything not already in the database.
     * @return how many new recordings were ingested.
     */
    suspend fun ingest(context: Context): Int {
        val settings = CaptureSettings(context)
        if (!settings.oemIngestEnabled) {
            Log.i(TAG, "skip — OEM ingestion disabled")
            return 0
        }
        // Same gate as capture: an un-enrolled or remotely-disabled device stores nothing.
        if (!ActivationStore.isRecordingAllowed(context)) {
            Log.i(TAG, "skip — device not activated or recording disabled")
            return 0
        }

        val dao = App.instance.database.recordingDao()
        val known = dao.allFilePaths().toHashSet()
        val now = System.currentTimeMillis()
        var ingested = 0

        val files = candidateFiles(context)
        // Proof this handset records calls itself. Set from the FILES, not from a successful
        // insert, so it still latches when everything is already ingested.
        if (files.isNotEmpty()) settings.oemRecordingSeen = true

        for (file in files) {
            if (file.absolutePath in known) continue
            if (now - file.lastModified() < SETTLE_MS) {
                Log.d(TAG, "skip (still settling): ${file.name}")
                continue
            }
            if (file.length() <= 0) continue

            val parsed = parseName(file)
            // The filename has no direction, so enrich from the call log by timestamp. Using
            // the nearest entry (not simply the latest) keeps a backlog import accurate.
            val info = CallLogReader.nearest(context, parsed.startedAt)

            val entity = RecordingEntity(
                filePath = file.absolutePath,
                sourceId = SourceRegistry.telephony().id,
                callee = parsed.callee ?: info?.name ?: info?.number,
                startedAt = parsed.startedAt,
                // The dialer finalizes the file on hang-up. A non-null endedAt is also what
                // makes UploadWorker consider the row ready to send.
                endedAt = file.lastModified(),
                audioSource = "OEM · ${Build.MANUFACTURER}",
                direction = info?.direction,
            )
            runCatching { dao.insert(entity) }
                .onSuccess {
                    ingested++
                    Log.i(TAG, "ingested ${file.name} (callee=${entity.callee}, dir=${entity.direction})")
                }
                .onFailure { Log.w(TAG, "insert failed for ${file.name}", it) }
        }

        // Always sweep — NOT only when something new was ingested. The duplicate we need to
        // clear may sit beside an OEM recording that was imported on an earlier run.
        purgeDuplicateAppCaptures(dao)

        if (ingested > 0) UploadScheduler.enqueue(context)
        return ingested
    }

    /**
     * Remove our own near-end-only captures of calls the OEM also recorded. Even with the
     * sticky flag there's one unavoidable window — the very first call on a fresh handset,
     * before any OEM file exists — so duplicates are cleaned up after the fact rather than
     * left for the user to sort out. Only ever deletes OUR capture, never the OEM file, and
     * never one that has already been uploaded (that send can't be recalled).
     */
    private suspend fun purgeDuplicateAppCaptures(
        dao: com.voicetranscriber.callrecorder.storage.RecordingDao,
    ) {
        runCatching { dao.appCapturesDuplicatingOem(OVERLAP_TOLERANCE_MS) }
            .getOrDefault(emptyList())
            .forEach { dup ->
                runCatching { File(dup.filePath).delete() }
                runCatching { dao.deleteById(dup.id) }
                Log.i(TAG, "dropped duplicate app capture #${dup.id} — OEM recording covers this call")
            }
    }

    /**
     * True when this handset records calls itself — used to decide whether our own
     * (near-end-only) capture should stand down. Deliberately cheap (existence + a name
     * listing, no file stats) because it runs inside a broadcast receiver.
     *
     * Deliberately CONSERVATIVE: standing down when the OEM won't actually record would lose
     * the call entirely, which is worse than a duplicate. So we require proof — either a
     * recording is already present, or we've ingested one before ([CaptureSettings
     * .oemRecordingSeen]). The sticky flag is what stops the fresh-phone case where the
     * folder is still empty during the first call.
     */
    fun isAvailable(context: Context): Boolean {
        if (CaptureSettings(context).oemRecordingSeen) return true
        return folders(context).any { dir ->
            runCatching { dir.isDirectory && (dir.list()?.any { isAudio(it) } == true) }
                .getOrDefault(false)
        }
    }

    /** All call-recording files across the configured folders, newest first. */
    private fun candidateFiles(context: Context): List<File> = folders(context)
        .flatMap { dir -> dir.listFiles()?.asList().orEmpty() }
        .filter { it.isFile && isAudio(it.name) && isCallRecording(it) }
        .sortedByDescending { it.lastModified() }

    private fun folders(context: Context): List<File> {
        val root = Environment.getExternalStorageDirectory()
        return CaptureSettings(context).oemFolders
            .split(',')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .map { File(root, it) }
    }

    private fun isAudio(name: String) =
        name.substringAfterLast('.', "").lowercase(Locale.US) in AUDIO_EXTS

    /** Exclude voice memos, which some OEMs file alongside call recordings. */
    private fun isCallRecording(file: File): Boolean {
        val path = file.absolutePath.lowercase(Locale.US)
        if (path.contains("voice recorder") || path.contains("voice_recorder")) return false
        return true
    }

    private data class Parsed(val callee: String?, val startedAt: Long)

    /**
     * `Call recording <callee>_<yyMMdd>_<HHmmss>.m4a` → callee + start time. Falls back to
     * the file's mtime and bare name if the OEM uses a different convention.
     */
    private fun parseName(file: File): Parsed {
        val base = file.nameWithoutExtension
        val m = STAMPED_NAME.find(base) ?: return Parsed(base.ifEmpty { null }, file.lastModified())
        val callee = m.groupValues[1].replaceFirst(CALL_PREFIX, "").trim().ifEmpty { null }
        val startedAt = runCatching {
            // Two-digit year: SimpleDateFormat pivots around the current century, which is
            // correct for anything the dialer has written.
            SimpleDateFormat("yyMMddHHmmss", Locale.US)
                .parse(m.groupValues[2] + m.groupValues[3])?.time
        }.getOrNull() ?: file.lastModified()
        return Parsed(callee, startedAt)
    }
}
