package com.voicetranscriber.callrecorder.attendance

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * Taps on attendance notification buttons: the heads-up prompt's three answers
 * (the fallback when full-screen intents are not allowed), Start shift, Start
 * break and Back to dialling. All of them work offline - the answer is queued
 * like every other event.
 */
class AttendanceActionReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        val pending = goAsync()
        Thread {
            try {
                when (action) {
                    START_SHIFT -> AttendanceController.startShift(context)
                    START_BREAK -> AttendanceController.startBreak(context)
                    BACK -> AttendanceController.back(context)
                    ANSWER_HERE -> AttendanceController.answer(context, PromptAnswer.HERE, null)
                    ANSWER_TECHNICAL -> AttendanceController.answer(
                        context, PromptAnswer.TECHNICAL, TechnicalReason.fromWire(intent.getStringExtra(EXTRA_REASON)),
                    )
                    ANSWER_BREAK -> AttendanceController.answer(context, PromptAnswer.BREAK, null)
                }
                AttendanceNotifications.cancelReminder(context)
            } catch (t: Throwable) {
                Log.e("AttendanceAction", "action $action failed", t)
            } finally {
                pending.finish()
            }
        }.start()
    }

    companion object {
        private const val P = "com.voicetranscriber.callrecorder.attendance."
        const val START_SHIFT = P + "START_SHIFT"
        const val START_BREAK = P + "START_BREAK"
        const val BACK = P + "BACK"
        const val ANSWER_HERE = P + "ANSWER_HERE"
        const val ANSWER_TECHNICAL = P + "ANSWER_TECHNICAL"
        const val ANSWER_BREAK = P + "ANSWER_BREAK"
        const val EXTRA_REASON = "reason"
    }
}
