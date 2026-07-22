package com.voicetranscriber.callrecorder.util

import android.content.Context
import androidx.appcompat.app.AppCompatDelegate

/**
 * Persists the user's Light / Dark / System choice and applies it app-wide.
 * Values are AppCompatDelegate.MODE_NIGHT_* constants; applying recreates active activities.
 */
object ThemeManager {
    private const val PREFS = "theme"
    private const val KEY = "night_mode"

    fun current(context: Context): Int =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .getInt(KEY, AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM)

    /** Apply the saved mode (call from Application.onCreate). */
    fun apply(context: Context) {
        AppCompatDelegate.setDefaultNightMode(current(context))
    }

    /** Persist and apply a new mode. */
    fun set(context: Context, mode: Int) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putInt(KEY, mode).apply()
        AppCompatDelegate.setDefaultNightMode(mode)
    }
}
