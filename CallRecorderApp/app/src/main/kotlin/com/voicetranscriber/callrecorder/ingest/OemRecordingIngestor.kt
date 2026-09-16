package com.voicetranscriber.callrecorder.ingest

import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import com.voicetranscriber.callrecorder.App
import com.voicetranscriber.callrecorder.capture.CaptureSettings
import com.voicetranscriber.callrecorder.platform.ActivationStore
import com.voicetranscriber.callrecorder.platform.EventLog
import com.voicetranscriber.callrecorder.recordings.SourceRegistry
import com.voicetranscriber.callrecorder.service.CallLogReader
import com.voicetranscriber.callrecorder.storage.RecordingEntity
import com.voicetranscriber.callrecorder.upload.UploadScheduler
import java.io.File
import java.text.SimpleDateFormat
import java.time.Instant
import java.util.Locale

/**
 * Adopts the OEM dialer's own call recordings instead of capturing audio ourselves.
 *
 * Samsung's "Auto record calls" (and the MIUI/Realme equivalents) records BOTH ends, because
 * the system dialer taps the telephony stream directly - something a normal app can never do
 * (that path needs CAPTURE_AUDIO_OUTPUT, a signature|privileged permission). So rather than
 * fight the audio stack, we read the files it produces, parse their metadata, and insert a
 * normal [RecordingEntity]. Everything downstream - upload, ASR, LLM - is unchanged.
 *
 * Verified on Samsung SM-M136B / Android 14:
 *   /storage/emulated/0/Recordings/Call/Call recording <callee>_<yyMMdd>_<HHmmss>.m4a
 * where <callee> is a phone number OR a contact name that may contain spaces and emoji.
 * The embedded timestamp is the call START; the file's mtime is when it was finalized on
 * hang-up, which we use as the end time.
 *
 * Verified on Xiaomi 24048RN6CI / Android 16 (HyperOS):
 *   /storage/emulated/0/Recordings/sound_recorder/call_rec/<display>(<number>)_yyyyMMddHHmmss.mp3
 * - a different folder, a fused 14-digit stamp, and the number alongside the display name.
 */
object OemRecordingIngestor {

    private const val TAG = "OemIngestor"

    /** Matches a trailing `_yyMMdd_HHmmss`. Greedy head so a callee may contain `_`. */
    private val STAMPED_NAME = Regex("""^(.*)_(\d{6})_(\d{6})$""")

    /** Transsion (Infinix / Tecno / itel): `yyyyMMdd_HHmmss` with no callee in the name - the
     *  counterparty number is the parent folder (Music/PhoneRecord/<number>/) instead. */
    private val PLAIN_STAMP = Regex("""^(\d{8})_(\d{6})$""")

    /** Xiaomi HyperOS: `<display>_yyyyMMddHHmmss` - one unseparated 14-digit stamp. */
    private val FUSED_STAMP = Regex("""^(.*)_(\d{14})$""")

    /**
     * Xiaomi writes the callee as `<display>(<number>)` - `Ravi Kumar(8754258581)` for a saved
     * contact, `8754258581(8754258581)` for an unknown one.
     */
    private val NAME_WITH_NUMBER = Regex("""^(.*)\((\+?[\d\s-]{3,20})\)$""")

    /** Samsung's prefix; stripped case-insensitively so other locales still parse. */
    private val CALL_PREFIX = Regex("""^call\s+recording\s+""", RegexOption.IGNORE_CASE)

    private val AUDIO_EXTS = setOf("m4a", "3ga", "amr", "awb", "mp3", "wav", "aac")

    /**
     * Folder fragments that identify some OEM's call-recording directory. Used to classify
     * MediaStore rows, which arrive with no indication of what produced them.
     */
    private val CALL_DIR_MARKERS = listOf(
        "/call/", "/calls/", "/call recordings/", "/callrecord", "/call_rec",
        "/phonerecord", "/recordings/call", "/record/call",
    )

    /** Shared-storage folders that hold audio which is definitively NOT a call recording. */
    private val EXCLUDED_DIRS = listOf(
        "voice recorder", "voice_recorder", "voicerecorder", "/whatsapp/", "/telegram/",
        "/download/", "/downloads/", "/ringtones/", "/notifications/", "/alarms/",
        "/podcasts/", "/movies/", "/dcim/", "/audiobooks/",
    )

    /**
     * Cap on MediaStore rows examined per pass. The query is ordered newest-first, so a call
     * recorded today sits near the top; without a cap a media library of tens of thousands of
     * tracks would be walked on every ingest - and [isAvailable] runs from a broadcast
     * receiver on the main thread, where that is an ANR.
     */
    private const val MEDIA_ROW_CAP = 3_000

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
            Log.i(TAG, "skip - OEM ingestion disabled")
            return 0
        }
        // Same gate as capture: an un-enrolled or remotely-disabled device stores nothing.
        if (!ActivationStore.isRecordingAllowed(context)) {
            Log.i(TAG, "skip - device not activated or recording disabled")
            return 0
        }

        val dao = App.instance.database.recordingDao()
        val known = dao.allFilePaths().toHashSet()
        val now = System.currentTimeMillis()
        var ingested = 0
        var skippedByFloor = 0
        var oldestSkippedAt = Long.MAX_VALUE

        // Backlog floor. On the very first ingest, anchor it a few days back so a call made
        // just before this build installed still imports, while a handset that already holds
        // years of history (a Transsion phone can have tens of thousands of files under
        // Music/PhoneRecord) does not dump the entire archive as leads. Never advanced after -
        // the recording DB (`known`) is what stops re-processing what was already sent.
        if (settings.oemIngestSince == 0L) {
            settings.oemIngestSince = now - CaptureSettings.BACKLOG_GRACE_MS
        }
        val since = settings.oemIngestSince

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
            // Historical backlog on a phone that recorded calls long before enrollment - skip.
            // Silent otherwise: counted and reported below so a customer who onboarded with
            // real backlog on the handset (very common - Samsung/Xiaomi's own recorder was
            // already running before this app existed) shows up as "N calls were never sent"
            // instead of a rep just noticing gaps with no explanation anywhere.
            if (parsed.startedAt < since) {
                skippedByFloor++
                if (parsed.startedAt < oldestSkippedAt) oldestSkippedAt = parsed.startedAt
                continue
            }
            // The filename has no direction, so enrich from the call log by timestamp. Using
            // the nearest entry (not simply the latest) keeps a backlog import accurate.
            val info = CallLogReader.nearest(context, parsed.startedAt)

            // Name and number are two different facts, and the old precedence
            // - filename, then log name, then log number - collapsed them into
            // one slot where the first hit won. A contact saved on the handset
            // put its NAME in the filename, so `info.number` was never reached
            // and the call reached the server with no digits at all: the CRM
            // then held a lead nobody could ring back.
            //
            // Take each from the best source it has, and hand them on in
            // Xiaomi's `Name(number)` form, which UploadWorker already splits
            // back into remoteName + remoteNumber.
            val fromFile = parsed.callee?.let { NAME_WITH_NUMBER.find(it) }
            val calleeName = fromFile?.groupValues?.get(1)?.trim()?.ifEmpty { null }
                ?: parsed.callee?.takeIf { s -> s.any { it.isLetter() } }
                ?: info?.name
            val calleeNumber = fromFile?.groupValues?.get(2)?.trim()
                ?: parsed.callee?.takeIf { s -> s.any { it.isDigit() } && s.none { it.isLetter() } }
                ?: info?.number

            val entity = RecordingEntity(
                filePath = file.absolutePath,
                sourceId = SourceRegistry.telephony().id,
                callee = when {
                    calleeName != null && calleeNumber != null -> "$calleeName($calleeNumber)"
                    else -> calleeNumber ?: calleeName
                },
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

        if (skippedByFloor > 0) {
            val oldestIso = Instant.ofEpochMilli(oldestSkippedAt).toString()
            val graceDays = CaptureSettings.BACKLOG_GRACE_MS / (24 * 60 * 60 * 1000)
            Log.w(
                TAG,
                "skipped $skippedByFloor recording(s) older than the $graceDays-day " +
                    "import floor (oldest: $oldestIso) - they will never be uploaded",
            )
            EventLog.record(
                context,
                "oem_backlog_skipped",
                mapOf("count" to skippedByFloor.toString(), "oldestSkippedAt" to oldestIso),
            )
        }

        // Always sweep - NOT only when something new was ingested. The duplicate we need to
        // clear may sit beside an OEM recording that was imported on an earlier run.
        purgeDuplicateAppCaptures(dao)

        if (ingested > 0) UploadScheduler.enqueue(context)
        return ingested
    }

    /**
     * Remove our own near-end-only captures of calls the OEM also recorded. Even with the
     * sticky flag there's one unavoidable window - the very first call on a fresh handset,
     * before any OEM file exists - so duplicates are cleaned up after the fact rather than
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
                Log.i(TAG, "dropped duplicate app capture #${dup.id} - OEM recording covers this call")
            }
    }

    /**
     * True when this handset records calls itself - used to decide whether our own
     * (near-end-only) capture should stand down. Deliberately cheap (existence + a name
     * listing, no file stats) because it runs inside a broadcast receiver.
     *
     * Deliberately CONSERVATIVE: standing down when the OEM won't actually record would lose
     * the call entirely, which is worse than a duplicate. So we require proof - either a
     * recording is already present, or we've ingested one before ([CaptureSettings
     * .oemRecordingSeen]). The sticky flag is what stops the fresh-phone case where the
     * folder is still empty during the first call.
     */
    fun isAvailable(context: Context): Boolean {
        if (CaptureSettings(context).oemRecordingSeen) return true
        val inKnownFolder = folders(context).any { dir ->
            runCatching { dir.isDirectory && (dir.list()?.any { isAudio(it) } == true) }
                .getOrDefault(false)
        }
        // Checked last, and only ever needs one hit: this is the case that matters on a brand
        // whose folder we don't have listed, where the folder walk finds nothing and we would
        // otherwise wrongly conclude the handset doesn't record itself.
        return inKnownFolder || mediaStoreFiles(context, stopAfter = 1).isNotEmpty()
    }

    /**
     * Every call recording this handset holds, newest first, from two independent discoveries
     * unioned by path.
     *
     * The folder list on its own is a standing liability: each OEM files recordings somewhere
     * different, and they move between OS versions - HyperOS relocated Xiaomi's from
     * MIUI/sound_recorder/call_rec to Recordings/sound_recorder/call_rec, and ingestion
     * silently returned nothing until that path was added by hand. MediaStore already knows
     * where the dialer put them on ANY brand, so it covers folders we have never seen and
     * survives the next relocation without a code change.
     *
     * Both are kept because they fail in different places: MediaStore needs READ_MEDIA_AUDIO
     * and lags until the media scanner indexes a new file, while the folder walk reads the
     * disk directly but only where we thought to look.
     */
    private fun candidateFiles(context: Context): List<File> {
        val fromFolders = folders(context)
            .flatMap { dir -> filesUnder(dir) }
            .filter { it.isFile && isAudio(it.name) && isCallRecording(it) }
        return (fromFolders + mediaStoreFiles(context))
            .distinctBy { it.absolutePath }
            .sortedByDescending { it.lastModified() }
    }

    /**
     * Files directly in [dir] plus files one level down. Transsion (Infinix/Tecno/itel) nests
     * each call under a per-number folder - Music/PhoneRecord/<number>/<file> - while Samsung
     * and the rest are flat, where the extra level simply finds nothing. Deliberately one
     * level only: a full walk of external storage would be slow and could pull in unrelated
     * media.
     */
    private fun filesUnder(dir: File): List<File> {
        val direct = dir.listFiles()?.asList().orEmpty()
        val nested = direct
            .filter { it.isDirectory }
            .flatMap { it.listFiles()?.asList().orEmpty() }
        return direct + nested
    }

    private fun folders(context: Context): List<File> {
        val root = Environment.getExternalStorageDirectory()
        return CaptureSettings(context).oemFolders
            .split(',')
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .map { File(root, it) }
    }

    /**
     * Call recordings as MediaStore knows them, wherever on shared storage they live.
     *
     * Returns empty - never throws - when READ_MEDIA_AUDIO hasn't been granted, leaving the
     * folder walk in charge. DATA is deprecated but still populated for shared-storage files,
     * and a real path is what the rest of the pipeline needs: the settle check, size, mtime
     * and upload all work on a File.
     *
     * @param stopAfter return as soon as this many matches are found (existence checks).
     */
    private fun mediaStoreFiles(context: Context, stopAfter: Int = Int.MAX_VALUE): List<File> =
        runCatching {
            val out = mutableListOf<File>()
            context.contentResolver.query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                arrayOf(MediaStore.Audio.Media.DISPLAY_NAME, MediaStore.Audio.Media.DATA),
                null,
                null,
                "${MediaStore.Audio.Media.DATE_MODIFIED} DESC",
            )?.use { cursor ->
                val nameIdx = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME)
                val dataIdx = cursor.getColumnIndex(MediaStore.Audio.Media.DATA)
                if (dataIdx < 0) return@use
                var rows = 0
                while (cursor.moveToNext() && rows++ < MEDIA_ROW_CAP) {
                    val name = cursor.getString(nameIdx) ?: continue
                    val path = cursor.getString(dataIdx) ?: continue
                    if (!isAudio(name) || !looksLikeCallRecording(path, name)) continue
                    val file = File(path)
                    if (!file.isFile) continue
                    out += file
                    if (out.size >= stopAfter) break
                }
            }
            out
        }.getOrElse {
            // A missing permission is the ordinary case on a handset that granted only
            // All-files access, not an error worth surfacing.
            Log.d(TAG, "MediaStore unavailable (${it.javaClass.simpleName}) - folders only")
            emptyList()
        }

    /**
     * Whether a MediaStore row is a call recording.
     *
     * This has to be STRICT. The query returns every indexed audio file on the device, so a
     * loose rule would import the user's music library, WhatsApp voice notes and ringtones as
     * leads - each of which would reach the CRM as a call and be transcribed at cost. A
     * recognised call-recording folder or a dialer naming prefix is required; "it is audio"
     * is never enough.
     */
    private fun looksLikeCallRecording(path: String, name: String): Boolean {
        val p = path.lowercase(Locale.US)
        val n = name.lowercase(Locale.US)
        // App-private storage - including our own captures under Android/data - is not OEM
        // output, and adopting our own file here would double-count the call.
        if (p.contains("/android/data/") || p.contains("/android/obb/")) return false
        if (EXCLUDED_DIRS.any { p.contains(it) }) return false
        return CALL_DIR_MARKERS.any { p.contains(it) } ||
            n.startsWith("call recording") ||
            n.startsWith("call_")
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

        // Samsung and most OEMs: `<callee>_yyMMdd_HHmmss`.
        STAMPED_NAME.find(base)?.let { m ->
            val callee = m.groupValues[1].replaceFirst(CALL_PREFIX, "").trim().ifEmpty { null }
            val startedAt = runCatching {
                // Two-digit year: SimpleDateFormat pivots around the current century, which is
                // correct for anything the dialer has written.
                SimpleDateFormat("yyMMddHHmmss", Locale.US)
                    .parse(m.groupValues[2] + m.groupValues[3])?.time
            }.getOrNull() ?: file.lastModified()
            return Parsed(callee ?: numberFromParent(file), startedAt)
        }

        // Xiaomi HyperOS: `<display>(<number>)_yyyyMMddHHmmss`. The parenthesised number is
        // authoritative; the display collapses to it when the contact isn't saved, in which
        // case there's no point carrying `8754258581(8754258581)` around.
        FUSED_STAMP.find(base)?.let { m ->
            val display = m.groupValues[1].replaceFirst(CALL_PREFIX, "").trim()
            val callee = NAME_WITH_NUMBER.find(display)?.let { d ->
                val name = d.groupValues[1].trim()
                val number = d.groupValues[2].trim()
                if (name.isEmpty() || name == number) number else display
            } ?: display.ifEmpty { null }
            val startedAt = runCatching {
                SimpleDateFormat("yyyyMMddHHmmss", Locale.US).parse(m.groupValues[2])?.time
            }.getOrNull() ?: file.lastModified()
            return Parsed(callee ?: numberFromParent(file), startedAt)
        }

        // Transsion (Infinix/Tecno/itel): `yyyyMMdd_HHmmss`, no callee in the name - the number
        // is the parent folder (Music/PhoneRecord/<number>/).
        PLAIN_STAMP.find(base)?.let { m ->
            val startedAt = runCatching {
                SimpleDateFormat("yyyyMMddHHmmss", Locale.US)
                    .parse(m.groupValues[1] + m.groupValues[2])?.time
            }.getOrNull() ?: file.lastModified()
            return Parsed(numberFromParent(file), startedAt)
        }

        // Unknown convention: parent-folder number if there is one, else the bare name; mtime
        // for timing.
        return Parsed(numberFromParent(file) ?: base.ifEmpty { null }, file.lastModified())
    }

    /**
     * The counterparty number when recordings are nested as `<root>/…/<number>/<file>` - the
     * immediate parent folder name, accepted only when it reads as a phone number so a flat
     * OEM layout (parent = "Call", "PhoneRecord", …) is never mistaken for one.
     */
    private fun numberFromParent(file: File): String? =
        file.parentFile?.name?.trim()?.takeIf { p ->
            p.length in 3..20 && p.all { it.isDigit() || it == '+' }
        }
}
