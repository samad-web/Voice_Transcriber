package com.voicetranscriber.callrecorder.platform

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature

/**
 * Hardware-backed device identity (platform design §3.2): a P-256 keypair in
 * the Android Keystore. The private key never leaves hardware; the server
 * stores the public key at enrollment and verifies a nonce signature on every
 * token refresh, so a stolen token file alone is useless.
 */
object DeviceIdentity {

    private const val ALIAS = "aura_device_identity"
    private const val STORE = "AndroidKeyStore"

    private fun keyStore(): KeyStore = KeyStore.getInstance(STORE).apply { load(null) }

    fun ensureKeyPair() {
        if (keyStore().containsAlias(ALIAS)) return
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, STORE)
        generator.initialize(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                .setAlgorithmParameterSpec(java.security.spec.ECGenParameterSpec("secp256r1"))
                .setDigests(KeyProperties.DIGEST_SHA256)
                // Recording runs unattended; requiring user auth would break background capture.
                .setUserAuthenticationRequired(false)
                .build(),
        )
        generator.generateKeyPair()
    }

    /** SPKI PEM the server stores at enrollment. */
    fun publicKeyPem(): String {
        val publicKey = keyStore().getCertificate(ALIAS).publicKey
        val body = Base64.encodeToString(publicKey.encoded, Base64.NO_WRAP)
            .chunked(64)
            .joinToString("\n")
        return "-----BEGIN PUBLIC KEY-----\n$body\n-----END PUBLIC KEY-----\n"
    }

    /** ECDSA-SHA256 over the raw nonce string, base64url — matches the server verifier. */
    fun signNonce(nonce: String): String {
        val entry = keyStore().getEntry(ALIAS, null) as KeyStore.PrivateKeyEntry
        val signature = Signature.getInstance("SHA256withECDSA").apply {
            initSign(entry.privateKey)
            update(nonce.toByteArray(Charsets.UTF_8))
        }
        return Base64.encodeToString(
            signature.sign(),
            Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
        )
    }

    fun wipe() {
        val store = keyStore()
        if (store.containsAlias(ALIAS)) store.deleteEntry(ALIAS)
    }
}
