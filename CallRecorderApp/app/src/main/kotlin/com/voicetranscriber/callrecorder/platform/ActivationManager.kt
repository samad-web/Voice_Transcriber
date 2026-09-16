package com.voicetranscriber.callrecorder.platform

import android.content.Context
import com.voicetranscriber.callrecorder.update.AppVersion
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
        // Register the FCM push token so the server can wake this device,
        // push instant logout/wipe, and trigger config refreshes on demand.
        // Hands off to WorkManager - enrollment must not fail, or appear to
        // fail, because a push token could not be registered.
        FcmTokenManager.syncNow(context)
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
            val token = accessToken(baseUrl, deviceId)
            val config = PlatformApi.fetchConfig(baseUrl, token)
            ActivationStore.saveConfig(
                context, config.recordingEnabled, config.version, config.appLockPasswordHash,
            )
            // recordingEnabled is the only capture knob the server config document
            // currently carries, so it fully drives the local gate (isRecordingAllowed).
            // TODO: when the server extends DeviceConfig with capture policy (e.g. a
            // preferred audio source, VoIP on/off, consent-tone requirement), apply
            // those here into CaptureSettings so remote policy also drives *how* we
            // capture, not just whether we do.
            "Config v${config.version}: recording ${if (config.recordingEnabled) "ENABLED" else "DISABLED"}"
        } catch (e: PlatformApi.ApiException) {
            if (e.code == 401) {
                // Remote logout/wipe or revocation - close the recording gate locally.
                // The app-lock hash is left exactly as last synced: a revoked device
                // should still show its lock screen, not fall open on an auth failure.
                ActivationStore.saveConfig(
                    context,
                    recordingEnabled = false,
                    configVersion = 0,
                    appLockPasswordHash = ActivationStore.appLockPasswordHash(context),
                )
                "Server rejected device (${e.code}) - recording disabled"
            } else {
                "Config refresh failed: ${e.message}"
            }
        }
    }

    /**
     * Nonce → Keystore signature → 15-minute JWT. Device tokens are short-lived
     * by design, so nothing caches one: every caller mints a fresh token for the
     * one request it is about to make.
     *
     * Blocking, and deliberately not `suspend` - callers are already inside a
     * `Dispatchers.IO` block, and making this suspend would only hide that.
     */
    internal fun accessToken(baseUrl: String, deviceId: String): String {
        val nonce = PlatformApi.challenge(baseUrl, deviceId)
        return PlatformApi.authenticate(baseUrl, deviceId, nonce, DeviceIdentity.signNonce(nonce))
    }

    /**
     * Ask the server whether a newer build is published for this fleet.
     *
     * Returns null for "nothing newer" AND for every failure - an unreachable
     * server, a revoked device, a release channel that is empty. Updating is a
     * convenience; it must never be able to report a problem that looks like a
     * recording problem, and the caller ([AppUpdateWorker]) simply tries again
     * on its next cycle.
     */
    suspend fun checkForUpdate(context: Context): PlatformApi.AppUpdate? =
        withContext(Dispatchers.IO) {
            val baseUrl = ActivationStore.apiBaseUrl(context)
            val deviceId = ActivationStore.deviceId(context) ?: return@withContext null
            try {
                PlatformApi.checkUpdate(
                    baseUrl,
                    accessToken(baseUrl, deviceId),
                    AppVersion.current(context),
                )
            } catch (_: Throwable) {
                null
            }
        }

    fun deactivate(context: Context) {
        ActivationStore.clear(context)
        DeviceIdentity.wipe()
    }
}
