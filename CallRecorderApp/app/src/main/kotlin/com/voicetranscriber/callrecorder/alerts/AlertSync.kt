package com.voicetranscriber.callrecorder.alerts

import android.content.Context
import android.util.Log
import androidx.annotation.WorkerThread

/**
 * Collect waiting alerts, show the new ones, and report what happened.
 *
 * Runs straight from the `alert` push (the popup should not wait for
 * WorkManager to schedule anything), from [AlertSyncWorker] when that fails or
 * when the phone comes back online, and after the hourly config refresh as a
 * catch-up for pushes that never arrived.
 *
 * Throws on any network failure - the caller decides whether to retry. Nothing
 * is lost by a throw: the server keeps the alert until a phone acks it, and
 * receipts stay in [AlertStore] until the server has them.
 */
object AlertSync {

    private const val TAG = "AlertSync"

    @WorkerThread
    fun sync(context: Context) {
        val session = AlertApi.session(context) ?: return
        val alerts = session.fetch()
        val fresh = AlertStore.takeNew(context, alerts)
        val shown = fresh.isEmpty() || AlertNotifications.show(context, fresh)
        if (!shown) {
            // Notifications are off on this phone. Not delivered, so the
            // console says "not reached" rather than claiming it arrived, and
            // forgotten so a later fetch shows it if they are turned back on.
            AlertStore.forget(context, fresh.map { it.id })
            Log.w(TAG, "${fresh.size} alert(s) not shown: notifications are blocked")
        }
        val freshIds = fresh.map { it.id }.toSet()
        // Already-shown ids the server still lists are re-acked: their first ack was lost.
        AlertStore.queueDelivered(context, alerts.map { it.id }.filter { shown || it !in freshIds })
        val (delivered, opened) = AlertStore.pendingAcks(context)
        session.ack(delivered, opened)
        AlertStore.clearAcks(context, delivered, opened)
        if (fresh.isNotEmpty()) Log.i(TAG, "showed ${fresh.size} alert(s)")
    }
}
