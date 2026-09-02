package com.voicetranscriber.callrecorder.update

import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.voicetranscriber.callrecorder.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Installs the APK [AppUpdateManager] already downloaded and verified. Invisible
 * - it has no layout and finishes itself; the only thing the user sees is
 * Android's own "Update app?" confirmation.
 *
 * WHY AN ACTIVITY AND NOT A RECEIVER. `PackageInstaller` answers a commit with
 * `STATUS_PENDING_USER_ACTION` and an Intent that must be launched to show that
 * confirmation. Launching an activity from a background component is blocked on
 * Android 10+, so a BroadcastReceiver would commit successfully and then be
 * unable to show anything - a tap that appears to do nothing. Running the commit
 * from a visible activity means the app holds foreground status at the moment
 * the confirmation needs to appear.
 *
 * The session's own status callback therefore targets THIS activity
 * (`singleTop` + [onNewIntent]) rather than a receiver.
 */
class UpdateInstallActivity : AppCompatActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Re-entry from the PackageInstaller status callback, not a fresh tap.
        if (intent?.action == ACTION_STATUS) {
            handleStatus(intent)
            return
        }

        val apk = AppUpdateStore.readyFile(this)
        if (apk == null) {
            // The pending build was installed, superseded, or its file is gone.
            // Nothing to apologise for - just clear the stale notification.
            UpdateNotification.dismiss(this)
            finish()
            return
        }

        // "Install unknown apps" is a per-app grant the user must give once,
        // and without it commit() throws. Sending them to the exact settings
        // page is the difference between a one-tap fix and a support call.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !packageManager.canRequestPackageInstalls()
        ) {
            Toast.makeText(this, R.string.update_needs_install_permission, Toast.LENGTH_LONG).show()
            startActivity(
                Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:$packageName"),
                ),
            )
            finish()
            return
        }

        lifecycleScope.launch { commit(apk) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.action == ACTION_STATUS) handleStatus(intent)
    }

    /**
     * Streams the APK into a PackageInstaller session and commits it. The commit
     * does not install anything by itself - it asks the system to, and the
     * answer arrives back here as [ACTION_STATUS].
     */
    private suspend fun commit(apk: File) {
        try {
            val installer = packageManager.packageInstaller
            val params = PackageInstaller.SessionParams(
                PackageInstaller.SessionParams.MODE_FULL_INSTALL,
            )
            params.setAppPackageName(packageName)

            val sessionId = withContext(Dispatchers.IO) {
                val id = installer.createSession(params)
                installer.openSession(id).use { session ->
                    session.openWrite(SESSION_NAME, 0, apk.length()).use { output ->
                        apk.inputStream().use { it.copyTo(output) }
                        // fsync before close: the session is committed from the
                        // bytes the installer can actually see on disk, and a
                        // buffered tail would fail verification as a corrupt APK.
                        session.fsync(output)
                    }
                }
                id
            }

            val callback = PendingIntent.getActivity(
                this,
                sessionId,
                Intent(this, UpdateInstallActivity::class.java)
                    .setAction(ACTION_STATUS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
                // MUTABLE is required, not a relaxation: PackageInstaller fills
                // EXTRA_STATUS and EXTRA_INTENT into this intent, and an
                // immutable one would arrive back empty.
                PendingIntent.FLAG_UPDATE_CURRENT or mutabilityFlag(),
            )
            withContext(Dispatchers.IO) {
                installer.openSession(sessionId).use { it.commit(callback.intentSender) }
            }
        } catch (t: Throwable) {
            Log.w(TAG, "install session failed", t)
            Toast.makeText(this, R.string.update_install_failed, Toast.LENGTH_LONG).show()
            finish()
        }
    }

    private fun handleStatus(intent: Intent) {
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, Int.MIN_VALUE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                // The system's own "Update app?" dialog. We are foreground, so
                // this launch is permitted - see the class comment.
                val confirm = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                }
                if (confirm != null) {
                    startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                } else {
                    Toast.makeText(this, R.string.update_install_failed, Toast.LENGTH_LONG).show()
                }
                // Not finish(): the confirmation is a separate task, and this
                // activity must stay alive to receive the outcome below.
            }

            PackageInstaller.STATUS_SUCCESS -> {
                // Usually never reached - a successful self-update replaces this
                // very process, so the app is killed before the callback lands.
                // Handled anyway, because "usually" is not "never" and a leftover
                // notification pointing at a build you are already running is
                // exactly the kind of thing that erodes trust in the prompt.
                UpdateNotification.dismiss(this)
                AppUpdateStore.clear(this)
                finish()
            }

            else -> {
                val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)
                Log.w(TAG, "install status $status: $message")
                // Includes the user simply declining (STATUS_FAILURE_ABORTED).
                // The APK stays on disk and the notification stays up, so
                // "not now" means later, not never.
                if (status != PackageInstaller.STATUS_FAILURE_ABORTED) {
                    Toast.makeText(this, R.string.update_install_failed, Toast.LENGTH_LONG).show()
                }
                finish()
            }
        }
    }

    private fun mutabilityFlag(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0

    companion object {
        private const val TAG = "UpdateInstall"
        private const val ACTION_STATUS = "com.voicetranscriber.callrecorder.INSTALL_STATUS"
        private const val SESSION_NAME = "aura-update"
    }
}
