package com.voicetranscriber.callrecorder.platform

import android.content.Context
import java.util.Calendar

/**
 * The telecaller using this handset. Stored locally so the app can greet them by
 * name ("Good morning, Priya") and label their recordings/uploads with who made
 * the call. Backed by SharedPreferences — set once from the profile dialog.
 */
class TelecallerProfile(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    var name: String?
        get() = prefs.getString(KEY_NAME, null)?.trim()?.ifBlank { null }
        set(value) = prefs.edit().putString(KEY_NAME, value?.trim()?.ifBlank { null }).apply()

    val hasName: Boolean get() = !name.isNullOrBlank()

    companion object {
        private const val PREFS = "telecaller_profile"
        private const val KEY_NAME = "name"

        /** Time-of-day greeting: morning / afternoon / evening. */
        fun greetingHour(hour: Int): Greeting = when (hour) {
            in 5..11 -> Greeting.MORNING
            in 12..16 -> Greeting.AFTERNOON
            else -> Greeting.EVENING
        }

        fun currentGreeting(): Greeting =
            greetingHour(Calendar.getInstance().get(Calendar.HOUR_OF_DAY))
    }

    enum class Greeting { MORNING, AFTERNOON, EVENING }
}
