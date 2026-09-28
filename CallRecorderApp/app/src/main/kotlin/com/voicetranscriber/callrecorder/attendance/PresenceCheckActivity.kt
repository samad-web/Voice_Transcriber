package com.voicetranscriber.callrecorder.attendance

import android.os.Build
import android.os.Bundle
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.LinearLayout
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import com.google.android.material.button.MaterialButton
import com.voicetranscriber.callrecorder.databinding.ActivityPresenceCheckBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * The presence check (doc 33 §3.4), shown over the lock screen by the
 * full-screen intent of the `attendance_prompt` notification: I'm here /
 * Phone or network problem (then an optional one-tap reason) / Taking a break.
 *
 * Deliberately NOT behind the app lock: it exposes three answers and nothing
 * else, and a prompt that first asks for a password would time out into AWAY.
 * Every answer is queued locally, so it works with no network.
 */
class PresenceCheckActivity : AppCompatActivity() {

    private lateinit var binding: ActivityPresenceCheckBinding
    private var technicalChosen = false
    private var answered = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        showOverLockScreen()
        binding = ActivityPresenceCheckBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.btnHere.setOnClickListener { submit(PromptAnswer.HERE, null) }
        binding.btnBreak.setOnClickListener { submit(PromptAnswer.BREAK, null) }
        binding.btnTechnical.setOnClickListener {
            technicalChosen = true
            binding.answers.visibility = android.view.View.GONE
            binding.reasons.visibility = android.view.View.VISIBLE
        }
        binding.btnSkipReason.setOnClickListener { submit(PromptAnswer.TECHNICAL, null) }
        val dp = resources.displayMetrics.density
        for (reason in TechnicalReason.entries) {
            val b = MaterialButton(this, null, com.google.android.material.R.attr.materialButtonOutlinedStyle).apply {
                text = reason.label
                layoutParams = LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, (56 * dp).toInt(),
                ).apply { topMargin = (8 * dp).toInt() }
                setOnClickListener { submit(PromptAnswer.TECHNICAL, reason) }
            }
            binding.reasonButtons.addView(b)
        }

        lifecycleScope.launch {
            val ui = withContext(Dispatchers.Default) { AttendanceController.currentUi(applicationContext) }
            if (ui.state != HandsetState.PROMPTING && ui.state != HandsetState.AWAY) finish()
        }
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                AttendanceController.ui.collect { ui ->
                    // Answered elsewhere (the notification, a call started): nothing to ask.
                    if (!answered && ui.state != HandsetState.PROMPTING && ui.state != HandsetState.AWAY &&
                        ui.running
                    ) {
                        finish()
                    }
                }
            }
        }
    }

    private fun showOverLockScreen() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
            setShowWhenLocked(true)
            setTurnScreenOn(true)
        } else {
            @Suppress("DEPRECATION")
            window.addFlags(
                WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON,
            )
        }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun submit(answer: PromptAnswer, reason: TechnicalReason?) {
        if (answered) return
        answered = true
        val app = applicationContext
        Thread { AttendanceController.answer(app, answer, reason) }.start()
        finish()
    }

    override fun onStop() {
        super.onStop()
        // "Phone or network problem" was chosen but no reason: the answer still counts.
        if (technicalChosen && !answered && !isChangingConfigurations) submit(PromptAnswer.TECHNICAL, null)
    }
}
