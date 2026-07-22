package com.voicetranscriber.callrecorder.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
import android.util.Log
import com.voicetranscriber.callrecorder.capture.CaptureSettings
import com.voicetranscriber.callrecorder.ingest.OemIngestWorker
import com.voicetranscriber.callrecorder.ingest.OemRecordingIngestor
import com.voicetranscriber.callrecorder.platform.ActivationStore
import com.voicetranscriber.callrecorder.platform.EventLog
import com.voicetranscriber.callrecorder.recordings.SourceRegistry

/**
 * Native cellular call detection — analogue of Cube ACR's `OnPhoneState`.
 *
 * Recording starts on OFFHOOK (call *active/attended*), never on RINGING — so an
 * unanswered incoming call is not recorded. Direction is inferred: if we saw a RINGING
 * state first it's incoming, otherwise it's an outgoing call we dialed.
 */
class PhoneStateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return
        when (intent.getStringExtra(TelephonyManager.EXTRA_STATE)) {
            TelephonyManager.EXTRA_STATE_RINGING -> {
                sawRinging = true
                lastNumber = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)
            }
            TelephonyManager.EXTRA_STATE_OFFHOOK -> {
                // Activation gate: an un-enrolled or remotely-disabled device never records.
                if (!ActivationStore.isRecordingAllowed(context)) {
                    Log.i("PhoneStateReceiver", "recording blocked — device not activated/enabled")
                    return
                }
                val direction = if (sawRinging) DIR_INCOMING else DIR_OUTGOING
                val number = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER) ?: lastNumber
                // Lightweight, non-blocking event; the HealthWorker batch-POSTs these.
                // Direction only (no number) to keep the telemetry event free of PII.
                EventLog.record(context, "call_offhook", mapOf("direction" to direction))

                // If this handset records calls itself, its file has BOTH sides — ours would
                // only have the near end. Recording anyway would just save a worse duplicate,
                // so stand down and import the OEM file after the call instead.
                if (CaptureSettings(context).preferOemRecordings &&
                    OemRecordingIngestor.isAvailable(context)
                ) {
                    Log.i("PhoneStateReceiver", "own capture skipped — device records calls itself")
                    return
                }
                RecordingService.start(context, SourceRegistry.telephony().id, number, direction)
            }
            TelephonyManager.EXTRA_STATE_IDLE -> {
                sawRinging = false
                lastNumber = null
                RecordingService.stop(context)
                // The dialer writes its recording on hang-up; pick it up shortly after.
                OemIngestWorker.enqueueAfterCall(context)
            }
        }
    }

    companion object {
        const val DIR_INCOMING = "incoming"
        const val DIR_OUTGOING = "outgoing"
        // Receiver instances are short-lived, so remember cross-broadcast state here.
        @Volatile private var sawRinging = false
        @Volatile private var lastNumber: String? = null
    }
}
