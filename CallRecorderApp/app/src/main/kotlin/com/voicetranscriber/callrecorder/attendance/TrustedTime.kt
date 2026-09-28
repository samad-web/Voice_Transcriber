package com.voicetranscriber.callrecorder.attendance

/**
 * The phone's three clocks, behind an interface so the engine can run on a fake
 * one in tests. The Android implementation is [SystemDeviceClock].
 */
interface DeviceClock {
    /** System.currentTimeMillis() - what the user can change in Settings. */
    fun wallMs(): Long

    /** SystemClock.elapsedRealtime() - monotonic, counts deep sleep, resets on boot. */
    fun elapsedMs(): Long

    /** Settings.Global.BOOT_COUNT as a string; changes on every boot. */
    fun bootId(): String
}

/**
 * "Now" for every local decision: a wall reading taken ONCE (the anchor) and
 * then advanced only by the monotonic clock. A telecaller who moves the phone's
 * clock forward by an hour mid-shift does not skip an hour of silence timer,
 * break or reminders (doc 33 §4, "Clock trust") - the jump never reaches here.
 *
 * The anchor is re-taken:
 *  - on a new boot (elapsedRealtime restarted, so the old anchor means nothing),
 *  - from the server on every successful presence upload ([correctFromServer]),
 *    which is what repairs a clock that was already wrong when the shift began.
 */
class TrustedTime(private val clock: DeviceClock, anchor: Anchor? = null) {

    /** Persistable: a wall instant and the elapsedRealtime it corresponds to, in one boot. */
    data class Anchor(val wallMs: Long, val elapsedMs: Long, val bootId: String)

    var anchor: Anchor = validOrFresh(anchor)
        private set

    private fun validOrFresh(candidate: Anchor?): Anchor {
        val boot = clock.bootId()
        val elapsed = clock.elapsedMs()
        return if (candidate != null && candidate.bootId == boot && candidate.elapsedMs <= elapsed) {
            candidate
        } else {
            Anchor(clock.wallMs(), elapsed, boot)
        }
    }

    /** Trusted now, epoch ms. */
    fun now(): Long {
        if (anchor.bootId != clock.bootId() || clock.elapsedMs() < anchor.elapsedMs) {
            anchor = Anchor(clock.wallMs(), clock.elapsedMs(), clock.bootId())
        }
        return anchor.wallMs + (clock.elapsedMs() - anchor.elapsedMs)
    }

    /** Converts a trusted instant into the elapsedRealtime it will occur at (for alarms). */
    fun toElapsed(trustedMs: Long): Long = clock.elapsedMs() + (trustedMs - now())

    /**
     * Re-anchors from a presence upload that the server accepted.
     *
     * [clockSkewSeconds] is the server's `sentAt - receivedAt` (it is omitted
     * when under 2 minutes, which reads as 0 here). [sentWallMs] and
     * [sentElapsedMs] are the raw readings put in that batch's sentAt /
     * sentMonoMs. True time at send = raw wall at send - skew.
     *
     * Returns true when the anchor moved by more than [toleranceMs].
     */
    fun correctFromServer(
        sentWallMs: Long,
        sentElapsedMs: Long,
        sentBootId: String,
        clockSkewSeconds: Long,
        toleranceMs: Long = 5_000,
    ): Boolean {
        if (sentBootId != clock.bootId()) return false
        val trueAtSend = sentWallMs - clockSkewSeconds * 1000
        val predicted = anchor.wallMs + (sentElapsedMs - anchor.elapsedMs)
        if (anchor.bootId == sentBootId && kotlin.math.abs(predicted - trueAtSend) <= toleranceMs) return false
        anchor = Anchor(trueAtSend, sentElapsedMs, sentBootId)
        return true
    }
}
