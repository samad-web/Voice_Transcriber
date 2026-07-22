package com.voicetranscriber.callrecorder

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import com.google.android.material.color.DynamicColors
import com.voicetranscriber.callrecorder.ingest.OemIngestWorker
import com.voicetranscriber.callrecorder.platform.ConfigRefreshWorker
import com.voicetranscriber.callrecorder.platform.HealthWorker
import com.voicetranscriber.callrecorder.storage.RecordingDatabase
import com.voicetranscriber.callrecorder.util.ThemeManager

class App : Application() {

    val database: RecordingDatabase by lazy { RecordingDatabase.get(this) }

    override fun onCreate() {
        super.onCreate()
        instance = this
        // Material You: theme the app from the device wallpaper on Android 12+.
        DynamicColors.applyToActivitiesIfAvailable(this)
        // Apply the saved Light/Dark/System preference.
        ThemeManager.apply(this)
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(
                CHANNEL_RECORDING,
                getString(R.string.channel_recording),
                // LOW keeps it quiet but the recording notification stays visible —
                // an always-on indicator is intentional (transparency, and required for
                // a microphone foreground service).
                NotificationManager.IMPORTANCE_LOW,
            ),
        )

        // Periodic platform sync. Both workers no-op internally until the device is
        // activated, and KEEP means these are idempotent across app restarts.
        // - HealthWorker (~6h): reports device telemetry + drains call-detection events.
        // - ConfigRefreshWorker (~1h): pulls remote config so logout/wipe/policy changes
        //   reach the device without a manual refresh.
        HealthWorker.schedule(this)
        ConfigRefreshWorker.schedule(this)
        // - OemIngestWorker (~15m): imports the OEM dialer's own (both-ends) call recordings.
        //   Safety net for anything missed while the app was killed; the per-call trigger in
        //   PhoneStateReceiver handles the responsive path.
        OemIngestWorker.schedule(this)
    }

    companion object {
        const val CHANNEL_RECORDING = "recording"
        lateinit var instance: App
            private set
    }
}
