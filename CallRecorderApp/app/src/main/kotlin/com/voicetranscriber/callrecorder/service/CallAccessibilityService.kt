package com.voicetranscriber.callrecorder.service

import android.accessibilityservice.AccessibilityService
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.voicetranscriber.callrecorder.capture.CaptureSettings
import com.voicetranscriber.callrecorder.recordings.CallSource
import com.voicetranscriber.callrecorder.recordings.SourceRegistry

/**
 * The "eyes and ears" for VoIP calls — clean-room analogue of Cube ACR's helper app.
 * Detects when a messenger's *call screen* is in the foreground, starts recording, and
 * stops when the call screen is dismissed.
 *
 * Detection is deliberately conservative: it fires only for a KNOWN messenger package
 * AND a window that looks like a call screen (exact activity match, or a class-name
 * hint like "voip"/"webrtc" so it survives app updates that rename the activity). It
 * does NOT start just because the app is open.
 */
class CallAccessibilityService : AccessibilityService() {

    private var activeSource: CallSource? = null
    private var activePackage: String? = null

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        val pkg = event.packageName?.toString()
        val cls = event.className?.toString()
        val source = detectCallSource(pkg, cls)

        when {
            // A call screen appeared and we're not already recording → start.
            source != null && activeSource == null -> {
                if (!CaptureSettings(this).recordVoipCalls) return // VoIP recording disabled
                activeSource = source
                activePackage = pkg
                val callee = rootInActiveWindow?.let { scrapeCallee(it, source) }
                Log.i(TAG, "VoIP call detected: ${source.id}${callee?.let { " ($it)" } ?: ""}")
                RecordingService.start(this, source.id, callee)
            }
            // The call screen went away → the call ended, so stop. We stop when leaving the
            // call app (to any real app/launcher) OR showing a non-call screen in the same
            // app, but IGNORE the notification shade / keyboard so mid-call multitasking
            // doesn't cut it. This also prevents the old "stuck recording" bug where stop
            // never fired because the user jumped straight to the home screen.
            source == null && activeSource != null && pkg != null && !isTransientOverlay(pkg) -> {
                Log.i(TAG, "VoIP call ended (foreground now $pkg): ${activeSource?.id}")
                RecordingService.stop(this)
                activeSource = null
                activePackage = null
            }
        }
    }

    /** Windows that appear over a call without ending it — don't stop recording for these. */
    private fun isTransientOverlay(pkg: String): Boolean =
        pkg == "com.android.systemui" || pkg.contains("inputmethod", ignoreCase = true)

    private fun detectCallSource(pkg: String?, cls: String?): CallSource? {
        pkg ?: return null
        val known = SourceRegistry.matchByPackage(pkg) ?: return null // must be a known messenger
        if (SourceRegistry.matchByActivity(cls) != null) return known // exact activity match
        // Fallback heuristic — survives activity renames across app versions.
        if (cls != null && CALL_HINTS.any { cls.contains(it, ignoreCase = true) }) return known
        return null
    }

    /** Reads the callee name from the source's declared view IDs, if present. */
    private fun scrapeCallee(root: AccessibilityNodeInfo, source: CallSource): String? {
        for (viewId in source.calleeViewIds) {
            val text = root.findAccessibilityNodeInfosByViewId(viewId)
                .firstOrNull { !it.text.isNullOrBlank() }?.text?.toString()
            if (!text.isNullOrBlank()) return text
        }
        return null
    }

    override fun onInterrupt() { /* no-op */ }

    private companion object {
        const val TAG = "CallAccessibility"
        val CALL_HINTS = listOf("voip", "webrtc", "incall", "calling.ui", "voicecall")
    }
}
