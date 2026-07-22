package com.voicetranscriber.callrecorder.platform

import android.content.Context
import android.os.BatteryManager
import android.os.PowerManager
import android.os.StatFs
import com.voicetranscriber.callrecorder.App
import com.voicetranscriber.callrecorder.service.AccessibilityStatus
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.Instant

/**
 * Gathers real device telemetry and reports it to /v1/devices/me/health, then
 * drains any queued call-detection events to /v1/devices/me/events. Acquires a
 * short-lived device JWT (challenge → Keystore-sign → authenticate) per run.
 *
 * Throws on network/auth failure so the caller ([HealthWorker]) can retry.
 */
object HealthReporter {

    suspend fun report(context: Context) = withContext(Dispatchers.IO) {
        // Only activated devices talk to the platform.
        val deviceId = ActivationStore.deviceId(context) ?: return@withContext
        val baseUrl = ActivationStore.apiBaseUrl(context)

        // challenge → Keystore-sign → authenticate (same as the upload worker).
        val nonce = PlatformApi.challenge(baseUrl, deviceId)
        val jwt = PlatformApi.authenticate(baseUrl, deviceId, nonce, DeviceIdentity.signNonce(nonce))

        val dao = App.instance.database.recordingDao()
        val lastUploadMillis = dao.lastUploadedAtMillis()

        PlatformApi.reportHealth(
            baseUrl = baseUrl,
            accessToken = jwt,
            batteryLevel = batteryLevel(context),
            accessibilityEnabled = AccessibilityStatus.isEnabled(context),
            batteryOptExempt = isBatteryOptExempt(context),
            pendingUploads = dao.countPendingUploads(),
            freeStorageMb = freeStorageMb(context),
            lastUploadAtIso = lastUploadMillis?.let { Instant.ofEpochMilli(it).toString() },
        )

        // Best-effort: drain queued events; put them back if the send fails.
        val events = EventLog.takeAll(context)
        if (events.isNotEmpty()) {
            try {
                PlatformApi.reportEvents(baseUrl, jwt, events)
            } catch (t: Throwable) {
                EventLog.restore(context, events)
                throw t
            }
        }
    }

    /** 0..100, or -1 if unknown. */
    private fun batteryLevel(context: Context): Int {
        val bm = context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        return bm?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
    }

    private fun isBatteryOptExempt(context: Context): Boolean {
        val pm = context.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
        return pm.isIgnoringBatteryOptimizations(context.packageName)
    }

    private fun freeStorageMb(context: Context): Long {
        val path = (context.getExternalFilesDir(null) ?: context.filesDir).absolutePath
        val stat = StatFs(path)
        return stat.availableBytes / (1024L * 1024L)
    }
}
