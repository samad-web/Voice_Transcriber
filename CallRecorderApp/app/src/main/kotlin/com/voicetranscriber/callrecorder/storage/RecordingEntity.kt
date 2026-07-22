package com.voicetranscriber.callrecorder.storage

import androidx.room.Entity
import androidx.room.PrimaryKey

/** One recording's metadata. Clean-room analogue of Cube ACR's Room-backed model. */
@Entity(tableName = "recordings")
data class RecordingEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val filePath: String,
    val sourceId: String,
    val callee: String?,
    val startedAt: Long,
    val endedAt: Long? = null,
    /** Which AudioRecord source actually captured this (e.g. "VOICE_CALL", "MIC"). */
    val audioSource: String? = null,
    /** "incoming", "outgoing", or null when unknown (e.g. VoIP). */
    val direction: String? = null,
    /** User-entered note (editable). */
    val note: String? = null,
    val transcript: String? = null,

    // --- Upload subsystem (schema v4) ---
    /** Upload lifecycle: PENDING | UPLOADING | UPLOADED | FAILED | DISCARDED. */
    val uploadState: String = "PENDING",
    /** Server-assigned call id once POST /v1/calls succeeds. */
    val remoteCallId: String? = null,
    /** How many upload attempts have been made (for backoff / diagnostics). */
    val attemptCount: Int = 0,
    /** Last upload error message, if any. */
    val lastError: String? = null,
    /** SHA-256 (64-hex) of the file that was/will be uploaded. */
    val sha256: String? = null,
    /** Bytes confirmed uploaded so far (resumability / progress). */
    val bytesUploaded: Long = 0,
)
