package com.voicetranscriber.callrecorder.connectivity

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.voicetranscriber.callrecorder.R
import com.voicetranscriber.callrecorder.alerts.AlertSyncWorker
import com.voicetranscriber.callrecorder.platform.ActivationStore

/**
 * "You're offline - turn on internet."
 *
 * An app cannot switch mobile data or Wi-Fi on itself (Android 10 took that
 * away from every app that is not the system), and the server cannot reach a
 * phone that is offline - so the phone has to be the one that notices. This
 * keeps a persistent notification up while there is no working internet, with
 * a button straight to Android's Internet panel (the Wi-Fi and mobile-data
 * switches in one sheet), and clears it the moment a connection validates.
 *
 * "Working" means VALIDATED, not merely connected: a phone on a data pack that
 * has run out still shows full bars and is exactly as unreachable.
 *
 * Two triggers, because neither alone is enough:
 *  - a network callback while this process is alive - instant;
 *  - [ConnectivityCheckWorker] every ~15 minutes - for when it is not.
 *
 * A [GRACE_MS] wait before showing: switching from Wi-Fi to mobile data drops
 * the default network for a moment, and a notice for every handover would be
 * noise people learn to swipe away.
 *
 * When the connection comes back it also asks for any phone alerts it missed:
 * a push sent while it was offline may never arrive.
 */
object ConnectivityWatch {

    const val CHANNEL = "connectivity"
    private const val ID_OFFLINE = 6300
    private const val GRACE_MS = 30_000L

    private val handler by lazy { Handler(Looper.getMainLooper()) }
    @Volatile private var started = false
    @Volatile private var offline = false
    private lateinit var app: Context

    private val check = Runnable { evaluate(app) }

    fun createChannel(context: Context) {
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(
                CHANNEL, context.getString(R.string.offline_channel), NotificationManager.IMPORTANCE_HIGH,
            ).apply { description = context.getString(R.string.offline_channel_desc) },
        )
    }

    /** Called once per process from App.onCreate. */
    fun start(context: Context) {
        if (started) return
        started = true
        app = context.applicationContext
        val cm = app.getSystemService(ConnectivityManager::class.java) ?: return
        runCatching {
            cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                    if (caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
                        caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
                    ) {
                        handler.removeCallbacks(check)
                        handler.post { evaluate(app) }
                    }
                }

                override fun onLost(network: Network) = scheduleCheck()
            })
        }
        // The state the process started in.
        scheduleCheck()
    }

    private fun scheduleCheck() {
        handler.removeCallbacks(check)
        handler.postDelayed(check, GRACE_MS)
    }

    fun isOnline(context: Context): Boolean {
        val cm = context.getSystemService(ConnectivityManager::class.java) ?: return false
        val caps = cm.getNetworkCapabilities(cm.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    /**
     * Show or clear the notice for the network as it is right now. The whole
     * job of [ConnectivityCheckWorker]. A phone that is not paired is never
     * nagged - it has nothing to receive.
     */
    fun evaluate(context: Context) {
        if (!ActivationStore.isActivated(context)) {
            clear(context)
            return
        }
        if (isOnline(context)) {
            val wasOffline = offline
            offline = false
            clear(context)
            if (wasOffline) AlertSyncWorker.enqueue(context)
        } else {
            offline = true
            showOffline(context)
        }
    }

    private fun showOffline(context: Context) {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return
        val panel = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            Intent(Settings.Panel.ACTION_INTERNET_CONNECTIVITY)
        } else {
            Intent(Settings.ACTION_WIRELESS_SETTINGS)
        }.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val turnOn = PendingIntent.getActivity(
            context, 91, panel, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val n = NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_wifi_off)
            .setContentTitle(context.getString(R.string.offline_title))
            .setContentText(context.getString(R.string.offline_body))
            .setStyle(NotificationCompat.BigTextStyle().bigText(context.getString(R.string.offline_body)))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(turnOn)
            .addAction(0, context.getString(R.string.offline_turn_on), turnOn)
            .build()
        context.getSystemService(NotificationManager::class.java).notify(ID_OFFLINE, n)
    }

    private fun clear(context: Context) =
        context.getSystemService(NotificationManager::class.java).cancel(ID_OFFLINE)
}
