package com.voicetranscriber.callrecorder.ui

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import androidx.appcompat.app.AppCompatActivity
import com.voicetranscriber.callrecorder.databinding.ActivityLockBinding
import com.voicetranscriber.callrecorder.platform.ActivationStore
import com.voicetranscriber.callrecorder.platform.AppLock

/**
 * The real launcher entry point (see AndroidManifest — MainActivity is no
 * longer exported). Gates the WHOLE app behind the instance's app-lock
 * password, set on the CRM's Instance page and synced via device config.
 *
 * Falls through with no prompt when the org hasn't set a password, or once
 * already unlocked this process ([AppLock.unlockedThisSession] resets on
 * every cold start, which is what makes this "every time the app opens"
 * rather than a one-time unlock).
 */
class LockActivity : AppCompatActivity() {

    private lateinit var binding: ActivityLockBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val hash = ActivationStore.appLockPasswordHash(this)
        if (hash == null || AppLock.unlockedThisSession) {
            enterApp()
            return
        }

        binding = ActivityLockBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.unlockBtn.setOnClickListener { attemptUnlock(hash) }
        binding.password.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_DONE) {
                attemptUnlock(hash)
                true
            } else {
                false
            }
        }
    }

    private fun attemptUnlock(hash: String) {
        val entered = binding.password.text?.toString().orEmpty()
        if (entered.isNotEmpty() && AppLock.verify(entered, hash)) {
            AppLock.unlockedThisSession = true
            enterApp()
        } else {
            binding.error.visibility = View.VISIBLE
            binding.password.text?.clear()
        }
    }

    private fun enterApp() {
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }
}
