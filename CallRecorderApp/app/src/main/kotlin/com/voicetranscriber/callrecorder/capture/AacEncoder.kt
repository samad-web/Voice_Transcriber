package com.voicetranscriber.callrecorder.capture

import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMuxer
import android.util.Log
import java.io.File

/**
 * PCM 16-bit mono -> AAC in an .m4a container, via MediaCodec + MediaMuxer.
 * Clean-room analogue of Cube ACR's MediaCodec/MediaMuxer pipeline.
 *
 * Hardening notes (vs. the naive first draft):
 *  - Never drops PCM: input is split into codec-input-buffer-sized chunks and we
 *    WAIT for a free input buffer rather than discarding the read on a -1.
 *  - Monotonic, drift-free presentation timestamps derived from a cumulative sample
 *    counter (not from a per-call clock), so chunking/backpressure can't skew them.
 *  - Muxer track added exactly once; output before the muxer starts is dropped safely.
 *  - Bounded end-of-stream drain (won't spin forever if the codec misbehaves).
 *  - Any failure flips [failed] and still releases codec + muxer exactly once.
 *
 * Not thread-safe: [feed] and [finish] are expected to be called from the single
 * capture thread that owns this encoder.
 */
class AacEncoder(
    private val outFile: File,
    private val sampleRate: Int,
    private val channels: Int = 1,
    private val bitRate: Int = 128_000,
) {
    private lateinit var codec: MediaCodec
    private lateinit var muxer: MediaMuxer
    private val bufferInfo = MediaCodec.BufferInfo()

    private var trackIndex = -1
    private var muxerStarted = false
    private var started = false
    private var finished = false
    private var released = false

    /** Total per-channel frames queued so far — the presentation clock source. */
    private var framesQueued = 0L

    /** True if encoding failed; the output file should be considered unusable. */
    @Volatile
    var failed = false
        private set

    fun start() {
        check(!started) { "AacEncoder already started" }
        started = true
        try {
            val format = MediaFormat.createAudioFormat(MIME, sampleRate, channels).apply {
                setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
                setInteger(MediaFormat.KEY_BIT_RATE, bitRate)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, MAX_INPUT_SIZE)
            }
            codec = MediaCodec.createEncoderByType(MIME).apply {
                configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
                start()
            }
            muxer = MediaMuxer(outFile.absolutePath, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        } catch (t: Throwable) {
            fail("start", t)
        }
    }

    /** Push one chunk of PCM bytes; splits it to fit the codec's input buffers. */
    fun feed(pcm: ByteArray, length: Int) {
        if (!started || finished || failed || length <= 0) return
        try {
            var offset = 0
            while (offset < length) {
                val inIndex = codec.dequeueInputBuffer(TIMEOUT_US)
                if (inIndex < 0) {
                    // No free input buffer yet — drain outputs and retry WITHOUT
                    // advancing the offset, so no audio is lost.
                    drain(endOfStream = false)
                    continue
                }
                val inBuf = codec.getInputBuffer(inIndex) ?: continue
                inBuf.clear()
                val chunk = minOf(inBuf.capacity(), length - offset)
                inBuf.put(pcm, offset, chunk)
                val ptsUs = framesQueued * 1_000_000L / sampleRate
                codec.queueInputBuffer(inIndex, 0, chunk, ptsUs, 0)
                framesQueued += chunk.toLong() / BYTES_PER_SAMPLE / channels
                offset += chunk
                drain(endOfStream = false)
            }
        } catch (t: Throwable) {
            fail("feed", t)
        }
    }

    /** Signal end-of-stream, flush the encoder, finalize the file, release resources. */
    fun finish() {
        if (finished) return
        finished = true
        if (failed || !started) { release(); return }
        try {
            var inIndex = codec.dequeueInputBuffer(TIMEOUT_US)
            var tries = 0
            while (inIndex < 0 && tries++ < MAX_DRAIN_TRIES) {
                inIndex = codec.dequeueInputBuffer(TIMEOUT_US)
            }
            if (inIndex >= 0) {
                val ptsUs = framesQueued * 1_000_000L / sampleRate
                codec.queueInputBuffer(inIndex, 0, 0, ptsUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                drain(endOfStream = true)
            }
        } catch (t: Throwable) {
            fail("finish", t)
        } finally {
            release()
        }
    }

    private fun drain(endOfStream: Boolean) {
        var tries = 0
        while (true) {
            val outIndex = codec.dequeueOutputBuffer(bufferInfo, if (endOfStream) TIMEOUT_US else 0)
            when {
                outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    check(!muxerStarted) { "output format changed twice" }
                    trackIndex = muxer.addTrack(codec.outputFormat)
                    muxer.start()
                    muxerStarted = true
                }
                outIndex >= 0 -> {
                    val out = codec.getOutputBuffer(outIndex)
                    val isConfig = bufferInfo.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0
                    if (out != null && bufferInfo.size > 0 && !isConfig && muxerStarted) {
                        out.position(bufferInfo.offset)
                        out.limit(bufferInfo.offset + bufferInfo.size)
                        muxer.writeSampleData(trackIndex, out, bufferInfo)
                    }
                    codec.releaseOutputBuffer(outIndex, false)
                    if (bufferInfo.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) return
                }
                else -> {
                    // INFO_TRY_AGAIN_LATER (or any other transient negative).
                    if (!endOfStream) return
                    if (tries++ >= MAX_DRAIN_TRIES) {
                        Log.w(TAG, "EOS not observed after $MAX_DRAIN_TRIES tries; giving up")
                        return
                    }
                }
            }
        }
    }

    private fun fail(where: String, t: Throwable) {
        failed = true
        Log.e(TAG, "AAC encode failed in $where", t)
        release()
    }

    private fun release() {
        if (released) return
        released = true
        if (started) runCatching { codec.stop() }
        runCatching { if (::codec.isInitialized) codec.release() }
        if (muxerStarted) runCatching { muxer.stop() }
        runCatching { if (::muxer.isInitialized) muxer.release() }
    }

    private companion object {
        const val TAG = "AacEncoder"
        const val MIME = MediaFormat.MIMETYPE_AUDIO_AAC
        const val TIMEOUT_US = 10_000L
        const val MAX_INPUT_SIZE = 16_384
        const val BYTES_PER_SAMPLE = 2 // 16-bit PCM
        const val MAX_DRAIN_TRIES = 100 // ~1s at TIMEOUT_US before we bail on a stuck drain
    }
}
