package com.voicetranscriber.callrecorder.recordings

import com.voicetranscriber.callrecorder.capture.ProfileKind

/**
 * Declarative description of one recordable call source — the clean-room analogue of
 * Cube ACR's per-app `*Recording` classes (package name, call-screen activity IDs, and
 * the view IDs to read the caller name from). Plain data; no vendor code copied.
 */
data class CallSource(
    /** Stable key, e.g. "whatsapp", "telephony". */
    val id: String,
    /** Human label shown in the UI. */
    val label: String,
    /** App package that owns the call UI (null for native cellular telephony). */
    val packageName: String?,
    /** Fully-qualified activity/class names that indicate an active call screen. */
    val callScreenClasses: Set<String> = emptySet(),
    /** Accessibility view IDs whose text holds the other party's name/number. */
    val calleeViewIds: List<String> = emptyList(),
    /** Which capture profile this source uses (phone vs VoIP tuning). */
    val profileKind: ProfileKind = ProfileKind.VOIP,
)
