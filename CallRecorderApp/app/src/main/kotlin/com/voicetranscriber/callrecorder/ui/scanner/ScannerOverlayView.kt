package com.voicetranscriber.callrecorder.ui.scanner

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.graphics.RectF
import android.graphics.Shader
import android.util.AttributeSet
import android.view.View
import android.view.animation.LinearInterpolator
import kotlin.math.min

/**
 * Paytm-style scanner decoration drawn on top of the camera preview:
 *   - a dark scrim with a clear rounded "window" in the centre,
 *   - four bright corner brackets around the window,
 *   - a glowing horizontal line that sweeps up and down inside the window.
 *
 * Pure Canvas drawing — no image assets. The framing window rect is exposed so
 * the host activity can (optionally) constrain decoding to it.
 */
class ScannerOverlayView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyle: Int = 0,
) : View(context, attrs, defStyle) {

    private val density = resources.displayMetrics.density
    private fun dp(v: Float) = v * density

    /** Paytm accent — a bright cyan/blue. */
    private val accent = Color.parseColor("#00C6FF")
    private val cornerRadius = dp(28f)

    private val scrimPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.parseColor("#B3000000") // ~70% black
    }
    private val clearPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
    }
    private val cornerPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = accent
        style = Paint.Style.STROKE
        strokeWidth = dp(4f)
        strokeCap = Paint.Cap.ROUND
    }
    private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG)

    /** The transparent framing window, recomputed on size change. */
    val window = RectF()

    /** 0f (top) → 1f (bottom), driven by the animator. */
    private var sweep = 0f

    private val animator = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 2200L
        interpolator = LinearInterpolator()
        repeatMode = ValueAnimator.REVERSE
        repeatCount = ValueAnimator.INFINITE
        addUpdateListener {
            sweep = it.animatedValue as Float
            invalidate()
        }
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        // A centred square window, ~72% of the shorter edge.
        val side = min(w, h) * 0.72f
        val left = (w - side) / 2f
        val top = (h - side) / 2f - dp(24f) // nudge up a touch, room for the hint below
        window.set(left, top, left + side, top + side)
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (!animator.isStarted) animator.start()
    }

    override fun onDetachedFromWindow() {
        animator.cancel()
        super.onDetachedFromWindow()
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        // Punch the rounded window out of the scrim on an offscreen layer.
        val layer = canvas.saveLayer(0f, 0f, width.toFloat(), height.toFloat(), null)
        canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), scrimPaint)
        canvas.drawRoundRect(window, cornerRadius, cornerRadius, clearPaint)
        canvas.restoreToCount(layer)

        drawCorners(canvas)
        drawSweepLine(canvas)
    }

    private fun drawCorners(canvas: Canvas) {
        val len = dp(30f)          // arm length
        val r = cornerRadius
        val p = Path()

        // Top-left
        p.moveTo(window.left, window.top + r + len)
        p.lineTo(window.left, window.top + r)
        p.quadTo(window.left, window.top, window.left + r, window.top)
        p.lineTo(window.left + r + len, window.top)
        // Top-right
        p.moveTo(window.right - r - len, window.top)
        p.lineTo(window.right - r, window.top)
        p.quadTo(window.right, window.top, window.right, window.top + r)
        p.lineTo(window.right, window.top + r + len)
        // Bottom-right
        p.moveTo(window.right, window.bottom - r - len)
        p.lineTo(window.right, window.bottom - r)
        p.quadTo(window.right, window.bottom, window.right - r, window.bottom)
        p.lineTo(window.right - r - len, window.bottom)
        // Bottom-left
        p.moveTo(window.left + r + len, window.bottom)
        p.lineTo(window.left + r, window.bottom)
        p.quadTo(window.left, window.bottom, window.left, window.bottom - r)
        p.lineTo(window.left, window.bottom - r - len)

        canvas.drawPath(p, cornerPaint)
    }

    private fun drawSweepLine(canvas: Canvas) {
        val inset = dp(10f)
        val y = window.top + inset + (window.height() - 2 * inset) * sweep
        val left = window.left + inset
        val right = window.right - inset

        // A soft glow: transparent → accent → transparent vertically around the line.
        val glow = dp(22f)
        linePaint.shader = LinearGradient(
            0f, y - glow, 0f, y + glow,
            intArrayOf(Color.TRANSPARENT, withAlpha(accent, 0x66), Color.TRANSPARENT),
            floatArrayOf(0f, 0.5f, 1f),
            Shader.TileMode.CLAMP,
        )
        canvas.drawRect(left, y - glow, right, y + glow, linePaint)

        // The bright core line.
        linePaint.shader = null
        linePaint.color = accent
        linePaint.strokeWidth = dp(2.5f)
        canvas.drawLine(left, y, right, y, linePaint)
    }

    private fun withAlpha(color: Int, alpha: Int) =
        (color and 0x00FFFFFF) or (alpha shl 24)
}
