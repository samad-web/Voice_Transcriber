package com.voicetranscriber.callrecorder.util

import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Human-readable recording file names: "<caller name> <yyyy-MM-dd HH-mm-ss>.m4a".
 * The on-disk name IS what gets shared (FileProvider exposes the real file name), so
 * naming the file readably means the shared file is readable too.
 */
object RecordingNaming {
    // Characters not allowed in file names on Android/Windows/most share targets.
    private val ILLEGAL = Regex("[\\\\/:*?\"<>|\\n\\r\\t]")

    fun baseName(name: String?, startedAt: Long): String {
        val safe = (name ?: "Call").replace(ILLEGAL, " ").trim().ifEmpty { "Call" }.take(40)
        val stamp = SimpleDateFormat("yyyy-MM-dd HH-mm-ss", Locale.US).format(Date(startedAt))
        return "$safe $stamp"
    }

    /**
     * Rename [path] to the readable "<name> <date time>.m4a" form (same directory),
     * de-duplicating with " (n)" if needed. Returns the new path, or the old one on failure.
     */
    fun renameToReadable(path: String, name: String?, startedAt: Long): String {
        val old = File(path)
        if (!old.exists()) return path
        val dir = old.parentFile ?: return path
        val base = baseName(name, startedAt)
        var target = File(dir, "$base.m4a")
        var i = 1
        while (target.exists() && target.absolutePath != old.absolutePath) {
            target = File(dir, "$base ($i).m4a"); i++
        }
        return when {
            target.absolutePath == old.absolutePath -> path // already correctly named
            old.renameTo(target) -> target.absolutePath
            else -> path
        }
    }
}
