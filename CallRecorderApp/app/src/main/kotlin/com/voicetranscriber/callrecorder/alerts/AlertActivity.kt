package com.voicetranscriber.callrecorder.alerts

import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import com.google.android.material.card.MaterialCardView
import com.voicetranscriber.callrecorder.R
import com.voicetranscriber.callrecorder.databinding.ActivityHandsetAlertBinding
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/**
 * The phone-alert screen. Opened two ways:
 *  - by the system, over the lock screen, from the `alerts_popup`
 *    notification's full-screen intent: lists EVERY unanswered popup (a bulk
 *    reassign is one screen of ten leads, not ten screens);
 *  - by tapping an `alerts` notification ([EXTRA_ID]): just that one alert.
 *
 * Deliberately NOT behind the app lock, like the attendance presence check: it
 * shows what the alert said and one button, and a popup that first asked for
 * the app password would defeat the point of popping up.
 *
 * "Got it" is the read receipt the manager sees on the Phones page. Backing
 * out without it leaves the alert unread and its notification in place.
 */
class AlertActivity : AppCompatActivity() {

    private lateinit var binding: ActivityHandsetAlertBinding
    private var shownIds: List<String> = emptyList()
    private var singleId: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        showOverLockScreen()
        binding = ActivityHandsetAlertBinding.inflate(layoutInflater)
        setContentView(binding.root)
        binding.btnGotIt.setOnClickListener { gotIt() }
        render(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        render(intent)
    }

    private fun render(intent: Intent?) {
        singleId = intent?.getStringExtra(EXTRA_ID)
        val alerts = singleId?.let { listOfNotNull(AlertStore.get(this, it)) } ?: AlertStore.popups(this)
        if (alerts.isEmpty()) {
            finish()
            return
        }
        shownIds = alerts.map { it.id }
        binding.heading.text =
            if (alerts.size == 1) alerts[0].title else getString(R.string.alert_popup_many, alerts.size)
        binding.cards.removeAllViews()
        alerts.asReversed().forEach { binding.cards.addView(card(it, showTitle = alerts.size > 1)) }
    }

    private fun card(alert: HandsetAlert, showTitle: Boolean): View {
        val dp = resources.displayMetrics.density
        val inner = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (16 * dp).toInt()
            setPadding(pad, pad, pad, pad)
        }
        if (showTitle) {
            inner.addView(text(alert.title, com.google.android.material.R.style.TextAppearance_Material3_TitleMedium))
        }
        alert.body?.let { inner.addView(text(it, com.google.android.material.R.style.TextAppearance_Material3_BodyLarge)) }
        val meta = listOfNotNull(alert.sentBy?.let { getString(R.string.alert_from, it) }, time(alert.createdAt))
        if (meta.isNotEmpty()) {
            inner.addView(
                text(meta.joinToString(" · "), com.google.android.material.R.style.TextAppearance_Material3_BodySmall).apply {
                    setPadding(0, (8 * dp).toInt(), 0, 0)
                },
            )
        }
        return MaterialCardView(this, null, com.google.android.material.R.attr.materialCardViewOutlinedStyle).apply {
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
            ).apply { topMargin = (12 * dp).toInt() }
            addView(inner)
        }
    }

    private fun text(value: String, appearance: Int) = TextView(this).apply {
        setTextAppearance(appearance)
        text = value
    }

    private fun time(iso: String): String? = runCatching {
        Instant.parse(iso).atZone(ZoneId.systemDefault())
            .format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT))
    }.getOrNull()

    private fun gotIt() {
        AlertStore.markOpened(this, shownIds)
        singleId?.let { AlertNotifications.cancel(this, it) }
        AlertNotifications.refreshPopup(this)
        AlertSyncWorker.enqueue(this)
        finish()
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

    companion object {
        const val EXTRA_ID = "alert_id"
    }
}
