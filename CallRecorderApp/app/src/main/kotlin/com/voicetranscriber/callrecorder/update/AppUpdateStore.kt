package com.voicetranscriber.callrecorder.update

import android.content.Context
import android.content.SharedPreferences
import com.voicetranscriber.callrecorder.platform.PlatformApi.AppUpdate
import java.io.File

/**
 * The one downloaded-and-verified APK waiting to be installed, if any.
 *
 * Only ever ONE: a fleet update is a straight line, so a newer build simply
 * replaces whatever was pending. [markReady] deletes every other file in the
 * directory, which is what keeps a phone from accumulating a folder of dead
 * APKs it will never install.
 */
object AppUpdateStore {

    private const val PREFS = "aura_app_update"
    private const val DIR = "updates"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * Internal storage, not external: the APK is handed straight to
     * PackageInstaller as a stream, so nothing outside this app ever needs to
     * read it - and a file no other app can reach cannot be swapped between the
     * digest check and the install.
     */
    fun dir(context: Context): File = File(context.filesDir, DIR).apply { mkdirs() }

    fun fileFor(context: Context, versionCode: Int): File =
        File(dir(context), "aura-$versionCode.apk")

    /** versionCode of the pending build, or -1 when nothing is waiting. */
    fun pendingVersionCode(context: Context): Int = prefs(context).getInt("version_code", -1)

    fun pendingVersionName(context: Context): String? =
        prefs(context).getString("version_name", null)

    fun pendingNotes(context: Context): String? = prefs(context).getString("notes", null)

    /**
     * The pending APK, but only when the recorded build is genuinely newer than
     * what is installed AND the file is still on disk.
     *
     * Both halves are load-bearing. After a successful self-update the pending
     * row still names the build we are now RUNNING, and offering to install the
     * version you are already on is an update prompt that can never be
     * satisfied - Android refuses an equal versionCode. The file check covers
     * the phone having reclaimed the storage underneath us.
     */
    fun readyFile(context: Context): File? {
        val pending = pendingVersionCode(context)
        if (pending <= AppVersion.current(context)) return null
        return fileFor(context, pending).takeIf { it.isFile && it.length() > 0 }
    }

    fun markReady(context: Context, update: AppUpdate) {
        prefs(context).edit()
            .putInt("version_code", update.versionCode)
            .putString("version_name", update.versionName)
            .putString("notes", update.notes)
            .apply()
        // Everything that is not the build we just verified is dead weight - a
        // superseded download, or a `.part` from a transfer that never finished.
        val keep = fileFor(context, update.versionCode).name
        dir(context).listFiles()?.forEach { if (it.name != keep) it.delete() }
    }

    /**
     * Forget the pending build and delete its bytes. Called once the installed
     * version has caught up, so a phone is not carrying an APK of itself.
     */
    fun clear(context: Context) {
        prefs(context).edit().clear().apply()
        dir(context).listFiles()?.forEach { it.delete() }
    }
}
