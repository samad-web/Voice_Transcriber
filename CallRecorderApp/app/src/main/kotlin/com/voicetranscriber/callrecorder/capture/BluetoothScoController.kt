package com.voicetranscriber.callrecorder.capture

import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log

/**
 * Routes call audio through Bluetooth SCO so an AudioRecord (VOICE_COMMUNICATION) can
 * capture it when the call is on a Bluetooth headset. Best-effort and device-dependent —
 * on some phones the telephony stack owns SCO exclusively and capture stays empty.
 */
class BluetoothScoController(private val am: AudioManager) {
    private var engaged = false

    /** Is a Bluetooth headset currently connected as a communication device? */
    fun headsetPresent(): Boolean = try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            am.availableCommunicationDevices.any {
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
            }
        } else {
            am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)
                .any { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
        }
    } catch (t: Throwable) {
        Log.d(TAG, "headsetPresent check failed: ${t.message}"); false
    }

    /** Try to route audio to the BT headset for capture. Returns true if engaged. */
    fun engage(): Boolean {
        engaged = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val dev = am.availableCommunicationDevices.firstOrNull {
                    it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO || it.type == AudioDeviceInfo.TYPE_BLE_HEADSET
                } ?: return false
                am.setCommunicationDevice(dev)
            } else {
                @Suppress("DEPRECATION")
                run { am.startBluetoothSco(); am.isBluetoothScoOn = true; true }
            }
        } catch (t: Throwable) {
            Log.d(TAG, "SCO engage failed: ${t.message}"); false
        }
        return engaged
    }

    fun release() {
        if (!engaged) return
        engaged = false
        runCatching {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                am.clearCommunicationDevice()
            } else {
                @Suppress("DEPRECATION")
                run { am.isBluetoothScoOn = false; am.stopBluetoothSco() }
            }
        }
    }

    private companion object {
        const val TAG = "BtSco"
    }
}
