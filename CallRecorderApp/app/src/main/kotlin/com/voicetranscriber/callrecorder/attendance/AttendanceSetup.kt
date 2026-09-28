package com.voicetranscriber.callrecorder.attendance

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat

/**
 * The guided setup (doc 33 §10): what this phone still has to allow for
 * attendance to work all shift, and the settings page for each.
 *
 * The battery exemption is the one that matters most: without it Samsung's
 * "sleeping apps" kills the shift service mid-shift, and the server files the
 * gap as "phone or app restarted" (rule 8) every single day.
 */
object AttendanceSetup {

    enum class Step { NOTIFICATIONS, BATTERY, FULL_SCREEN, EXACT_ALARM }

    fun missing(context: Context): List<Step> = buildList {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            add(Step.NOTIFICATIONS)
        }
        val pm = context.getSystemService(PowerManager::class.java)
        if (pm != null && !pm.isIgnoringBatteryOptimizations(context.packageName)) add(Step.BATTERY)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val nm = context.getSystemService(NotificationManager::class.java)
            if (nm != null && !nm.canUseFullScreenIntent()) add(Step.FULL_SCREEN)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val am = context.getSystemService(AlarmManager::class.java)
            if (am != null && !am.canScheduleExactAlarms()) add(Step.EXACT_ALARM)
        }
    }

    /** The settings screen that grants [step], or null for the runtime permission prompt (NOTIFICATIONS). */
    fun intentFor(context: Context, step: Step): Intent? {
        val pkg = Uri.parse("package:${context.packageName}")
        return when (step) {
            Step.NOTIFICATIONS -> null
            // Needs REQUEST_IGNORE_BATTERY_OPTIMIZATIONS; shows the system's own yes/no dialog.
            Step.BATTERY -> Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkg)
            Step.FULL_SCREEN -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, pkg)
            } else {
                null
            }
            Step.EXACT_ALARM -> if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, pkg)
            } else {
                null
            }
        }
    }

    /** A fallback when a phone's settings app does not handle the specific page. */
    fun appDetails(context: Context): Intent =
        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))
}
