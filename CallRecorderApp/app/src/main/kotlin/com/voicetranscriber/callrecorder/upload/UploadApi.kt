package com.voicetranscriber.callrecorder.upload

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import com.voicetranscriber.callrecorder.util.applyNgrokBypass

/**
 * Upload half of the platform API. Follows the same dependency-free
 * HttpURLConnection pattern as [com.voicetranscriber.callrecorder.platform.PlatformApi]
 * (checklist §3.2 will later swap in OkHttp + cert pinning). Kept separate
 * because part uploads target presigned URLs, not the fixed `<baseUrl>/v1` host.
 */
object UploadApi {

    class ApiException(val code: Int, message: String) : Exception(message)

    /** Result of POST /v1/calls — the multipart upload plan. */
    data class CreateCallResult(
        val callId: String,
        val uploadId: String,
        val partUrls: List<String>,
        val partSizeBytes: Long,
    )

    /** One completed part: its 1-based index and the ETag the store returned. */
    data class PartResult(val n: Int, val etag: String)

    /**
     * POST /v1/calls — registers the call and requests a multipart upload plan.
     * [sha256] must be the lowercase 64-hex digest of the raw audio bytes.
     */
    fun createCall(
        baseUrl: String,
        jwt: String,
        idempotencyKey: String,
        direction: String?,
        startedAt: String,
        durationS: Long,
        audioSourceUsed: String?,
        sha256: String,
        bytes: Long,
        consentPlayed: Boolean,
        remoteNumber: String? = null,
        remoteName: String? = null,
    ): CreateCallResult {
        val body = JSONObject()
            .put("idempotencyKey", idempotencyKey)
            .put("direction", direction ?: JSONObject.NULL)
            .put("startedAt", startedAt)
            .put("durationS", durationS)
            .put("audioSourceUsed", audioSourceUsed ?: JSONObject.NULL)
            .put("sha256", sha256)
            .put("bytes", bytes)
            .put("consentPlayed", consentPlayed)
        // Optional; the schema rejects null (only absent), so add only when present.
        if (!remoteNumber.isNullOrBlank()) body.put("remoteNumber", remoteNumber)
        if (!remoteName.isNullOrBlank()) body.put("remoteName", remoteName)
        val response = requestJson("${baseUrl.trimEnd('/')}/v1/calls", "POST", body, jwt)
        val upload = response.getJSONObject("upload")
        val urlsJson: JSONArray = upload.getJSONArray("partUrls")
        val partUrls = ArrayList<String>(urlsJson.length())
        for (i in 0 until urlsJson.length()) partUrls.add(urlsJson.getString(i))
        return CreateCallResult(
            callId = response.getString("callId"),
            uploadId = upload.getString("uploadId"),
            partUrls = partUrls,
            partSizeBytes = upload.getLong("partSizeBytes"),
        )
    }

    /** PUT the raw bytes of one part to its presigned URL; returns the response ETag. */
    fun uploadPart(url: String, bytes: ByteArray): String {
        val connection = URL(url).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "PUT"
            connection.connectTimeout = 15_000
            connection.readTimeout = 60_000
            connection.doOutput = true
            connection.setFixedLengthStreamingMode(bytes.size)
            connection.setRequestProperty("content-type", "application/octet-stream")
            connection.applyNgrokBypass()
            connection.outputStream.use { it.write(bytes) }
            val code = connection.responseCode
            if (code !in 200..299) {
                val text = connection.errorStream?.bufferedReader()?.readText().orEmpty()
                throw ApiException(code, "part PUT HTTP $code: ${text.take(300)}")
            }
            return connection.getHeaderField("ETag")
                ?: connection.getHeaderField("etag")
                ?: throw ApiException(code, "part PUT succeeded but response had no ETag")
        } finally {
            connection.disconnect()
        }
    }

    /** POST /v1/calls/{callId}/complete — finalizes the multipart upload. Returns the server status. */
    fun completeCall(
        baseUrl: String,
        jwt: String,
        callId: String,
        uploadId: String,
        parts: List<PartResult>,
        sha256: String,
    ): String {
        val partsArray = JSONArray()
        for (part in parts) {
            partsArray.put(JSONObject().put("n", part.n).put("etag", part.etag))
        }
        val body = JSONObject()
            .put("uploadId", uploadId)
            .put("parts", partsArray)
            .put("sha256", sha256)
        val response = requestJson(
            "${baseUrl.trimEnd('/')}/v1/calls/$callId/complete",
            "POST",
            body,
            jwt,
        )
        return response.optString("status", "")
    }

    /** SHA-256 of a file, streamed, as a lowercase 64-hex string. */
    fun sha256Hex(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun requestJson(
        fullUrl: String,
        method: String,
        body: JSONObject?,
        jwt: String,
    ): JSONObject {
        val connection = URL(fullUrl).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 10_000
            connection.readTimeout = 30_000
            connection.setRequestProperty("content-type", "application/json")
            connection.applyNgrokBypass()
            connection.setRequestProperty("authorization", "Bearer $jwt")
            if (body != null) {
                connection.doOutput = true
                connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            }
            val code = connection.responseCode
            val text = (if (code in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.readText() ?: "{}"
            if (code !in 200..299) throw ApiException(code, "HTTP $code: ${text.take(300)}")
            return JSONObject(text)
        } finally {
            connection.disconnect()
        }
    }
}
