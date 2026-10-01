package com.voicetranscriber.callrecorder.alerts

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.voicetranscriber.callrecorder.R

/**
 * Phone alerts in the shade and over the lock screen, on two channels:
 *  - `alerts_popup` (HIGH): new leads and managers' messages. Its notification
 *    carries a full-screen intent, so the system opens [AlertActivity] over
 *    the lock screen and turns the display on. One notification stands for
 *    every unanswered popup - ten leads at once are one screen listing ten,
 *    not ten screens.
 *  - `alerts` (HIGH): tasks, follow-ups, missed call-backs. Heads-up, then the
 *    shade; tapping one opens the same screen with just that alert.
 *
 * CATEGORY_MESSAGE, not ALARM: the phone's own Do Not Disturb still decides.
 * A lead from a night-time ad must not ring a telecaller awake at 2 am the way
 * an alarm-category notification would.
 */
object AlertNotifications {

    const val CHANNEL_POPUP = "alerts_popup"
    const val CHANNEL_NOTIFY = "alerts"

    private const val ID_POPUP = 6100
    private const val ID_NOTIFY_BASE = 6200

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_POPUP, context.getString(R.string.alert_channel_popup), NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = context.getString(R.string.alert_channel_popup_desc)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_NOTIFY, context.getString(R.string.alert_channel_notify), NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = context.getString(R.string.alert_channel_notify_desc) },
        )
    }

    /** Notifications allowed at all, and neither of our channels switched off. */
    fun canPost(context: Context): Boolean {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        val nm = context.getSystemService(NotificationManager::class.java)
        return listOf(CHANNEL_POPUP, CHANNEL_NOTIFY).all {
            (nm.getNotificationChannel(it)?.importance ?: NotificationManager.IMPORTANCE_DEFAULT) !=
                NotificationManager.IMPORTANCE_NONE
        }
    }

    /**
     * Put [fresh] in front of the person. False when this phone will not show
     * a notification at all - the caller must then NOT report them delivered,
     * or the console would say a message arrived that nobody could see.
     */
    fun show(context: Context, fresh: List<HandsetAlert>): Boolean {
        if (!canPost(context)) return false
        fresh.filter { !it.popup }.forEach { postNotify(context, it) }
        if (fresh.any { it.popup }) refreshPopup(context)
        return true
    }

    /** Re-post (or clear) the one notification that stands for every unanswered popup. */
    fun refreshPopup(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        val popups = AlertStore.popups(context)
        if (popups.isEmpty()) {
            nm.cancel(ID_POPUP)
            return
        }
        val latest = popups.last()
        val title = if (popups.size == 1) latest.title else context.getString(R.string.alert_popup_many, popups.size)
        val text = if (popups.size == 1) {
            latest.body ?: latest.title
        } else {
            popups.asReversed().take(4).joinToString("\n") { it.body?.let { b -> "${it.title}: $b" } ?: it.title }
        }
        val screen = PendingIntent.getActivity(
            context, 81,
            Intent(context, AlertActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(context, CHANNEL_POPUP)
            .setSmallIcon(R.drawable.ic_alert)
            .setContentTitle(title)
            .setContentText(text.lineSequence().first())
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setFullScreenIntent(screen, true)
            .setContentIntent(screen)
            .setAutoCancel(false)
            .addAction(0, context.getString(R.string.alert_got_it), gotIt(context, null))
            .build()
        nm.notify(ID_POPUP, n)
    }

    private fun postNotify(context: Context, alert: HandsetAlert) {
        val open = PendingIntent.getActivity(
            context, notifyId(alert.id),
            Intent(context, AlertActivity::class.java)
                .putExtra(AlertActivity.EXTRA_ID, alert.id)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(context, CHANNEL_NOTIFY)
            .setSmallIcon(R.drawable.ic_alert)
            .setContentTitle(alert.title)
            .setContentText(alert.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(alert.body ?: alert.title))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(open)
            .addAction(0, context.getString(R.string.alert_got_it), gotIt(context, alert.id))
            .build()
        context.getSystemService(NotificationManager::class.java).notify(notifyId(alert.id), n)
    }

    /** "Got it" on a notification. [id] null = every unanswered popup. */
    private fun gotIt(context: Context, id: String?): PendingIntent =
        PendingIntent.getBroadcast(
            context, if (id == null) 82 else notifyId(id) + 1000,
            Intent(context, AlertActionReceiver::class.java)
                .setAction(AlertActionReceiver.GOT_IT)
                .apply { if (id != null) putExtra(AlertActivity.EXTRA_ID, id) },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    fun notifyId(id: String): Int = ID_NOTIFY_BASE + (id.hashCode() and 0x3FF)

    fun cancel(context: Context, id: String) =
        context.getSystemService(NotificationManager::class.java).cancel(notifyId(id))
}
