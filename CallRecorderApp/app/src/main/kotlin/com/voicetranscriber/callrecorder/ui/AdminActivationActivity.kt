package com.voicetranscriber.callrecorder.ui

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.voicetranscriber.callrecorder.databinding.ActivityAdminActivationBinding
import com.voicetranscriber.callrecorder.platform.ActivationManager
import com.voicetranscriber.callrecorder.platform.ActivationStore
import com.voicetranscriber.callrecorder.R
import com.voicetranscriber.callrecorder.ui.scanner.QrScannerActivity
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Admin-only screen - the device half of the activation gate. Reached via a
 * hidden entry (long-press the toolbar title), NOT from normal navigation.
 * The admin enters the instance ID + one-time admin key generated in the web
 * app's Device Activation page. Until this succeeds, the app cannot record.
 */
class AdminActivationActivity : AppCompatActivity() {

    private lateinit var binding: ActivityAdminActivationBinding
    private var statusText: String = ""

    // One enrollment at a time. A scan now activates by itself, so a tap on
    // Activate a moment later must not spend a second use of a one-use code.
    private var enrolling = false

    // QR scanner (Paytm-style animated viewfinder) - returns the JSON the web
    // activation page encodes into the code.
    private val scanLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode == Activity.RESULT_OK) {
            result.data?.getStringExtra(QrScannerActivity.EXTRA_RESULT)
                ?.let { applyScannedPayload(it) }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityAdminActivationBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.toolbar.setNavigationOnClickListener { finish() }
        binding.serverUrl.setText(ActivationStore.apiBaseUrl(this))

        binding.scanBtn.setOnClickListener {
            scanLauncher.launch(Intent(this, QrScannerActivity::class.java))
        }
        binding.activateBtn.setOnClickListener { activate() }
        binding.refreshBtn.setOnClickListener {
            lifecycleScope.launch {
                statusText = ActivationManager.refreshConfig(this@AdminActivationActivity)
                renderState()
            }
        }
        binding.deactivateBtn.setOnClickListener {
            ActivationManager.deactivate(this)
            statusText = getString(R.string.admin_enrollment_cleared)
            renderState()
        }

        renderState()
    }

    /**
     * The web activation QR encodes {"v":1,"instanceId":"...","adminKey":"..."}
     * (and optionally "serverUrl"). Fill the fields, then - when nothing about
     * the scan needs a human to look at it - activate straight away, the way
     * WhatsApp links a device the moment its QR is read. The console's pairing
     * dialog is watching for exactly that moment and moves on by itself.
     *
     * The confirm step stays for the two cases where it earns its tap:
     *  - the code names a DIFFERENT server than this phone is set up for. The
     *    owner console never sends one; an operator-issued code may, and a QR
     *    that silently repoints a phone at another host is the thing the
     *    confirm step exists to catch.
     *  - the phone is already activated. Enrolling again makes it a new device
     *    on the server, which should be a decision, not a side effect of
     *    pointing the camera at a screen.
     */
    private fun applyScannedPayload(raw: String) {
        val json = try {
            JSONObject(raw)
        } catch (e: Exception) {
            statusText = getString(R.string.admin_scan_unrecognized)
            renderState()
            return
        }

        val instance = json.optString("instanceId").trim()
        val key = json.optString("adminKey").trim()
        val scannedUrl = json.optString("serverUrl").trim()
        if (instance.isEmpty() || key.isEmpty()) {
            statusText = getString(R.string.admin_scan_unrecognized)
            renderState()
            return
        }

        val currentUrl = binding.serverUrl.text?.toString()?.trim().orEmpty()
        val repoints = scannedUrl.isNotEmpty() && scannedUrl.trimEnd('/') != currentUrl.trimEnd('/')

        binding.instanceId.setText(instance)
        binding.adminKey.setText(key)
        if (scannedUrl.isNotEmpty()) binding.serverUrl.setText(scannedUrl)

        when {
            repoints -> statusText = getString(R.string.admin_scanned_confirm)
            ActivationStore.isActivated(this) ->
                statusText = getString(R.string.admin_scanned_already_activated)
            else -> activate()
        }
        renderState()
    }

    private fun activate() {
        if (enrolling) return
        val url = binding.serverUrl.text?.toString()?.trim().orEmpty()
        val instance = binding.instanceId.text?.toString()?.trim().orEmpty()
        val key = binding.adminKey.text?.toString()?.trim().orEmpty()
        if (url.isEmpty() || instance.isEmpty() || key.isEmpty()) {
            statusText = getString(R.string.admin_fields_required)
            renderState()
            return
        }
        enrolling = true
        binding.activateBtn.isEnabled = false
        statusText = getString(R.string.admin_enrolling)
        renderState()
        lifecycleScope.launch {
            statusText = try {
                ActivationManager.enroll(this@AdminActivationActivity, url, instance, key)
            } catch (e: Exception) {
                getString(R.string.admin_activation_failed, e.message)
            } finally {
                enrolling = false
                binding.activateBtn.isEnabled = true
            }
            renderState()
        }
    }

    private fun renderState() {
        binding.status.text = "${ActivationStore.statusSummary(this)}\n\n$statusText"
            .lines().distinct().joinToString("\n").trim()
    }
}
