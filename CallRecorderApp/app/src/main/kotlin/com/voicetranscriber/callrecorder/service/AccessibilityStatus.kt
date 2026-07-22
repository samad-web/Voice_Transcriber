package com.voicetranscriber.callrecorder.service

import android.content.ComponentName
import android.content.Context
import android.provider.Settings

/** Whether our [CallAccessibilityService] is currently enabled in system settings. */
object AccessibilityStatus {
    fun isEnabled(context: Context): Boolean {
        val expected = ComponentName(context, CallAccessibilityService::class.java).flattenToString()
        val enabled = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES,
        ) ?: return false
        return enabled.split(':').any { it.equals(expected, ignoreCase = true) }
    }
}
