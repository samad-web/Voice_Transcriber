package com.voicetranscriber.callrecorder.update

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log

/**
 * The two moments around an unattended install that arrive as broadcasts:
 *
 *  - [ACTION_STATUS]: the outcome of an [AutoInstaller] commit. Success almost
 *    never lands here - the install kills this process first - so what this
 *    really handles is Android declining to install without asking.
 *  - MY_PACKAGE_REPLACED: sent to the NEW build right after any update,
 *    unattended or tapped. It also starts the process, so the app's workers
 *    and push registration come back up without waiting for a call.
 */
class UpdateReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_MY_PACKAGE_REPLACED -> onReplaced(context)
            ACTION_STATUS -> onStatus(context, intent)
        }
    }

    private fun onReplaced(context: Context) {
        Log.i(TAG, "now running v${AppVersion.currentName(context)}")
        // readyFile() is null once the installed build has caught up with the
        // pending one. Drop its bytes and the notification that advertised it
        // now, rather than at the next 6h check.
        if (AppUpdateStore.readyFile(context) == null) {
            AppUpdateStore.clear(context)
            UpdateNotification.dismiss(context)
        }
    }

    private fun onStatus(context: Context, intent: Intent) {
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, Int.MIN_VALUE)) {
            PackageInstaller.STATUS_SUCCESS -> onReplaced(context)

            // What abandoning the session below reports back. Nothing to add.
            PackageInstaller.STATUS_FAILURE_ABORTED -> Unit

            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                // Android wants a confirmation after all: an OEM policy, the
                // silent-update rate limit, or a targetSdk too old for this
                // Android version. A receiver cannot open that dialog (background
                // activity launches are blocked on Android 10+), so drop this
                // session and ask. The tap opens a fresh one from a foreground
                // window, and the next cycle tries unattended again.
                Log.i(TAG, "unattended install declined by the system - asking instead")
                val sessionId = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
                if (sessionId != -1) {
                    runCatching { context.packageManager.packageInstaller.abandonSession(sessionId) }
                }
                askToInstall(context)
            }

            else -> {
                Log.w(
                    TAG,
                    "unattended install failed: status $status " +
                        intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE),
                )
                askToInstall(context)
            }
        }
    }

    private fun askToInstall(context: Context) {
        if (AppUpdateStore.readyFile(context) == null) return
        UpdateNotification.show(
            context,
            AppUpdateStore.pendingVersionName(context) ?: "",
            AppUpdateStore.pendingNotes(context),
        )
    }

    companion object {
        private const val TAG = "UpdateReceiver"
        const val ACTION_STATUS = "com.voicetranscriber.callrecorder.AUTO_INSTALL_STATUS"
    }
}
