package com.voicetranscriber.callrecorder.update

import android.content.Context
import android.util.Log
import com.voicetranscriber.callrecorder.platform.ActivationManager
import com.voicetranscriber.callrecorder.platform.ActivationStore
import com.voicetranscriber.callrecorder.platform.PlatformApi.AppUpdate
import com.voicetranscriber.callrecorder.util.applyNgrokBypass
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest

/**
 * Check → download → verify. Everything up to, but NOT including, the install:
 * handing bytes to the package installer needs a foreground window, so that
 * half lives in [UpdateInstallActivity].
 *
 * The split is deliberate. This side is allowed to run unattended on a worker
 * and can afford to fail quietly; the install side is the only part the person
 * holding the phone ever sees, and it must be driven by their tap.
 */
object AppUpdateManager {

    private const val TAG = "AppUpdate"

    /** What a sync attempt concluded. Distinct cases so the UI can say something true. */
    sealed interface Outcome {
        /** A verified APK is on disk and ready for [UpdateInstallActivity]. */
        data class Ready(val versionName: String, val versionCode: Int, val notes: String?) : Outcome
        /** The server has nothing newer than what is installed. */
        data object UpToDate : Outcome
        /** Not enrolled, or the check/download failed. Recording is unaffected. */
        data class Unavailable(val reason: String) : Outcome
    }

    /**
     * One full cycle. Safe to call from anywhere - it is idempotent, and an APK
     * that is already downloaded and verified is not fetched again.
     */
    suspend fun sync(context: Context): Outcome = withContext(Dispatchers.IO) {
        if (!ActivationStore.isActivated(context)) {
            return@withContext Outcome.Unavailable("device not activated")
        }

        // Housekeeping first: if the installed version has caught up with (or
        // passed) whatever was pending, the stored APK is a copy of ourselves.
        // Dropping it here is what stops a phone quietly holding a few MB of
        // dead weight forever after every successful update.
        val pending = AppUpdateStore.pendingVersionCode(context)
        if (pending in 0..AppVersion.current(context)) AppUpdateStore.clear(context)

        val update = ActivationManager.checkForUpdate(context)
            ?: return@withContext if (AppUpdateStore.readyFile(context) != null) {
                // The check failed (or the channel went quiet) but a verified
                // build is already sitting on disk. Keep offering it rather than
                // throwing away a good download over one bad poll.
                Outcome.Ready(
                    AppUpdateStore.pendingVersionName(context) ?: "",
                    AppUpdateStore.pendingVersionCode(context),
                    AppUpdateStore.pendingNotes(context),
                )
            } else {
                Outcome.UpToDate
            }

        // Already downloaded and verified on an earlier cycle - nothing to do
        // but keep offering it. This is the normal state of a phone whose owner
        // has not tapped the notification yet.
        val existing = AppUpdateStore.readyFile(context)
        if (existing != null && AppUpdateStore.pendingVersionCode(context) == update.versionCode) {
            return@withContext Outcome.Ready(update.versionName, update.versionCode, update.notes)
        }

        return@withContext try {
            download(context, update)
            AppUpdateStore.markReady(context, update)
            Log.i(TAG, "v${update.versionName} (${update.versionCode}) verified and ready")
            Outcome.Ready(update.versionName, update.versionCode, update.notes)
        } catch (t: Throwable) {
            Log.w(TAG, "download failed", t)
            Outcome.Unavailable(t.message ?: "download failed")
        }
    }

    /**
     * Streams the presigned URL to disk, digesting as it goes, and only names
     * the file once the digest matches.
     *
     * The download lands on `.part` and is renamed on success, so a transfer
     * that dies halfway - a dropped connection, a killed process, a flat battery
     * - can never leave a truncated file sitting where [AppUpdateStore.readyFile]
     * would find it and hand it to the installer.
     */
    private fun download(context: Context, update: AppUpdate) {
        val target = AppUpdateStore.fileFor(context, update.versionCode)
        val part = File(target.parentFile, "${target.name}.part")
        part.delete()

        val connection = URL(update.url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "GET"
            connection.connectTimeout = 15_000
            // Generous: a few MB over a weak mobile connection in a customer's
            // office, on a phone that is also uploading call audio.
            connection.readTimeout = 120_000
            connection.applyNgrokBypass()

            val code = connection.responseCode
            if (code !in 200..299) throw IllegalStateException("HTTP $code fetching update")

            val digest = MessageDigest.getInstance("SHA-256")
            connection.inputStream.use { input ->
                part.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read == -1) break
                        digest.update(buffer, 0, read)
                        output.write(buffer, 0, read)
                    }
                }
            }

            // Size before digest: a truncated transfer is the likely failure and
            // its message ("got 1.2 of 3.4 MB") is far more useful than a hash
            // mismatch, which reads like tampering.
            if (part.length() != update.sizeBytes) {
                throw IllegalStateException(
                    "size mismatch: got ${part.length()} bytes, expected ${update.sizeBytes}",
                )
            }
            val actual = digest.digest().joinToString("") { "%02x".format(it) }
            if (!actual.equals(update.sha256, ignoreCase = true)) {
                throw IllegalStateException("sha256 mismatch - refusing to install")
            }

            // Only now does the file get the name anything else looks for.
            if (!part.renameTo(target)) {
                throw IllegalStateException("could not stage ${target.name}")
            }
        } finally {
            // A no-op on success (the rename above already consumed it), and on
            // failure it takes the half-written bytes with it - otherwise the
            // next cycle would find a corrupt prefix sitting under the `.part`
            // name and have to decide what to do with it.
            part.delete()
            connection.disconnect()
        }
    }
}
