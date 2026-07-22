package com.voicetranscriber.callrecorder.recordings

import com.voicetranscriber.callrecorder.capture.ProfileKind

/**
 * Clean-room analogue of Cube ACR's `ActivityRecordingFactory`: a lookup from a
 * foreground package/activity to the [CallSource] that describes how to record it.
 * Add sources by appending to [BUILT_IN] — the data here is our own.
 */
object SourceRegistry {

    val BUILT_IN: List<CallSource> = listOf(
        CallSource(
            id = "telephony",
            label = "Phone call",
            packageName = null, // native cellular — driven by PhoneStateReceiver
            profileKind = ProfileKind.PHONE,
        ),
        CallSource(
            id = "whatsapp",
            label = "WhatsApp",
            packageName = "com.whatsapp",
            callScreenClasses = setOf(
                "com.whatsapp.calling.ui.VoipActivityV2",
                "com.whatsapp.calling.ui.VoipActivityV3",
            ),
            calleeViewIds = listOf("com.whatsapp:id/name", "com.whatsapp:id/contact_name"),
            profileKind = ProfileKind.VOIP,
        ),
        CallSource(
            id = "telegram",
            label = "Telegram",
            packageName = "org.telegram.messenger",
            callScreenClasses = setOf("org.telegram.ui.VoIPActivity"),
            profileKind = ProfileKind.VOIP,
        ),
        CallSource(
            id = "signal",
            label = "Signal",
            packageName = "org.thoughtcrime.securesms",
            callScreenClasses = setOf("org.thoughtcrime.securesms.WebRtcCallActivity"),
            profileKind = ProfileKind.VOIP,
        ),
        // These rely on the accessibility service's call-screen heuristic (class-name hints)
        // rather than a hardcoded activity, so they survive app updates.
        CallSource("whatsapp_business", "WhatsApp Business", "com.whatsapp.w4b", profileKind = ProfileKind.VOIP),
        CallSource("messenger", "Messenger", "com.facebook.orca", profileKind = ProfileKind.VOIP),
        CallSource("instagram", "Instagram", "com.instagram.android", profileKind = ProfileKind.VOIP),
        CallSource("gmeet", "Google Meet", "com.google.android.apps.tachyon", profileKind = ProfileKind.VOIP),
        CallSource("zoom", "Zoom", "us.zoom.videomeetings", profileKind = ProfileKind.VOIP),
        CallSource("skype", "Skype", "com.skype.raider", profileKind = ProfileKind.VOIP),
        CallSource("viber", "Viber", "com.viber.voip", profileKind = ProfileKind.VOIP),
    )

    private val byActivity: Map<String, CallSource> =
        BUILT_IN.flatMap { s -> s.callScreenClasses.map { it to s } }.toMap()

    private val byPackage: Map<String, CallSource> =
        BUILT_IN.mapNotNull { s -> s.packageName?.let { it to s } }.toMap()

    fun matchByActivity(className: String?): CallSource? =
        className?.let { byActivity[it] }

    fun matchByPackage(packageName: String?): CallSource? =
        packageName?.let { byPackage[it] }

    fun telephony(): CallSource = BUILT_IN.first { it.id == "telephony" }
}
