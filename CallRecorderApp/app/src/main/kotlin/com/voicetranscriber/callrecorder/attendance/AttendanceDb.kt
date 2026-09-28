package com.voicetranscriber.callrecorder.attendance

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase

/**
 * One presence event waiting to be uploaded (doc 33 §10 "Event log").
 * Rows are deleted only after the server accepted the batch that carried them,
 * so the queue survives process death, reboots and days offline.
 */
@Entity(tableName = "presence_events")
data class PresenceEventEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val kind: String,
    /** ISO instant from the phone's wall clock when it happened. */
    val at: String,
    val bootId: String,
    /** elapsedRealtime when it happened. */
    val monoMs: Long,
    /** JSON object, or null for no payload. */
    val payload: String?,
)

/**
 * A leave or break application made on the phone, kept until the server has
 * stored it (doc 33 §6.3: "Waiting to send"). [clientRef] is generated when
 * Send is tapped and reused on every retry, so a retry after a lost response
 * is stored once on the server.
 */
@Entity(tableName = "pending_requests")
data class PendingRequestEntity(
    @PrimaryKey val clientRef: String,
    /** The full POST body, clientRef included. */
    val body: String,
    val createdAt: Long,
    /** "waiting" (will retry) or "failed" (the server refused it; shown until dismissed). */
    val status: String,
    val lastError: String?,
)

@Dao
interface AttendanceDao {
    @Insert
    fun insertEvent(event: PresenceEventEntity): Long

    @Query("SELECT * FROM presence_events ORDER BY id ASC LIMIT :limit")
    fun oldestEvents(limit: Int): List<PresenceEventEntity>

    @Query("DELETE FROM presence_events WHERE id <= :maxId AND id >= :minId")
    fun deleteEventRange(minId: Long, maxId: Long)

    @Query("SELECT COUNT(*) FROM presence_events")
    fun eventCount(): Int

    /** Bounds a very long offline stretch: heartbeats go first, they carry the least. */
    @Query(
        "DELETE FROM presence_events WHERE id IN " +
            "(SELECT id FROM presence_events WHERE kind = 'heartbeat' ORDER BY id ASC LIMIT :n)",
    )
    fun dropOldestHeartbeats(n: Int)

    @Query("DELETE FROM presence_events")
    fun clearEvents()

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    fun upsertRequest(request: PendingRequestEntity)

    @Query("SELECT * FROM pending_requests ORDER BY createdAt ASC")
    fun pendingRequests(): List<PendingRequestEntity>

    @Query("DELETE FROM pending_requests WHERE clientRef = :clientRef")
    fun deleteRequest(clientRef: String)
}

/**
 * Its own database file, NOT a new table in recordings.db: that database has
 * fallbackToDestructiveMigration(), and an attendance schema mistake must
 * never be able to wipe a telecaller's call recordings.
 */
@Database(entities = [PresenceEventEntity::class, PendingRequestEntity::class], version = 1, exportSchema = false)
abstract class AttendanceDb : RoomDatabase() {
    abstract fun dao(): AttendanceDao

    companion object {
        @Volatile private var instance: AttendanceDb? = null

        fun get(context: Context): AttendanceDb =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(context.applicationContext, AttendanceDb::class.java, "attendance.db")
                    .build().also { instance = it }
            }
    }
}
