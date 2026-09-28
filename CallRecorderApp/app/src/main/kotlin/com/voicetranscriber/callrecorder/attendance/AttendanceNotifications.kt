package com.voicetranscriber.callrecorder.attendance

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.voicetranscriber.callrecorder.R
import com.voicetranscriber.callrecorder.ui.LockActivity

/**
 * Every attendance notification, and its three channels:
 *  - `attendance_shift` (LOW): the ongoing "On shift · next break 1:00 pm" of the service.
 *  - `attendance_prompt` (HIGH): the presence check, full-screen over the lock screen.
 *  - `attendance_reminder` (HIGH): the §6.2 reminders, the away notice, decisions.
 */
object AttendanceNotifications {

    const val CHANNEL_SHIFT = "attendance_shift"
    const val CHANNEL_PROMPT = "attendance_prompt"
    const val CHANNEL_REMINDER = "attendance_reminder"

    const val ID_SHIFT = 5301
    private const val ID_PROMPT = 5302
    private const val ID_REMINDER = 5303
    private const val ID_AWAY = 5304
    private const val ID_NOTICE = 5305
    private const val ID_ARM_FALLBACK = 5306
    private const val ID_DECISION_BASE = 5400

    fun createChannels(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_SHIFT, context.getString(R.string.att_channel_shift), NotificationManager.IMPORTANCE_LOW,
            ).apply { description = context.getString(R.string.att_channel_shift_desc) },
        )
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_PROMPT, context.getString(R.string.att_channel_prompt), NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = context.getString(R.string.att_channel_prompt_desc)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            },
        )
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_REMINDER, context.getString(R.string.att_channel_reminder),
                NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = context.getString(R.string.att_channel_reminder_desc) },
        )
    }

    private fun canPost(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED ||
            android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU

    private fun nm(context: Context) = context.getSystemService(NotificationManager::class.java)

    /** Opens the Attendance screen through the launcher gate (app lock is respected). */
    fun openScreen(context: Context, requestCode: Int = 1): PendingIntent =
        PendingIntent.getActivity(
            context, requestCode,
            Intent(context, LockActivity::class.java)
                .putExtra(LockActivity.EXTRA_OPEN, LockActivity.OPEN_ATTENDANCE)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun action(context: Context, action: String, requestCode: Int, reason: String? = null): PendingIntent =
        PendingIntent.getBroadcast(
            context, requestCode,
            Intent(context, AttendanceActionReceiver::class.java).setAction(action).apply {
                if (reason != null) putExtra(AttendanceActionReceiver.EXTRA_REASON, reason)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    // ── The service's ongoing notification ──

    fun shift(context: Context, ui: AttendanceController.Ui): Notification {
        val b = NotificationCompat.Builder(context, CHANNEL_SHIFT)
            .setSmallIcon(R.drawable.ic_schedule)
            .setContentTitle(ui.title)
            .setContentText(ui.detail)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setContentIntent(openScreen(context))
        when (ui.state) {
            HandsetState.OFF_SHIFT -> if (ui.canStart) {
                b.addAction(0, context.getString(R.string.att_start_shift), action(context, AttendanceActionReceiver.START_SHIFT, 11))
            }
            HandsetState.BREAK_DUE -> b.addAction(
                0, context.getString(R.string.att_start_break), action(context, AttendanceActionReceiver.START_BREAK, 12),
            )
            HandsetState.ON_BREAK, HandsetState.AWAY, HandsetState.TECHNICAL -> b.addAction(
                0, context.getString(R.string.att_back_to_dialling), action(context, AttendanceActionReceiver.BACK, 13),
            )
            else -> Unit
        }
        return b.build()
    }

    fun updateShift(context: Context, ui: AttendanceController.Ui) {
        if (!canPost(context)) return
        nm(context).notify(ID_SHIFT, shift(context, ui))
    }

    fun cancelShift(context: Context) = nm(context).cancel(ID_SHIFT)

    // ── The presence prompt (doc 33 §3.4) ──

    /**
     * One notification serves both paths: with the full-screen permission the
     * system launches [PresenceCheckActivity] over the lock screen; without it
     * (Android 14 revokes it by default for many apps) the same notification
     * shows heads-up with the three answers as action buttons.
     */
    fun showPrompt(context: Context) {
        if (!canPost(context)) {
            // No notification permission: try the activity directly (works while the app is in front).
            runCatching {
                context.startActivity(
                    Intent(context, PresenceCheckActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
            return
        }
        val full = PendingIntent.getActivity(
            context, 21,
            Intent(context, PresenceCheckActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(context, CHANNEL_PROMPT)
            .setSmallIcon(R.drawable.ic_schedule)
            .setContentTitle(context.getString(R.string.att_prompt_title))
            .setContentText(context.getString(R.string.att_prompt_body))
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setFullScreenIntent(full, true)
            .setContentIntent(full)
            .setOngoing(true)
            .setAutoCancel(false)
            .addAction(0, context.getString(R.string.att_answer_here), action(context, AttendanceActionReceiver.ANSWER_HERE, 22))
            .addAction(
                0, context.getString(R.string.att_answer_technical_short),
                action(context, AttendanceActionReceiver.ANSWER_TECHNICAL, 23),
            )
            .addAction(0, context.getString(R.string.att_answer_break_short), action(context, AttendanceActionReceiver.ANSWER_BREAK, 24))
            .build()
        nm(context).notify(ID_PROMPT, n)
    }

    fun closePrompt(context: Context) = nm(context).cancel(ID_PROMPT)

    // ── Away ──

    fun showAway(context: Context) {
        if (!canPost(context)) return
        val n = NotificationCompat.Builder(context, CHANNEL_REMINDER)
            .setSmallIcon(R.drawable.ic_schedule)
            .setContentTitle(context.getString(R.string.att_away_title))
            .setContentText(context.getString(R.string.att_away_body))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(action(context, AttendanceActionReceiver.BACK, 31))
            .addAction(0, context.getString(R.string.att_im_back), action(context, AttendanceActionReceiver.BACK, 32))
            .build()
        nm(context).notify(ID_AWAY, n)
    }

    fun clearAway(context: Context) = nm(context).cancel(ID_AWAY)

    // ── Reminders (doc 33 §6.2) ──

    fun remind(context: Context, text: String, quiet: Boolean, action: PresenceEngine.ReminderAction) {
        if (!canPost(context)) return
        val b = NotificationCompat.Builder(context, CHANNEL_REMINDER)
            .setSmallIcon(R.drawable.ic_schedule)
            .setContentTitle(context.getString(R.string.att_reminder_title))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(openScreen(context, 41))
            // Never interrupt a call: during one the reminder lands silently in the shade.
            .setSilent(quiet)
            .setPriority(if (quiet) NotificationCompat.PRIORITY_LOW else NotificationCompat.PRIORITY_HIGH)
        when (action) {
            PresenceEngine.ReminderAction.START_SHIFT -> b.addAction(
                0, context.getString(R.string.att_start_shift), action(context, AttendanceActionReceiver.START_SHIFT, 42),
            )
            PresenceEngine.ReminderAction.START_BREAK -> b.addAction(
                0, context.getString(R.string.att_start_break), action(context, AttendanceActionReceiver.START_BREAK, 43),
            )
            PresenceEngine.ReminderAction.BACK -> b.addAction(
                0, context.getString(R.string.att_back_to_dialling), action(context, AttendanceActionReceiver.BACK, 44),
            )
            PresenceEngine.ReminderAction.NONE -> Unit
        }
        nm(context).notify(ID_REMINDER, b.build())
    }

    fun cancelReminder(context: Context) = nm(context).cancel(ID_REMINDER)

    // ── Notice, arming fallback, decisions ──

    fun showNoticeNeeded(context: Context) {
        if (!canPost(context)) return
        val n = NotificationCompat.Builder(context, CHANNEL_REMINDER)
            .setSmallIcon(R.drawable.ic_schedule)
            .setContentTitle(context.getString(R.string.att_notice_notif_title))
            .setContentText(context.getString(R.string.att_notice_notif_body))
            .setAutoCancel(true)
            .setContentIntent(openScreen(context, 51))
            .build()
        nm(context).notify(ID_NOTICE, n)
    }

    fun cancelNotice(context: Context) = nm(context).cancel(ID_NOTICE)

    /** Shown when Android refused to start the shift service from the background alarm. */
    fun showStartFallback(context: Context, text: String) {
        if (!canPost(context)) return
        val n = NotificationCompat.Builder(context, CHANNEL_REMINDER)
            .setSmallIcon(R.drawable.ic_schedule)
            .setContentTitle(context.getString(R.string.att_reminder_title))
            .setContentText(text)
            .setAutoCancel(true)
            .setContentIntent(openScreen(context, 61))
            .build()
        nm(context).notify(ID_ARM_FALLBACK, n)
    }

    fun decision(context: Context, requestId: String, text: String) {
        if (!canPost(context)) return
        val n = NotificationCompat.Builder(context, CHANNEL_REMINDER)
            .setSmallIcon(R.drawable.ic_schedule)
            .setContentTitle(context.getString(R.string.att_decision_title))
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setAutoCancel(true)
            .setContentIntent(openScreen(context, 71))
            .build()
        nm(context).notify(ID_DECISION_BASE + (requestId.hashCode() and 0x3F), n)
    }

    /** Everything attendance puts in the shade, for when attendance is switched off. */
    fun cancelAll(context: Context) {
        val nm = nm(context)
        listOf(ID_SHIFT, ID_PROMPT, ID_REMINDER, ID_AWAY, ID_NOTICE, ID_ARM_FALLBACK).forEach(nm::cancel)
    }
}
