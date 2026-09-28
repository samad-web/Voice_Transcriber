package com.voicetranscriber.callrecorder.attendance

import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * The shift's foreground service (type `specialUse`; the manifest property
 * explains why). It runs only while a shift window is being tracked - from
 * shift start - 10 min until the shift ends and any call in progress has ended.
 *
 * It holds no attendance logic itself: the state machine lives in
 * [AttendanceController], so a call hook or a notification tap that arrives
 * while the service is (re)starting drives the same engine. The service adds:
 *  - the ongoing notification ("On shift · next break 1:00 pm"),
 *  - a 20-second tick while the CPU is awake (the TICK alarm covers Doze),
 *  - network lost/restored logging (doc 33 §3.2: tracked separately from state),
 *  - screen-unlock logging (weak evidence only).
 * There is no microphone and no audio of any kind here (doc 33 §2).
 */
class ShiftService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var loop: Job? = null
    private var announced = false
    private val main = Handler(Looper.getMainLooper())

    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var networkUp: Boolean? = null
    private var lostAtElapsed = 0L

    private val unlockReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == Intent.ACTION_USER_PRESENT) {
                scope.launch { AttendanceController.onScreenUnlock(applicationContext) }
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        // A system broadcast still reaches a not-exported runtime receiver.
        ContextCompat.registerReceiver(
            this, unlockReceiver, IntentFilter(Intent.ACTION_USER_PRESENT), ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        registerNetwork()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // First, always: a service started with startForegroundService() that does not
        // call startForeground() in time crashes the app on Android 12+.
        goForeground()
        startRefused = false
        if (!announced) {
            announced = true
            scope.launch { AttendanceController.onServiceStarted(applicationContext) }
        }
        if (loop == null) {
            loop = scope.launch {
                while (isActive) {
                    AttendanceController.tick(applicationContext)
                    if (!AttendanceController.ui.value.running) {
                        stopSelfSafely()
                        break
                    }
                    delay(TICK_MS)
                }
            }
        }
        return START_STICKY
    }

    private fun goForeground() {
        val n = AttendanceNotifications.shift(this, AttendanceController.ui.value)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(AttendanceNotifications.ID_SHIFT, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(AttendanceNotifications.ID_SHIFT, n)
        }
    }

    private fun stopSelfSafely() {
        main.post {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
    }

    private fun registerNetwork() {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        networkUp = cm.activeNetwork != null
        if (networkUp == false) {
            scope.launch { AttendanceController.onNetworkLost(applicationContext, 0) }
        }
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                main.post {
                    main.removeCallbacks(confirmLost)
                    if (networkUp == false) {
                        scope.launch { AttendanceController.onNetworkRestored(applicationContext) }
                    }
                    networkUp = true
                }
            }

            override fun onLost(network: Network) {
                main.post {
                    lostAtElapsed = SystemClock.elapsedRealtime()
                    // Wi-Fi to mobile hand-overs lose the default network for an instant;
                    // only a loss that lasts is an outage worth logging.
                    main.removeCallbacks(confirmLost)
                    main.postDelayed(confirmLost, LOSS_DEBOUNCE_MS)
                }
            }
        }
        runCatching { cm.registerDefaultNetworkCallback(callback) }
            .onSuccess { networkCallback = callback }
            .onFailure { Log.w(TAG, "network callback unavailable", it) }
    }

    private val confirmLost = Runnable {
        val cm = getSystemService(ConnectivityManager::class.java)
        if (cm?.activeNetwork == null && networkUp != false) {
            networkUp = false
            val ago = SystemClock.elapsedRealtime() - lostAtElapsed
            scope.launch { AttendanceController.onNetworkLost(applicationContext, ago) }
        }
    }

    override fun onDestroy() {
        isRunning = false
        main.removeCallbacks(confirmLost)
        runCatching { unregisterReceiver(unlockReceiver) }
        networkCallback?.let { cb ->
            runCatching { getSystemService(ConnectivityManager::class.java)?.unregisterNetworkCallback(cb) }
        }
        scope.cancel()
        super.onDestroy()
    }

    companion object {
        private const val TAG = "ShiftService"
        private const val TICK_MS = 20_000L
        private const val LOSS_DEBOUNCE_MS = 5_000L

        @Volatile
        var isRunning = false
            private set

        /** True when the last start attempt was refused by Android's background-start rules. */
        @Volatile
        var startRefused = false
            private set

        fun start(context: Context, ui: AttendanceController.Ui) {
            try {
                context.startForegroundService(Intent(context, ShiftService::class.java))
                startRefused = false
            } catch (t: Throwable) {
                // ForegroundServiceStartNotAllowedException (Android 12+) or
                // IllegalStateException: the app is in the background without an
                // exemption. The engine still runs from alarms and call hooks; the
                // service comes up the next time the app is opened.
                startRefused = true
                Log.w(TAG, "shift service start refused: ${t.message}")
                AttendanceNotifications.updateShift(context, ui)
            }
        }

        fun stop(context: Context) {
            if (!isRunning) {
                AttendanceNotifications.cancelShift(context)
                return
            }
            context.stopService(Intent(context, ShiftService::class.java))
        }
    }
}
