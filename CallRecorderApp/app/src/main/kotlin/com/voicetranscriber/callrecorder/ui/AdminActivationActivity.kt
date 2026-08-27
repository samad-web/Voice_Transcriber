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
 * Admin-only screen — the device half of the activation gate. Reached via a
 * hidden entry (long-press the toolbar title), NOT from normal navigation.
 * The admin enters the instance ID + one-time admin key generated in the web
 * app's Device Activation page. Until this succeeds, the app cannot record.
 */
class AdminActivationActivity : AppCompatActivity() {

    private lateinit var binding: ActivityAdminActivationBinding
    private var statusText: String = ""

    // QR scanner (Paytm-style animated viewfinder) — returns the JSON the web
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
     * (and optionally "serverUrl"). Fill the fields; the admin still confirms
     * the server URL and taps Activate.
     */
    private fun applyScannedPayload(raw: String) {
        try {
            val json = JSONObject(raw)
            json.optString("instanceId").takeIf { it.isNotBlank() }?.let { binding.instanceId.setText(it) }
            json.optString("adminKey").takeIf { it.isNotBlank() }?.let { binding.adminKey.setText(it) }
            json.optString("serverUrl").takeIf { it.isNotBlank() }?.let { binding.serverUrl.setText(it) }
            statusText = getString(R.string.admin_scanned_confirm)
        } catch (e: Exception) {
            statusText = getString(R.string.admin_scan_unrecognized)
        }
        renderState()
    }

    private fun activate() {
        val url = binding.serverUrl.text?.toString()?.trim().orEmpty()
        val instance = binding.instanceId.text?.toString()?.trim().orEmpty()
        val key = binding.adminKey.text?.toString()?.trim().orEmpty()
        if (url.isEmpty() || instance.isEmpty() || key.isEmpty()) {
            statusText = getString(R.string.admin_fields_required)
            renderState()
            return
        }
        statusText = getString(R.string.admin_enrolling)
        renderState()
        lifecycleScope.launch {
            statusText = try {
                ActivationManager.enroll(this@AdminActivationActivity, url, instance, key)
            } catch (e: Exception) {
                getString(R.string.admin_activation_failed, e.message)
            }
            renderState()
        }
    }

    private fun renderState() {
        binding.status.text = "${ActivationStore.statusSummary(this)}\n\n$statusText"
            .lines().distinct().joinToString("\n").trim()
    }
}
