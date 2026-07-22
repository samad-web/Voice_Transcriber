package com.voicetranscriber.callrecorder.platform

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Orchestrates the activation gate (the product requirement): the admin
 * generates an instance ID + one-time admin key in the web app; this enrolls
 * the device against them. Until enrollment succeeds AND the server config
 * says recordingEnabled, no capture path may start.
 */
object ActivationManager {

    suspend fun enroll(
        context: Context,
        apiBaseUrl: String,
        instanceId: String,
        adminKey: String,
    ): String = withContext(Dispatchers.IO) {
        DeviceIdentity.ensureKeyPair()
        val enrollment = PlatformApi.register(
            baseUrl = apiBaseUrl.trimEnd('/'),
            instanceId = instanceId.trim(),
            enrollmentToken = adminKey.trim(),
            publicKeyPem = DeviceIdentity.publicKeyPem(),
        )
        ActivationStore.saveEnrollment(
            context, apiBaseUrl.trimEnd('/'), instanceId.trim(),
            enrollment.deviceId, enrollment.refreshToken,
        )
        refreshConfig(context)
        "Activated as device ${enrollment.deviceId.take(8)}…"
    }

    /**
     * Nonce → Keystore signature → 15-min JWT → config. Sets recordingEnabled
     * from the server's answer; on auth failure (revoked/wiped device) the
     * gate closes locally too.
     */
    suspend fun refreshConfig(context: Context): String = withContext(Dispatchers.IO) {
        val baseUrl = ActivationStore.apiBaseUrl(context)
        val deviceId = ActivationStore.deviceId(context)
            ?: return@withContext "Not activated"
        try {
            val nonce = PlatformApi.challenge(baseUrl, deviceId)
            val token = PlatformApi.authenticate(
                baseUrl, deviceId, nonce, DeviceIdentity.signNonce(nonce),
            )
            val config = PlatformApi.fetchConfig(baseUrl, token)
            ActivationStore.saveConfig(context, config.recordingEnabled, config.version)
            // recordingEnabled is the only capture knob the server config document
            // currently carries, so it fully drives the local gate (isRecordingAllowed).
            // TODO: when the server extends DeviceConfig with capture policy (e.g. a
            // preferred audio source, VoIP on/off, consent-tone requirement), apply
            // those here into CaptureSettings so remote policy also drives *how* we
            // capture, not just whether we do.
            "Config v${config.version}: recording ${if (config.recordingEnabled) "ENABLED" else "DISABLED"}"
        } catch (e: PlatformApi.ApiException) {
            if (e.code == 401) {
                // Remote logout/wipe or revocation — close the gate locally.
                ActivationStore.saveConfig(context, recordingEnabled = false, configVersion = 0)
                "Server rejected device (${e.code}) — recording disabled"
            } else {
                "Config refresh failed: ${e.message}"
            }
        }
    }

    fun deactivate(context: Context) {
        ActivationStore.clear(context)
        DeviceIdentity.wipe()
    }
}
