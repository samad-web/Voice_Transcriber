package com.voicetranscriber.callrecorder.ui.scanner

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.zxing.BarcodeFormat
import com.journeyapps.barcodescanner.BarcodeCallback
import com.journeyapps.barcodescanner.BarcodeResult
import com.journeyapps.barcodescanner.DefaultDecoderFactory
import com.voicetranscriber.callrecorder.databinding.ActivityQrScannerBinding

/**
 * Full-screen QR scanner with a Paytm-style animated viewfinder
 * ([ScannerOverlayView]). Returns the decoded text to the caller via
 * [EXTRA_RESULT]. Used by the admin activation screen to read the enrollment QR.
 */
class QrScannerActivity : AppCompatActivity() {

    private lateinit var binding: ActivityQrScannerBinding
    private var hasCamera = false

    private val cameraPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        hasCamera = granted
        if (granted) binding.barcode.resume()
        else {
            Toast.makeText(this, "Camera permission is needed to scan", Toast.LENGTH_LONG).show()
            finish()
        }
    }

    private val callback = object : BarcodeCallback {
        override fun barcodeResult(result: BarcodeResult) {
            // First hit wins; stop so we don't fire repeatedly during finish().
            binding.barcode.pause()
            setResult(
                Activity.RESULT_OK,
                Intent().putExtra(EXTRA_RESULT, result.text),
            )
            finish()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityQrScannerBinding.inflate(layoutInflater)
        setContentView(binding.root)

        // Decode QR codes only; ignore 1-D barcodes.
        binding.barcode.decoderFactory = DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE))
        binding.barcode.decodeContinuous(callback)
        binding.close.setOnClickListener { finish() }

        hasCamera = ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        if (!hasCamera) cameraPermission.launch(Manifest.permission.CAMERA)
    }

    override fun onResume() {
        super.onResume()
        if (hasCamera) binding.barcode.resume()
    }

    override fun onPause() {
        super.onPause()
        binding.barcode.pause()
    }

    companion object {
        const val EXTRA_RESULT = "scan_result"
    }
}
