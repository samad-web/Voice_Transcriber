package com.voicetranscriber.callrecorder.update

import android.app.Activity
import android.app.Application
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.annotation.RequiresApi
import com.voicetranscriber.callrecorder.service.RecordingService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Installs a downloaded, verified update with nobody tapping anything.
 *
 * Installing KILLS this process, at once and with no callback. So the question
 * is never just "is there an update" but "can the app die right now without
 * anyone losing something", and [blocker] is where that is answered. Calls
 * come first: a telecaller's recording cut off mid-call is gone for good, while
 * an update that waits half an hour costs nothing.
 *
 * Where an unattended install is impossible - Android 11 and older, or a phone
 * whose installer refuses one - the tap-to-install notification from before is
 * the fallback, so no phone ends up worse off than it was.
 */
object AutoInstaller {

    private const val TAG = "AutoInstaller"

    /**
     * How long a ready build may keep being deferred before the notification is
     * shown as well. A blocker that never clears (an app holding the audio mode
     * in "communication" forever) would otherwise leave a phone silently stuck
     * on an old build; after this the holder can at least tap to install.
     */
    private val ASK_AFTER_MS = TimeUnit.HOURS.toMillis(24)

    private val startedActivities = AtomicInteger(0)

    /**
     * Counts this app's visible activities. Registered once in App.onCreate.
     * Kept here rather than asking ActivityManager for our importance, because
     * a running worker or the recording foreground service also raise that -
     * only a started Activity means a person is looking at the app.
     */
    val activityTracker = object : Application.ActivityLifecycleCallbacks {
        override fun onActivityStarted(activity: Activity) {
            startedActivities.incrementAndGet()
        }

        override fun onActivityStopped(activity: Activity) {
            startedActivities.decrementAndGet()
        }

        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
        override fun onActivityResumed(activity: Activity) = Unit
        override fun onActivityPaused(activity: Activity) = Unit
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
        override fun onActivityDestroyed(activity: Activity) = Unit
    }

    /** Why the app must not be replaced right now, or null when it may be. */
    fun blocker(context: Context): String? {
        if (RecordingService.isRecording) return "a call is being recorded"
        // Any mode but NORMAL means ringing, a cellular call, or a VoIP call -
        // including calls this app is not recording. Needs no permission, unlike
        // TelephonyManager's call state on Android 12+.
        val audio = context.getSystemService(AudioManager::class.java)
        if (audio != null && audio.mode != AudioManager.MODE_NORMAL) return "a call is in progress"
        if (startedActivities.get() > 0) return "the app is open"
        return null
    }

    /**
     * Installs the pending build if there is one and now is safe; otherwise
     * schedules another attempt or falls back to asking. Never throws.
     */
    suspend fun installReady(context: Context) {
        val apk = AppUpdateStore.readyFile(context) ?: return
        val name = AppUpdateStore.pendingVersionName(context) ?: ""
        val notes = AppUpdateStore.pendingNotes(context)

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            // Before Android 12 an ordinary app cannot update itself unattended
            // at all - only a device-owner app can. Ask, as before.
            UpdateNotification.show(context, name, notes)
            return
        }

        val blocker = blocker(context)
        if (blocker != null) {
            Log.i(TAG, "v$name install deferred: $blocker")
            val since = AppUpdateStore.readySince(context)
            if (since > 0 && System.currentTimeMillis() - since >= ASK_AFTER_MS) {
                UpdateNotification.show(context, name, notes)
            }
            // Last: this replaces the unique retry, which may be the worker
            // running this very call.
            AppUpdateWorker.retryInstallLater(context)
            return
        }

        try {
            withContext(Dispatchers.IO) {
                val sessionId = UpdateSession.write(context, apk)
                UpdateSession.commit(context, sessionId, statusSender(context, sessionId))
            }
            // If the install goes through, this process is killed within
            // seconds. Anything else comes back through UpdateReceiver.
            Log.i(TAG, "v$name committed for unattended install")
        } catch (t: Throwable) {
            Log.w(TAG, "unattended install could not start", t)
            UpdateNotification.show(context, name, notes)
        }
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private fun statusSender(context: Context, sessionId: Int) =
        PendingIntent.getBroadcast(
            context,
            sessionId,
            Intent(context, UpdateReceiver::class.java).setAction(UpdateReceiver.ACTION_STATUS),
            // MUTABLE is required: PackageInstaller fills EXTRA_STATUS into this
            // intent, and an immutable one would arrive back empty.
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
        ).intentSender
}
