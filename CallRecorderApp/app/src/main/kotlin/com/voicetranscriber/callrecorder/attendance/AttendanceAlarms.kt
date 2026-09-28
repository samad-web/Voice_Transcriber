package com.voicetranscriber.callrecorder.attendance

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import android.util.Log

/**
 * Two alarms:
 *  - SHIFT: wall-clock alarm at shift start - 10 min (doc 33 §10 "Arming"). It
 *    starts the shift service, which posts the first reminder.
 *  - TICK: an elapsedRealtime alarm at the engine's next deadline (a silence
 *    threshold, a prompt timeout, a reminder, the next heartbeat), so a phone in
 *    Doze still prompts and heartbeats on time. Elapsed time, not wall time: a
 *    clock change cannot move it.
 *
 * Both are exact-while-idle when SCHEDULE_EXACT_ALARM is granted, and fall back
 * to inexact allow-while-idle when it is not (Android 14 denies it by default;
 * the guided setup asks for it). With the battery-optimisation exemption,
 * allow-while-idle alarms may fire every few seconds even in Doze, which is
 * what makes the 2-minute heartbeat hold on a sleeping phone.
 */
object AttendanceAlarms {

    private const val TAG = "AttendanceAlarms"
    const val ACTION_SHIFT = "com.voicetranscriber.callrecorder.attendance.SHIFT_ALARM"
    const val ACTION_TICK = "com.voicetranscriber.callrecorder.attendance.TICK_ALARM"

    private fun am(context: Context) = context.getSystemService(AlarmManager::class.java)

    fun canExact(context: Context): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am(context)?.canScheduleExactAlarms() == true

    private fun pending(context: Context, action: String, flags: Int): PendingIntent? =
        PendingIntent.getBroadcast(
            context, action.hashCode(),
            Intent(context, AttendanceAlarmReceiver::class.java).setAction(action),
            flags or PendingIntent.FLAG_IMMUTABLE,
        )

    private fun set(context: Context, type: Int, at: Long, action: String) {
        val manager = am(context) ?: return
        val pi = pending(context, action, PendingIntent.FLAG_UPDATE_CURRENT) ?: return
        try {
            if (canExact(context)) {
                manager.setExactAndAllowWhileIdle(type, at, pi)
            } else {
                manager.setAndAllowWhileIdle(type, at, pi)
            }
        } catch (e: SecurityException) {
            // Permission revoked between the check and the call.
            manager.setAndAllowWhileIdle(type, at, pi)
        }
    }

    private fun cancel(context: Context, action: String) {
        val pi = pending(context, action, PendingIntent.FLAG_NO_CREATE) ?: return
        am(context)?.cancel(pi)
        pi.cancel()
    }

    /** [wallAt] is on the trusted timeline; RTC alarms need the raw clock, so convert with [trustedNow]. */
    fun armShift(context: Context, wallAt: Long, trustedNow: Long) {
        val raw = System.currentTimeMillis() + (wallAt - trustedNow)
        Log.i(TAG, "shift alarm armed for ${ShiftSchedule.iso(wallAt)}")
        set(context, AlarmManager.RTC_WAKEUP, raw, ACTION_SHIFT)
    }

    fun cancelShift(context: Context) = cancel(context, ACTION_SHIFT)

    fun scheduleTick(context: Context, elapsedAt: Long) =
        set(context, AlarmManager.ELAPSED_REALTIME_WAKEUP, elapsedAt, ACTION_TICK)

    fun cancelTick(context: Context) = cancel(context, ACTION_TICK)
}

/** Wakes the engine for a deadline, or arms a shift that is about to start. */
class AttendanceAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        val pm = context.getSystemService(PowerManager::class.java)
        val wl = pm?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "aura:attendance-tick")
        runCatching { wl?.acquire(20_000) }
        Thread {
            try {
                when (intent.action) {
                    AttendanceAlarms.ACTION_SHIFT -> {
                        AttendanceController.sync(context)
                        if (ShiftService.startRefused && AttendanceController.ui.value.running) {
                            // Android refused a background start (no exact-alarm or battery
                            // exemption): ask the person to open the app instead.
                            val w = AttendanceController.ui.value.window
                            val zone = AttendanceStore.config(context)?.timeZone ?: "UTC"
                            AttendanceNotifications.showStartFallback(
                                context,
                                w?.let { "Shift starts at ${ShiftSchedule.clock(it.startMs, zone)}. Tap to open." }
                                    ?: "Your shift is starting. Tap to open.",
                            )
                        }
                    }
                    AttendanceAlarms.ACTION_TICK -> AttendanceController.tick(context)
                }
            } catch (t: Throwable) {
                Log.e("AttendanceAlarm", "alarm handling failed", t)
            } finally {
                runCatching { if (wl?.isHeld == true) wl.release() }
                pending.finish()
            }
        }.start()
    }
}

/**
 * Re-arms after a reboot, and when the exact-alarm permission is granted. The
 * existing MY_PACKAGE_REPLACED receiver (UpdateReceiver) covers updates, and
 * App.onCreate covers every other process start.
 */
class AttendanceBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            "android.intent.action.QUICKBOOT_POWERON",
            AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED,
            -> {
                val pending = goAsync()
                Thread {
                    try {
                        AttendanceController.onBootOrRearm(context)
                    } catch (t: Throwable) {
                        Log.e("AttendanceBoot", "re-arm failed", t)
                    } finally {
                        pending.finish()
                    }
                }.start()
            }
        }
    }
}
