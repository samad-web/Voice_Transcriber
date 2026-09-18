package com.voicetranscriber.callrecorder.update

import android.Manifest
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.voicetranscriber.callrecorder.App
import com.voicetranscriber.callrecorder.R

/**
 * A notification saying a new build is ready, whose tap goes straight to the
 * installer.
 *
 * The FALLBACK, not the normal path: on Android 12+ [AutoInstaller] installs
 * without asking. This appears only where that cannot happen - older Android,
 * a phone whose installer insists on a confirmation, or a build that has waited
 * a day for a safe moment to install.
 */
object UpdateNotification {

    private const val ID = 4201

    fun show(context: Context, versionName: String, notes: String?) {
        // POST_NOTIFICATIONS is runtime-granted on Android 13+, and a phone that
        // denied it would throw here rather than merely stay quiet. The update
        // is still downloaded and still installable from the settings sheet -
        // the notification is the convenient path, not the only one.
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }

        val tap = PendingIntent.getActivity(
            context,
            0,
            Intent(context, UpdateInstallActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(context, App.CHANNEL_UPDATES)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .setContentTitle(context.getString(R.string.update_ready_title, versionName))
            .setContentText(notes ?: context.getString(R.string.update_ready_body))
            .setStyle(
                NotificationCompat.BigTextStyle()
                    .bigText(notes ?: context.getString(R.string.update_ready_body)),
            )
            .setContentIntent(tap)
            // Not auto-cancelled: the tap opens a system confirmation the user
            // can still back out of, and a notification that vanished on the
            // first tap would leave them with no way back to it.
            .setAutoCancel(false)
            .setOngoing(false)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()

        context.getSystemService(NotificationManager::class.java).notify(ID, notification)
    }

    fun dismiss(context: Context) {
        context.getSystemService(NotificationManager::class.java).cancel(ID)
    }
}
