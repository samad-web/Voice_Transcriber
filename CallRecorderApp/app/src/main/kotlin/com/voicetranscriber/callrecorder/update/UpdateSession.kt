package com.voicetranscriber.callrecorder.update

import android.content.Context
import android.content.IntentSender
import android.content.pm.PackageInstaller
import android.os.Build
import java.io.File

/**
 * The PackageInstaller session both install paths share: [AutoInstaller] on a
 * worker with nobody watching, and [UpdateInstallActivity] behind a tap.
 *
 * WHY THE SESSION ASKS FOR NO CONFIRMATION. On Android 12+ an app may replace
 * ITSELF without the system's "Update app?" dialog, but only when all of these
 * hold - and Android checks them, not us:
 *  - the manifest declares UPDATE_PACKAGES_WITHOUT_USER_ACTION;
 *  - the session sets USER_ACTION_NOT_REQUIRED (below);
 *  - the installer is the app being updated (always true here);
 *  - the NEW APK's targetSdk is recent enough: 29+ on Android 12, 30+ on 13,
 *    31+ on 14, 33+ after that. Letting targetSdk fall behind future Android
 *    releases silently turns this back into a prompt on the newest phones.
 * When any of them fails, the commit answers STATUS_PENDING_USER_ACTION instead
 * of installing, so asking is never skipped where Android requires it.
 */
object UpdateSession {

    private const val NAME = "aura-update"

    /**
     * Creates a session and streams [apk] into it. Installs nothing - that is
     * [commit]. Returns the session id, which callers use as the request code
     * of the PendingIntent that receives the outcome.
     */
    fun write(context: Context, apk: File): Int {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(
            PackageInstaller.SessionParams.MODE_FULL_INSTALL,
        ).apply {
            setAppPackageName(context.packageName)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
            }
        }

        val id = installer.createSession(params)
        try {
            installer.openSession(id).use { session ->
                session.openWrite(NAME, 0, apk.length()).use { output ->
                    apk.inputStream().use { it.copyTo(output) }
                    // fsync before close: the session is committed from the
                    // bytes the installer can actually see on disk, and a
                    // buffered tail would fail verification as a corrupt APK.
                    session.fsync(output)
                }
            }
        } catch (t: Throwable) {
            // A half-written session is not reused by anything, and the system
            // only reaps abandoned ones after days.
            runCatching { installer.abandonSession(id) }
            throw t
        }
        return id
    }

    /** Hands the written session to the system. The outcome arrives at [status]. */
    fun commit(context: Context, sessionId: Int, status: IntentSender) {
        context.packageManager.packageInstaller.openSession(sessionId).use { it.commit(status) }
    }
}
