package com.voicetranscriber.callrecorder.escalation

import android.content.Context
import android.os.SystemClock
import android.util.Log
import androidx.annotation.WorkerThread
import com.voicetranscriber.callrecorder.alerts.HandsetAlert
import com.voicetranscriber.callrecorder.platform.ConfigRefreshWorker
import com.voicetranscriber.callrecorder.platform.PlatformApi

/**
 * Pulls the status of this telecaller's escalations into [EscalationStore], so
 * each escalated recording's row can say "waiting", "picked up" or "answered".
 *
 * Runs on return to the app (throttled), right after a raise, and after an
 * escalation alert arrives. Does nothing while the feature is off.
 */
object EscalationSync {

    private const val TAG = "EscalationSync"

    /** A resume more often than this reuses what the last read found. */
    private const val RESUME_MIN_INTERVAL_MS = 30_000L

    @Volatile private var lastRefreshElapsed = 0L

    /** The alert kinds (0151) that mean an escalation's status changed. */
    private val ESCALATION_ALERT_KINDS = setOf(HandsetAlert.KIND_ESCALATION_RECEIVED, HandsetAlert.KIND_ESCALATION_UPDATE)

    fun isEscalationAlert(alert: HandsetAlert): Boolean = alert.kind in ESCALATION_ALERT_KINDS

    /**
     * Reads the list and replaces the cache. Throws on a network failure; a 403
     * `escalation_disabled` also asks for a config refresh, so the menu goes the
     * moment the server says the switch is off rather than an hour later.
     */
    @WorkerThread
    fun refresh(context: Context) {
        if (!EscalationStore.isEnabled(context)) return
        try {
            val views = EscalationApi.list(context)
            EscalationStore.replaceAll(context, views)
            lastRefreshElapsed = SystemClock.elapsedRealtime()
        } catch (e: PlatformApi.ApiException) {
            if (isDisabled(e)) ConfigRefreshWorker.runNow(context)
            throw e
        }
    }

    /** For onResume: at most one read per [RESUME_MIN_INTERVAL_MS], and never throws. */
    @WorkerThread
    fun refreshIfStale(context: Context) {
        val last = lastRefreshElapsed
        if (last != 0L && SystemClock.elapsedRealtime() - last < RESUME_MIN_INTERVAL_MS) return
        refreshQuietly(context)
    }

    /** Never throws - for callers whose own job must not fail because of this one. */
    @WorkerThread
    fun refreshQuietly(context: Context) {
        runCatching { refresh(context) }.onFailure { Log.w(TAG, "escalation status refresh failed", it) }
    }

    fun isDisabled(e: PlatformApi.ApiException): Boolean = e.code == 403 && e.errorCode == "escalation_disabled"
}
