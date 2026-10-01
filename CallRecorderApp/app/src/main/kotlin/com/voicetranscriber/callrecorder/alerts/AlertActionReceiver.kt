package com.voicetranscriber.callrecorder.alerts

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * "Got it" pressed on a notification, without opening anything. Records the
 * read receipt locally and hands sending it to [AlertSyncWorker], which waits
 * for a network if there is none.
 */
class AlertActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != GOT_IT) return
        val id = intent.getStringExtra(AlertActivity.EXTRA_ID)
        if (id != null) {
            AlertStore.markOpened(context, listOf(id))
            AlertNotifications.cancel(context, id)
        } else {
            AlertStore.markOpened(context, AlertStore.popups(context).map { it.id })
            AlertNotifications.refreshPopup(context)
        }
        AlertSyncWorker.enqueue(context)
    }

    companion object {
        const val GOT_IT = "com.voicetranscriber.callrecorder.alerts.GOT_IT"
    }
}
