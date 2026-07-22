package com.voicetranscriber.callrecorder.storage

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface RecordingDao {
    @Insert
    suspend fun insert(recording: RecordingEntity): Long

    @Update
    suspend fun update(recording: RecordingEntity)

    @Query("SELECT * FROM recordings ORDER BY startedAt DESC")
    fun observeAll(): Flow<List<RecordingEntity>>

    /** Every known file path — the dedupe set for OEM-recording ingestion. */
    @Query("SELECT filePath FROM recordings")
    suspend fun allFilePaths(): List<String>

    /**
     * Our own (non-OEM) captures overlapping a time window. Used to drop the near-end-only
     * duplicate once the OEM's both-ends recording of the same call has been ingested.
     * Already-uploaded rows are excluded — that send can't be taken back.
     */
    @Query(
        "SELECT * FROM recordings " +
            "WHERE (audioSource IS NULL OR audioSource NOT LIKE 'OEM%') " +
            "AND uploadState != 'UPLOADED' " +
            "AND EXISTS (" +
            "  SELECT 1 FROM recordings oem" +
            "  WHERE oem.audioSource LIKE 'OEM%'" +
            "  AND recordings.startedAt BETWEEN oem.startedAt - :toleranceMs" +
            "    AND COALESCE(oem.endedAt, oem.startedAt) + :toleranceMs)",
    )
    suspend fun appCapturesDuplicatingOem(toleranceMs: Long): List<RecordingEntity>

    @Query("UPDATE recordings SET transcript = :text WHERE id = :id")
    suspend fun setTranscript(id: Long, text: String?)

    @Query("DELETE FROM recordings WHERE id = :id")
    suspend fun deleteById(id: Long)

    @Query("DELETE FROM recordings WHERE id IN (:ids)")
    suspend fun deleteByIds(ids: List<Long>)

    @Query("UPDATE recordings SET callee = :name, note = :note, filePath = :path WHERE id = :id")
    suspend fun updateMeta(id: Long, name: String?, note: String?, path: String)

    @Query("UPDATE recordings SET filePath = :path, callee = :callee, direction = :direction WHERE id = :id")
    suspend fun updateResolved(id: Long, path: String, callee: String?, direction: String?)

    // --- Upload subsystem ---

    /** Finished recordings that still need uploading (PENDING or a previously FAILED attempt). */
    @Query(
        "SELECT * FROM recordings " +
            "WHERE uploadState IN ('PENDING', 'FAILED') AND endedAt IS NOT NULL " +
            "ORDER BY startedAt ASC",
    )
    suspend fun pendingUploads(): List<RecordingEntity>

    /** How many finished recordings are still queued for upload (device-health metric). */
    @Query(
        "SELECT COUNT(*) FROM recordings " +
            "WHERE uploadState IN ('PENDING', 'FAILED') AND endedAt IS NOT NULL",
    )
    suspend fun countPendingUploads(): Int

    /** Millis of the most recently uploaded recording, or null if none (device-health metric). */
    @Query("SELECT MAX(endedAt) FROM recordings WHERE uploadState = 'UPLOADED'")
    suspend fun lastUploadedAtMillis(): Long?

    /** Uploaded recordings whose transcript hasn't been fetched back yet. */
    @Query(
        "SELECT * FROM recordings " +
            "WHERE uploadState = 'UPLOADED' AND remoteCallId IS NOT NULL AND transcript IS NULL",
    )
    suspend fun awaitingTranscript(): List<RecordingEntity>

    /** Cheap single-column transition (e.g. PENDING → UPLOADING). */
    @Query("UPDATE recordings SET uploadState = :uploadState WHERE id = :id")
    suspend fun setUploadState(id: Long, uploadState: String)

    /** Persist the computed content hash so it survives retries. */
    @Query("UPDATE recordings SET sha256 = :sha256, bytesUploaded = :bytesUploaded WHERE id = :id")
    suspend fun setUploadProgress(id: Long, sha256: String?, bytesUploaded: Long)

    /** Record the outcome of an upload attempt. */
    @Query(
        "UPDATE recordings SET uploadState = :uploadState, remoteCallId = :remoteCallId, " +
            "attemptCount = :attemptCount, lastError = :lastError WHERE id = :id",
    )
    suspend fun setUploadResult(
        id: Long,
        uploadState: String,
        remoteCallId: String?,
        attemptCount: Int,
        lastError: String?,
    )
}
