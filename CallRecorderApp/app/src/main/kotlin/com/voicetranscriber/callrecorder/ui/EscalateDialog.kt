package com.voicetranscriber.callrecorder.ui

import android.text.InputFilter
import android.text.InputType
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.RelativeSizeSpan
import android.view.View
import android.widget.LinearLayout
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import com.google.android.material.color.MaterialColors
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import com.voicetranscriber.callrecorder.R
import com.voicetranscriber.callrecorder.escalation.EscalationApi
import com.voicetranscriber.callrecorder.escalation.EscalationConfig
import com.voicetranscriber.callrecorder.escalation.EscalationStore
import com.voicetranscriber.callrecorder.escalation.EscalationSync
import com.voicetranscriber.callrecorder.platform.ConfigRefreshWorker
import com.voicetranscriber.callrecorder.platform.PlatformApi
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.util.UUID

/**
 * "Escalate to Priya" (Build docs/38): pick a reason, add a note, send.
 *
 * One [clientRef] per dialog, reused by every Send in it: a retry after a lost
 * response is stored once by the server, and the dialog stays open on a
 * retryable failure precisely so that the retry reuses it.
 */
class EscalateDialog(
    private val activity: AppCompatActivity,
    private val config: EscalationConfig,
    /** The server's call id - RecordingEntity.remoteCallId. */
    private val callId: String,
) {

    private val app = activity.applicationContext
    private val clientRef = UUID.randomUUID().toString()

    fun show() {
        val dp = activity.resources.displayMetrics.density
        val recipient = config.recipientName ?: activity.getString(R.string.escalate_your_managers)

        val reasons = RadioGroup(activity).apply { orientation = RadioGroup.VERTICAL }
        val secondary = MaterialColors.getColor(
            activity, com.google.android.material.R.attr.colorOnSurfaceVariant, 0xFF666666.toInt(),
        )
        config.reasons.forEach { r ->
            reasons.addView(
                RadioButton(activity).apply {
                    id = View.generateViewId()
                    tag = r.code
                    text = reasonText(r.label, r.hint, secondary)
                    val v = (6 * dp).toInt()
                    setPadding(paddingLeft, v, paddingRight, v)
                },
            )
        }

        val noteLayout = TextInputLayout(activity).apply {
            hint = activity.getString(R.string.escalate_note_optional)
            isCounterEnabled = true
            counterMaxLength = config.noteMax
        }
        val note = TextInputEditText(noteLayout.context).apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or
                InputType.TYPE_TEXT_FLAG_MULTI_LINE
            maxLines = 4
            filters = arrayOf(InputFilter.LengthFilter(config.noteMax))
        }
        noteLayout.addView(note)

        // "Something else" needs a note - say so in the field the moment it is picked.
        reasons.setOnCheckedChangeListener { group, checkedId ->
            val other = group.findViewById<RadioButton>(checkedId)?.tag == EscalationConfig.REASON_OTHER
            noteLayout.hint = activity.getString(
                if (other) R.string.escalate_note_required else R.string.escalate_note_optional,
            )
            if (!other) noteLayout.error = null
        }

        val content = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            val pad = (20 * dp).toInt()
            setPadding(pad, (8 * dp).toInt(), pad, 0)
            addView(
                TextView(activity).apply {
                    setText(R.string.escalate_reason_title)
                    setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_BodyMedium)
                },
            )
            addView(reasons)
            addView(
                noteLayout,
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                    .apply { topMargin = (8 * dp).toInt() },
            )
            addView(
                TextView(activity).apply {
                    text = activity.getString(R.string.escalate_goes_to, recipient)
                    setTextAppearance(com.google.android.material.R.style.TextAppearance_Material3_BodySmall)
                    setPadding(0, (4 * dp).toInt(), 0, 0)
                },
            )
        }

        val title = config.recipientName?.let { activity.getString(R.string.escalate_to, it) }
            ?: activity.getString(R.string.escalate_to_manager)
        val dialog = AlertDialog.Builder(activity)
            .setTitle(title)
            .setView(ScrollView(activity).apply { addView(content) })
            .setPositiveButton(R.string.escalate_send, null)
            .setNegativeButton(android.R.string.cancel, null)
            .create()

        dialog.setOnShowListener {
            val send = dialog.getButton(AlertDialog.BUTTON_POSITIVE)
            val cancel = dialog.getButton(AlertDialog.BUTTON_NEGATIVE)

            fun busy(on: Boolean) {
                send.isEnabled = !on
                cancel.isEnabled = !on
                send.setText(if (on) R.string.escalate_sending else R.string.escalate_send)
                dialog.setCancelable(!on)
            }

            send.setOnClickListener {
                val reason = reasons.findViewById<RadioButton>(reasons.checkedRadioButtonId)?.tag as? String
                if (reason == null) {
                    Toast.makeText(activity, R.string.escalate_pick_reason, Toast.LENGTH_SHORT).show()
                    return@setOnClickListener
                }
                val text = note.text?.toString()?.trim().orEmpty()
                if (reason == EscalationConfig.REASON_OTHER && text.isEmpty()) {
                    noteLayout.error = activity.getString(R.string.escalate_note_needed)
                    note.requestFocus()
                    return@setOnClickListener
                }
                noteLayout.error = null
                busy(true)
                activity.lifecycleScope.launch {
                    val result = withContext(Dispatchers.IO) {
                        runCatching { EscalationApi.raise(app, callId, reason, text.ifEmpty { null }, clientRef) }
                    }
                    if (!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.CREATED)) return@launch
                    result.onSuccess { raised ->
                        // The row says "Escalated · waiting" straight away; the list read
                        // after it picks up anything else that changed meanwhile.
                        EscalationStore.put(app, raised.escalation)
                        dialog.dismiss()
                        val to = raised.escalation.assignedToName ?: activity.getString(R.string.escalate_your_managers)
                        Toast.makeText(
                            activity,
                            activity.getString(if (raised.duplicate) R.string.escalate_duplicate else R.string.escalate_done, to),
                            Toast.LENGTH_LONG,
                        ).show()
                        activity.lifecycleScope.launch(Dispatchers.IO) { EscalationSync.refreshQuietly(app) }
                    }.onFailure { e ->
                        val (message, final) = describe(e)
                        Toast.makeText(activity, message, Toast.LENGTH_LONG).show()
                        if (final) dialog.dismiss() else busy(false)
                    }
                }
            }
        }
        dialog.show()
    }

    /** "Customer wants a senior" with its hint underneath, smaller and quieter. */
    private fun reasonText(label: String, hint: String?, hintColor: Int): CharSequence {
        if (hint.isNullOrBlank()) return label
        val sb = SpannableStringBuilder(label).append('\n')
        val start = sb.length
        sb.append(hint)
        sb.setSpan(RelativeSizeSpan(0.85f), start, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        sb.setSpan(ForegroundColorSpan(hintColor), start, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        return sb
    }

    /**
     * A message for the telecaller, and whether trying again from this dialog is
     * pointless (true closes it). Network failures and validation keep it open so
     * a retry reuses the same clientRef.
     */
    private fun describe(e: Throwable): Pair<String, Boolean> {
        if (e is EscalationApi.NotActivated) return activity.getString(R.string.escalate_err_not_paired) to true
        if (e is IOException) return activity.getString(R.string.escalate_err_offline) to false
        if (e !is PlatformApi.ApiException) return activity.getString(R.string.escalate_err_generic) to false
        // A JSON-looking or blank message is not something to show a telecaller.
        val server = e.errorMessage?.trim()?.takeUnless { it.startsWith("{") || it.startsWith("[") }
        return when {
            EscalationSync.isDisabled(e) -> {
                // The switch went off since the last config refresh: fetch it now so the menu goes too.
                ConfigRefreshWorker.runNow(app)
                activity.getString(R.string.escalate_err_disabled) to true
            }
            // Our own words, always: an API without this route also answers 404 ("Cannot POST ...").
            e.code == 404 -> activity.getString(R.string.escalate_err_not_found) to true
            e.code == 429 -> (server ?: activity.getString(R.string.escalate_err_too_many)) to true
            e.code == 400 -> (server ?: activity.getString(R.string.escalate_err_invalid)) to false
            e.code == 401 -> activity.getString(R.string.escalate_err_not_paired) to true
            e.code == 403 -> (server ?: activity.getString(R.string.escalate_err_generic)) to true
            else -> activity.getString(R.string.escalate_err_generic) to false
        }
    }
}
