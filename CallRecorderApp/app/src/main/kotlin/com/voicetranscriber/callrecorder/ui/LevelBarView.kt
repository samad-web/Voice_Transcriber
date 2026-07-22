package com.voicetranscriber.callrecorder.ui

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View

/**
 * Live scrolling waveform. Call [push] with an amplitude (0f..1f) as audio plays; each
 * sample becomes a centered, mirrored vertical bar. New samples enter on the right and
 * older ones scroll off the left — the classic voice-level waveform.
 */
class LevelBarView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {

    private val bar = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFF0B6E4F.toInt() }
    private val capacity = 96
    private val amps = FloatArray(capacity)
    private var head = 0
    private var count = 0

    fun push(amp: Float) {
        amps[head] = amp.coerceIn(0f, 1f)
        head = (head + 1) % capacity
        if (count < capacity) count++
        invalidate()
    }

    fun clear() {
        count = 0
        head = 0
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val h = height.toFloat()
        val mid = h / 2f
        val slot = width.toFloat() / capacity
        // Draw oldest -> newest, left to right.
        for (i in 0 until count) {
            val idx = (head - count + i + capacity * 2) % capacity
            val barHeight = (amps[idx] * h).coerceAtLeast(2f)
            val x = i * slot
            canvas.drawRect(x, mid - barHeight / 2f, x + slot * 0.7f, mid + barHeight / 2f, bar)
        }
    }
}
