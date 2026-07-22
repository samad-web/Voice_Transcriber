package com.voicetranscriber.callrecorder.ui

import android.annotation.SuppressLint
import android.os.Bundle
import android.text.InputType
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.app.Activity
import android.content.Intent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.voicetranscriber.callrecorder.platform.ActivationManager
import com.voicetranscriber.callrecorder.platform.ActivationStore
import com.voicetranscriber.callrecorder.ui.scanner.QrScannerActivity
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Admin-only screen — the device half of the activation gate. Reached via a
 * hidden entry (long-press the toolbar title), NOT from normal navigation.
 * The admin enters the instance ID + one-time admin key generated in the web
 * app's Device Activation page. Until this succeeds, the app cannot record.
 *
 * Programmatic UI on purpose: no layout resources to keep the admin surface
 * self-contained. QR-scan entry lands with the CameraX work (checklist §3.1).
 */
class AdminActivationActivity : AppCompatActivity() {

    private lateinit var status: TextView
    private lateinit var serverUrl: EditText
    private lateinit var instanceId: EditText
    private lateinit var adminKey: EditText

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

    @SuppressLint("SetTextI18n")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "Device Activation (Admin)"

        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }

        status = TextView(this).apply { textSize = 14f }
        serverUrl = field("Platform server URL").apply {
            setText(ActivationStore.apiBaseUrl(this@AdminActivationActivity))
        }
        instanceId = field("Instance ID")
        adminKey = field("One-time admin key").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }

        val scanBtn = Button(this).apply {
            text = "Scan Activation QR"
            setOnClickListener {
                scanLauncher.launch(Intent(this@AdminActivationActivity, QrScannerActivity::class.java))
            }
        }
        val activateBtn = Button(this).apply {
            text = "Activate Device"
            setOnClickListener { activate() }
        }
        val refreshBtn = Button(this).apply {
            text = "Refresh Server Config"
            setOnClickListener {
                lifecycleScope.launch {
                    status.text = ActivationManager.refreshConfig(this@AdminActivationActivity)
                    renderState()
                }
            }
        }
        val deactivateBtn = Button(this).apply {
            text = "Deactivate (clear enrollment)"
            setOnClickListener {
                ActivationManager.deactivate(this@AdminActivationActivity)
                status.text = "Enrollment cleared."
                renderState()
            }
        }

        listOf(status, serverUrl, scanBtn, instanceId, adminKey, activateBtn, refreshBtn, deactivateBtn)
            .forEach { view ->
                root.addView(
                    view,
                    LinearLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.WRAP_CONTENT,
                    ).apply { topMargin = pad / 2 },
                )
            }
        setContentView(ScrollView(this).apply { addView(root) })
        renderState()
    }

    private fun field(hintText: String): EditText = EditText(this).apply {
        hint = hintText
        inputType = InputType.TYPE_CLASS_TEXT
    }

    /**
     * The web activation QR encodes {"v":1,"instanceId":"...","adminKey":"..."}
     * (and optionally "serverUrl"). Fill the fields; the admin still confirms
     * the server URL and taps Activate.
     */
    @SuppressLint("SetTextI18n")
    private fun applyScannedPayload(raw: String) {
        try {
            val json = JSONObject(raw)
            json.optString("instanceId").takeIf { it.isNotBlank() }?.let { instanceId.setText(it) }
            json.optString("adminKey").takeIf { it.isNotBlank() }?.let { adminKey.setText(it) }
            json.optString("serverUrl").takeIf { it.isNotBlank() }?.let { serverUrl.setText(it) }
            status.text = "Scanned instance + key. Confirm the server URL, then Activate."
        } catch (e: Exception) {
            status.text = "Unrecognized QR (expected the activation code from the web app)."
        }
        renderState()
    }

    @SuppressLint("SetTextI18n")
    private fun activate() {
        val url = serverUrl.text.toString().trim()
        val instance = instanceId.text.toString().trim()
        val key = adminKey.text.toString().trim()
        if (url.isEmpty() || instance.isEmpty() || key.isEmpty()) {
            status.text = "All three fields are required."
            return
        }
        status.text = "Enrolling…"
        lifecycleScope.launch {
            status.text = try {
                ActivationManager.enroll(this@AdminActivationActivity, url, instance, key)
            } catch (e: Exception) {
                "Activation failed: ${e.message}"
            }
            renderState()
        }
    }

    @SuppressLint("SetTextI18n")
    private fun renderState() {
        status.text = "${ActivationStore.statusSummary(this)}\n\n${status.text}"
            .lines().distinct().joinToString("\n").trim()
    }
}
