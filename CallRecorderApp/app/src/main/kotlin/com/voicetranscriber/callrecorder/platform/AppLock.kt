package com.voicetranscriber.callrecorder.platform

import java.security.MessageDigest
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec

/**
 * Verifies the mobile app-lock password [ui.LockActivity] prompts for, entirely
 * offline against the hash synced down in [ActivationStore.appLockPasswordHash].
 *
 * Format: `pbkdf2$<iterations>$<saltHex>$<hashHex>`, produced server-side by
 * `apps/api/src/common/app-lock-hash.ts`. PBKDF2-HMAC-SHA256 was picked
 * specifically because `SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")`
 * has been available since API 26 - this app's minSdk - so no third-party
 * crypto dependency is needed, and Node's `crypto.pbkdf2Sync` produces a
 * byte-identical key for the same salt/iterations/keylen (both are plain
 * RFC 8018 PBKDF2).
 */
object AppLock {

    /** Tracks whether the password has been entered since this process started -
     *  resets on every cold start, which is what makes the lock "every time the
     *  app is opened" rather than a one-time unlock. */
    @Volatile
    var unlockedThisSession: Boolean = false

    fun verify(password: String, stored: String): Boolean {
        val parts = stored.split("$")
        if (parts.size != 4 || parts[0] != "pbkdf2") return false
        val iterations = parts[1].toIntOrNull() ?: return false
        val salt = parts[2].hexToBytes() ?: return false
        val expected = parts[3].hexToBytes() ?: return false

        val spec = PBEKeySpec(password.toCharArray(), salt, iterations, expected.size * 8)
        val actual = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded

        return constantTimeEquals(expected, actual)
    }

    /** Avoids leaking timing information about how much of the hash matched. */
    private fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean =
        a.size == b.size && MessageDigest.isEqual(a, b)

    private fun String.hexToBytes(): ByteArray? {
        if (length % 2 != 0) return null
        return try {
            ByteArray(length / 2) { i -> ((this[i * 2].digitToInt(16) shl 4) + this[i * 2 + 1].digitToInt(16)).toByte() }
        } catch (e: NumberFormatException) {
            null
        }
    }
}
